import type { ExecutionToken } from "@roo-code/types"

import type { Task } from "../../core/task/Task"
import { ExecutionAuthorityError } from "../../core/task-persistence/taskLifecycle"

/**
 * Explicit incarnation permission for constructor-free orchestration units only.
 * Persistence/cleanup tests must claim through the real store instead. This does
 * not stand in for storage authority, and STOP cannot be undone by resetting flags.
 */
export function withTaskExecution<T extends { taskId: string; instanceId: string; abort: boolean }>(task: T) {
	const token: ExecutionToken = Object.freeze({
		taskId: task.taskId,
		generation: 1,
		owner: Object.freeze({
			hostSessionId: "unit-host",
			providerId: "unit-provider",
			runtimeId: task.instanceId,
			processId: 1,
			machineId: "unit-machine",
			machineProof: "local" as const,
		}),
	})
	let stopped = false
	const runtime = Object.assign(task, {
		executionToken: token,
		executionGeneration: token.generation,
		executionBlocked: false,
		abandoned: false,
	})
	const guardExecution = vi.fn<Task["guardExecution"]>(async () => {
		stopped ||= !!(
			runtime.abort ||
			runtime.abandoned ||
			runtime.executionBlocked ||
			runtime.executionToken !== token ||
			runtime.taskId !== token.taskId ||
			runtime.instanceId !== token.owner.runtimeId ||
			runtime.executionGeneration !== token.generation
		)
		if (stopped) runtime.executionBlocked = true
		return !stopped
	})
	return Object.assign(runtime, {
		guardExecution,
		requireExecution: vi.fn<Task["requireExecution"]>(async () => {
			if (!(await guardExecution())) throw new ExecutionAuthorityError("stale_generation")
		}),
		trackExecutionWork: <Result>(work: Promise<Result>): Promise<Result> => work,
	})
}
