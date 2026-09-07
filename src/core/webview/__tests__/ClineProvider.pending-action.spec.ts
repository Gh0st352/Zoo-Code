import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { PendingTaskAction } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { createCompletionTask } from "../../../__tests__/helpers/completion-fixtures"

const pendingAction: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "action-1",
	approvalText: "{}",
	mode: "code",
	message: "Child task",
	todos: [],
}

describe("ClineProvider pending task actions", () => {
	let directory: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	let task: ReturnType<typeof createCompletionTask>

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-pending-action-"))
		store = new TaskHistoryStore(directory)
		await store.initialize()
		const claim = await store.claimNewTask(
			{ id: "task-1", number: 1, ts: 1, task: "Task", tokensIn: 0, tokensOut: 0, totalCost: 0 },
			store.ownerForRuntime("runtime-1"),
		)
		if (claim.kind !== "applied") throw new Error(claim.reason)
		const token = Object.freeze({ ...claim.token, owner: Object.freeze({ ...claim.token.owner }) })
		provider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			taskHistoryStore: store,
			ownedExecutions: new Map(),
			delegationEpoch: 0,
			recentTasksCache: [],
			getCurrentTask: () => task,
		})
		task = createCompletionTask(provider, {
			taskId: token.taskId,
			instanceId: token.owner.runtimeId,
			executionToken: token,
			executionGeneration: token.generation,
			guardExecution: async () => {
				if (task.abort || task.executionBlocked || task.executionToken !== token) return false
				const allowed = (await store.guardExecution(token)).kind === "allowed"
				if (!allowed) task.executionBlocked = true
				return allowed
			},
		})
		provider["rememberExecution"](token, task)
	})

	afterEach(async () => {
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("sets a pending action atomically and invalidates the recent-task cache", async () => {
		const command = vi.spyOn(store, "lifecycleCommand")
		await expect(provider.setPendingTaskAction(task.taskId, pendingAction)).rejects.toMatchObject({
			reason: "owner_mismatch",
		})
		expect(command).not.toHaveBeenCalled()
		await provider.setPendingTaskAction(task.taskId, pendingAction, task)
		expect(command).toHaveBeenCalledExactlyOnceWith(
			task.taskId,
			expect.any(Function),
			[],
			false,
			task.executionToken,
			expect.any(Function),
		)
		expect((await store.readAuthoritative(task.taskId)).pendingAction).toEqual(pendingAction)
		expect(provider["recentTasksCache"]).toBeUndefined()
	})

	it("clears only the matching action", async () => {
		await provider.setPendingTaskAction(task.taskId, pendingAction, task)
		await expect(provider.clearPendingTaskAction(task.taskId, "stale-action", task)).resolves.toBe(false)
		expect((await store.readAuthoritative(task.taskId)).pendingAction).toEqual(pendingAction)
		await expect(provider.clearPendingTaskAction(task.taskId, pendingAction.actionId, task)).resolves.toBe(true)
		expect((await store.readAuthoritative(task.taskId)).pendingAction).toBeUndefined()
	})

	it("returns false when the task was deleted before clear", async () => {
		await provider.setPendingTaskAction(task.taskId, pendingAction, task)
		// This task double has no external work; attest its cleanup before deletion.
		expect(await store.settleTaskExecution(task.executionToken!, true)).toMatchObject({ kind: "applied" })
		await store.delete(task.taskId)
		const command = vi.spyOn(store, "lifecycleCommand")
		await expect(provider.clearPendingTaskAction(task.taskId, pendingAction.actionId, task)).resolves.toBe(false)
		expect(command).not.toHaveBeenCalled()
		expect(task.executionBlocked).toBe(true)
	})

	it("propagates unrelated store failures", async () => {
		await provider.setPendingTaskAction(task.taskId, pendingAction, task)
		const before = await store.readAuthoritative(task.taskId)
		vi.spyOn(store, "lifecycleCommand").mockRejectedValueOnce(new Error("disk unavailable"))
		await expect(provider.clearPendingTaskAction(task.taskId, pendingAction.actionId, task)).rejects.toThrow(
			"disk unavailable",
		)
		expect(await store.readAuthoritative(task.taskId)).toEqual(before)
	})
})
