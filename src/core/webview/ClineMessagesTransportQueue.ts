export type ClineMessagesTransportQueueOutcome = "completed" | "failed" | "disposed"

/**
 * Scalar-only hooks used by optional diagnostics. Hook failures are contained
 * by the queue and can never affect delivery or caller Promise settlement.
 */
export type ClineMessagesTransportQueueObservation = {
	onQueued?: () => void
	onSuperseded?: (replacement?: ClineMessagesTransportQueueObservation) => void
	onStarted?: (waiterCount: number) => void
	onEmitted?: (waiterCount: number) => void
	onDiscarded?: () => void
	onSettled?: (outcome: ClineMessagesTransportQueueOutcome) => void
}

export type ClineMessagesTransportQueueExecution = {
	markEmitted: () => void
}

export type ClineMessagesTransportQueueResult = {
	promise: Promise<void>
	superseded: boolean
	hardBoundaryClosed: boolean
}

type QueueWaiter = {
	resolve: () => void
	reject: (error: unknown) => void
	observation?: ClineMessagesTransportQueueObservation
}

type CoalescibleQueueEntry<TIdentity, TPayload> = {
	kind: "coalescible"
	identity: TIdentity
	payload: TPayload
	execute: (payload: TPayload, execution: ClineMessagesTransportQueueExecution) => Promise<void>
	currentObservation?: ClineMessagesTransportQueueObservation
	waiters: QueueWaiter[]
	replaceable: boolean
	started: boolean
	settled: boolean
}

type BoundaryQueueEntry = {
	kind: "boundary"
	execute: () => Promise<void>
	waiters: QueueWaiter[]
	settled: boolean
}

type QueueEntry<TIdentity, TPayload> = CoalescibleQueueEntry<TIdentity, TPayload> | BoundaryQueueEntry

function createWaiter(observation?: ClineMessagesTransportQueueObservation): {
	waiter: QueueWaiter
	promise: Promise<void>
} {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { waiter: { resolve, reject, observation }, promise }
}

/**
 * A narrow serial queue for extension-to-webview transcript operations.
 *
 * Only the newest adjacent, not-yet-started coalescible entry can replace its
 * payload. Starting an entry, observing a hard boundary, or seeing a different
 * identity closes that replacement window. In-flight work is never cancelled.
 */
export class ClineMessagesTransportQueue<TIdentity, TPayload> {
	private readonly entries: Array<QueueEntry<TIdentity, TPayload>> = []
	private readonly startGate: Promise<void>
	private replaceableEntry?: CoalescibleQueueEntry<TIdentity, TPayload>
	private activeEntry?: QueueEntry<TIdentity, TPayload>
	private draining = false
	private drainPromise: Promise<void> = Promise.resolve()
	private disposedError?: Error

	public constructor(
		private readonly sameIdentity: (left: TIdentity, right: TIdentity) => boolean,
		startGate: Promise<void> = Promise.resolve(),
	) {
		this.startGate = startGate.catch(() => undefined)
	}

	public get hasWork(): boolean {
		return this.draining || this.entries.length > 0
	}

	/** Resolves after the non-cancellable active operation has finished. */
	public waitForIdle(): Promise<void> {
		return this.drainPromise
	}

	public enqueueCoalescible(
		identity: TIdentity,
		payload: TPayload,
		execute: (payload: TPayload, execution: ClineMessagesTransportQueueExecution) => Promise<void>,
		observation?: ClineMessagesTransportQueueObservation,
	): ClineMessagesTransportQueueResult {
		const { waiter, promise } = createWaiter(observation)
		if (this.disposedError) {
			this.rejectWaiter(waiter, this.disposedError, "disposed")
			return { promise, superseded: false, hardBoundaryClosed: false }
		}

		const replaceable = this.replaceableEntry
		if (replaceable && this.sameIdentity(replaceable.identity, identity)) {
			this.notify(replaceable.currentObservation?.onSuperseded, observation)
			this.notify(observation?.onQueued)
			replaceable.payload = payload
			replaceable.execute = execute
			replaceable.currentObservation = observation
			replaceable.waiters.push(waiter)
			return { promise, superseded: true, hardBoundaryClosed: false }
		}

		const hardBoundaryClosed = this.closeReplacementWindow()
		const entry: CoalescibleQueueEntry<TIdentity, TPayload> = {
			kind: "coalescible",
			identity,
			payload,
			execute,
			currentObservation: observation,
			waiters: [waiter],
			replaceable: true,
			started: false,
			settled: false,
		}
		this.notify(observation?.onQueued)
		this.entries.push(entry)
		this.replaceableEntry = entry
		this.startDrain()
		return { promise, superseded: false, hardBoundaryClosed }
	}

	public enqueueBoundary(execute: () => Promise<void>): ClineMessagesTransportQueueResult {
		const { waiter, promise } = createWaiter()
		if (this.disposedError) {
			this.rejectWaiter(waiter, this.disposedError, "disposed")
			return { promise, superseded: false, hardBoundaryClosed: false }
		}

		const hardBoundaryClosed = this.closeReplacementWindow()
		this.entries.push({ kind: "boundary", execute, waiters: [waiter], settled: false })
		this.startDrain()
		return { promise, superseded: false, hardBoundaryClosed }
	}

	/** Closes coalescing across a post that is ordered outside this queue. */
	public markHardBoundary(): boolean {
		return this.closeReplacementWindow()
	}

	/**
	 * Rejects every caller immediately and releases every not-yet-started
	 * payload. The underlying in-flight bridge operation is allowed to finish
	 * because VS Code webview posts are not cancellable.
	 */
	public dispose(error = new Error("Cline messages transport queue disposed")): void {
		if (this.disposedError) {
			return
		}
		this.disposedError = error
		this.closeReplacementWindow()

		if (this.activeEntry) {
			this.settleEntry(this.activeEntry, "disposed", error)
		}

		for (const entry of this.entries) {
			if (entry.kind === "coalescible" && !entry.started) {
				this.notify(entry.currentObservation?.onDiscarded)
			}
			this.settleEntry(entry, "disposed", error)
		}
		this.entries.length = 0
	}

	private closeReplacementWindow(): boolean {
		if (!this.replaceableEntry) {
			return false
		}
		this.replaceableEntry.replaceable = false
		this.replaceableEntry = undefined
		return true
	}

	private startDrain(): void {
		if (!this.draining) {
			this.drainPromise = this.drain()
		}
	}

	private async drain(): Promise<void> {
		if (this.draining) {
			return
		}
		this.draining = true

		try {
			await this.startGate
			while (this.entries.length > 0) {
				const entry = this.entries.shift()
				if (!entry) {
					continue
				}
				if (entry.kind === "coalescible") {
					entry.started = true
					entry.replaceable = false
					if (this.replaceableEntry === entry) {
						this.replaceableEntry = undefined
					}
				}
				this.activeEntry = entry
				await this.runEntry(entry)
				if (this.activeEntry === entry) {
					this.activeEntry = undefined
				}
			}
		} finally {
			this.draining = false
		}
	}

	private async runEntry(entry: QueueEntry<TIdentity, TPayload>): Promise<void> {
		if (entry.settled) {
			return
		}

		try {
			if (entry.kind === "boundary") {
				await entry.execute()
			} else {
				const waiterCount = entry.waiters.length
				let emitted = false
				this.notify(entry.currentObservation?.onStarted, waiterCount)
				await entry.execute(entry.payload, {
					markEmitted: () => {
						if (emitted || entry.settled || this.disposedError) {
							return
						}
						emitted = true
						this.notify(entry.currentObservation?.onEmitted, waiterCount)
					},
				})
			}
			this.settleEntry(entry, "completed")
		} catch (error) {
			this.settleEntry(entry, "failed", error)
		}
	}

	private settleEntry(
		entry: QueueEntry<TIdentity, TPayload>,
		outcome: ClineMessagesTransportQueueOutcome,
		error?: unknown,
	): void {
		if (entry.settled) {
			return
		}
		entry.settled = true
		for (const waiter of entry.waiters) {
			if (outcome === "completed") {
				this.resolveWaiter(waiter)
			} else {
				this.rejectWaiter(waiter, error, outcome)
			}
		}
	}

	private resolveWaiter(waiter: QueueWaiter): void {
		this.notify(waiter.observation?.onSettled, "completed")
		waiter.resolve()
	}

	private rejectWaiter(
		waiter: QueueWaiter,
		error: unknown,
		outcome: Exclude<ClineMessagesTransportQueueOutcome, "completed">,
	): void {
		this.notify(waiter.observation?.onSettled, outcome)
		waiter.reject(error)
	}

	private notify<T>(callback: ((value: T) => void) | undefined, value: T): void
	private notify(callback: (() => void) | undefined): void
	private notify<T>(callback: ((value: T) => void) | (() => void) | undefined, value?: T): void {
		if (!callback) {
			return
		}
		try {
			if (value === undefined) {
				;(callback as () => void)()
			} else {
				;(callback as (argument: T) => void)(value)
			}
		} catch {
			// Diagnostics and observers must never alter transport behavior.
		}
	}
}
