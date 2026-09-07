import { TaskScheduler } from "../TaskScheduler"
import { type Task } from "../Task"

function stubTask(): Task {
	// Only the scheduler's authority boundary is doubled; real store admission is
	// covered in Task.execution-authority.spec.ts.
	const task: Pick<Task, "abort" | "abandoned" | "guardExecution"> = {
		abort: false,
		abandoned: false,
		guardExecution: vi.fn(async (): Promise<boolean> => !task.abort && !task.abandoned),
	}
	return task as Task
}

describe("TaskScheduler", () => {
	it("runs a task immediately when a permit is available", async () => {
		const scheduler = new TaskScheduler(1)
		let ran = false
		await scheduler.schedule(stubTask(), async () => {
			ran = true
		})
		expect(ran).toBe(true)
	})

	it("queues a second task at maxConcurrency=1 until the first completes", async () => {
		const scheduler = new TaskScheduler(1)
		const order: number[] = []
		let resolveFirst!: () => void

		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		await vi.waitFor(() => expect(resolveFirst).toBeDefined())

		expect(scheduler.waiting).toBe(0)

		const second = scheduler.schedule(stubTask(), async () => {
			order.push(2)
		})
		await vi.waitFor(() => expect(scheduler.waiting).toBe(1))

		order.push(1)
		resolveFirst()
		await first
		await second

		expect(order).toEqual([1, 2])
	})

	it("allows two tasks in parallel at maxConcurrency=2", async () => {
		const scheduler = new TaskScheduler(2)
		const running: number[] = []
		let resolveA: (() => void) | undefined
		let resolveB: (() => void) | undefined

		const a = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveA = res)))
		const b = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveB = res)))

		await vi.waitFor(() => {
			expect(resolveA).toBeDefined()
			expect(resolveB).toBeDefined()
		})

		expect(scheduler.waiting).toBe(0)
		expect(resolveA).toBeDefined()
		expect(resolveB).toBeDefined()
		running.push(1, 2)
		resolveA!()
		resolveB!()
		await Promise.all([a, b])
		expect(running).toEqual([1, 2])
	})

	it("releases the permit even when the run function throws", async () => {
		const scheduler = new TaskScheduler(1)
		await expect(
			scheduler.schedule(stubTask(), async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")

		// Permit must have been released — next task should run immediately.
		let ran = false
		await scheduler.schedule(stubTask(), async () => {
			ran = true
		})
		expect(ran).toBe(true)
	})

	it("cancelQueued() rejects waiting tasks without affecting the running one", async () => {
		const scheduler = new TaskScheduler(1)
		let resolveRunning!: () => void
		const running = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveRunning = res)))

		await vi.waitFor(() => expect(resolveRunning).toBeDefined())

		const errors: unknown[] = []
		const queued = scheduler.schedule(stubTask(), async () => {}).catch((e) => errors.push(e))
		await vi.waitFor(() => expect(scheduler.waiting).toBe(1))
		scheduler.cancelQueued()
		expect(scheduler.waiting).toBe(0)

		await queued
		expect(errors).toHaveLength(1)

		// Running task is unaffected.
		resolveRunning()
		await expect(running).resolves.toBeUndefined()
	})

	it("skips run() and releases permit when task is aborted before admission", async () => {
		const scheduler = new TaskScheduler(1)
		let resolveFirst!: () => void
		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		await vi.waitFor(() => expect(resolveFirst).toBeDefined())

		const abortedTask = stubTask()
		let ran = false
		const queued = scheduler.schedule(abortedTask, async () => {
			ran = true
		})
		await vi.waitFor(() => expect(scheduler.waiting).toBe(1))
		abortedTask.abort = true

		resolveFirst()
		await Promise.all([first, queued])

		expect(ran).toBe(false)
		// Permit must be released — a subsequent task can run immediately.
		let next = false
		await scheduler.schedule(stubTask(), async () => {
			next = true
		})
		expect(next).toBe(true)
	})

	it("skips run() and releases permit when task is abandoned before admission", async () => {
		const scheduler = new TaskScheduler(1)
		let resolveFirst!: () => void
		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		await vi.waitFor(() => expect(resolveFirst).toBeDefined())

		const abandonedTask = stubTask()
		let ran = false
		const queued = scheduler.schedule(abandonedTask, async () => {
			ran = true
		})
		await vi.waitFor(() => expect(scheduler.waiting).toBe(1))
		abandonedTask.abandoned = true

		resolveFirst()
		await Promise.all([first, queued])

		expect(ran).toBe(false)
	})

	it("defaults to maxConcurrency=1", async () => {
		const scheduler = new TaskScheduler()
		let resolveFirst!: () => void
		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		await vi.waitFor(() => expect(resolveFirst).toBeDefined())

		const second = scheduler.schedule(stubTask(), async () => {})
		await vi.waitFor(() => expect(scheduler.waiting).toBe(1))

		resolveFirst()
		await Promise.all([first, second])
	})
})
