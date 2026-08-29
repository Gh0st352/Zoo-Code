import { CdpCollector } from "./cdp-collector.mjs"
import { DEFAULTS, EXIT_CODES } from "./constants.mjs"
import { ControlChannel } from "./control.mjs"
import { applyRetention, createEvidenceRun, recoverIncompleteRuns, sanitizedFailure } from "./evidence.mjs"
import { cleanupOperationalState, launchVsCode, terminateDedicatedChild } from "./launch.mjs"
import { assertSafeOutputRoot } from "./path-safety.mjs"
import { ProcessSampler } from "./process-sampler.mjs"
import { createClock, generateEpochId } from "./records.mjs"
import { SnapshotCoordinator } from "./snapshot.mjs"

function classify(state) {
	if (state.browserExited) return "browserTerminated"
	if (state.targetCrashed || state.targetDestroyed || state.rendererExited) return "rendererTerminated"
	if (state.rendererBlocked) return "rendererBlockedSuspected"
	if (state.navigationFailure) return "navigationBridgeFailureSuspected"
	if (state.gpuExited && !state.rendererBlocked) return "gpuCompositorFailureSuspected"
	if (state.extensionHostExited) return "extensionHostFailureSuspected"
	if (state.exceptionCount > 0) return "javascriptRenderFailureSuspected"
	return "unknown"
}

export class CaptureOrchestrator {
	constructor(options, dependencies = {}) {
		this.options = options
		this.dependencies = dependencies
		this.clock = dependencies.clock ?? createClock()
		this.random = dependencies.random
		this.run = null
		this.control = null
		this.cdp = null
		this.processSampler = null
		this.snapshot = null
		this.launch = null
		this.rootPid = options.pid ?? options.expectedRootPid ?? null
		this.browserEpoch = null
		this.stopping = false
		this.stopReason = null
		this.stopSnapshotPolicy = "wait"
		this.stopPromiseResolve = null
		this.stopPromise = new Promise((resolve) => {
			this.stopPromiseResolve = resolve
		})
		this.manifestTimer = null
		this.durationTimer = null
		this.pendingWrites = new Set()
		this.asyncFailure = null
		this.state = {
			browserExited: false,
			rendererExited: false,
			targetCrashed: false,
			targetDestroyed: false,
			rendererBlocked: false,
			navigationFailure: false,
			gpuExited: false,
			extensionHostExited: false,
			exceptionCount: 0,
		}
	}

	async writeRecord(recordType, data, context = {}) {
		if (recordType === "targetCrashed") this.state.targetCrashed = true
		if (recordType === "targetDestroyed" && context.selectedRenderer === true) this.state.targetDestroyed = true
		if (recordType === "rendererBlockedSuspected") this.state.rendererBlocked = true
		if (recordType === "runtimeException") this.state.exceptionCount += 1
		const target = context.target
		const record = this.run.makeRecord({
			source:
				recordType.startsWith("process") || recordType.endsWith("ProcessExited")
					? "processSampler"
					: (context.source ?? "cdp"),
			recordType,
			capabilityState: context.capabilityState ?? "available",
			browserEpoch: this.browserEpoch,
			processEpoch: context.processEpoch ?? null,
			cdpConnectionEpoch: this.cdp?.connectionEpoch ?? null,
			targetEpoch: target?.epoch ?? null,
			rendererEpoch: target?.rendererEpoch ?? null,
			data,
		})
		await this.run.writer.write(record)
	}

	queueRecord(recordType, data, context = {}) {
		const pending = this.writeRecord(recordType, data, context)
		this.pendingWrites.add(pending)
		void pending
			.catch((error) => {
				if (!this.asyncFailure) this.asyncFailure = error
				this.requestStop("captureFailure")
			})
			.finally(() => this.pendingWrites.delete(pending))
	}

	queueManifestHeartbeat(patch = {}) {
		const pending = this.run.heartbeat(patch)
		this.pendingWrites.add(pending)
		void pending
			.catch((error) => {
				if (!this.asyncFailure) this.asyncFailure = error
				this.requestStop("captureFailure")
			})
			.finally(() => this.pendingWrites.delete(pending))
	}

	async waitForPendingWrites() {
		while (this.pendingWrites.size > 0) await Promise.allSettled([...this.pendingWrites])
		if (this.asyncFailure) throw this.asyncFailure
	}

	async setCapability(name, state, reason) {
		const capabilities = { ...this.run.manifest.capabilities, [name]: { state, reason } }
		this.run.manifest.capabilities = capabilities
	}

	async setupProcessSampler(rootPid) {
		if (!rootPid) return
		this.rootPid = rootPid
		this.browserEpoch = generateEpochId(this.random)
		this.processSampler = this.dependencies.processSamplerFactory
			? this.dependencies.processSamplerFactory(rootPid)
			: new ProcessSampler({
					rootPid,
					intervalMs: this.options.processIntervalMs,
					commandLineRoleProbe: this.options.commandLineRoleProbe,
					clock: this.clock,
					random: this.random,
				})
		this.processSampler.on("sample", (sample) => {
			const data = {
				pid: sample.pid,
				parentPid: sample.parentPid,
				...(sample.creationTimeUtc ? { creationTimeUtc: sample.creationTimeUtc } : {}),
				role: sample.role,
				confidence: sample.confidence,
				...(sample.workingSetBytes !== undefined
					? { workingSetBytes: sample.workingSetBytes, semantic: "windowsWorkingSet" }
					: {}),
				...(sample.privateBytes !== undefined ? { privateBytes: sample.privateBytes } : {}),
				...(sample.pagedBytes !== undefined ? { pagedBytes: sample.pagedBytes } : {}),
				...(sample.cpuTimeMs !== undefined ? { cpuTimeMs: sample.cpuTimeMs } : {}),
				...(sample.threadCount !== undefined ? { threadCount: sample.threadCount } : {}),
				...(sample.handleCount !== undefined ? { handleCount: sample.handleCount } : {}),
				present: sample.present,
				...(sample.systemAvailableMemoryBytes !== undefined
					? { systemAvailableMemoryBytes: sample.systemAvailableMemoryBytes }
					: {}),
				unavailable: sample.unavailable,
			}
			this.queueRecord("processMemory", data, { processEpoch: sample.processEpoch })
		})
		this.processSampler.on("disappeared", (sample) => {
			if (sample.role === "renderer") this.state.rendererExited = true
			if (sample.role === "gpu") this.state.gpuExited = true
			if (sample.role === "extensionHost") this.state.extensionHostExited = true
			const recordType =
				sample.role === "renderer"
					? "rendererProcessExited"
					: sample.role === "gpu"
						? "gpuProcessExited"
						: sample.role === "extensionHost"
							? "extensionHostProcessExited"
							: "processDisappeared"
			const data =
				recordType === "processDisappeared"
					? { pid: sample.pid, role: sample.role, confidence: sample.confidence, reason: "processExited" }
					: { pid: sample.pid, confidence: sample.confidence, reason: "processExited" }
			this.queueRecord(recordType, data, { processEpoch: sample.processEpoch })
		})
		this.processSampler.on("missed", (event) =>
			this.queueRecord(
				"processSampleMissed",
				{ code: event.code, consecutiveMisses: event.consecutiveMisses, retryable: true },
				{ capabilityState: "degraded" },
			),
		)
		this.processSampler.on("degraded", (event) =>
			this.queueRecord(
				"processSamplerDegraded",
				{ code: event.code, consecutiveMisses: event.consecutiveMisses, retryable: true },
				{ capabilityState: "degraded" },
			),
		)
		this.processSampler.on("dropped", (event) =>
			this.queueRecord(
				"writerDroppedRecords",
				{ droppedCount: event.droppedCount },
				{ source: "processSampler", capabilityState: "degraded" },
			),
		)
		this.processSampler.on("rootExited", ({ pid, reason }) => {
			this.state.browserExited = true
			this.queueRecord("browserProcessExited", { pid, reason })
			this.requestStop("monitoredProcessExited")
		})
		this.processSampler.start()
	}

	async start() {
		this.options.output = await assertSafeOutputRoot(this.options.output, {
			forbiddenRoots: [this.options.userDataDir, this.options.extensionsDir],
			create: !(this.options.command === "launch" && this.options.dryRun),
		})
		if (this.options.command === "launch" && this.options.dryRun) {
			const launch = await (this.dependencies.launchVsCode ?? launchVsCode)(this.options, "aaaaaaaaaaaaaaaaaaaa")
			return { dryRun: true, plan: launch.plan }
		}
		await recoverIncompleteRuns(this.options.output, { clock: this.clock })
		await applyRetention(this.options.output, this.options)
		this.run = await createEvidenceRun(this.options, {
			clock: this.clock,
			random: this.random,
			harnessCreationTimeUtc: this.dependencies.harnessCreationTimeUtc,
		})
		await this.run.updateState("preflight")
		this.control = await ControlChannel.create({
			runId: this.run.manifest.runId,
			harnessCreationTimeUtc: this.run.manifest.harnessCreationTimeUtc,
			onRequest: (request) => this.handleControl(request),
		})
		this.control.start()
		this.signalHandler = (signal) => this.requestStop(signal === "SIGINT" ? "signal" : "signal")
		process.on("zoo-live-capture-stop", this.signalHandler)
		if (this.options.command === "launch") {
			await this.run.updateState("launching")
			this.launch = await (this.dependencies.launchVsCode ?? launchVsCode)(this.options, this.run.manifest.runId)
			this.options.cdpPort = this.launch.cdpPort
			await this.setupProcessSampler(this.launch.rootPid)
			this.launch.child.once("exit", () => {
				this.state.browserExited = true
				this.requestStop("monitoredProcessExited")
			})
		} else if (this.options.command === "process") {
			await this.run.updateState("attaching")
			await this.setupProcessSampler(this.options.pid)
		} else {
			await this.run.updateState("attaching")
		}

		if (this.options.command !== "process") {
			this.cdp = this.dependencies.cdpCollectorFactory
				? this.dependencies.cdpCollectorFactory()
				: new CdpCollector({
						options: this.options,
						clock: this.clock,
						random: this.random,
						onRecord: (type, data, context) => this.writeRecord(type, data, context),
						onCapability: (name, state, reason) => this.setCapability(name, state, reason),
						onAutoSnapshot: () => this.snapshot?.request({ reason: "heapThreshold" }),
					})
			const connection = await this.cdp.connect()
			if (
				this.options.expectedRootPid &&
				connection.browserPid &&
				connection.browserPid !== this.options.expectedRootPid
			) {
				throw Object.assign(new Error("CDP browser PID does not match --expected-root-pid"), {
					code: "BROWSER_PID_MISMATCH",
				})
			}
			if (!this.processSampler)
				await this.setupProcessSampler(connection.browserPid ?? this.options.expectedRootPid)
			if (!this.processSampler)
				throw Object.assign(new Error("Browser PID is unavailable"), { code: "BROWSER_PID_UNAVAILABLE" })
			this.snapshot = new SnapshotCoordinator({
				run: this.run,
				cdp: this.cdp,
				processSampler: this.processSampler,
				clock: this.clock,
				options: this.options,
				onRecord: (type, data) => this.writeRecord(type, data),
				onManifest: (patch) => this.run.heartbeat(patch),
			})
		}
		await this.run.writeProvenance("capabilities", this.run.manifest.capabilities)
		if (this.cdp) await this.run.writeProvenance("targets", { targets: this.cdp.sanitizedTargets() })
		await this.run.updateState("capturing")
		await this.writeRecord("runStarted", { status: "started" }, { source: "harness" })
		this.manifestTimer = setInterval(() => this.queueManifestHeartbeat(), this.options.manifestIntervalMs)
		this.manifestTimer.unref?.()
		if (this.options.durationMs !== null) {
			this.durationTimer = setTimeout(() => this.requestStop("durationElapsed"), this.options.durationMs)
			this.durationTimer.unref?.()
		}
		await this.stopPromise
		return this.finalize()
	}

	async handleControl(request) {
		if (request.type === "stop") {
			this.stopSnapshotPolicy = request.snapshotPolicy
			this.requestStop("controlRequest")
			return { accepted: true }
		}
		if (!this.snapshot) throw Object.assign(new Error("Snapshots require CDP"), { code: "cdpUnavailable" })
		return this.snapshot.request(request)
	}

	requestStop(reason) {
		if (this.stopping) return
		this.stopping = true
		this.stopReason = reason
		this.stopPromiseResolve()
	}

	async finalize() {
		if (this.signalHandler) process.off("zoo-live-capture-stop", this.signalHandler)
		clearInterval(this.manifestTimer)
		clearTimeout(this.durationTimer)
		await this.run.updateState("stopping")
		await this.writeRecord(
			"runStopping",
			{ reason: this.stopReason, diagnosticPause: Boolean(this.snapshot?.active) },
			{ source: "harness" },
		)
		await this.snapshot?.stop(this.stopSnapshotPolicy)
		await this.cdp?.stop()
		await this.processSampler?.stop({ finalSample: true })
		await this.waitForPendingWrites()
		if (this.options.command === "launch" && this.launch?.child) {
			await (this.dependencies.terminateDedicatedChild ?? terminateDedicatedChild)(this.launch.child)
		}
		await this.control?.close({ removeOperationalState: false })
		const classification = classify(this.state)
		const outcome =
			this.stopReason === "monitoredProcessExited"
				? "monitoredProcessExited"
				: this.stopReason === "signal"
					? "interrupted"
					: "stopped"
		await this.writeRecord("runFinalized", { outcome, classification }, { source: "harness" })
		const operationalCleanup = await cleanupOperationalState(this.control?.operationalDir, this.options.profileMode)
		await this.run.finalize({ outcome, classification, operationalCleanup })
		return {
			exitCode:
				outcome === "monitoredProcessExited"
					? EXIT_CODES.monitoredProcessExited
					: outcome === "interrupted"
						? EXIT_CODES.interrupted
						: EXIT_CODES.success,
			runDir: this.run.runDir,
			outcome,
			classification,
		}
	}

	async fail(error) {
		if (this.signalHandler) process.off("zoo-live-capture-stop", this.signalHandler)
		this.requestStop("captureFailure")
		clearInterval(this.manifestTimer)
		clearTimeout(this.durationTimer)
		await this.snapshot?.stop("abort").catch(() => {})
		await this.cdp?.stop().catch(() => {})
		await this.processSampler?.stop({ finalSample: false }).catch(() => {})
		if (this.options.command === "launch" && this.launch?.child) {
			await (this.dependencies.terminateDedicatedChild ?? terminateDedicatedChild)(this.launch.child).catch(
				() => {},
			)
		}
		await this.control?.close({ removeOperationalState: false }).catch(() => {})
		if (this.run && !this.run.finalized) {
			await this.run.finalize({
				outcome: "failed",
				classification: classify(this.state),
				operationalCleanup: "unknown",
				failure: sanitizedFailure("harness", "finalizing", error.code ?? "unknownFailure", error),
			})
		}
		await cleanupOperationalState(this.control?.operationalDir, this.options.profileMode).catch(() => {})
		throw error
	}
}

export async function runCapture(options, dependencies = {}) {
	const orchestrator = new CaptureOrchestrator(options, dependencies)
	try {
		return await orchestrator.start()
	} catch (error) {
		return orchestrator.fail(error)
	}
}
