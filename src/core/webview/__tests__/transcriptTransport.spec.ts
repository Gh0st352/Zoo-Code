import type { ClineMessage, ExtensionMessage } from "@roo-code/types"
import {
	createTranscriptTransportState,
	reduceTranscriptTransport,
	transcriptFrameMessage,
	TranscriptTransport,
	type TranscriptFrame,
} from "../transcriptTransport"
import {
	checkTranscriptTransportModel,
	exploreTranscriptTransport,
	TRANSPORT_ACTIONS,
	TRANSPORT_LANDMARKS,
	TRANSPORT_MUTATIONS,
	TRANSPORT_SCENARIOS,
} from "./transcriptTransport.model"

describe("transcript transport bounded model", () => {
	test("exhausts all scenarios, actions and landmarks and rejects every mutant", () => {
		const result = checkTranscriptTransportModel()
		expect(result.results).toHaveLength(TRANSPORT_SCENARIOS.length)
		expect(result.actions).toEqual([...TRANSPORT_ACTIONS].sort())
		expect(result.landmarks).toEqual(Object.keys(TRANSPORT_LANDMARKS).sort())
		expect(result.counterexamples).toHaveLength(TRANSPORT_MUTATIONS.length)
	})

	test("fails closed on depth and state truncation", () => {
		expect(() =>
			exploreTranscriptTransport(TRANSPORT_SCENARIOS[0], undefined, { depth: 0, states: 30_000 }),
		).toThrow("depth 0 truncation")
		expect(() => exploreTranscriptTransport(TRANSPORT_SCENARIOS[0], undefined, { depth: 40, states: 1 })).toThrow(
			"state budget 1 exceeded",
		)
	})

	test("produces deterministic shortest counterexamples", () => {
		const mutation = TRANSPORT_MUTATIONS.find(({ name }) => name === "reset-promise-barrier")!
		const first = exploreTranscriptTransport(TRANSPORT_SCENARIOS[0], mutation.reduce)
		const second = exploreTranscriptTransport(TRANSPORT_SCENARIOS[0], mutation.reduce)
		expect(first.witness).toEqual(second.witness)
		expect(first.witness?.map(({ event }) => event)).toEqual([
			"initial",
			"producer:snapshot",
			"pump",
			"controller:resync",
			"pump",
		])
	})
})

describe("transcript transport reducer", () => {
	test.each([true, false])("ignores settlement without a physical send (success=%s)", (success) => {
		const state = createTranscriptTransportState()
		const transition = reduceTranscriptTransport(state, { type: "settle", success })
		expect(transition).toEqual({ state, release: [], settle: [] })
		expect(transition.state).toBe(state)
	})

	test.each(["queued", "active"] as const)("discards a stale-generation %s job before sending", (location) => {
		const admitted = reduceTranscriptTransport(createTranscriptTransportState(2), {
			type: "enqueue",
			request: { kind: "snapshot", taskId: "a" },
			total: 3,
			focusedTaskId: "a",
		})
		let state = admitted.state
		if (location === "active") {
			state = reduceTranscriptTransport(state, { type: "pump", focusedTaskId: "a" }).state
			state = reduceTranscriptTransport(state, { type: "settle", success: true }).state
		}
		// Adversarial reducer input: normal invalidation also releases this work. Keep
		// the pre-send guard defensive if stale ownership ever reaches this boundary.
		state = { ...state, generation: state.generation + 1 }
		const current = reduceTranscriptTransport(state, {
			type: "enqueue",
			request: { kind: "append", taskId: "a" },
			total: 1,
			focusedTaskId: "a",
		})

		const transition = reduceTranscriptTransport(current.state, { type: "pump", focusedTaskId: "a" })

		expect(transition.release).toEqual([admitted.accepted!.id])
		expect(transition.settle).toEqual([{ id: admitted.accepted!.id }])
		expect(transition.post).toEqual({ job: current.accepted, phase: "append", start: 0, count: 0 })
		expect(transition.state.queue).toEqual([])
		expect(transition.state.active).toEqual({ job: current.accepted, position: 0 })
	})

	test.each([
		{ total: 0, chunks: [] },
		{ total: 1, chunks: [{ start: 0, count: 1 }] },
		{ total: 2, chunks: [{ start: 0, count: 2 }] },
		{
			total: 3,
			chunks: [
				{ start: 0, count: 2 },
				{ start: 2, count: 1 },
			],
		},
		{
			total: 5,
			chunks: [
				{ start: 0, count: 2 },
				{ start: 2, count: 2 },
				{ start: 4, count: 1 },
			],
		},
	])("describes exact captured ranges for a $total-message snapshot", ({ total, chunks }) => {
		const messages: ClineMessage[] = Array.from({ length: total }, (_, ts) => ({ ts, type: "say" }))
		const admitted = reduceTranscriptTransport(createTranscriptTransportState(2), {
			type: "enqueue",
			request: { kind: "snapshot", taskId: "a" },
			total: messages.length,
			focusedTaskId: "a",
		})
		let state = admitted.state
		const frames: TranscriptFrame[] = []
		for (let index = 0; index < chunks.length + 2; index++) {
			const transition = reduceTranscriptTransport(state, { type: "pump", focusedTaskId: "a" })
			expect(transition.post).toBeDefined()
			frames.push(transition.post!)
			state = reduceTranscriptTransport(transition.state, { type: "settle", success: true }).state
		}

		expect(state.queue).toEqual([])
		expect(state.active).toBeUndefined()
		expect(state.inFlight).toBeUndefined()
		expect(frames).toEqual([
			{ job: admitted.accepted, phase: "start", start: 0, count: 0 },
			...chunks.map((range) => ({ job: admitted.accepted, phase: "chunk", ...range })),
			{ job: admitted.accepted, phase: "end", start: 0, count: 0 },
		])
		expect(frames.slice(1, -1).map((frame) => transcriptFrameMessage(frame, messages).clineMessages)).toEqual(
			chunks.map(({ start, count }) => messages.slice(start, start + count)),
		)
	})
})

describe("transcript transport driver", () => {
	const message: ClineMessage = { ts: 1, type: "say", text: "initial", images: ["image"] }

	test.each([true, false])(
		"retains the sole held caller through repeated invalidation (success=%s)",
		async (success) => {
			let resolveHeld!: () => void
			let rejectHeld!: (error: Error) => void
			const held = new Promise<void>((resolve, reject) => {
				resolveHeld = resolve
				rejectHeld = reject
			})
			const post = vi
				.fn<(frame: ExtensionMessage) => Promise<void>>()
				.mockReturnValueOnce(held)
				.mockResolvedValue(undefined)
			const log = vi.fn()
			const transport = new TranscriptTransport(() => "a", post, log)
			const resolved = vi.fn()
			const rejected = vi.fn()
			const active = transport.enqueue({ kind: "snapshot", taskId: "a" }, [message]).then(resolved, rejected)
			const [heldId] = transport["callers"].keys()

			for (let generation = 0; generation < 2; generation++) {
				const waiting = transport.enqueue({ kind: "update", taskId: "a" }, [message])
				transport.invalidate()
				await waiting
				expect([...transport["callers"].keys()]).toEqual([heldId])
				expect(transport["payloads"].size).toBe(0)
				expect(post).toHaveBeenCalledOnce()
				expect(resolved).not.toHaveBeenCalled()
				expect(rejected).not.toHaveBeenCalled()
			}

			const recovery = transport.enqueue({ kind: "snapshot", taskId: "a" }, [message])
			const failure = new Error("held post failed")
			if (success) resolveHeld()
			else rejectHeld(failure)
			await Promise.all([active, recovery])

			expect(resolved).toHaveBeenCalledTimes(success ? 1 : 0)
			expect(rejected.mock.calls).toEqual(success ? [] : [[failure]])
			expect(log.mock.calls).toEqual(success ? [] : [[failure]])
			expect(transport["callers"].size).toBe(0)
			expect(transport["payloads"].size).toBe(0)
			expect(post.mock.calls.slice(1).map(([frame]) => frame.type)).toEqual([
				"clineMessagesSnapshotStart",
				"clineMessagesSnapshotChunk",
				"clineMessagesSnapshotEnd",
			])
		},
	)

	test.each(["append", "update", "snapshot"] as const)(
		"rejects an unfocused %s before reading the payload or allocating work",
		async (kind) => {
			const readText = vi.fn(() => "obsolete")
			const unread: ClineMessage = {
				ts: 1,
				type: "say",
				get text() {
					return readText()
				},
			}
			const post = vi.fn<(frame: ExtensionMessage) => Promise<void>>().mockResolvedValue(undefined)
			const transport = new TranscriptTransport(() => "a", post, vi.fn())
			const state = transport["state"]

			await transport.enqueue({ kind, taskId: "b" }, [unread])

			expect(readText).not.toHaveBeenCalled()
			expect(post).not.toHaveBeenCalled()
			expect(transport["state"]).toBe(state)
			expect(transport.getSequence("b")).toBe(0)
			expect(transport["payloads"].size).toBe(0)
			expect(transport["callers"].size).toBe(0)
		},
	)

	test.each(["append", "update"] as const)("rejects a %s without a task scope", async (kind) => {
		const post = vi.fn<(frame: ExtensionMessage) => Promise<void>>().mockResolvedValue(undefined)
		const transport = new TranscriptTransport(() => undefined, post, vi.fn())
		const state = transport["state"]

		await transport.enqueue({ kind, taskId: undefined }, [message])

		expect(post).not.toHaveBeenCalled()
		expect(transport["state"]).toBe(state)
		expect(transport["payloads"].size).toBe(0)
		expect(transport["callers"].size).toBe(0)
	})

	test.each(["start", "chunk", "end", "delta"] as const)(
		"keeps the physical barrier across rejected held %s and recovers",
		async (phase) => {
			const type: ExtensionMessage["type"] =
				phase === "start"
					? "clineMessagesSnapshotStart"
					: phase === "chunk"
						? "clineMessagesSnapshotChunk"
						: phase === "end"
							? "clineMessagesSnapshotEnd"
							: "clineMessageAppended"
			let rejectHeld!: (error: Error) => void
			let notifyStarted!: () => void
			const held = new Promise<void>((_resolve, reject) => {
				rejectHeld = reject
			})
			const started = new Promise<void>((resolve) => {
				notifyStarted = resolve
			})
			let heldOnce = false
			let physical = 0
			let maximumPhysical = 0
			const post = vi.fn(async (frame: ExtensionMessage) => {
				physical++
				maximumPhysical = Math.max(maximumPhysical, physical)
				try {
					if (frame.type === type && !heldOnce) {
						heldOnce = true
						notifyStarted()
						await held
					}
				} finally {
					physical--
				}
			})
			const log = vi.fn()
			const transport = new TranscriptTransport(() => "a", post, log)
			const active = transport.enqueue({ kind: phase === "delta" ? "append" : "snapshot", taskId: "a" }, [
				message,
			])
			const rejected = expect(active).rejects.toThrow("held post failed")
			await started
			const discarded = transport.enqueue({ kind: "update", taskId: "a" }, [message])
			transport.invalidate()
			await discarded
			const recovery = transport.enqueue({ kind: "snapshot", taskId: "a" }, [message])
			expect(physical).toBe(1)
			expect(transport["payloads"].size).toBe(1)
			const before = post.mock.calls.length
			rejectHeld(new Error("held post failed"))
			await Promise.all([rejected, recovery])
			expect(maximumPhysical).toBe(1)
			expect(post.mock.calls.slice(before).map(([frame]) => frame.type)).toEqual([
				"clineMessagesSnapshotStart",
				"clineMessagesSnapshotChunk",
				"clineMessagesSnapshotEnd",
			])
			expect(log).toHaveBeenCalledOnce()
			expect(transport["callers"].size).toBe(0)
			expect(transport["payloads"].size).toBe(0)
		},
	)

	test("recovers from a synchronous post throw", async () => {
		const post = vi
			.fn<(frame: ExtensionMessage) => Promise<void>>()
			.mockImplementationOnce(() => {
				throw new Error("sync failure")
			})
			.mockResolvedValue(undefined)
		const transport = new TranscriptTransport(() => "a", post, vi.fn())
		await expect(transport.enqueue({ kind: "append", taskId: "a" }, [message])).rejects.toThrow("sync failure")
		await transport.enqueue({ kind: "update", taskId: "a" }, [message])
		expect(post.mock.calls.map(([frame]) => frame.clineMessagesSeq)).toEqual([1, 2])
	})

	test("rejects invalid chunk-size bounds", () => {
		for (const size of [0, -1, 1.5, Infinity])
			expect(() => createTranscriptTransportState(size)).toThrow("positive safe integer")
	})

	test("delivers one message per chunk at the minimum valid chunk size", async () => {
		const post = vi.fn<(frame: ExtensionMessage) => Promise<void>>().mockResolvedValue(undefined)
		const transport = new TranscriptTransport(() => "a", post, vi.fn())
		transport["state"] = createTranscriptTransportState(1)
		const second = { ...message, ts: 2, text: "second" }

		await transport.enqueue({ kind: "snapshot", taskId: "a" }, [message, second])

		const common = { taskId: "a", clineMessagesSeq: 0, snapshotId: "a:1" }
		expect(post.mock.calls.map(([frame]) => frame)).toEqual([
			{ ...common, type: "clineMessagesSnapshotStart", snapshotTotal: 2 },
			{ ...common, type: "clineMessagesSnapshotChunk", snapshotStartIndex: 0, clineMessages: [message] },
			{ ...common, type: "clineMessagesSnapshotChunk", snapshotStartIndex: 1, clineMessages: [second] },
			{ ...common, type: "clineMessagesSnapshotEnd", snapshotTotal: 2 },
		])
		expect(transport["payloads"].size).toBe(0)
		expect(transport["callers"].size).toBe(0)
	})

	test("does not adopt a newer generation if cloning reenters invalidation", async () => {
		const post = vi.fn().mockResolvedValue(undefined)
		const transport = new TranscriptTransport(() => "a", post, vi.fn())
		const reentrant: ClineMessage = {
			ts: 1,
			type: "say",
			get text() {
				transport.invalidate()
				return "obsolete"
			},
		}
		await transport.enqueue({ kind: "snapshot", taskId: "a", bumpSeq: true }, [reentrant])
		expect(transport.generation).toBe(1)
		expect(transport.getSequence("a")).toBe(0)
		expect(transport["state"].nextSnapshotId).toBe(0)
		expect(post).not.toHaveBeenCalled()
	})
})
