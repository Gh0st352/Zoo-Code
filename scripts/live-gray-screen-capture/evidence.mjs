import fs from "node:fs/promises"
import path from "node:path"

import { writeJsonAtomic, readJsonBounded } from "./atomic-file.mjs"
import {
	CRITICAL_RECORD_TYPES,
	DEFAULTS,
	EVENT_STREAM_TYPES,
	SCHEMA_VERSION,
	freezeCaptureConfig,
} from "./constants.mjs"
import { createClock, createRecordFactory, generateRunId, sanitizeOsError } from "./records.mjs"
import { currentProcessCreationTimeUtc, inspectProcessIdentity, isValidCreationTimeUtc } from "./process-identity.mjs"

const RUN_DIRECTORY_PATTERN = /^run-\d{8}T\d{6}Z-[a-z2-7]{20}$/
const SEGMENT_KINDS = Object.freeze({
	events: { directory: "events", prefix: "events" },
	renderer: { directory: "metrics", prefix: "renderer" },
	processes: { directory: "metrics", prefix: "processes" },
})

function retentionError(code, message) {
	return Object.assign(new Error(message), { code })
}

async function assertRetainedDirectory(directory) {
	const stat = await fs.lstat(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw retentionError("RETENTION_UNSAFE_ENTRY", "Retention encountered an unsafe directory entry")
	}
}

function compactUtc(utc) {
	return utc.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

function isCritical(record) {
	return CRITICAL_RECORD_TYPES.has(record.recordType)
}

function streamKind(record) {
	if (record.recordType === "processMemory") return "processes"
	if (record.recordType === "rendererMemory" || record.recordType === "rendererProbe") return "renderer"
	if (EVENT_STREAM_TYPES.has(record.recordType)) return "events"
	throw new TypeError(`No evidence stream for ${record.recordType}`)
}

function assertRecordEnvelope(record) {
	const allowed = new Set([
		"schemaVersion",
		"runId",
		"recordSequence",
		"utc",
		"monotonicNs",
		"source",
		"recordType",
		"browserEpoch",
		"processEpoch",
		"cdpConnectionEpoch",
		"targetEpoch",
		"rendererEpoch",
		"capabilityState",
		"data",
	])
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new TypeError(`Record envelope contains forbidden field ${key}`)
	}
	if (record.schemaVersion !== SCHEMA_VERSION || !record.data || typeof record.data !== "object") {
		throw new TypeError("Record envelope is invalid")
	}
}

async function syncDirectory(directory) {
	let handle
	try {
		handle = await fs.open(directory, "r")
		await handle.sync()
	} catch (error) {
		if (process.platform !== "win32") throw error
	} finally {
		await handle?.close().catch(() => {})
	}
}

class Segment {
	constructor({ runDir, kind, rotationBytes, openFile = fs.open }) {
		this.runDir = runDir
		this.kind = kind
		this.rotationBytes = rotationBytes
		this.openFile = openFile
		this.ordinal = 0
		this.bytes = 0
		this.handle = null
	}

	async openNext() {
		await this.close()
		this.ordinal += 1
		const spec = SEGMENT_KINDS[this.kind]
		const directory = path.join(this.runDir, spec.directory)
		const fileName = `${spec.prefix}-${String(this.ordinal).padStart(6, "0")}.ndjson`
		this.handle = await this.openFile(path.join(directory, fileName), "wx", 0o600)
		this.bytes = 0
	}

	async append(buffer, critical) {
		if (!this.handle || (this.bytes > 0 && this.bytes + buffer.length > this.rotationBytes)) await this.openNext()
		let offset = 0
		while (offset < buffer.length) {
			const result = await this.handle.write(buffer, offset, buffer.length - offset, null)
			if (!Number.isSafeInteger(result?.bytesWritten) || result.bytesWritten <= 0) {
				throw Object.assign(new Error("Evidence write made no progress"), { code: "EVIDENCE_WRITE_FAILED" })
			}
			offset += result.bytesWritten
		}
		this.bytes += buffer.length
		if (critical) await this.handle.sync()
	}

	async flush(sync = false) {
		if (sync && this.handle) await this.handle.sync()
	}

	async close() {
		if (!this.handle) return
		const handle = this.handle
		this.handle = null
		await handle.sync()
		await handle.close()
	}
}

export class EvidenceWriter {
	constructor({
		runDir,
		maxRecordBytes,
		rotationBytes,
		maxQueueRecords,
		maxRunEvidenceBytes,
		flushIntervalMs = DEFAULTS.flushIntervalMs,
		fsyncIntervalMs = DEFAULTS.fsyncIntervalMs,
		openFile = fs.open,
	}) {
		this.runDir = runDir
		this.maxRecordBytes = maxRecordBytes
		this.maxQueueRecords = maxQueueRecords
		this.maxRunEvidenceBytes = maxRunEvidenceBytes
		this.totalBytes = 0
		this.queue = []
		this.draining = false
		this.closed = false
		this.failure = null
		this.droppedOrdinary = 0
		this.downsampleFactor = 1
		this.ordinaryCounter = 0
		this.segments = Object.fromEntries(
			Object.keys(SEGMENT_KINDS).map((kind) => [kind, new Segment({ runDir, kind, rotationBytes, openFile })]),
		)
		this.idleWaiters = []
		this.flushTimer = setInterval(
			() => void this.flush(false).catch((error) => this.latchFailure(error)),
			flushIntervalMs,
		)
		this.flushTimer.unref?.()
		this.fsyncTimer = setInterval(
			() => void this.flush(true).catch((error) => this.latchFailure(error)),
			fsyncIntervalMs,
		)
		this.fsyncTimer.unref?.()
	}

	write(record) {
		if (this.closed)
			return Promise.reject(Object.assign(new Error("Evidence writer is closed"), { code: "EVIDENCE_CLOSED" }))
		if (this.failure) return Promise.reject(this.failure)
		assertRecordEnvelope(record)
		const critical = isCritical(record)
		if (!critical) {
			this.ordinaryCounter += 1
			if (this.totalBytes >= this.maxRunEvidenceBytes) {
				this.downsampleFactor = Math.min(1_048_576, this.downsampleFactor * 2)
			}
			if (this.ordinaryCounter % this.downsampleFactor !== 0) {
				this.droppedOrdinary += 1
				return Promise.resolve(false)
			}
		}

		const line = `${JSON.stringify(record)}\n`
		const buffer = Buffer.from(line, "utf8")
		if (buffer.length > this.maxRecordBytes) {
			return Promise.reject(
				Object.assign(new Error("Evidence record exceeds the fixed bound"), { code: "RECORD_TOO_LARGE" }),
			)
		}

		return new Promise((resolve, reject) => {
			if (this.queue.length >= this.maxQueueRecords) {
				const ordinaryIndex = this.queue.findIndex((item) => !item.critical)
				if (ordinaryIndex !== -1) {
					const [dropped] = this.queue.splice(ordinaryIndex, 1)
					this.droppedOrdinary += 1
					dropped.resolve(false)
				} else if (!critical) {
					this.droppedOrdinary += 1
					resolve(false)
					return
				} else {
					reject(Object.assign(new Error("Critical evidence queue is full"), { code: "CRITICAL_QUEUE_FULL" }))
					return
				}
			}
			this.queue.push({ record, buffer, critical, resolve, reject })
			this.scheduleDrain()
		})
	}

	scheduleDrain() {
		if (this.draining) return
		this.draining = true
		queueMicrotask(() => {
			void this.drain()
		})
	}

	async drain() {
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift()
				try {
					await this.segments[streamKind(item.record)].append(item.buffer, item.critical)
					this.totalBytes += item.buffer.length
					item.resolve(true)
				} catch (error) {
					this.latchFailure(error)
					item.reject(error)
					for (const queued of this.queue.splice(0)) queued.reject(this.failure)
					break
				}
			}
		} finally {
			this.draining = false
			if (this.queue.length > 0) this.scheduleDrain()
			else this.resolveIdle()
		}
	}

	latchFailure(error) {
		if (this.failure) return
		this.failure = Object.assign(new Error("Evidence writer failed"), {
			code: "EVIDENCE_WRITE_FAILED",
			cause: error,
		})
	}

	resolveIdle() {
		for (const resolve of this.idleWaiters.splice(0)) resolve()
	}

	async waitForIdle() {
		if (!this.draining && this.queue.length === 0) return
		await new Promise((resolve) => this.idleWaiters.push(resolve))
	}

	async flush(sync = false) {
		await this.waitForIdle()
		if (this.failure) throw this.failure
		await Promise.all(Object.values(this.segments).map((segment) => segment.flush(sync)))
		if (this.failure) throw this.failure
	}

	async close() {
		if (this.closed) return
		this.closed = true
		clearInterval(this.flushTimer)
		clearInterval(this.fsyncTimer)
		await this.waitForIdle()
		const results = await Promise.allSettled(Object.values(this.segments).map((segment) => segment.close()))
		const closeFailure = results.find((result) => result.status === "rejected")?.reason
		if (closeFailure) this.latchFailure(closeFailure)
		if (this.failure) throw this.failure
	}

	status() {
		return {
			segmentOrdinals: Object.fromEntries(
				Object.entries(this.segments).map(([kind, segment]) => [kind, segment.ordinal]),
			),
			nonSnapshotEvidenceBytes: this.totalBytes,
			droppedOrdinaryRecords: this.droppedOrdinary,
			downsampleFactor: this.downsampleFactor,
		}
	}
}

function buildManifest({
	runId,
	mode,
	profileMode,
	clock,
	captureConfig,
	harnessPid,
	harnessCreationTimeUtc,
	provenance,
}) {
	const utc = clock.utc()
	return {
		schemaVersion: SCHEMA_VERSION,
		runId,
		state: "allocated",
		captureMode: mode,
		profileMode,
		startedUtc: utc,
		updatedUtc: utc,
		startedMonotonicNs: clock.monotonicNs().toString(),
		harnessPid,
		harnessCreationTimeUtc,
		captureConfig,
		provenance: {
			nodeVersion: process.version,
			platform: process.platform,
			architecture: process.arch,
			extensionSource: provenance.extensionSource,
			workspaceArgumentPresent: provenance.workspaceArgumentPresent,
			transportDiagnostics: provenance.transportDiagnostics,
			partialCoalescing: provenance.partialCoalescing,
			cdpLoopbackFamily: provenance.cdpLoopbackFamily ?? null,
			cdpPort: provenance.cdpPort ?? null,
		},
		capabilities: {},
		epochs: {
			browserEpoch: null,
			cdpConnectionEpoch: null,
			targetEpoch: null,
			rendererEpoch: null,
		},
		targetIdentity: "unresolved",
		activeSnapshot: null,
		lastSuccessfulProcessSampleUtc: null,
		lastCdpEventUtc: null,
		lastRendererHeartbeatUtc: null,
		segmentOrdinals: { events: 0, renderer: 0, processes: 0 },
		nonSnapshotEvidenceBytes: 0,
		droppedOrdinaryRecords: 0,
		downsampleFactor: 1,
		snapshotCount: 0,
	}
}

export class EvidenceRun {
	constructor({ outputRoot, runDir, manifest, clock, writer, makeRecord }) {
		this.outputRoot = outputRoot
		this.runDir = runDir
		this.manifest = manifest
		this.clock = clock
		this.writer = writer
		this.makeRecord = makeRecord
		this.finalized = false
	}

	async updateState(state, patch = {}) {
		if (this.finalized) throw new Error("Run is finalized")
		const allowedStates = ["allocated", "preflight", "launching", "attaching", "capturing", "stopping", "failed"]
		if (!allowedStates.includes(state)) throw new TypeError("Invalid active manifest state")
		const writerStatus = this.writer.status()
		this.manifest = {
			...this.manifest,
			...patch,
			...writerStatus,
			state,
			updatedUtc: this.clock.utc(),
		}
		await writeJsonAtomic(path.join(this.runDir, "manifest.partial.json"), this.manifest)
	}

	async heartbeat(patch = {}) {
		await this.updateState(this.manifest.state, patch)
	}

	async writeProvenance(name, value) {
		if (!["processes", "targets", "capabilities"].includes(name)) throw new TypeError("Invalid provenance artifact")
		await writeJsonAtomic(path.join(this.runDir, "provenance", `${name}.json`), value)
	}

	async finalize({ outcome, classification, operationalCleanup = "completed", failure = null }) {
		if (this.finalized) return
		await this.writer.flush(true)
		const writerStatus = this.writer.status()
		await this.writer.close()
		const terminal = {
			...this.manifest,
			...writerStatus,
			state: outcome === "failed" ? "failed" : "completed",
			updatedUtc: this.clock.utc(),
			completedUtc: this.clock.utc(),
			captureOutcome: outcome,
			classification,
			operationalCleanup,
			failure,
		}
		await writeJsonAtomic(path.join(this.runDir, "manifest.json"), terminal)
		await writeJsonAtomic(path.join(this.runDir, "summary.json"), {
			schemaVersion: SCHEMA_VERSION,
			runId: terminal.runId,
			captureOutcome: terminal.captureOutcome,
			classification: terminal.classification,
			startedUtc: terminal.startedUtc,
			completedUtc: terminal.completedUtc,
			targetIdentity: terminal.targetIdentity,
			snapshotCount: terminal.snapshotCount,
			nonSnapshotEvidenceBytes: terminal.nonSnapshotEvidenceBytes,
			droppedOrdinaryRecords: terminal.droppedOrdinaryRecords,
		})
		await fs.unlink(path.join(this.runDir, "manifest.partial.json")).catch((error) => {
			if (error.code !== "ENOENT") throw error
		})
		await syncDirectory(this.runDir)
		this.manifest = terminal
		this.finalized = true
	}
}

export async function createEvidenceRun(options, dependencies = {}) {
	const clock = dependencies.clock ?? createClock()
	const runId = dependencies.runId ?? generateRunId(dependencies.random)
	const outputRoot = path.resolve(options.output)
	await fs.mkdir(outputRoot, { recursive: true })
	const runName = `run-${compactUtc(clock.utc())}-${runId}`
	const runDir = path.join(outputRoot, runName)
	await fs.mkdir(runDir, { recursive: false })
	for (const directory of ["events", "metrics", "provenance", "snapshots", "failures"]) {
		await fs.mkdir(path.join(runDir, directory))
	}
	const captureConfig = freezeCaptureConfig(options)
	const harnessCreationTimeUtc =
		dependencies.harnessCreationTimeUtc ??
		(await (dependencies.currentProcessCreationTimeUtc ?? currentProcessCreationTimeUtc)())
	if (!isValidCreationTimeUtc(harnessCreationTimeUtc)) {
		throw Object.assign(new Error("Harness process identity is unavailable"), {
			code: "PROCESS_IDENTITY_UNAVAILABLE",
		})
	}
	const manifest = buildManifest({
		runId,
		mode: options.command,
		profileMode: options.profileMode ?? "notApplicable",
		clock,
		captureConfig,
		harnessPid: process.pid,
		harnessCreationTimeUtc,
		provenance: {
			extensionSource: options.extensionDevelopmentPath
				? "developmentPath"
				: options.extensionVsix
					? "vsix"
					: options.profileMode === "default"
						? "defaultProfile"
						: options.profileMode === "custom"
							? "customProfile"
							: "unknown",
			workspaceArgumentPresent: Boolean(options.workspace || options.passthrough?.length),
			transportDiagnostics: options.enableTransportDiagnostics ? "enabled" : "disabled",
			partialCoalescing: options.enablePartialCoalescing ? "enabled" : "disabled",
		},
	})
	await writeJsonAtomic(path.join(runDir, "manifest.partial.json"), manifest)
	const writer = new EvidenceWriter({
		runDir,
		maxRecordBytes: options.maxRecordBytes ?? DEFAULTS.maxRecordBytes,
		rotationBytes: options.rotationBytes ?? DEFAULTS.rotationBytes,
		maxQueueRecords: options.maxQueueRecords ?? DEFAULTS.maxQueueRecords,
		maxRunEvidenceBytes: options.maxRunEvidenceBytes ?? DEFAULTS.maxRunEvidenceBytes,
	})
	return new EvidenceRun({
		outputRoot,
		runDir,
		manifest,
		clock,
		writer,
		makeRecord: createRecordFactory({ runId, clock, random: dependencies.random }),
	})
}

export async function recoverIncompleteRuns(outputRoot, dependencies = {}) {
	const clock = dependencies.clock ?? createClock()
	let entries
	try {
		entries = await fs.readdir(outputRoot, { withFileTypes: true })
	} catch (error) {
		if (error.code === "ENOENT") return []
		throw error
	}
	const recovered = []
	for (const entry of entries) {
		if (!entry.isDirectory() || !RUN_DIRECTORY_PATTERN.test(entry.name)) continue
		const runDir = path.join(outputRoot, entry.name)
		const partialPath = path.join(runDir, "manifest.partial.json")
		let partial
		try {
			partial = await readJsonBounded(partialPath, 256 * 1024)
		} catch (error) {
			if (error.code === "ENOENT") continue
			continue
		}
		if (!Number.isSafeInteger(partial.harnessPid) || !isValidCreationTimeUtc(partial.harnessCreationTimeUtc))
			continue
		const identity = await (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(partial.harnessPid)
		if (identity.state === "unknown") continue
		if (identity.state === "present" && identity.creationTimeUtc === partial.harnessCreationTimeUtc) continue
		const terminal = {
			...partial,
			state: "incompleteRecovered",
			captureOutcome: "incompleteRecovered",
			classification: "unknown",
			updatedUtc: clock.utc(),
			completedUtc: clock.utc(),
			operationalCleanup: "unknown",
			failure: { component: "harness", stage: "finalizing", code: "interrupted", osCode: null },
		}
		await writeJsonAtomic(path.join(runDir, "manifest.json"), terminal)
		await fs.unlink(partialPath).catch(() => {})
		recovered.push(partial.runId)
	}
	return recovered
}

async function directorySize(root, predicate = () => true) {
	await assertRetainedDirectory(root)
	let total = 0
	const entries = await fs.readdir(root, { withFileTypes: true })
	for (const entry of entries) {
		const target = path.join(root, entry.name)
		const stat = await fs.lstat(target)
		if (stat.isSymbolicLink()) {
			throw retentionError("RETENTION_UNSAFE_ENTRY", "Retention encountered a reparse point")
		}
		if (stat.isDirectory()) total += await directorySize(target, predicate)
		else if (stat.isFile() && predicate(target)) total += stat.size
	}
	return total
}

async function removeCompletedRun(outputRoot, run) {
	await assertRetainedDirectory(outputRoot)
	await assertRetainedDirectory(run.runDir)
	const outputRealPath = await fs.realpath(outputRoot)
	const runRealPath = await fs.realpath(run.runDir)
	if (path.dirname(runRealPath) !== outputRealPath || path.basename(runRealPath) !== path.basename(run.runDir)) {
		throw retentionError("RETENTION_UNSAFE_ENTRY", "Retention target escaped the evidence root")
	}
	await fs.rm(runRealPath, { recursive: true, force: false })
}

export async function applyRetention(outputRoot, options, dependencies = {}) {
	const nowMs = dependencies.nowMs ?? Date.now()
	let entries
	try {
		entries = await fs.readdir(outputRoot, { withFileTypes: true })
	} catch (error) {
		if (error.code === "ENOENT") return { pruned: 0 }
		throw error
	}
	const completed = []
	let protectedEvidenceBytes = 0
	for (const entry of entries) {
		if (!RUN_DIRECTORY_PATTERN.test(entry.name)) continue
		const runDir = path.join(outputRoot, entry.name)
		const runStat = await fs.lstat(runDir)
		if (runStat.isSymbolicLink()) {
			throw retentionError("RETENTION_UNSAFE_ENTRY", "Retention encountered a run reparse point")
		}
		if (!runStat.isDirectory()) continue
		try {
			await fs.access(path.join(runDir, "manifest.partial.json"))
			protectedEvidenceBytes += await directorySize(runDir, (file) => !file.endsWith(".heapsnapshot"))
			continue
		} catch {}
		try {
			const manifest = await readJsonBounded(path.join(runDir, "manifest.json"), 256 * 1024)
			const completedMs = Date.parse(manifest.completedUtc)
			const evidenceBytes = await directorySize(runDir, (file) => !file.endsWith(".heapsnapshot"))
			const snapshotBytes = await directorySize(runDir, (file) => file.endsWith(".heapsnapshot"))
			const snapshotDirectory = path.join(runDir, "snapshots")
			let snapshotCount = 0
			try {
				snapshotCount = (await fs.readdir(snapshotDirectory)).filter((file) =>
					file.endsWith(".heapsnapshot"),
				).length
			} catch {}
			completed.push({ runDir, completedMs, evidenceBytes, snapshotBytes, snapshotCount })
		} catch {
			protectedEvidenceBytes += await directorySize(runDir, (file) => !file.endsWith(".heapsnapshot"))
		}
	}
	if (protectedEvidenceBytes > DEFAULTS.retentionEvidenceBytes) {
		const error = new Error("Protected incomplete evidence exceeds the retention cap")
		error.code = "RETENTION_BLOCKED"
		throw error
	}
	completed.sort((left, right) => left.completedMs - right.completedMs)
	let evidenceBytes = completed.reduce((sum, run) => sum + run.evidenceBytes, protectedEvidenceBytes)
	let snapshotBytes = completed.reduce((sum, run) => sum + run.snapshotBytes, 0)
	let snapshotCount = completed.reduce((sum, run) => sum + run.snapshotCount, 0)
	let remainingRuns = completed.length
	let pruned = 0
	for (const run of completed) {
		const tooOld = !Number.isFinite(run.completedMs) || nowMs - run.completedMs > options.retentionDays * 86_400_000
		const overCaps =
			remainingRuns > options.retentionRuns ||
			evidenceBytes > DEFAULTS.retentionEvidenceBytes ||
			snapshotBytes > DEFAULTS.retentionSnapshotBytes ||
			snapshotCount > DEFAULTS.retentionSnapshots
		if (!tooOld && !overCaps) continue
		await (dependencies.removeCompletedRun ?? removeCompletedRun)(outputRoot, run)
		remainingRuns -= 1
		evidenceBytes -= run.evidenceBytes
		snapshotBytes -= run.snapshotBytes
		snapshotCount -= run.snapshotCount
		pruned += 1
	}
	return { pruned }
}

export function sanitizedFailure(component, stage, code, error) {
	return { component, stage, code, osCode: sanitizeOsError(error) }
}
