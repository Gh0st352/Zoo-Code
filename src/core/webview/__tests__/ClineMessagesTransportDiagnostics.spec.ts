import {
	ClineMessagesTransportDiagnostics,
	estimateSerializedWeight,
	formatClineMessagesTransportHighWater,
	isClineMessagesTransportDiagnosticsEnabled,
	type ClineMessagesTransportProcessMemory,
} from "../ClineMessagesTransportDiagnostics"

const processMemory: ClineMessagesTransportProcessMemory = {
	rssBytes: 100,
	heapTotalBytes: 80,
	heapUsedBytes: 60,
	externalBytes: 20,
	arrayBuffersBytes: 10,
}

describe("ClineMessagesTransportDiagnostics", () => {
	it("estimates JSON character and UTF-8 byte weight without retaining a serialized copy", () => {
		const payload = {
			ascii: 'a\n"b',
			unicode: "é😀",
			items: [true, null, 12],
		}

		const expected = JSON.stringify(payload)
		expect(estimateSerializedWeight(payload)).toEqual({
			characters: expected.length,
			bytes: Buffer.byteLength(expected),
		})
	})

	it("tracks pending weight, high-water marks, timings, bridge duration, and outcomes", () => {
		let now = 10
		const diagnostics = new ClineMessagesTransportDiagnostics({
			now: () => now,
			readProcessMemory: () => processMemory,
			estimateSerializedWeight: () => ({ characters: 123, bytes: 150 }),
		})

		const operation = diagnostics.beginOperation("update-partial", 7, { privatePayload: "not retained" })
		now = 12
		diagnostics.markEnqueued(operation)

		expect(diagnostics.snapshot()).toMatchObject({
			pending: { operations: 1, estimatedCharacters: 123, estimatedBytes: 150, bridgePosts: 0 },
			highWater: { operations: 1, estimatedCharacters: 123, estimatedBytes: 150 },
			totals: { enqueued: 1, cloneDurationMs: 2, maxCloneDurationMs: 2 },
			processMemory,
		})

		now = 20
		diagnostics.markStarted(operation)
		const bridgePost = diagnostics.startBridgePost()
		now = 25
		diagnostics.markBridgePostSettled(bridgePost, "completed")
		now = 30
		diagnostics.markSettled(operation)

		expect(diagnostics.snapshot()).toMatchObject({
			pending: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0, bridgePosts: 0 },
			highWater: { bridgePosts: 1 },
			totals: {
				started: 1,
				completed: 1,
				queueWaitMs: 8,
				maxQueueWaitMs: 8,
				operationDurationMs: 10,
				maxOperationDurationMs: 10,
				bridgePostsStarted: 1,
				bridgePostsCompleted: 1,
				bridgeDurationMs: 5,
				maxBridgeDurationMs: 5,
			},
			byKind: { "update-partial": { enqueued: 1, completed: 1, dropped: 0, failed: 0 } },
			recentOperations: [
				{
					kind: "update-partial",
					sequence: 7,
					estimatedCharacters: 123,
					estimatedBytes: 150,
					cloneDurationMs: 2,
					queueWaitMs: 8,
					operationDurationMs: 10,
					outcome: "completed",
				},
			],
		})
	})

	it("bounds recent samples while preserving aggregate totals", () => {
		let now = 0
		const diagnostics = new ClineMessagesTransportDiagnostics({
			maxRecentOperations: 2,
			now: () => now,
			readProcessMemory: () => processMemory,
			estimateSerializedWeight: () => ({ characters: 1, bytes: 1 }),
		})

		for (let sequence = 1; sequence <= 5; sequence++) {
			const operation = diagnostics.beginOperation("append", sequence, {})
			now++
			diagnostics.markEnqueued(operation)
			now++
			diagnostics.markStarted(operation)
			now++
			diagnostics.markSettled(operation)
		}

		const snapshot = diagnostics.snapshot()
		expect(snapshot.totals).toMatchObject({ enqueued: 5, completed: 5 })
		expect(snapshot.recentOperations.map(({ sequence }) => sequence)).toEqual([4, 5])
	})

	it("resets state and ignores handles created before the reset", () => {
		const diagnostics = new ClineMessagesTransportDiagnostics({
			readProcessMemory: () => processMemory,
			estimateSerializedWeight: () => ({ characters: 10, bytes: 10 }),
		})
		const staleOperation = diagnostics.beginOperation("snapshot", 3, {})
		diagnostics.markEnqueued(staleOperation)

		diagnostics.reset()
		diagnostics.markStarted(staleOperation)
		diagnostics.markDropped(staleOperation, "generation")
		diagnostics.markSettled(staleOperation)

		expect(diagnostics.snapshot()).toMatchObject({
			pending: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0 },
			highWater: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0 },
			totals: { enqueued: 0, started: 0, completed: 0, dropped: 0, failed: 0 },
			recentOperations: [],
		})
	})

	it("cleans pending counters on dropped and failed operations", () => {
		const diagnostics = new ClineMessagesTransportDiagnostics({
			readProcessMemory: () => processMemory,
			estimateSerializedWeight: () => ({ characters: 10, bytes: 12 }),
		})
		const dropped = diagnostics.beginOperation("snapshot", 4, {})
		diagnostics.markEnqueued(dropped)
		diagnostics.markStarted(dropped)
		diagnostics.markDropped(dropped, "focus")
		diagnostics.markSettled(dropped)

		const failed = diagnostics.beginOperation("update-final", 5, {})
		diagnostics.markEnqueued(failed)
		diagnostics.markStarted(failed)
		diagnostics.markSettled(failed, true)

		expect(diagnostics.snapshot()).toMatchObject({
			pending: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0 },
			totals: { dropped: 1, failed: 1, focusDrops: 1, generationDrops: 0 },
			byKind: {
				snapshot: { dropped: 1 },
				"update-final": { failed: 1 },
			},
		})
	})

	it("contains only scalar metadata in formatted high-water output", () => {
		const formatted = formatClineMessagesTransportHighWater({
			kind: "update-partial",
			sequence: 9,
			pendingOperations: 8,
			pendingEstimatedCharacters: 1_000,
			pendingEstimatedBytes: 1_200,
			processMemory,
		})

		expect(formatted).toBe(
			"[clineMessages] queue high-water kind=update-partial sequence=9 pendingOperations=8 " +
				"pendingEstimatedCharacters=1000 pendingEstimatedBytes=1200 rssBytes=100 heapUsedBytes=60",
		)
		expect(formatted).not.toContain("privatePayload")
	})

	it("requires explicit environment opt-in", () => {
		expect(isClineMessagesTransportDiagnosticsEnabled({})).toBe(false)
		expect(isClineMessagesTransportDiagnosticsEnabled({ ROO_CODE_TRANSCRIPT_TRANSPORT_DIAGNOSTICS: "0" })).toBe(
			false,
		)
		expect(isClineMessagesTransportDiagnosticsEnabled({ ROO_CODE_TRANSCRIPT_TRANSPORT_DIAGNOSTICS: "1" })).toBe(
			true,
		)
	})

	it("tracks scalar-only coalescing outcomes and avoided weight", () => {
		const diagnostics = new ClineMessagesTransportDiagnostics({
			readProcessMemory: () => processMemory,
			estimateSerializedWeight: () => ({ characters: 250, bytes: 300 }),
		})
		const first = diagnostics.beginCoalescingObservation(diagnostics.estimateWeight({ first: true }))
		const second = diagnostics.beginCoalescingObservation(diagnostics.estimateWeight({ second: true }))

		diagnostics.markCoalescingOffered(first)
		diagnostics.markCoalescingOffered(second)
		diagnostics.markCoalescingSuperseded(first)
		diagnostics.markCoalescingEmitted(second, 2)
		diagnostics.markCoalescingHardBoundaryFlush()
		diagnostics.markCoalescingFailClosedSkip()
		diagnostics.markCoalescingWaiterSettled(first, false)
		diagnostics.markCoalescingWaiterSettled(second, true)

		expect(diagnostics.snapshot().totals).toMatchObject({
			coalescingOffered: 2,
			coalescingSuperseded: 1,
			coalescingEmitted: 1,
			coalescingHardBoundaryFlushes: 1,
			coalescingFailClosedSkips: 1,
			coalescingWaitersSettled: 1,
			coalescingWaitersRejected: 1,
			coalescingMaxWaitersPerEmission: 2,
			coalescingEstimatedAvoidedCharacters: 250,
			coalescingEstimatedAvoidedBytes: 300,
		})
	})

	it("replaces pending coalescing weight exactly and ignores observations from an older reset epoch", () => {
		const diagnostics = new ClineMessagesTransportDiagnostics()
		const first = diagnostics.beginCoalescingObservation({ characters: 100, bytes: 110 })
		const replacement = diagnostics.beginCoalescingObservation({ characters: 300, bytes: 330 })

		diagnostics.markCoalescingOffered(first)
		diagnostics.markCoalescingPendingQueued(first)
		diagnostics.markCoalescingOffered(replacement)
		diagnostics.markCoalescingPendingReplaced(first, replacement)

		expect(diagnostics.snapshot().coalescing).toMatchObject({
			pendingOperations: 1,
			pendingEstimatedCharacters: 300,
			pendingEstimatedBytes: 330,
			pendingWaiters: 2,
		})

		diagnostics.reset()
		diagnostics.markCoalescingPendingRemoved(replacement)
		diagnostics.markCoalescingEmitted(replacement, 2)
		diagnostics.markCoalescingWaiterSettled(first, false)

		expect(diagnostics.snapshot()).toMatchObject({
			coalescing: {
				pendingOperations: 0,
				pendingEstimatedCharacters: 0,
				pendingEstimatedBytes: 0,
				pendingWaiters: 0,
			},
			totals: { coalescingEmitted: 0, coalescingWaitersSettled: 0 },
		})
	})

	it("caps recent samples and clears bounded state after thousands of operations", () => {
		const sampleLimit = 32
		const operationCount = 4_000
		const diagnostics = new ClineMessagesTransportDiagnostics({
			maxRecentOperations: sampleLimit,
			readProcessMemory: () => processMemory,
			estimateSerializedWeight: () => ({ characters: 2, bytes: 3 }),
		})

		for (let sequence = 1; sequence <= operationCount; sequence++) {
			const operation = diagnostics.beginOperation("update-partial", sequence, { payload: "not retained" })
			diagnostics.markEnqueued(operation)
			diagnostics.markStarted(operation)
			diagnostics.markSettled(operation)
		}

		const snapshot = diagnostics.snapshot()
		expect(snapshot).toMatchObject({
			pending: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0, bridgePosts: 0 },
			totals: { enqueued: operationCount, started: operationCount, completed: operationCount, failed: 0 },
		})
		expect(snapshot.recentOperations).toHaveLength(sampleLimit)
		expect(snapshot.recentOperations[0]?.sequence).toBe(operationCount - sampleLimit + 1)
		expect(snapshot.recentOperations.at(-1)?.sequence).toBe(operationCount)

		diagnostics.dispose()
		expect(diagnostics.snapshot()).toMatchObject({
			pending: { operations: 0, estimatedCharacters: 0, estimatedBytes: 0, bridgePosts: 0 },
			totals: { enqueued: 0, started: 0, completed: 0, failed: 0 },
			recentOperations: [],
		})
	})
})
