import path from "node:path"

export const SCHEMA_VERSION = 1
export const VALIDATOR_VERSION = 1

export const EXIT_CODES = Object.freeze({
	success: 0,
	usage: 2,
	preflight: 3,
	capability: 4,
	snapshot: 5,
	evidence: 6,
	monitoredProcessExited: 7,
	interrupted: 130,
})

export const DEFAULTS = Object.freeze({
	output: path.join("plans", "diagnostics"),
	rendererIntervalMs: 2_000,
	processIntervalMs: 5_000,
	heartbeatWarningMs: 5_000,
	heartbeatFailureMs: 10_000,
	heapWarningRatio: 0.7,
	heapCriticalRatio: 0.82,
	autoSnapshotSamples: 3,
	snapshotCooldownMs: 30 * 60 * 1_000,
	manifestIntervalMs: 30_000,
	flushIntervalMs: 5_000,
	fsyncIntervalMs: 30_000,
	rotationBytes: 16 * 1024 * 1024,
	maxRecordBytes: 8 * 1024,
	maxQueueRecords: 256,
	maxRunEvidenceBytes: 512 * 1024 * 1024,
	retentionRuns: 10,
	retentionDays: 14,
	retentionEvidenceBytes: 2 * 1024 * 1024 * 1024,
	retentionSnapshots: 6,
	retentionSnapshotBytes: 50 * 1024 * 1024 * 1024,
	maxSnapshotsPerRun: 3,
	httpTimeoutMs: 3_000,
	commandTimeoutMs: 5_000,
	metricTimeoutMs: 3_000,
	launchTimeoutMs: 20_000,
	processSampleTimeoutMs: 4_000,
	firstSnapshotChunkTimeoutMs: 60_000,
	snapshotInactivityTimeoutMs: 60_000,
	snapshotAbsoluteTimeoutMs: 30 * 60 * 1_000,
	validationTimeoutMs: 30 * 60 * 1_000,
	controlTimeoutMs: 30_000,
	stopSnapshotWaitMs: 30_000,
	maxHttpBytes: 64 * 1024,
	maxWebSocketMessageBytes: 32 * 1024 * 1024,
	maxPendingCdpCommands: 256,
	maxQueuedCdpEvents: 256,
	maxQueuedCdpEventBytes: 64 * 1024 * 1024,
	maxSnapshotChunkBytes: 16 * 1024 * 1024,
	maxJsonDepth: 64,
})

export const CAPTURE_MODES = Object.freeze(["launch", "attach", "process"])
export const PROFILE_MODES = Object.freeze(["isolated", "default", "custom"])
export const CAPABILITY_STATES = Object.freeze(["available", "degraded", "unavailable"])
export const SOURCES = Object.freeze(["harness", "cdp", "processSampler"])
export const CONFIDENCE = Object.freeze(["exact", "strongCandidate", "ambiguous", "unresolved"])
export const PROCESS_ROLES = Object.freeze(["browser", "renderer", "gpu", "extensionHost", "utility", "other"])

export const UNAVAILABLE_REASONS = Object.freeze([
	"unsupported",
	"notConnected",
	"notApplicable",
	"permissionDenied",
	"processExited",
	"pidReused",
	"timedOut",
	"malformedResponse",
	"ambiguousIdentity",
	"notSampled",
	"diagnosticPause",
])

export const RECORD_TYPES = Object.freeze([
	"runStarted",
	"runStopping",
	"runFinalized",
	"writerDroppedRecords",
	"targetIdentity",
	"targetCreated",
	"targetAttached",
	"targetDetached",
	"targetDestroyed",
	"targetCrashed",
	"executionContextReplaced",
	"mainFrameNavigated",
	"runtimeException",
	"rendererMemory",
	"rendererProbe",
	"heapThresholdCrossed",
	"heapDecreaseObserved",
	"heartbeatDelayed",
	"heartbeatRecovered",
	"rendererBlockedSuspected",
	"cdpConnectionOpened",
	"cdpConnectionClosed",
	"cdpCommandTimedOut",
	"processMemory",
	"processDisappeared",
	"processSampleMissed",
	"processSamplerDegraded",
	"processExited",
	"gpuProcessReplaced",
	"browserProcessExited",
	"rendererProcessExited",
	"extensionHostProcessExited",
	"gpuProcessExited",
	"snapshotStarted",
	"snapshotCompleted",
	"snapshotRejected",
	"snapshotFailed",
])

export const EVENT_STREAM_TYPES = new Set(
	RECORD_TYPES.filter((recordType) => !["rendererMemory", "rendererProbe", "processMemory"].includes(recordType)),
)

export const CRITICAL_RECORD_TYPES = new Set([
	"runStopping",
	"runFinalized",
	"heartbeatDelayed",
	"heartbeatRecovered",
	"rendererBlockedSuspected",
	"targetDetached",
	"targetDestroyed",
	"targetCrashed",
	"cdpConnectionClosed",
	"cdpCommandTimedOut",
	"processDisappeared",
	"browserProcessExited",
	"rendererProcessExited",
	"extensionHostProcessExited",
	"gpuProcessExited",
	"snapshotStarted",
	"snapshotCompleted",
	"snapshotRejected",
	"snapshotFailed",
])

export const SNAPSHOT_TRIGGER_REASONS = Object.freeze([
	"manual",
	"heapThreshold",
	"preFailureCheckpoint",
	"testFixture",
])

export const SNAPSHOT_FAILURE_CODES = Object.freeze([
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

export const ERROR_CODES = Object.freeze([
	"invalidArguments",
	"nonLoopbackEndpoint",
	"endpointMismatch",
	"listenerInspectionFailed",
	"nonLoopbackListener",
	"httpFailed",
	"httpTooLarge",
	"httpTimedOut",
	"webSocketUnavailable",
	"webSocketClosed",
	"cdpTimedOut",
	"cdpProtocolError",
	"cdpMalformedMessage",
	"methodUnavailable",
	"processSampleFailed",
	"processSampleTimedOut",
	"processProjectionUnsafe",
	"processProjectionMalformed",
	"evidenceWriteFailed",
	"controlRejected",
	"monitoredProcessExited",
	"interrupted",
	"unknownFailure",
])

export const CLASSIFICATIONS = Object.freeze([
	"rendererTerminated",
	"rendererBlockedSuspected",
	"javascriptRenderFailureSuspected",
	"navigationBridgeFailureSuspected",
	"gpuCompositorFailureSuspected",
	"extensionHostFailureSuspected",
	"browserTerminated",
	"unknown",
])

export const FIXED_EXPRESSIONS = Object.freeze({
	structuralProbe: `(() => {
		const rootPresent = document.getElementById("root") !== null;
		const acquireApiPresent = typeof globalThis.acquireVsCodeApi === "function";
		const bootstrapGlobalsCount = ["IMAGES_BASE_URI", "AUDIO_BASE_URI", "MATERIAL_ICONS_BASE_URI"]
			.reduce((count, key) => count + (Object.prototype.hasOwnProperty.call(globalThis, key) ? 1 : 0), 0);
		const ready = document.readyState;
		return {
			schemaVersion: 1,
			rootPresent,
			acquireApiPresent,
			bootstrapGlobalsCount,
			vscodeWebviewTrait: document.body?.classList.contains("vscode-body") === true,
			documentReady: ready === "loading" ? "loading" : ready === "interactive" ? "interactive" : "complete",
			domNodeCount: Math.min(document.getElementsByTagName("*").length, 1000000)
		};
	})()`,
	installProbe: `(() => {
		const key = "__zooLiveGrayScreenProbeV1";
		if (globalThis[key]?.schemaVersion === 1) return { installed: true, longTaskAvailable: globalThis[key].longTaskAvailable };
		const state = {
			schemaVersion: 1,
			timerSequence: 0,
			animationFrameSequence: 0,
			lastTimerMonotonicMs: performance.now(),
			lastFrameMonotonicMs: performance.now(),
			longTaskCount: 0,
			longTaskTotalMs: 0,
			longTaskMaxMs: 0,
			errorCount: 0,
			rejectionCount: 0,
			longTaskAvailable: false
		};
		Object.defineProperty(globalThis, key, { value: state, configurable: true });
		state.timer = setInterval(() => {
			state.timerSequence = Math.min(Number.MAX_SAFE_INTEGER, state.timerSequence + 1);
			state.lastTimerMonotonicMs = performance.now();
		}, 1000);
		const frame = () => {
			state.animationFrameSequence = Math.min(Number.MAX_SAFE_INTEGER, state.animationFrameSequence + 1);
			state.lastFrameMonotonicMs = performance.now();
			state.frame = requestAnimationFrame(frame);
		};
		state.frame = requestAnimationFrame(frame);
		addEventListener("error", () => { state.errorCount = Math.min(Number.MAX_SAFE_INTEGER, state.errorCount + 1); });
		addEventListener("unhandledrejection", () => { state.rejectionCount = Math.min(Number.MAX_SAFE_INTEGER, state.rejectionCount + 1); });
		try {
			if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
				state.longTaskAvailable = true;
				state.observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						const duration = Number.isFinite(entry.duration) ? Math.max(0, entry.duration) : 0;
						state.longTaskCount = Math.min(Number.MAX_SAFE_INTEGER, state.longTaskCount + 1);
						state.longTaskTotalMs = Math.min(Number.MAX_SAFE_INTEGER, state.longTaskTotalMs + duration);
						state.longTaskMaxMs = Math.max(state.longTaskMaxMs, duration);
					}
				});
				state.observer.observe({ entryTypes: ["longtask"] });
			}
		} catch { state.longTaskAvailable = false; }
		return { installed: true, longTaskAvailable: state.longTaskAvailable };
	})()`,
	probeSample: `(() => {
		const state = globalThis.__zooLiveGrayScreenProbeV1;
		if (state?.schemaVersion !== 1) return { available: false };
		const sample = {
			available: true,
			timerSequence: state.timerSequence,
			animationFrameSequence: state.animationFrameSequence,
			lastTimerMonotonicMs: state.lastTimerMonotonicMs,
			lastFrameMonotonicMs: state.lastFrameMonotonicMs,
			longTaskAvailable: state.longTaskAvailable,
			longTaskCount: state.longTaskCount,
			longTaskTotalMs: state.longTaskTotalMs,
			longTaskMaxMs: state.longTaskMaxMs,
			errorCount: state.errorCount,
			rejectionCount: state.rejectionCount,
			documentVisibility: document.visibilityState === "hidden" ? "hidden" : "visible",
			documentReady: document.readyState === "loading" ? "loading" : document.readyState === "interactive" ? "interactive" : "complete",
			rootPresent: document.getElementById("root") !== null,
			domNodeCount: Math.min(document.getElementsByTagName("*").length, 1000000)
		};
		state.longTaskCount = 0;
		state.longTaskTotalMs = 0;
		state.longTaskMaxMs = 0;
		return sample;
	})()`,
	performanceMemory: `(() => {
		const memory = performance.memory;
		if (!memory) return { available: false };
		return {
			available: true,
			usedJsHeapBytes: memory.usedJSHeapSize,
			totalJsHeapBytes: memory.totalJSHeapSize,
			jsHeapLimitBytes: memory.jsHeapSizeLimit
		};
	})()`,
})

export const PERFORMANCE_METRIC_MAP = Object.freeze({
	JSHeapUsedSize: "performanceJsHeapUsedBytes",
	JSHeapTotalSize: "performanceJsHeapTotalBytes",
	TaskDuration: "taskDurationSeconds",
	ScriptDuration: "scriptDurationSeconds",
	LayoutDuration: "layoutDurationSeconds",
	RecalcStyleDuration: "recalcStyleDurationSeconds",
	Nodes: "nodeCount",
	Documents: "documentCount",
	Frames: "frameCount",
	JSEventListeners: "eventListenerCount",
})

export const CDP_METHODS = new Set([
	"Target.setDiscoverTargets",
	"Target.setAutoAttach",
	"Target.getTargets",
	"Target.attachToTarget",
	"Target.detachFromTarget",
	"SystemInfo.getProcessInfo",
	"Runtime.enable",
	"Runtime.evaluate",
	"Runtime.getHeapUsage",
	"Performance.enable",
	"Performance.getMetrics",
	"Page.enable",
	"Page.setLifecycleEventsEnabled",
	"HeapProfiler.enable",
	"HeapProfiler.takeHeapSnapshot",
])

export function freezeCaptureConfig(options) {
	return Object.freeze({
		rendererIntervalMs: options.rendererIntervalMs,
		processIntervalMs: options.processIntervalMs,
		heartbeatWarningMs: options.heartbeatWarningMs,
		heartbeatFailureMs: options.heartbeatFailureMs,
		heapWarningRatio: options.heapWarningRatio,
		heapCriticalRatio: options.heapCriticalRatio,
		autoSnapshotEnabled: options.autoSnapshotEnabled,
		autoSnapshotSamples: options.autoSnapshotSamples,
		snapshotCooldownMs: options.snapshotCooldownMs,
		manifestIntervalMs: options.manifestIntervalMs,
		rotationBytes: options.rotationBytes,
		maxRecordBytes: options.maxRecordBytes,
		maxQueueRecords: options.maxQueueRecords,
		retentionRuns: options.retentionRuns,
		retentionDays: options.retentionDays,
		commandLineRoleProbe: options.commandLineRoleProbe,
	})
}
