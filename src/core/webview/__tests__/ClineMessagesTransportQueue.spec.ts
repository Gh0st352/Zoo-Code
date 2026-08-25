import { ClineMessagesTransportQueue, type ClineMessagesTransportQueueExecution } from "../ClineMessagesTransportQueue"

type Payload = { text: string }

function createDeferred() {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

describe("ClineMessagesTransportQueue", () => {
	it("retains one in-flight payload and one latest pending payload per adjacent identity", async () => {
		const queue = new ClineMessagesTransportQueue<string, Payload>((left, right) => left === right)
		const bridge = createDeferred()
		const emitted: string[] = []
		const execute = async (payload: Payload, execution: ClineMessagesTransportQueueExecution) => {
			execution.markEmitted()
			emitted.push(payload.text)
			if (emitted.length === 1) {
				await bridge.promise
			}
		}

		const promises = [queue.enqueueCoalescible("same", { text: "one" }, execute).promise]
		for (let turn = 0; turn < 3 && emitted.length === 0; turn++) {
			await Promise.resolve()
		}
		for (const text of ["two", "three", "four"]) {
			promises.push(queue.enqueueCoalescible("same", { text }, execute).promise)
		}

		expect(emitted).toEqual(["one"])
		bridge.resolve()
		await Promise.all(promises)
		expect(emitted).toEqual(["one", "four"])
	})

	it("coalesces offers made before an inherited legacy queue gate opens", async () => {
		const legacyGate = createDeferred()
		const queue = new ClineMessagesTransportQueue<string, Payload>(
			(left, right) => left === right,
			legacyGate.promise,
		)
		const emitted: string[] = []
		const execute = async (payload: Payload) => {
			emitted.push(payload.text)
		}

		const first = queue.enqueueCoalescible("same", { text: "first" }, execute)
		const second = queue.enqueueCoalescible("same", { text: "second" }, execute)

		expect(second.superseded).toBe(true)
		expect(emitted).toEqual([])
		legacyGate.resolve()
		await Promise.all([first.promise, second.promise])
		expect(emitted).toEqual(["second"])
	})

	it("settles superseded callers with the surviving replacement result and recovers after failure", async () => {
		const queue = new ClineMessagesTransportQueue<string, Payload>((left, right) => left === right)
		const blocker = createDeferred()
		const failure = new Error("replacement failed")
		const boundary = queue.enqueueBoundary(() => blocker.promise).promise
		const first = queue.enqueueCoalescible("same", { text: "first" }, async () => {}).promise
		const second = queue.enqueueCoalescible("same", { text: "second" }, async () => {
			throw failure
		}).promise
		const recovered = queue.enqueueBoundary(async () => {}).promise

		blocker.resolve()
		await boundary
		await expect(first).rejects.toBe(failure)
		await expect(second).rejects.toBe(failure)
		await expect(recovered).resolves.toBeUndefined()
	})

	it("keeps hard boundaries and differing identities in exact FIFO order", async () => {
		const queue = new ClineMessagesTransportQueue<string, Payload>((left, right) => left === right)
		const blocker = createDeferred()
		const order: string[] = []
		const firstBoundary = queue.enqueueBoundary(() => blocker.promise).promise
		const first = queue.enqueueCoalescible("a", { text: "a1" }, async (payload) => {
			order.push(payload.text)
		}).promise
		const unrelated = queue.enqueueBoundary(async () => {
			order.push("boundary")
		}).promise
		const second = queue.enqueueCoalescible("a", { text: "a2" }, async (payload) => {
			order.push(payload.text)
		}).promise
		const otherIdentity = queue.enqueueCoalescible("b", { text: "b1" }, async (payload) => {
			order.push(payload.text)
		}).promise

		blocker.resolve()
		await Promise.all([firstBoundary, first, unrelated, second, otherIdentity])
		expect(order).toEqual(["a1", "boundary", "a2", "b1"])
	})

	it("rejects queued and in-flight waiters on disposal without running pending payloads", async () => {
		const queue = new ClineMessagesTransportQueue<string, Payload>((left, right) => left === right)
		const bridge = createDeferred()
		const disposal = new Error("disposed for test")
		let pendingRan = false
		const inFlight = queue.enqueueBoundary(() => bridge.promise).promise
		const pending = queue.enqueueCoalescible("same", { text: "pending" }, async () => {
			pendingRan = true
		}).promise

		queue.dispose(disposal)
		await expect(inFlight).rejects.toBe(disposal)
		await expect(pending).rejects.toBe(disposal)
		bridge.resolve()
		await Promise.resolve()
		expect(pendingRan).toBe(false)
	})

	it("soaks thousands of offers with bounded payload state, fan-in, failure recovery, and reuse", async () => {
		const queue = new ClineMessagesTransportQueue<string, Payload>((left, right) => left === right)
		const firstGate = createDeferred()
		const offers = 4_000
		const settled: string[] = []
		const emitted: string[] = []
		let activeExecutions = 0
		let maxActiveExecutions = 0

		const execute = async (payload: Payload) => {
			activeExecutions++
			maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions)
			try {
				if (payload.text === "revision-1") {
					await firstGate.promise
				}
				emitted.push(payload.text)
			} finally {
				activeExecutions--
			}
		}

		const promises: Promise<void>[] = []
		for (let revision = 1; revision <= offers; revision++) {
			const result = queue.enqueueCoalescible("message-1", { text: `revision-${revision}` }, execute)
			promises.push(
				result.promise.then(
					() => {
						settled.push(`resolved-${revision}`)
					},
					() => {
						settled.push(`rejected-${revision}`)
					},
				),
			)
			if (revision === 1) {
				for (let turn = 0; turn < 5; turn++) {
					await Promise.resolve()
				}
				expect(queue["activeEntry"]).toBeDefined()
			}
		}
		expect(queue["entries"]).toHaveLength(1)

		firstGate.resolve()
		await Promise.all(promises)

		expect(maxActiveExecutions).toBe(1)
		expect(emitted).toEqual(["revision-1", `revision-${offers}`])
		expect(settled).toHaveLength(offers)
		expect(settled.every((outcome) => outcome.startsWith("resolved-"))).toBe(true)
		expect(queue["entries"]).toHaveLength(0)

		const failure = new Error("synthetic failure")
		await expect(
			queue.enqueueBoundary(async () => {
				throw failure
			}).promise,
		).rejects.toBe(failure)
		await expect(
			queue.enqueueBoundary(async () => {
				emitted.push("after-failure")
			}).promise,
		).resolves.toBeUndefined()
		expect(emitted.at(-1)).toBe("after-failure")
	})
})
