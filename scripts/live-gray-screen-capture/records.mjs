import { randomBytes } from "node:crypto"

import {
	CAPABILITY_STATES,
	CLASSIFICATIONS,
	CONFIDENCE,
	ERROR_CODES,
	PROCESS_ROLES,
	RECORD_TYPES,
	SCHEMA_VERSION,
	SNAPSHOT_FAILURE_CODES,
	SNAPSHOT_TRIGGER_REASONS,
	SOURCES,
	UNAVAILABLE_REASONS,
} from "./constants.mjs"

const RUN_ID_PATTERN = /^[a-z2-7]{20}$/
const EPOCH_PATTERN = /^e-[a-z2-7]{16}$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const FIXED_ENUMS = Object.freeze({
	capabilityState: CAPABILITY_STATES,
	confidence: CONFIDENCE,
	correlationConfidence: CONFIDENCE,
	role: PROCESS_ROLES,
	semantic: ["windowsWorkingSet"],
	reason: [
		...SNAPSHOT_TRIGGER_REASONS,
		...SNAPSHOT_FAILURE_CODES,
		...UNAVAILABLE_REASONS,
		"signal",
		"controlRequest",
		"durationElapsed",
		"monitoredProcessExited",
		"webSocketClose",
		"sessionDetached",
		"targetDestroyed",
		"targetCrash",
		"navigation",
		"executionContextReset",
		"thresholdWarning",
		"thresholdCritical",
		"collectionConsistentDecrease",
		"normalStop",
		"captureFailure",
	],
	code: [...ERROR_CODES, ...SNAPSHOT_FAILURE_CODES],
	category: ["exception", "unhandledRejection", "unknownRuntimeFailure"],
	documentReady: ["loading", "interactive", "complete", "unavailable"],
	documentVisibility: ["visible", "hidden", "unavailable"],
	targetType: ["page", "webview", "iframe", "worker", "other"],
	identityState: ["exact", "strongCandidate", "ambiguous", "unresolved"],
	threshold: ["warning", "critical"],
	stage: ["preflight", "locking", "streaming", "flushing", "validating", "promoting", "finalizing"],
	status: ["started", "completed", "rejected", "failed", "recovered", "available", "unavailable"],
	outcome: ["completed", "stopped", "monitoredProcessExited", "failed", "interrupted", "incompleteRecovered"],
	classification: CLASSIFICATIONS,
})

const BOOLEAN_FIELDS = new Set([
	"present",
	"rootPresent",
	"acquireApiPresent",
	"vscodeWebviewTrait",
	"strongCandidate",
	"uncaught",
	"longTaskAvailable",
	"overrideCooldown",
	"allowUnresponsiveAttempt",
	"privateArtifact",
	"retryable",
	"processExists",
	"processSampleContinued",
	"heartbeatProgressed",
	"diagnosticPause",
])

const INTEGER_FIELDS = new Set([
	"targetOrdinal",
	"pid",
	"parentPid",
	"attemptOrdinal",
	"timerSequence",
	"animationFrameSequence",
	"longTaskCount",
	"errorCount",
	"rejectionCount",
	"domNodeCount",
	"nodeCount",
	"documentCount",
	"frameCount",
	"eventListenerCount",
	"threadCount",
	"handleCount",
	"droppedCount",
	"consecutiveMisses",
	"navigationGeneration",
	"sampleCount",
	"snapshotCount",
	"chunkCount",
])

const NUMBER_FIELDS = new Set([
	"usedJsHeapBytes",
	"totalJsHeapBytes",
	"jsHeapLimitBytes",
	"runtimeUsedHeapBytes",
	"runtimeTotalHeapBytes",
	"embedderHeapUsedBytes",
	"backingStorageBytes",
	"performanceJsHeapUsedBytes",
	"performanceJsHeapTotalBytes",
	"workingSetBytes",
	"privateBytes",
	"pagedBytes",
	"cpuTimeMs",
	"systemAvailableMemoryBytes",
	"heapRatio",
	"heapSlopeBytesPerSecond",
	"taskDurationSeconds",
	"scriptDurationSeconds",
	"layoutDurationSeconds",
	"recalcStyleDurationSeconds",
	"longTaskTotalMs",
	"longTaskMaxMs",
	"lastTimerMonotonicMs",
	"lastFrameMonotonicMs",
	"heartbeatDelayMs",
	"durationMs",
	"byteCount",
	"estimatedSnapshotBytes",
	"requiredDiskBytes",
	"availableDiskBytes",
	"requiredPhysicalMemoryBytes",
	"availablePhysicalMemoryBytes",
	"requiredV8HeadroomBytes",
	"availableV8HeadroomBytes",
])

const STRING_FIELDS = new Set(["creationTimeUtc", "osCode"])
const EPOCH_FIELDS = new Set(["browserEpoch", "processEpoch", "cdpConnectionEpoch", "targetEpoch", "rendererEpoch"])

const RECORD_DATA_FIELDS = Object.freeze({
	runStarted: ["status"],
	runStopping: ["reason", "diagnosticPause"],
	runFinalized: ["outcome", "classification"],
	writerDroppedRecords: ["droppedCount"],
	targetIdentity: [
		"targetOrdinal",
		"targetType",
		"rootPresent",
		"acquireApiPresent",
		"bootstrapGlobalsCount",
		"vscodeWebviewTrait",
		"strongCandidate",
		"identityState",
		"documentReady",
		"domNodeCount",
	],
	targetCreated: ["targetOrdinal", "targetType"],
	targetAttached: ["targetOrdinal"],
	targetDetached: ["targetOrdinal", "reason"],
	targetDestroyed: ["targetOrdinal", "reason"],
	targetCrashed: ["targetOrdinal", "reason"],
	executionContextReplaced: ["targetOrdinal", "reason", "navigationGeneration"],
	mainFrameNavigated: ["targetOrdinal", "reason", "navigationGeneration"],
	runtimeException: ["targetOrdinal", "category", "uncaught"],
	rendererMemory: [
		"targetOrdinal",
		"usedJsHeapBytes",
		"totalJsHeapBytes",
		"jsHeapLimitBytes",
		"runtimeUsedHeapBytes",
		"runtimeTotalHeapBytes",
		"embedderHeapUsedBytes",
		"backingStorageBytes",
		"performanceJsHeapUsedBytes",
		"performanceJsHeapTotalBytes",
		"taskDurationSeconds",
		"scriptDurationSeconds",
		"layoutDurationSeconds",
		"recalcStyleDurationSeconds",
		"nodeCount",
		"documentCount",
		"frameCount",
		"eventListenerCount",
		"heapRatio",
		"heapSlopeBytesPerSecond",
		"unavailable",
	],
	rendererProbe: [
		"targetOrdinal",
		"timerSequence",
		"animationFrameSequence",
		"lastTimerMonotonicMs",
		"lastFrameMonotonicMs",
		"longTaskAvailable",
		"longTaskCount",
		"longTaskTotalMs",
		"longTaskMaxMs",
		"errorCount",
		"rejectionCount",
		"documentVisibility",
		"documentReady",
		"rootPresent",
		"domNodeCount",
		"unavailable",
	],
	heapThresholdCrossed: ["targetOrdinal", "threshold", "heapRatio", "sampleCount"],
	heapDecreaseObserved: ["targetOrdinal", "reason", "usedJsHeapBytes", "durationMs"],
	heartbeatDelayed: ["targetOrdinal", "heartbeatDelayMs", "diagnosticPause"],
	heartbeatRecovered: ["targetOrdinal", "heartbeatDelayMs", "sampleCount"],
	rendererBlockedSuspected: ["targetOrdinal", "heartbeatDelayMs", "diagnosticPause"],
	cdpConnectionOpened: ["status"],
	cdpConnectionClosed: ["reason", "retryable"],
	cdpCommandTimedOut: ["code", "retryable"],
	processMemory: [
		"pid",
		"parentPid",
		"creationTimeUtc",
		"role",
		"confidence",
		"workingSetBytes",
		"semantic",
		"privateBytes",
		"pagedBytes",
		"cpuTimeMs",
		"threadCount",
		"handleCount",
		"present",
		"systemAvailableMemoryBytes",
		"unavailable",
	],
	processDisappeared: ["pid", "role", "confidence", "reason"],
	processSampleMissed: ["code", "consecutiveMisses", "retryable"],
	processSamplerDegraded: ["code", "consecutiveMisses", "retryable"],
	gpuProcessReplaced: ["pid", "parentPid", "confidence"],
	browserProcessExited: ["pid", "reason"],
	rendererProcessExited: ["pid", "confidence", "reason"],
	extensionHostProcessExited: ["pid", "confidence", "reason"],
	gpuProcessExited: ["pid", "confidence", "reason"],
	snapshotStarted: ["attemptOrdinal", "targetOrdinal", "reason", "overrideCooldown", "privateArtifact"],
	snapshotCompleted: [
		"attemptOrdinal",
		"targetOrdinal",
		"reason",
		"byteCount",
		"nodeCount",
		"edgeCount",
		"durationMs",
		"privateArtifact",
	],
	snapshotRejected: ["attemptOrdinal", "targetOrdinal", "reason", "stage", "overrideCooldown"],
	snapshotFailed: ["attemptOrdinal", "targetOrdinal", "reason", "stage", "byteCount", "privateArtifact"],
})

function base32(bytes) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	let bits = 0
	let value = 0
	let output = ""
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			output += alphabet[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
	return output
}

export function generateRunId(random = randomBytes) {
	return base32(random(13)).slice(0, 20)
}

export function generateEpochId(random = randomBytes) {
	return `e-${base32(random(10)).slice(0, 16)}`
}

export function createClock() {
	return {
		utc: () => new Date().toISOString(),
		monotonicNs: () => process.hrtime.bigint(),
		monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
	}
}

function assertExactKeys(value, allowed, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new TypeError(`${label} contains forbidden field ${key}`)
	}
}

function validateNumber(value, key, integer = false) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
		throw new TypeError(`${key} must be a finite non-negative safe number`)
	}
	if (integer && !Number.isInteger(value)) throw new TypeError(`${key} must be an integer`)
	return value
}

function validateDataField(key, value) {
	if (value === undefined) throw new TypeError(`${key} may not be undefined`)
	if (BOOLEAN_FIELDS.has(key)) {
		if (typeof value !== "boolean") throw new TypeError(`${key} must be boolean`)
		return value
	}
	if (INTEGER_FIELDS.has(key)) return validateNumber(value, key, true)
	if (NUMBER_FIELDS.has(key)) return validateNumber(value, key)
	if (key === "bootstrapGlobalsCount" || key === "edgeCount") return validateNumber(value, key, true)
	if (key === "unavailable") {
		if (!Array.isArray(value) || value.length > 32 || value.some((item) => !UNAVAILABLE_REASONS.includes(item))) {
			throw new TypeError("unavailable contains an unsupported reason")
		}
		return [...new Set(value)]
	}
	if (Object.hasOwn(FIXED_ENUMS, key)) {
		if (!FIXED_ENUMS[key].includes(value)) throw new TypeError(`${key} contains an unsupported enum value`)
		return value
	}
	if (STRING_FIELDS.has(key)) {
		if (typeof value !== "string" || value.length > 64) throw new TypeError(`${key} must be a bounded string`)
		if (key === "creationTimeUtc" && !ISO_UTC_PATTERN.test(value))
			throw new TypeError("creationTimeUtc must be UTC")
		if (key === "osCode" && !/^[A-Z0-9_]{1,32}$/.test(value)) throw new TypeError("osCode is not allowlisted")
		return value
	}
	throw new TypeError(`No validator exists for data field ${key}`)
}

export function createRecordFactory({ runId, clock = createClock(), random = randomBytes }) {
	if (!RUN_ID_PATTERN.test(runId)) throw new TypeError("Invalid run ID")
	let sequence = 0
	return function makeRecord({
		source,
		recordType,
		capabilityState = "available",
		data,
		browserEpoch = null,
		processEpoch = null,
		cdpConnectionEpoch = null,
		targetEpoch = null,
		rendererEpoch = null,
	}) {
		if (!SOURCES.includes(source)) throw new TypeError("Invalid record source")
		if (!RECORD_TYPES.includes(recordType)) throw new TypeError("Invalid record type")
		if (!CAPABILITY_STATES.includes(capabilityState)) throw new TypeError("Invalid capability state")
		const allowedFields = RECORD_DATA_FIELDS[recordType]
		assertExactKeys(data, new Set(allowedFields), `${recordType}.data`)
		const cleanData = {}
		for (const key of allowedFields) {
			if (Object.hasOwn(data, key)) cleanData[key] = validateDataField(key, data[key])
		}
		for (const [key, value] of Object.entries({
			browserEpoch,
			processEpoch,
			cdpConnectionEpoch,
			targetEpoch,
			rendererEpoch,
		})) {
			if (value !== null && !EPOCH_PATTERN.test(value)) throw new TypeError(`Invalid ${key}`)
		}
		sequence += 1
		return {
			schemaVersion: SCHEMA_VERSION,
			runId,
			recordSequence: sequence,
			utc: clock.utc(),
			monotonicNs: clock.monotonicNs().toString(),
			source,
			recordType,
			browserEpoch,
			processEpoch,
			cdpConnectionEpoch,
			targetEpoch,
			rendererEpoch,
			capabilityState,
			data: cleanData,
		}
	}
}

export function sanitizeOsError(error) {
	const osCode = error && typeof error === "object" && typeof error.code === "string" ? error.code : null
	return /^[A-Z0-9_]{1,32}$/.test(osCode ?? "") ? osCode : null
}

export function sanitizeVersion(version) {
	const result = {}
	if (typeof version?.Browser === "string" && /^[A-Za-z0-9 ._+\-/]{1,96}$/.test(version.Browser)) {
		result.browserProduct = version.Browser
	}
	if (typeof version?.["Protocol-Version"] === "string" && /^\d{1,3}\.\d{1,3}$/.test(version["Protocol-Version"])) {
		result.protocolVersion = version["Protocol-Version"]
	}
	return result
}

export function isGeneratedRunId(value) {
	return typeof value === "string" && RUN_ID_PATTERN.test(value)
}

export function isGeneratedEpoch(value) {
	return typeof value === "string" && EPOCH_PATTERN.test(value)
}

export function assertClassification(value) {
	if (!CLASSIFICATIONS.includes(value)) throw new TypeError("Invalid classification")
	return value
}
