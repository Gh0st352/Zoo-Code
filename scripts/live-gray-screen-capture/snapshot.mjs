import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"

import { syncDirectory, writeJsonAtomic } from "./atomic-file.mjs"
import { DEFAULTS, SCHEMA_VERSION, VALIDATOR_VERSION } from "./constants.mjs"
import { currentProcessCreationTimeUtc, inspectProcessIdentity, isValidCreationTimeUtc } from "./process-identity.mjs"
import { SnapshotValidationError } from "./snapshot-validator.mjs"

const MIB = 1024 * 1024
const GIB = 1024 * MIB

const SNAPSHOT_RESULT_CODES = new Set([
	"snapshotBusy",
	"manualAcknowledgementRequired",
	"targetUnavailable",
	"targetAmbiguous",
	"heapMetricsUnavailable",
	"heapRatioBelowThreshold",
	"cooldownActive",
	"snapshotLimitReached",
	"diskMetricUnavailable",
	"diskHeadroomInsufficient",
	"physicalMemoryUnavailable",
	"physicalMemoryInsufficient",
	"v8HeadroomInsufficient",
	"lockUnavailable",
	"cdpUnavailable",
	"firstChunkTimedOut",
	"chunkInactivityTimedOut",
	"absoluteTimeout",
	"chunkTooLarge",
	"backpressureExceeded",
	"diskReserveBreached",
	"targetLost",
	"cdpConnectionLost",
	"writeFailed",
	"flushFailed",
	"validationFailed",
	"promotionFailed",
	"stopping",
	"unknownFailure",
])

function safeCode(error, fallback = "unknownFailure") {
	return typeof error?.code === "string" && SNAPSHOT_RESULT_CODES.has(error.code) ? error.code : fallback
}

export async function writeBufferFully(handle, buffer) {
	let offset = 0
	while (offset < buffer.length) {
		const result = await handle.write(buffer, offset, buffer.length - offset, null)
		if (!Number.isSafeInteger(result?.bytesWritten) || result.bytesWritten <= 0) {
			throw Object.assign(new Error("Snapshot write made no progress"), { code: "writeFailed" })
		}
		offset += result.bytesWritten
	}
}

export async function availableDiskBytes(directory, statfs = fs.statfs) {
	const stats = await statfs(directory)
	const bytes = Number(stats.bavail) * Number(stats.bsize)
	if (!Number.isSafeInteger(bytes) || bytes < 0)
		throw Object.assign(new Error("Disk metric unavailable"), { code: "diskMetricUnavailable" })
	return bytes
}

export async function evaluateSnapshotGates(
	{
		trigger,
		usedJsHeapBytes,
		jsHeapLimitBytes,
		availablePhysicalMemoryBytes,
		destinationDirectory,
		heapCriticalRatio,
		lastAttemptMonotonicMs,
		nowMonotonicMs,
		cooldownMs,
		overrideCooldown,
		successfulSnapshots,
		maxSnapshots,
	},
	dependencies = {},
) {
	if (
		!Number.isFinite(usedJsHeapBytes) ||
		usedJsHeapBytes <= 0 ||
		!Number.isFinite(jsHeapLimitBytes) ||
		jsHeapLimitBytes <= 0
	) {
		return { allowed: false, code: "heapMetricsUnavailable" }
	}
	const ratio = usedJsHeapBytes / jsHeapLimitBytes
	if (trigger !== "manual" && ratio < heapCriticalRatio) return { allowed: false, code: "heapRatioBelowThreshold" }
	if (successfulSnapshots >= maxSnapshots) return { allowed: false, code: "snapshotLimitReached" }
	if (!overrideCooldown && lastAttemptMonotonicMs !== null && nowMonotonicMs - lastAttemptMonotonicMs < cooldownMs) {
		return { allowed: false, code: "cooldownActive" }
	}
	if (!Number.isFinite(availablePhysicalMemoryBytes) || availablePhysicalMemoryBytes < 0) {
		return { allowed: false, code: "physicalMemoryUnavailable" }
	}
	const estimatedSnapshotBytes = Math.max(256 * MIB, 2 * usedJsHeapBytes)
	const diskReserveBytes = Math.max(2 * GIB, estimatedSnapshotBytes)
	const requiredDiskBytes = estimatedSnapshotBytes + diskReserveBytes
	const requiredPhysicalMemoryBytes = Math.max(2 * GIB, 0.75 * usedJsHeapBytes)
	const requiredV8HeadroomBytes = Math.max(256 * MIB, 0.08 * jsHeapLimitBytes)
	const availableV8HeadroomBytes = Math.max(0, jsHeapLimitBytes - usedJsHeapBytes)
	let diskBytes
	try {
		diskBytes = await (dependencies.availableDiskBytes ?? availableDiskBytes)(destinationDirectory)
	} catch {
		return { allowed: false, code: "diskMetricUnavailable" }
	}
	const metrics = {
		estimatedSnapshotBytes,
		diskReserveBytes,
		requiredDiskBytes,
		availableDiskBytes: diskBytes,
		requiredPhysicalMemoryBytes,
		availablePhysicalMemoryBytes,
		requiredV8HeadroomBytes,
		availableV8HeadroomBytes,
		heapRatio: ratio,
	}
	if (diskBytes < requiredDiskBytes) return { allowed: false, code: "diskHeadroomInsufficient", metrics }
	if (availablePhysicalMemoryBytes < requiredPhysicalMemoryBytes) {
		return { allowed: false, code: "physicalMemoryInsufficient", metrics }
	}
	if (availableV8HeadroomBytes < requiredV8HeadroomBytes)
		return { allowed: false, code: "v8HeadroomInsufficient", metrics }
	return { allowed: true, metrics }
}

export function validateInWorker(filePath, options = {}, dependencies = {}) {
	const WorkerImpl = dependencies.WorkerImpl ?? Worker
	return new Promise((resolve, reject) => {
		const worker = new WorkerImpl(new URL("./snapshot-validator-worker.mjs", import.meta.url), {
			workerData: { filePath, options },
			resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
		})
		let settled = false
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			void worker.terminate()
			reject(new SnapshotValidationError("validationTimedOut"))
		}, options.timeoutMs ?? DEFAULTS.validationTimeoutMs)
		worker.on("message", (message) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			void worker.terminate()
			if (message.status === "completed") resolve(message.result)
			else reject(new SnapshotValidationError(message.code ?? "validationFailed"))
		})
		worker.on("error", () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(new SnapshotValidationError("validationWorkerFailed"))
		})
		worker.on("exit", (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(new SnapshotValidationError(code === 0 ? "validationFailed" : "validationWorkerFailed"))
		})
	})
}

export class SnapshotCoordinator {
	constructor({ run, cdp, processSampler, clock, options, onRecord, onManifest, dependencies = {} }) {
		this.run = run
		this.cdp = cdp
		this.processSampler = processSampler
		this.clock = clock
		this.options = options
		this.onRecord = onRecord
		this.onManifest = onManifest
		this.dependencies = dependencies
		this.active = false
		this.aborting = false
		this.attemptOrdinal = 0
		this.successfulSnapshots = 0
		this.lastAttemptMonotonicMs = null
		this.activePromise = null
		this.abortActive = null
		this.abortCode = null
	}

	async request({
		reason,
		targetOrdinal = null,
		overrideCooldown = false,
		allowUnresponsiveAttempt = false,
		manualRiskAcknowledged = false,
	}) {
		this.attemptOrdinal += 1
		const attemptOrdinal = this.attemptOrdinal
		if (this.active) return this.rejectAttempt(attemptOrdinal, targetOrdinal, "snapshotBusy", overrideCooldown)
		this.active = true
		this.aborting = false
		this.abortCode = null
		let captureStarted = false
		try {
			if (reason === "manual" && !manualRiskAcknowledged) {
				return this.rejectAttempt(
					attemptOrdinal,
					targetOrdinal,
					"manualAcknowledgementRequired",
					overrideCooldown,
				)
			}
			let target
			try {
				target = this.cdp.resolveSnapshotTarget(targetOrdinal)
			} catch (error) {
				return this.rejectAttempt(
					attemptOrdinal,
					targetOrdinal,
					safeCode(error, "targetUnavailable"),
					overrideCooldown,
				)
			}
			const memory = this.cdp.latestMemory?.() ?? null
			const gate = await evaluateSnapshotGates(
				{
					trigger: reason,
					usedJsHeapBytes: memory?.usedJsHeapBytes ?? memory?.runtimeUsedHeapBytes,
					jsHeapLimitBytes: memory?.jsHeapLimitBytes,
					availablePhysicalMemoryBytes: this.processSampler?.latestAvailableMemoryBytes,
					destinationDirectory: path.join(this.run.runDir, "snapshots"),
					heapCriticalRatio: this.options.heapCriticalRatio,
					lastAttemptMonotonicMs: this.lastAttemptMonotonicMs,
					nowMonotonicMs: this.clock.monotonicMs(),
					cooldownMs: this.options.snapshotCooldownMs,
					overrideCooldown,
					successfulSnapshots: this.successfulSnapshots,
					maxSnapshots: DEFAULTS.maxSnapshotsPerRun,
				},
				this.dependencies,
			)
			if (!gate.allowed) return this.rejectAttempt(attemptOrdinal, target.ordinal, gate.code, overrideCooldown)

			this.lastAttemptMonotonicMs = this.clock.monotonicMs()
			captureStarted = true
			this.activePromise = this.capture({
				attemptOrdinal,
				target,
				reason,
				overrideCooldown,
				allowUnresponsiveAttempt,
				gateMetrics: gate.metrics,
			})
			try {
				return await this.activePromise
			} finally {
				this.activePromise = null
			}
		} finally {
			this.active = false
			if (captureStarted) this.cdp.setDiagnosticPause(false)
		}
	}

	async rejectAttempt(attemptOrdinal, targetOrdinal, code, overrideCooldown) {
		await this.onRecord("snapshotRejected", {
			attemptOrdinal,
			targetOrdinal: targetOrdinal ?? 0,
			reason: code,
			stage: "preflight",
			overrideCooldown,
		})
		return { status: "rejected", code }
	}

	async acquireLock(attemptOrdinal) {
		const lockPath = path.join(this.run.runDir, "snapshots", "snapshot.lock")
		for (let attempt = 0; attempt < 2; attempt += 1) {
			let handle
			try {
				handle = await fs.open(lockPath, "wx", 0o600)
				const processCreated = await (
					this.dependencies.currentProcessCreationTimeUtc ?? currentProcessCreationTimeUtc
				)()
				if (!isValidCreationTimeUtc(processCreated)) {
					throw Object.assign(new Error("Harness process identity is unavailable"), {
						code: "lockUnavailable",
					})
				}
				const content = `schema=1\nrun=${this.run.manifest.runId}\npid=${process.pid}\nprocessCreated=${processCreated}\nattempt=${attemptOrdinal}\nstarted=${this.clock.utc()}\n`
				await handle.writeFile(content, "utf8")
				await handle.sync()
				await handle.close()
				return lockPath
			} catch (error) {
				await handle?.close().catch(() => {})
				if (error.code !== "EEXIST" || attempt > 0 || !(await this.removeStaleLock(lockPath))) {
					throw Object.assign(new Error("Snapshot lock unavailable"), { code: "lockUnavailable" })
				}
			}
		}
		throw Object.assign(new Error("Snapshot lock unavailable"), { code: "lockUnavailable" })
	}

	async removeStaleLock(lockPath) {
		let content
		let observedStat
		try {
			observedStat = await fs.lstat(lockPath)
			if (!observedStat.isFile() || observedStat.isSymbolicLink()) return false
			content = await fs.readFile(lockPath, "utf8")
		} catch {
			return false
		}
		if (Buffer.byteLength(content) > 1024) return false
		const fields = Object.fromEntries(
			content
				.trim()
				.split("\n")
				.map((line) => line.split("=", 2)),
		)
		if (
			fields.schema !== "1" ||
			fields.run !== this.run.manifest.runId ||
			!/^[1-9]\d{0,9}$/.test(fields.pid ?? "") ||
			!isValidCreationTimeUtc(fields.processCreated) ||
			!/^[1-9]\d{0,9}$/.test(fields.attempt ?? "") ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fields.started ?? "")
		) {
			return false
		}
		const identity = await (this.dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(Number(fields.pid))
		if (identity.state === "unknown") return false
		if (identity.state === "present" && identity.creationTimeUtc === fields.processCreated) return false
		try {
			const currentStat = await fs.lstat(lockPath)
			if (
				!currentStat.isFile() ||
				currentStat.isSymbolicLink() ||
				currentStat.dev !== observedStat.dev ||
				currentStat.ino !== observedStat.ino ||
				currentStat.size !== observedStat.size ||
				currentStat.mtimeMs !== observedStat.mtimeMs
			) {
				return false
			}
			await fs.unlink(lockPath)
			return true
		} catch {
			return false
		}
	}

	requestAbort(code = "stopping") {
		if (this.abortActive) {
			this.abortActive(code)
			return
		}
		this.aborting = true
		this.abortCode = code
	}

	async capture({ attemptOrdinal, target, reason, overrideCooldown, allowUnresponsiveAttempt, gateMetrics }) {
		const startedMs = this.clock.monotonicMs()
		let lockPath
		let tempPath
		let finalPath
		let sidecarPath
		let sidecarTemporaryPath
		let handle
		let byteCount = 0
		let chunkCount = 0
		let writeChain = Promise.resolve()
		let expectedHash
		let failureStage = "locking"
		const hash = createHash("sha256")
		try {
			lockPath = await this.acquireLock(attemptOrdinal)
			failureStage = "streaming"
			const stamp = this.clock
				.utc()
				.replace(/[-:]/g, "")
				.replace(/\.\d{3}Z$/, "Z")
			const baseName = `snapshot-${stamp}-${String(attemptOrdinal).padStart(3, "0")}`
			tempPath = path.join(this.run.runDir, "snapshots", `${baseName}.heapsnapshot.tmp`)
			finalPath = path.join(this.run.runDir, "snapshots", `${baseName}.heapsnapshot`)
			sidecarPath = path.join(this.run.runDir, "snapshots", `${baseName}.json`)
			handle = await fs.open(tempPath, "wx", 0o600)
			this.cdp.setDiagnosticPause(true)
			await this.onManifest({ activeSnapshot: { attemptOrdinal, state: "streaming", privateArtifact: true } })
			await this.onRecord("snapshotStarted", {
				attemptOrdinal,
				targetOrdinal: target.ordinal,
				reason,
				overrideCooldown,
				privateArtifact: true,
			})

			let firstChunkReceived = false
			let inactivityTimer
			let rejectAbort
			const abortPromise = new Promise((_, reject) => {
				rejectAbort = reject
			})
			const failStream = (code) => {
				if (this.aborting) return
				this.aborting = true
				this.abortCode = code
				this.cdp.abortSnapshot?.()
				rejectAbort(Object.assign(new Error("Snapshot stream failed"), { code }))
			}
			this.abortActive = failStream
			const firstTimer = setTimeout(() => failStream("firstChunkTimedOut"), DEFAULTS.firstSnapshotChunkTimeoutMs)
			const absoluteTimer = setTimeout(() => failStream("absoluteTimeout"), DEFAULTS.snapshotAbsoluteTimeoutMs)
			const resetInactivity = () => {
				clearTimeout(inactivityTimer)
				inactivityTimer = setTimeout(
					() => failStream("chunkInactivityTimedOut"),
					DEFAULTS.snapshotInactivityTimeoutMs,
				)
			}
			this.cdp.setSnapshotListener((event) => {
				if (
					event.sessionId !== target.sessionId ||
					event.method !== "HeapProfiler.addHeapSnapshotChunk" ||
					this.aborting
				)
					return
				const chunk = event.params?.chunk
				if (typeof chunk !== "string") return failStream("writeFailed")
				const buffer = Buffer.from(chunk, "utf8")
				if (buffer.length > DEFAULTS.maxSnapshotChunkBytes) return failStream("chunkTooLarge")
				if (!firstChunkReceived) {
					firstChunkReceived = true
					clearTimeout(firstTimer)
				}
				resetInactivity()
				writeChain = writeChain.then(async () => {
					await writeBufferFully(handle, buffer)
					hash.update(buffer)
					byteCount += buffer.length
					chunkCount += 1
					if (byteCount > 0 && byteCount % (64 * MIB) < buffer.length) {
						const free = await (this.dependencies.availableDiskBytes ?? availableDiskBytes)(
							path.dirname(tempPath),
						)
						if (free < gateMetrics.diskReserveBytes) return failStream("diskReserveBreached")
					}
				})
				writeChain.catch(() => failStream("writeFailed"))
				return writeChain
			})
			this.cdp.setSnapshotDisconnectListener?.((code) => failStream(code), target.sessionId)

			try {
				await Promise.race([
					this.cdp.client.command(
						"HeapProfiler.takeHeapSnapshot",
						{ reportProgress: true, captureNumericValue: false, exposeInternals: false },
						{ sessionId: target.sessionId, timeoutMs: DEFAULTS.snapshotAbsoluteTimeoutMs },
					),
					abortPromise,
				])
			} finally {
				clearTimeout(firstTimer)
				clearTimeout(inactivityTimer)
				clearTimeout(absoluteTimer)
				this.cdp.setSnapshotListener(null)
				this.cdp.setSnapshotDisconnectListener?.(null)
				this.abortActive = null
			}
			if (this.cdp.eventQueue) await this.cdp.eventQueue
			await writeChain.catch((error) => {
				throw Object.assign(new Error("Snapshot write failed"), { code: safeCode(error, "writeFailed") })
			})
			failureStage = "flushing"
			if (this.aborting)
				throw Object.assign(new Error("Snapshot was aborted"), { code: this.abortCode ?? "stopping" })
			if (byteCount === 0) throw Object.assign(new Error("Snapshot is empty"), { code: "validationFailed" })
			expectedHash = hash.digest("hex")
			try {
				await handle.sync()
				await handle.close()
			} catch {
				throw Object.assign(new Error("Snapshot flush failed"), { code: "flushFailed" })
			}
			handle = null
			failureStage = "validating"
			await this.onManifest({ activeSnapshot: { attemptOrdinal, state: "validating", privateArtifact: true } })
			const validation = await (this.dependencies.validateInWorker ?? validateInWorker)(tempPath, {
				expectedSha256: expectedHash,
				timeoutMs: this.options.validationTimeoutMs ?? DEFAULTS.validationTimeoutMs,
			})
			failureStage = "promoting"
			try {
				await (this.dependencies.rename ?? fs.rename)(tempPath, finalPath)
				await (this.dependencies.syncDirectory ?? syncDirectory)(path.dirname(finalPath))
			} catch {
				throw Object.assign(new Error("Snapshot promotion failed"), { code: "promotionFailed" })
			}
			tempPath = null
			const durationMs = Math.max(0, this.clock.monotonicMs() - startedMs)
			try {
				sidecarTemporaryPath = `${sidecarPath}.pending`
				await (this.dependencies.writeJsonAtomic ?? writeJsonAtomic)(sidecarTemporaryPath, {
					schemaVersion: SCHEMA_VERSION,
					validatorVersion: VALIDATOR_VERSION,
					privateArtifact: true,
					attemptOrdinal,
					trigger: reason,
					targetOrdinal: target.ordinal,
					targetEpoch: target.epoch,
					rendererEpoch: target.rendererEpoch,
					byteCount: validation.byteCount,
					sha256: validation.sha256,
					nodeCount: validation.nodeCount,
					edgeCount: validation.edgeCount,
					nodeFieldCount: validation.nodeFieldCount,
					edgeFieldCount: validation.edgeFieldCount,
					chunkCount,
					durationMs,
					allowUnresponsiveAttempt,
				})
				await (this.dependencies.rename ?? fs.rename)(sidecarTemporaryPath, sidecarPath)
				await (this.dependencies.syncDirectory ?? syncDirectory)(path.dirname(sidecarPath))
				sidecarTemporaryPath = null
			} catch {
				throw Object.assign(new Error("Snapshot sidecar promotion failed"), { code: "promotionFailed" })
			}
			this.successfulSnapshots += 1
			await this.onManifest({ activeSnapshot: null, snapshotCount: this.successfulSnapshots })
			await this.onRecord("snapshotCompleted", {
				attemptOrdinal,
				targetOrdinal: target.ordinal,
				reason,
				byteCount: validation.byteCount,
				nodeCount: validation.nodeCount,
				edgeCount: validation.edgeCount,
				durationMs,
				privateArtifact: true,
			})
			return { status: "completed", attemptOrdinal, byteCount: validation.byteCount }
		} catch (error) {
			this.aborting = true
			if (["streaming", "flushing"].includes(failureStage) && !this.abortCode) this.cdp.abortSnapshot?.()
			await writeChain?.catch(() => {})
			await handle?.sync().catch(() => {})
			await handle?.close().catch(() => {})
			if (tempPath) await fs.unlink(tempPath).catch(() => {})
			if (finalPath) await fs.unlink(finalPath).catch(() => {})
			if (sidecarPath) await fs.unlink(sidecarPath).catch(() => {})
			if (sidecarTemporaryPath) await fs.unlink(sidecarTemporaryPath).catch(() => {})
			const stageFallback =
				failureStage === "validating"
					? "validationFailed"
					: failureStage === "promoting"
						? "promotionFailed"
						: "unknownFailure"
			const code = safeCode(error, stageFallback)
			await (this.dependencies.writeJsonAtomic ?? writeJsonAtomic)(
				path.join(this.run.runDir, "failures", `snapshot-${String(attemptOrdinal).padStart(3, "0")}.json`),
				{
					schemaVersion: SCHEMA_VERSION,
					privateArtifact: true,
					attemptOrdinal,
					targetOrdinal: target.ordinal,
					stage: failureStage,
					code,
					byteCount,
					chunkCount,
				},
			)
			await this.onManifest({ activeSnapshot: null })
			await this.onRecord("snapshotFailed", {
				attemptOrdinal,
				targetOrdinal: target.ordinal,
				reason: code,
				stage: failureStage,
				byteCount,
				privateArtifact: true,
			})
			return { status: "failed", code }
		} finally {
			this.abortActive = null
			if (lockPath) await fs.unlink(lockPath).catch(() => {})
		}
	}

	async stop(policy = "wait") {
		if (!this.activePromise) return
		if (policy === "abort") {
			this.requestAbort()
			this.cdp.abortSnapshot?.()
			await this.activePromise
			return
		}
		let completed = false
		await Promise.race([
			this.activePromise.finally(() => {
				completed = true
			}),
			new Promise((resolve) => setTimeout(resolve, DEFAULTS.stopSnapshotWaitMs)),
		])
		if (!completed) {
			this.requestAbort()
			this.cdp.abortSnapshot?.()
			await this.activePromise
		}
	}
}
