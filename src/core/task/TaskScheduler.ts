import { TaskSemaphore } from "../../utils/TaskSemaphore"
import { type Task } from "./Task"

/**
 * Semaphore-based concurrency gate for task execution.
 *
 * Ships at maxConcurrency=1, which is structurally identical to the current
 * serial behavior. Raising maxConcurrency later enables Story 3.2b fan-out
 * without touching the gate logic here.
 */
export class TaskScheduler {
	private readonly sem: TaskSemaphore
	private readonly scheduled = new Map<string, Promise<void>>()

	constructor(maxConcurrency = 1) {
		this.sem = new TaskSemaphore(maxConcurrency)
	}

	get waiting(): number {
		return this.sem.waiting
	}

	/**
	 * Acquire a permit for `task`, call `run()`, and release on completion.
	 *
	 * The returned promise resolves/rejects with the same value as `run()`.
	 * Release is guaranteed via try/finally even if `run()` throws.
	 *
	 * If the task was aborted or abandoned while waiting for a permit (e.g. the
	 * user cancelled it before it started), the permit is released immediately
	 * without calling `run()`.
	 */
	schedule(task: Task, run: () => Promise<void>): Promise<void> {
		const token = task.executionToken
		if (!token) return this.admit(task, run)
		const key = JSON.stringify([
			token.taskId,
			token.generation,
			token.owner.hostSessionId,
			token.owner.providerId,
			token.owner.runtimeId,
		])
		const existing = this.scheduled.get(key)
		if (existing) return existing
		const scheduled = this.admit(task, run)
		this.scheduled.set(key, scheduled)
		return scheduled
	}

	private async admit(task: Task, run: () => Promise<void>): Promise<void> {
		if (!(await task.guardExecution())) return
		const release = await this.sem.acquire()
		try {
			// Authority can change while queued. Never fall back for unclaimed mocks.
			if (!(await task.guardExecution())) return
			await run()
		} finally {
			release()
		}
	}

	/**
	 * Cancel all queued (waiting) tasks. Tasks that already acquired a permit
	 * are not affected — they continue to run to completion.
	 */
	cancelQueued(): void {
		this.sem.cancel()
	}
}
