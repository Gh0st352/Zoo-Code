export const CLINE_MESSAGES_TRANSPORT_DIAGNOSTICS_ENV = "ROO_CODE_TRANSCRIPT_TRANSPORT_DIAGNOSTICS"

const DEFAULT_RECENT_OPERATION_LIMIT = 64
const MAX_RECENT_OPERATION_LIMIT = 256

export type ClineMessagesTransportOperationKind = "append" | "update-partial" | "update-final" | "snapshot"
export type ClineMessagesTransportDropReason = "generation" | "focus"
export type ClineMessagesTransportOperationOutcome = "completed" | "dropped" | "failed"

export type EstimatedSerializedWeight = {
	characters: number
	bytes: number
}

export type ClineMessagesTransportProcessMemory = {
	rssBytes: number
	heapTotalBytes: number
	heapUsedBytes: number
	externalBytes: number
	arrayBuffersBytes: number
}

export type ClineMessagesTransportOperationSample = {
	kind: ClineMessagesTransportOperationKind
	sequence: number
	estimatedCharacters: number
	estimatedBytes: number
	queueWaitMs: number
	operationDurationMs: number
	cloneDurationMs: number
	outcome: ClineMessagesTransportOperationOutcome
	dropReason?: ClineMessagesTransportDropReason
}

type ClineMessagesTransportKindCounters = {
	enqueued: number
	completed: number
	dropped: number
	failed: number
	estimatedCharacters: number
	estimatedBytes: number
}

export type ClineMessagesTransportDiagnosticsSnapshot = {
	pending: {
		operations: number
		estimatedCharacters: number
		estimatedBytes: number
		bridgePosts: number
	}
	highWater: {
		operations: number
		estimatedCharacters: number
		estimatedBytes: number
		bridgePosts: number
	}
	coalescing: {
		pendingOperations: number
		pendingEstimatedCharacters: number
		pendingEstimatedBytes: number
		pendingWaiters: number
		highWaterOperations: number
		highWaterEstimatedCharacters: number
		highWaterEstimatedBytes: number
		highWaterWaiters: number
	}
	totals: {
		enqueued: number
		started: number
		completed: number
		dropped: number
		failed: number
		cloneFailures: number
		weightEstimationFailures: number
		estimatedCharacters: number
		estimatedBytes: number
		cloneDurationMs: number
		maxCloneDurationMs: number
		queueWaitMs: number
		maxQueueWaitMs: number
		operationDurationMs: number
		maxOperationDurationMs: number
		bridgePostsStarted: number
		bridgePostsCompleted: number
		bridgePostsDropped: number
		bridgePostsFailed: number
		bridgeDurationMs: number
		maxBridgeDurationMs: number
		generationDrops: number
		focusDrops: number
		coalescingOffered: number
		coalescingSuperseded: number
		coalescingEmitted: number
		coalescingHardBoundaryFlushes: number
		coalescingFailClosedSkips: number
		coalescingWaitersSettled: number
		coalescingWaitersRejected: number
		coalescingMaxWaitersPerEmission: number
		coalescingEstimatedAvoidedCharacters: number
		coalescingEstimatedAvoidedBytes: number
	}
	byKind: Record<ClineMessagesTransportOperationKind, ClineMessagesTransportKindCounters>
	recentOperations: ClineMessagesTransportOperationSample[]
	processMemory?: ClineMessagesTransportProcessMemory
}

export type ClineMessagesTransportHighWaterEvent = {
	kind: ClineMessagesTransportOperationKind
	sequence: number
	pendingOperations: number
	pendingEstimatedCharacters: number
	pendingEstimatedBytes: number
	processMemory?: ClineMessagesTransportProcessMemory
}

export type ClineMessagesTransportDiagnosticsOptions = {
	maxRecentOperations?: number
	now?: () => number
	readProcessMemory?: () => ClineMessagesTransportProcessMemory
	estimateSerializedWeight?: (value: unknown) => EstimatedSerializedWeight
	onHighWater?: (event: ClineMessagesTransportHighWaterEvent) => void
}

export type ClineMessagesTransportDiagnosticOperation = {
	readonly owner: symbol
	readonly epoch: number
	readonly kind: ClineMessagesTransportOperationKind
	readonly sequence: number
	readonly estimatedCharacters: number
	readonly estimatedBytes: number
	readonly cloneStartedAt: number
	cloneDurationMs: number
	enqueuedAt: number
	startedAt: number
	dropReason?: ClineMessagesTransportDropReason
	settled: boolean
}

export type ClineMessagesTransportCoalescingObservation = {
	readonly owner: symbol
	readonly epoch: number
	weight: EstimatedSerializedWeight
	pending: boolean
}

type ClineMessagesTransportDiagnosticBridgePost = {
	readonly owner: symbol
	readonly epoch: number
	readonly startedAt: number
	settled: boolean
}

type MutableDiagnosticsState = Omit<
	ClineMessagesTransportDiagnosticsSnapshot,
	"byKind" | "recentOperations" | "processMemory"
> & {
	byKind: Record<ClineMessagesTransportOperationKind, ClineMessagesTransportKindCounters>
}

function createKindCounters(): Record<ClineMessagesTransportOperationKind, ClineMessagesTransportKindCounters> {
	return {
		append: { enqueued: 0, completed: 0, dropped: 0, failed: 0, estimatedCharacters: 0, estimatedBytes: 0 },
		"update-partial": {
			enqueued: 0,
			completed: 0,
			dropped: 0,
			failed: 0,
			estimatedCharacters: 0,
			estimatedBytes: 0,
		},
		"update-final": {
			enqueued: 0,
			completed: 0,
			dropped: 0,
			failed: 0,
			estimatedCharacters: 0,
			estimatedBytes: 0,
		},
		snapshot: { enqueued: 0, completed: 0, dropped: 0, failed: 0, estimatedCharacters: 0, estimatedBytes: 0 },
	}
}

function createState(): MutableDiagnosticsState {
	return {
		pending: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0, bridgePosts: 0 },
		highWater: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0, bridgePosts: 0 },
		coalescing: {
			pendingOperations: 0,
			pendingEstimatedCharacters: 0,
			pendingEstimatedBytes: 0,
			pendingWaiters: 0,
			highWaterOperations: 0,
			highWaterEstimatedCharacters: 0,
			highWaterEstimatedBytes: 0,
			highWaterWaiters: 0,
		},
		totals: {
			enqueued: 0,
			started: 0,
			completed: 0,
			dropped: 0,
			failed: 0,
			cloneFailures: 0,
			weightEstimationFailures: 0,
			estimatedCharacters: 0,
			estimatedBytes: 0,
			cloneDurationMs: 0,
			maxCloneDurationMs: 0,
			queueWaitMs: 0,
			maxQueueWaitMs: 0,
			operationDurationMs: 0,
			maxOperationDurationMs: 0,
			bridgePostsStarted: 0,
			bridgePostsCompleted: 0,
			bridgePostsDropped: 0,
			bridgePostsFailed: 0,
			bridgeDurationMs: 0,
			maxBridgeDurationMs: 0,
			generationDrops: 0,
			focusDrops: 0,
			coalescingOffered: 0,
			coalescingSuperseded: 0,
			coalescingEmitted: 0,
			coalescingHardBoundaryFlushes: 0,
			coalescingFailClosedSkips: 0,
			coalescingWaitersSettled: 0,
			coalescingWaitersRejected: 0,
			coalescingMaxWaitersPerEmission: 0,
			coalescingEstimatedAvoidedCharacters: 0,
			coalescingEstimatedAvoidedBytes: 0,
		},
		byKind: createKindCounters(),
	}
}

function defaultReadProcessMemory(): ClineMessagesTransportProcessMemory {
	const memory = process.memoryUsage()
	return {
		rssBytes: memory.rss,
		heapTotalBytes: memory.heapTotal,
		heapUsedBytes: memory.heapUsed,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers,
	}
}

function normalizeMetric(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0
	}
	return Math.min(value, Number.MAX_SAFE_INTEGER)
}

function addMetric(current: number, amount: number): number {
	return Math.min(current + normalizeMetric(amount), Number.MAX_SAFE_INTEGER)
}

function subtractMetric(current: number, amount: number): number {
	return Math.max(0, current - normalizeMetric(amount))
}

function estimateJsonStringWeight(value: string): EstimatedSerializedWeight {
	let characters = 2
	let bytes = 2

	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)

		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			characters += 2
			bytes += 2
			continue
		}
		if (code <= 0x1f) {
			characters += 6
			bytes += 6
			continue
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				characters += 2
				bytes += 4
				index++
				continue
			}
			characters += 6
			bytes += 6
			continue
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			characters += 6
			bytes += 6
			continue
		}

		characters++
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
	}

	return { characters, bytes }
}

/**
 * Estimates JSON character and UTF-8 byte weight without materializing a JSON
 * string. Repeated/cyclic object references are represented by a small scalar
 * placeholder because the VS Code bridge uses structured clone rather than JSON.
 */
export function estimateSerializedWeight(value: unknown): EstimatedSerializedWeight {
	const seen = new WeakSet<object>()

	const visit = (current: unknown, arrayItem: boolean): EstimatedSerializedWeight | undefined => {
		if (current === null) {
			return { characters: 4, bytes: 4 }
		}

		switch (typeof current) {
			case "string":
				return estimateJsonStringWeight(current)
			case "boolean":
				return current ? { characters: 4, bytes: 4 } : { characters: 5, bytes: 5 }
			case "number": {
				const serialized = Number.isFinite(current) ? String(current) : "null"
				return { characters: serialized.length, bytes: serialized.length }
			}
			case "bigint":
			case "function":
			case "symbol":
			case "undefined":
				return arrayItem ? { characters: 4, bytes: 4 } : undefined
			case "object":
				break
		}

		if (seen.has(current)) {
			return { characters: 4, bytes: 4 }
		}
		seen.add(current)

		if (Array.isArray(current)) {
			let characters = 2
			let bytes = 2
			for (let index = 0; index < current.length; index++) {
				if (index > 0) {
					characters++
					bytes++
				}
				const itemWeight = visit(current[index], true) ?? { characters: 4, bytes: 4 }
				characters = addMetric(characters, itemWeight.characters)
				bytes = addMetric(bytes, itemWeight.bytes)
			}
			return { characters, bytes }
		}

		let characters = 2
		let bytes = 2
		let propertyCount = 0
		const record = current as Record<string, unknown>
		for (const key in record) {
			if (!Object.prototype.hasOwnProperty.call(current, key)) {
				continue
			}
			const itemWeight = visit(record[key], false)
			if (!itemWeight) {
				continue
			}
			if (propertyCount > 0) {
				characters++
				bytes++
			}
			const keyWeight = estimateJsonStringWeight(key)
			characters = addMetric(characters, keyWeight.characters + 1 + itemWeight.characters)
			bytes = addMetric(bytes, keyWeight.bytes + 1 + itemWeight.bytes)
			propertyCount++
		}
		return { characters, bytes }
	}

	return visit(value, false) ?? { characters: 0, bytes: 0 }
}

export class ClineMessagesTransportDiagnostics {
	private readonly owner = Symbol("clineMessagesTransportDiagnostics")
	private readonly now: () => number
	private readonly readProcessMemory: () => ClineMessagesTransportProcessMemory
	private readonly weightEstimator: (value: unknown) => EstimatedSerializedWeight
	private readonly onHighWater?: (event: ClineMessagesTransportHighWaterEvent) => void
	private readonly recentOperationLimit: number
	private recentOperations: Array<ClineMessagesTransportOperationSample | undefined>
	private nextRecentOperationIndex = 0
	private recentOperationCount = 0
	private nextHighWaterNotification = 1
	private epoch = 0
	private state = createState()
	private disposed = false

	public constructor(options: ClineMessagesTransportDiagnosticsOptions = {}) {
		this.now = options.now ?? (() => performance.now())
		this.readProcessMemory = options.readProcessMemory ?? defaultReadProcessMemory
		this.weightEstimator = options.estimateSerializedWeight ?? estimateSerializedWeight
		this.onHighWater = options.onHighWater
		this.recentOperationLimit = Math.min(
			Math.max(0, Math.trunc(options.maxRecentOperations ?? DEFAULT_RECENT_OPERATION_LIMIT)),
			MAX_RECENT_OPERATION_LIMIT,
		)
		this.recentOperations = new Array(this.recentOperationLimit)
	}

	public beginOperation(
		kind: ClineMessagesTransportOperationKind,
		sequence: number,
		payload: unknown,
	): ClineMessagesTransportDiagnosticOperation | undefined {
		if (this.disposed) {
			return undefined
		}

		const weight = this.estimateWeight(payload)

		return {
			owner: this.owner,
			epoch: this.epoch,
			kind,
			sequence,
			estimatedCharacters: normalizeMetric(weight.characters),
			estimatedBytes: normalizeMetric(weight.bytes),
			cloneStartedAt: this.now(),
			cloneDurationMs: 0,
			enqueuedAt: 0,
			startedAt: 0,
			settled: false,
		}
	}

	public markEnqueued(operation: ClineMessagesTransportDiagnosticOperation | undefined): void {
		if (!this.ownsCurrent(operation)) {
			return
		}

		const now = this.now()
		operation.cloneDurationMs = Math.max(0, now - operation.cloneStartedAt)
		operation.enqueuedAt = now

		const { pending, highWater, totals } = this.state
		pending.operations++
		pending.estimatedCharacters = addMetric(pending.estimatedCharacters, operation.estimatedCharacters)
		pending.estimatedBytes = addMetric(pending.estimatedBytes, operation.estimatedBytes)
		totals.enqueued++
		totals.estimatedCharacters = addMetric(totals.estimatedCharacters, operation.estimatedCharacters)
		totals.estimatedBytes = addMetric(totals.estimatedBytes, operation.estimatedBytes)
		totals.cloneDurationMs = addMetric(totals.cloneDurationMs, operation.cloneDurationMs)
		totals.maxCloneDurationMs = Math.max(totals.maxCloneDurationMs, operation.cloneDurationMs)

		const kindCounters = this.state.byKind[operation.kind]
		kindCounters.enqueued++
		kindCounters.estimatedCharacters = addMetric(kindCounters.estimatedCharacters, operation.estimatedCharacters)
		kindCounters.estimatedBytes = addMetric(kindCounters.estimatedBytes, operation.estimatedBytes)

		highWater.operations = Math.max(highWater.operations, pending.operations)
		highWater.estimatedCharacters = Math.max(highWater.estimatedCharacters, pending.estimatedCharacters)
		highWater.estimatedBytes = Math.max(highWater.estimatedBytes, pending.estimatedBytes)

		if (this.onHighWater && highWater.operations >= this.nextHighWaterNotification) {
			while (this.nextHighWaterNotification <= highWater.operations) {
				this.nextHighWaterNotification *= 2
			}
			try {
				this.onHighWater({
					kind: operation.kind,
					sequence: operation.sequence,
					pendingOperations: pending.operations,
					pendingEstimatedCharacters: pending.estimatedCharacters,
					pendingEstimatedBytes: pending.estimatedBytes,
					processMemory: this.tryReadProcessMemory(),
				})
			} catch {
				// Diagnostic emission must never alter transcript delivery.
			}
		}
	}

	public markCloneFailed(operation: ClineMessagesTransportDiagnosticOperation | undefined): void {
		if (!this.ownsCurrent(operation)) {
			return
		}
		this.state.totals.cloneFailures++
		this.state.byKind[operation.kind].failed++
	}

	public markStarted(operation: ClineMessagesTransportDiagnosticOperation | undefined): void {
		if (!this.ownsCurrent(operation) || operation.startedAt > 0) {
			return
		}
		operation.startedAt = this.now()
		const queueWaitMs = Math.max(0, operation.startedAt - operation.enqueuedAt)
		this.state.totals.started++
		this.state.totals.queueWaitMs = addMetric(this.state.totals.queueWaitMs, queueWaitMs)
		this.state.totals.maxQueueWaitMs = Math.max(this.state.totals.maxQueueWaitMs, queueWaitMs)
	}

	public markDropped(
		operation: ClineMessagesTransportDiagnosticOperation | undefined,
		reason: ClineMessagesTransportDropReason,
	): void {
		if (!this.ownsCurrent(operation) || operation.dropReason) {
			return
		}
		operation.dropReason = reason
	}

	public markSettled(operation: ClineMessagesTransportDiagnosticOperation | undefined, failed = false): void {
		if (!this.ownsCurrent(operation) || operation.settled) {
			return
		}
		operation.settled = true

		const settledAt = this.now()
		const queueWaitMs = operation.startedAt > 0 ? Math.max(0, operation.startedAt - operation.enqueuedAt) : 0
		const operationDurationMs = operation.startedAt > 0 ? Math.max(0, settledAt - operation.startedAt) : 0
		const outcome: ClineMessagesTransportOperationOutcome = failed
			? "failed"
			: operation.dropReason
				? "dropped"
				: "completed"

		this.state.pending.operations = Math.max(0, this.state.pending.operations - 1)
		this.state.pending.estimatedCharacters = subtractMetric(
			this.state.pending.estimatedCharacters,
			operation.estimatedCharacters,
		)
		this.state.pending.estimatedBytes = subtractMetric(this.state.pending.estimatedBytes, operation.estimatedBytes)
		this.state.totals.operationDurationMs = addMetric(this.state.totals.operationDurationMs, operationDurationMs)
		this.state.totals.maxOperationDurationMs = Math.max(
			this.state.totals.maxOperationDurationMs,
			operationDurationMs,
		)

		const kindCounters = this.state.byKind[operation.kind]
		if (outcome === "failed") {
			this.state.totals.failed++
			kindCounters.failed++
		} else if (outcome === "dropped") {
			this.state.totals.dropped++
			kindCounters.dropped++
			if (operation.dropReason === "generation") {
				this.state.totals.generationDrops++
			} else {
				this.state.totals.focusDrops++
			}
		} else {
			this.state.totals.completed++
			kindCounters.completed++
		}

		this.pushRecentOperation({
			kind: operation.kind,
			sequence: operation.sequence,
			estimatedCharacters: operation.estimatedCharacters,
			estimatedBytes: operation.estimatedBytes,
			queueWaitMs,
			operationDurationMs,
			cloneDurationMs: operation.cloneDurationMs,
			outcome,
			dropReason: operation.dropReason,
		})
	}

	public startBridgePost(): ClineMessagesTransportDiagnosticBridgePost | undefined {
		if (this.disposed) {
			return undefined
		}
		this.state.pending.bridgePosts++
		this.state.highWater.bridgePosts = Math.max(this.state.highWater.bridgePosts, this.state.pending.bridgePosts)
		this.state.totals.bridgePostsStarted++
		return { owner: this.owner, epoch: this.epoch, startedAt: this.now(), settled: false }
	}

	public markBridgePostSettled(
		post: ClineMessagesTransportDiagnosticBridgePost | undefined,
		outcome: "completed" | "dropped" | "failed",
	): void {
		if (!this.ownsCurrent(post) || post.settled) {
			return
		}
		post.settled = true
		const durationMs = Math.max(0, this.now() - post.startedAt)
		this.state.pending.bridgePosts = Math.max(0, this.state.pending.bridgePosts - 1)
		this.state.totals.bridgeDurationMs = addMetric(this.state.totals.bridgeDurationMs, durationMs)
		this.state.totals.maxBridgeDurationMs = Math.max(this.state.totals.maxBridgeDurationMs, durationMs)
		if (outcome === "completed") {
			this.state.totals.bridgePostsCompleted++
		} else if (outcome === "dropped") {
			this.state.totals.bridgePostsDropped++
		} else {
			this.state.totals.bridgePostsFailed++
		}
	}

	public estimateWeight(value: unknown): EstimatedSerializedWeight {
		if (this.disposed) {
			return { characters: 0, bytes: 0 }
		}
		try {
			const weight = this.weightEstimator(value)
			return {
				characters: normalizeMetric(weight.characters),
				bytes: normalizeMetric(weight.bytes),
			}
		} catch {
			this.state.totals.weightEstimationFailures++
			return { characters: 0, bytes: 0 }
		}
	}

	public beginCoalescingObservation(
		weight: EstimatedSerializedWeight,
	): ClineMessagesTransportCoalescingObservation | undefined {
		if (this.disposed) {
			return undefined
		}
		return {
			owner: this.owner,
			epoch: this.epoch,
			weight: {
				characters: normalizeMetric(weight.characters),
				bytes: normalizeMetric(weight.bytes),
			},
			pending: false,
		}
	}

	public markCoalescingOffered(observation: ClineMessagesTransportCoalescingObservation | undefined): void {
		if (this.ownsCurrent(observation)) {
			this.state.totals.coalescingOffered++
			this.state.coalescing.pendingWaiters++
			this.state.coalescing.highWaterWaiters = Math.max(
				this.state.coalescing.highWaterWaiters,
				this.state.coalescing.pendingWaiters,
			)
		}
	}

	public markCoalescingPendingQueued(observation: ClineMessagesTransportCoalescingObservation | undefined): void {
		if (!this.ownsCurrent(observation) || observation.pending) {
			return
		}
		observation.pending = true
		const coalescing = this.state.coalescing
		coalescing.pendingOperations++
		coalescing.pendingEstimatedCharacters = addMetric(
			coalescing.pendingEstimatedCharacters,
			observation.weight.characters,
		)
		coalescing.pendingEstimatedBytes = addMetric(coalescing.pendingEstimatedBytes, observation.weight.bytes)
		coalescing.highWaterOperations = Math.max(coalescing.highWaterOperations, coalescing.pendingOperations)
		coalescing.highWaterEstimatedCharacters = Math.max(
			coalescing.highWaterEstimatedCharacters,
			coalescing.pendingEstimatedCharacters,
		)
		coalescing.highWaterEstimatedBytes = Math.max(
			coalescing.highWaterEstimatedBytes,
			coalescing.pendingEstimatedBytes,
		)
	}

	public markCoalescingPendingStarted(observation: ClineMessagesTransportCoalescingObservation | undefined): void {
		this.markCoalescingPendingRemoved(observation)
	}

	public markCoalescingPendingReplaced(
		previous: ClineMessagesTransportCoalescingObservation | undefined,
		replacement: ClineMessagesTransportCoalescingObservation | undefined,
	): void {
		if (!this.ownsCurrent(previous) || !previous.pending) {
			return
		}
		const coalescing = this.state.coalescing
		coalescing.pendingEstimatedCharacters = subtractMetric(
			coalescing.pendingEstimatedCharacters,
			previous.weight.characters,
		)
		coalescing.pendingEstimatedBytes = subtractMetric(coalescing.pendingEstimatedBytes, previous.weight.bytes)
		previous.pending = false
		if (this.ownsCurrent(replacement) && !replacement.pending) {
			replacement.pending = true
			coalescing.pendingEstimatedCharacters = addMetric(
				coalescing.pendingEstimatedCharacters,
				replacement.weight.characters,
			)
			coalescing.pendingEstimatedBytes = addMetric(coalescing.pendingEstimatedBytes, replacement.weight.bytes)
			coalescing.highWaterEstimatedCharacters = Math.max(
				coalescing.highWaterEstimatedCharacters,
				coalescing.pendingEstimatedCharacters,
			)
			coalescing.highWaterEstimatedBytes = Math.max(
				coalescing.highWaterEstimatedBytes,
				coalescing.pendingEstimatedBytes,
			)
		} else {
			coalescing.pendingOperations = Math.max(0, coalescing.pendingOperations - 1)
		}
	}

	public markCoalescingPendingRemoved(observation: ClineMessagesTransportCoalescingObservation | undefined): void {
		if (!this.ownsCurrent(observation) || !observation.pending) {
			return
		}
		observation.pending = false
		const coalescing = this.state.coalescing
		coalescing.pendingOperations = Math.max(0, coalescing.pendingOperations - 1)
		coalescing.pendingEstimatedCharacters = subtractMetric(
			coalescing.pendingEstimatedCharacters,
			observation.weight.characters,
		)
		coalescing.pendingEstimatedBytes = subtractMetric(coalescing.pendingEstimatedBytes, observation.weight.bytes)
	}

	public markCoalescingSuperseded(observation: ClineMessagesTransportCoalescingObservation | undefined): void {
		if (!this.ownsCurrent(observation)) {
			return
		}
		this.state.totals.coalescingSuperseded++
		this.state.totals.coalescingEstimatedAvoidedCharacters = addMetric(
			this.state.totals.coalescingEstimatedAvoidedCharacters,
			observation.weight.characters,
		)
		this.state.totals.coalescingEstimatedAvoidedBytes = addMetric(
			this.state.totals.coalescingEstimatedAvoidedBytes,
			observation.weight.bytes,
		)
	}

	public markCoalescingEmitted(
		observation: ClineMessagesTransportCoalescingObservation | undefined,
		waiterCount: number,
	): void {
		if (!this.ownsCurrent(observation)) {
			return
		}
		this.state.totals.coalescingEmitted++
		this.state.totals.coalescingMaxWaitersPerEmission = Math.max(
			this.state.totals.coalescingMaxWaitersPerEmission,
			normalizeMetric(waiterCount),
		)
	}

	public markCoalescingHardBoundaryFlush(): void {
		if (!this.disposed) {
			this.state.totals.coalescingHardBoundaryFlushes++
		}
	}

	public markCoalescingFailClosedSkip(): void {
		if (!this.disposed) {
			this.state.totals.coalescingFailClosedSkips++
		}
	}

	public markCoalescingWaiterSettled(
		observation: ClineMessagesTransportCoalescingObservation | undefined,
		rejected: boolean,
	): void {
		if (!this.ownsCurrent(observation)) {
			return
		}
		if (rejected) {
			this.state.totals.coalescingWaitersRejected++
		} else {
			this.state.totals.coalescingWaitersSettled++
		}
		this.state.coalescing.pendingWaiters = Math.max(0, this.state.coalescing.pendingWaiters - 1)
	}

	public snapshot(): ClineMessagesTransportDiagnosticsSnapshot {
		return {
			pending: { ...this.state.pending },
			highWater: { ...this.state.highWater },
			coalescing: { ...this.state.coalescing },
			totals: { ...this.state.totals },
			byKind: {
				append: { ...this.state.byKind.append },
				"update-partial": { ...this.state.byKind["update-partial"] },
				"update-final": { ...this.state.byKind["update-final"] },
				snapshot: { ...this.state.byKind.snapshot },
			},
			recentOperations: this.getRecentOperations(),
			processMemory: this.tryReadProcessMemory(),
		}
	}

	public reset(): void {
		if (this.disposed) {
			return
		}
		this.epoch++
		this.state = createState()
		this.recentOperations.fill(undefined)
		this.nextRecentOperationIndex = 0
		this.recentOperationCount = 0
		this.nextHighWaterNotification = 1
	}

	public dispose(): void {
		if (this.disposed) {
			return
		}
		this.reset()
		this.disposed = true
		this.recentOperations = []
	}

	private ownsCurrent(
		observation:
			| ClineMessagesTransportDiagnosticOperation
			| ClineMessagesTransportDiagnosticBridgePost
			| ClineMessagesTransportCoalescingObservation
			| undefined,
	): observation is ClineMessagesTransportDiagnosticOperation &
		ClineMessagesTransportDiagnosticBridgePost &
		ClineMessagesTransportCoalescingObservation {
		return Boolean(
			observation && !this.disposed && observation.owner === this.owner && observation.epoch === this.epoch,
		)
	}

	private pushRecentOperation(sample: ClineMessagesTransportOperationSample): void {
		if (this.recentOperationLimit === 0) {
			return
		}
		this.recentOperations[this.nextRecentOperationIndex] = sample
		this.nextRecentOperationIndex = (this.nextRecentOperationIndex + 1) % this.recentOperationLimit
		this.recentOperationCount = Math.min(this.recentOperationCount + 1, this.recentOperationLimit)
	}

	private getRecentOperations(): ClineMessagesTransportOperationSample[] {
		const samples: ClineMessagesTransportOperationSample[] = []
		const firstIndex = this.recentOperationCount < this.recentOperationLimit ? 0 : this.nextRecentOperationIndex

		for (let offset = 0; offset < this.recentOperationCount; offset++) {
			const sample = this.recentOperations[(firstIndex + offset) % this.recentOperationLimit]
			if (sample) {
				samples.push({ ...sample })
			}
		}
		return samples
	}

	private tryReadProcessMemory(): ClineMessagesTransportProcessMemory | undefined {
		try {
			const memory = this.readProcessMemory()
			return {
				rssBytes: normalizeMetric(memory.rssBytes),
				heapTotalBytes: normalizeMetric(memory.heapTotalBytes),
				heapUsedBytes: normalizeMetric(memory.heapUsedBytes),
				externalBytes: normalizeMetric(memory.externalBytes),
				arrayBuffersBytes: normalizeMetric(memory.arrayBuffersBytes),
			}
		} catch {
			return undefined
		}
	}
}

export function isClineMessagesTransportDiagnosticsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[CLINE_MESSAGES_TRANSPORT_DIAGNOSTICS_ENV] === "1"
}

export function formatClineMessagesTransportHighWater(event: ClineMessagesTransportHighWaterEvent): string {
	const memory = event.processMemory
		? ` rssBytes=${event.processMemory.rssBytes} heapUsedBytes=${event.processMemory.heapUsedBytes}`
		: ""
	return (
		`[clineMessages] queue high-water kind=${event.kind} sequence=${event.sequence}` +
		` pendingOperations=${event.pendingOperations}` +
		` pendingEstimatedCharacters=${event.pendingEstimatedCharacters}` +
		` pendingEstimatedBytes=${event.pendingEstimatedBytes}${memory}`
	)
}
