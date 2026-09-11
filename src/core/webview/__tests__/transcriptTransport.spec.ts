import type { ClineMessage, ExtensionMessage } from "@roo-code/types"
import { createTranscriptTransportState, TranscriptTransport } from "../transcriptTransport"
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

describe("transcript transport driver", () => {
	const message: ClineMessage = { ts: 1, type: "say", text: "initial", images: ["image"] }

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
