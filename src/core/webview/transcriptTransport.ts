import type { ClineMessage, ExtensionMessage } from "@roo-code/types"

export type TranscriptRequest = {
	kind: "append" | "update" | "snapshot"
	taskId: string | undefined
	generation?: number
	bumpSeq?: boolean
}

export type TranscriptJob = {
	id: number
	generation: number
	taskId: string | undefined
	seq: number
	kind: TranscriptRequest["kind"]
	total: number
	/** Snapshot identity is absent on delta descriptors. */
	snapshotId?: string
}

export type TranscriptFrame = {
	job: TranscriptJob
	phase: "append" | "update" | "start" | "chunk" | "end"
	/** Exact captured-payload range for chunks; both values are zero for other phases. */
	start: number
	count: number
}

/** Payloads and Promise resolvers deliberately live outside the pure protocol state. */
export type TranscriptTransportState = {
	generation: number
	nextJobId: number
	nextSnapshotId: number
	sequences: ReadonlyMap<string, number>
	chunkSize: number
	queue: readonly TranscriptJob[]
	active?: { job: TranscriptJob; position: number }
	inFlight?: TranscriptFrame
}

export type TranscriptAction =
	| { type: "enqueue"; request: TranscriptRequest; total: number; focusedTaskId: string | undefined }
	| { type: "invalidate" }
	| { type: "forget-task"; taskId: string }
	| { type: "pump"; focusedTaskId: string | undefined }
	| { type: "settle"; success: boolean }

export type TranscriptTransition = {
	state: TranscriptTransportState
	accepted?: TranscriptJob
	post?: TranscriptFrame
	/** Drop all owned payload references, including an invalidated snapshot's unsent suffix. */
	release: number[]
	/** Active physical sends settle only at their actual completion boundary. */
	settle: Array<{ id: number; failed?: boolean }>
}

export function createTranscriptTransportState(chunkSize = 200): TranscriptTransportState {
	if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
		throw new Error("Transcript chunk size must be a positive safe integer")
	}
	return { generation: 0, nextJobId: 0, nextSnapshotId: 0, sequences: new Map(), chunkSize, queue: [] }
}

export function isTranscriptRequestCurrent(
	state: TranscriptTransportState,
	request: TranscriptRequest,
	focusedTaskId: string | undefined,
): boolean {
	return (
		(request.generation ?? state.generation) === state.generation &&
		request.taskId === focusedTaskId &&
		(request.kind === "snapshot" || request.taskId !== undefined)
	)
}

/** Shared by the production driver and the exhaustive bounded explorer. No I/O or mutation. */
export function reduceTranscriptTransport(
	state: TranscriptTransportState,
	action: TranscriptAction,
): TranscriptTransition {
	const result: TranscriptTransition = { state, release: [], settle: [] }
	const discard = (job: TranscriptJob) => {
		result.release.push(job.id)
		if (state.inFlight?.job.id !== job.id) result.settle.push({ id: job.id })
	}
	switch (action.type) {
		case "enqueue": {
			const { request, total, focusedTaskId } = action
			if (!isTranscriptRequestCurrent(state, request, focusedTaskId)) return result
			const sequences = new Map(state.sequences)
			const seq = request.taskId
				? (sequences.get(request.taskId) ?? 0) + (request.kind !== "snapshot" || request.bumpSeq ? 1 : 0)
				: 0
			if (request.taskId) sequences.set(request.taskId, seq)
			const nextSnapshotId = state.nextSnapshotId + (request.kind === "snapshot" ? 1 : 0)
			const job: TranscriptJob = {
				id: state.nextJobId + 1,
				generation: state.generation,
				taskId: request.taskId,
				seq,
				kind: request.kind,
				total,
				...(request.kind === "snapshot" ? { snapshotId: `${request.taskId ?? "none"}:${nextSnapshotId}` } : {}),
			}
			result.accepted = job
			result.state = { ...state, sequences, nextSnapshotId, nextJobId: job.id, queue: [...state.queue, job] }
			return result
		}
		case "invalidate":
			state.queue.forEach(discard)
			if (state.active) discard(state.active.job)
			// Never reset inFlight: an already invoked physical send cannot be unsent.
			result.state = { ...state, generation: state.generation + 1, queue: [], active: undefined }
			return result
		case "forget-task": {
			const sequences = new Map(state.sequences)
			sequences.delete(action.taskId)
			result.state = { ...state, sequences }
			return result
		}
		case "pump": {
			if (state.inFlight) return result
			let active = state.active
			const queue = [...state.queue]
			while (active || queue.length) {
				active ??= { job: queue.shift()!, position: 0 }
				const { job, position } = active
				if (job.generation !== state.generation || job.taskId !== action.focusedTaskId) {
					discard(job)
					active = undefined
					continue
				}
				const chunks = Math.ceil(job.total / state.chunkSize)
				const phase =
					job.kind !== "snapshot" ? job.kind : position === 0 ? "start" : position > chunks ? "end" : "chunk"
				const start = phase === "chunk" ? (position - 1) * state.chunkSize : 0
				const frame: TranscriptFrame = {
					job,
					phase,
					start,
					count: phase === "chunk" ? Math.min(state.chunkSize, job.total - start) : 0,
				}
				result.post = frame
				result.state = { ...state, queue, active, inFlight: frame }
				return result
			}
			result.state = { ...state, queue, active }
			return result
		}
		case "settle": {
			if (!state.inFlight) return result
			const { job, phase } = state.inFlight
			const finished = !action.success || !state.active || phase === "end" || job.kind !== "snapshot"
			if (finished) {
				result.release.push(job.id)
				result.settle.push({ id: job.id, failed: !action.success })
			}
			result.state = {
				...state,
				inFlight: undefined,
				active: finished ? undefined : { job, position: state.active!.position + 1 },
			}
			return result
		}
	}
}

export function transcriptFrameMessage(frame: TranscriptFrame, messages: readonly ClineMessage[]): ExtensionMessage {
	const { job, phase } = frame
	const common = { taskId: job.taskId, clineMessagesSeq: job.seq }
	if (phase === "append" || phase === "update") {
		return {
			...common,
			type: phase === "append" ? "clineMessageAppended" : "clineMessageUpdated",
			clineMessage: messages[0],
		}
	}
	if (phase === "chunk") {
		return {
			...common,
			type: "clineMessagesSnapshotChunk",
			snapshotId: job.snapshotId,
			snapshotStartIndex: frame.start,
			clineMessages: messages.slice(frame.start, frame.start + frame.count),
		}
	}
	return {
		...common,
		type: phase === "start" ? "clineMessagesSnapshotStart" : "clineMessagesSnapshotEnd",
		snapshotId: job.snapshotId,
		snapshotTotal: job.total,
	}
}

/** One driver owns all physical transcript sends, even across repeated invalidations. */
export class TranscriptTransport {
	private state = createTranscriptTransportState()
	private readonly payloads = new Map<number, readonly ClineMessage[]>()
	private readonly callers = new Map<number, { resolve: () => void; reject: (error: unknown) => void }>()

	constructor(
		private readonly focusedTaskId: () => string | undefined,
		private readonly postMessage: (message: ExtensionMessage) => Promise<void>,
		private readonly onError: (error: unknown) => void,
	) {}

	get generation(): number {
		return this.state.generation
	}

	getSequence(taskId: string | undefined): number {
		// Allow absent scopes in the read-only view; writers still require string task IDs.
		const sequences: ReadonlyMap<string | undefined, number> = this.state.sequences
		return sequences.get(taskId) ?? 0
	}

	forgetTask(taskId: string): void {
		this.apply({ type: "forget-task", taskId })
	}

	invalidate(): number {
		this.apply({ type: "invalidate" })
		return this.generation
	}

	enqueue(request: TranscriptRequest, messages: readonly ClineMessage[]): Promise<void> {
		// Guard before deep cloning (and allocating a sequence/ID). A delayed focus sync
		// must not traverse a large, already-obsolete transcript.
		const capturedRequest = { ...request, generation: request.generation ?? this.generation }
		if (!isTranscriptRequestCurrent(this.state, capturedRequest, this.focusedTaskId())) return Promise.resolve()
		// Task mutates message objects AND nested fields while posts are queued. Capture
		// the complete value now, together with its sequence, not at physical-send time.
		const payload = structuredClone(messages)
		const { accepted } = this.apply({
			type: "enqueue",
			request: capturedRequest,
			total: payload.length,
			focusedTaskId: this.focusedTaskId(),
		})
		if (!accepted) return Promise.resolve()
		this.payloads.set(accepted.id, payload)
		const promise = new Promise<void>((resolve, reject) => this.callers.set(accepted.id, { resolve, reject }))
		this.drain()
		return promise
	}

	private apply(action: TranscriptAction, error?: unknown): TranscriptTransition {
		const transition = reduceTranscriptTransport(this.state, action)
		this.state = transition.state
		for (const id of transition.release) this.payloads.delete(id)
		for (const { id, failed } of transition.settle) {
			// Admission registers before drain. The reducer settles each caller exactly once,
			// retaining a physical-send caller across invalidations until its send settles.
			const caller = this.callers.get(id)!
			this.callers.delete(id)
			if (failed) caller.reject(error)
			else caller.resolve()
		}
		return transition
	}

	private drain(): void {
		const { post } = this.apply({ type: "pump", focusedTaskId: this.focusedTaskId() })
		if (post) void this.send(post)
	}

	private async send(frame: TranscriptFrame): Promise<void> {
		try {
			// Do not retain the full payload in this async frame. Invalidation can release
			// the unsent snapshot suffix while only this physical message remains held.
			await this.postMessage(transcriptFrameMessage(frame, this.payloads.get(frame.job.id)!))
			this.apply({ type: "settle", success: true })
		} catch (error) {
			this.onError(error)
			this.apply({ type: "settle", success: false }, error)
		}
		this.drain()
	}
}
