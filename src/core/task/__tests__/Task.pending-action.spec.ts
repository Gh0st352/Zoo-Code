import type { PendingTaskAction } from "@roo-code/types"

import { Task } from "../Task"
import { createCompletionProvider, createCompletionTask } from "../../../__tests__/helpers/completion-fixtures"

const createAction: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "create-action",
	approvalText: JSON.stringify({ tool: "newTask" }),
	mode: "ask",
	message: "Child task",
	todos: [],
}

const finishAction: PendingTaskAction = {
	kind: "finish_subtask",
	actionId: "finish-action",
	approvalText: JSON.stringify({ tool: "finishTask" }),
	parentTaskId: "parent-1",
	result: "Done",
}

describe("Task pending action replay", () => {
	afterEach(() => vi.restoreAllMocks())

	it("executes an approved create-subtask action", async () => {
		const provider = createCompletionProvider()
		provider.delegateParentAndOpenChild.mockResolvedValue(createCompletionTask(provider, { taskId: "child-1" }))
		const task = createCompletionTask(provider, { taskId: "task-1" })
		task.setPendingTaskAction(createAction)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await task["resumePendingTaskAction"](createAction)

		expect(provider.validateTaskDelegation).toHaveBeenCalledExactlyOnceWith(task, createAction)
		expect(provider.validateTaskDelegation.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(task.ask).mock.invocationCallOrder[0],
		)
		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith({
			origin: task,
			parentTaskId: "task-1",
			message: "Child task",
			initialTodos: [],
			mode: "ask",
			pendingActionId: "create-action",
		})
	})

	it("executes an approved finish-subtask action", async () => {
		const provider = createCompletionProvider()
		const task = createCompletionTask(provider, { taskId: "task-1", parentTaskId: "parent-1" })
		task.setPendingTaskAction(finishAction)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await task["resumePendingTaskAction"](finishAction)

		const request = await provider.prepareDelegatedCompletion.mock.results[0].value
		expect(provider.prepareDelegatedCompletion).toHaveBeenCalledExactlyOnceWith(task, finishAction)
		expect(provider.prepareDelegatedCompletion.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(task.ask).mock.invocationCallOrder[0],
		)
		expect(Object.isFrozen(request)).toBe(true)
		expect(Object.isFrozen(request?.finish)).toBe(true)
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledWith({
			origin: task,
			request,
			parentTaskId: "parent-1",
			childTaskId: "task-1",
			completionResultSummary: "Done",
			pendingActionId: "finish-action",
		})
		expect(provider.reopenParentFromDelegation.mock.calls[0][0].request).toBe(request)
		expect(task.executionBlocked).toBe(true)
		expect(task.emit).not.toHaveBeenCalled()
		expect(task["initiateTaskLoop"]).not.toHaveBeenCalled()
	})

	it("stops without a fresh completion ask when approved finish delegation is stale", async () => {
		const provider = createCompletionProvider()
		provider.reopenParentFromDelegation.mockResolvedValue(false)
		const task = createCompletionTask(provider, { taskId: "task-1", parentTaskId: "parent-1" })
		task.setPendingTaskAction(finishAction)

		await task["resumePendingTaskAction"](finishAction)

		expect(provider.reopenParentFromDelegation).toHaveBeenCalledTimes(1)
		expect(provider.clearPendingTaskAction).not.toHaveBeenCalled()
		expect(provider.completeTask).not.toHaveBeenCalled()
		expect(task.ask).toHaveBeenCalledExactlyOnceWith("tool", finishAction.approvalText, false)
		expect(task.ask).not.toHaveBeenCalledWith("completion_result", "", false)
		expect(task["pendingAction"]).toEqual(finishAction)
		expect(task.executionBlocked).toBe(true)
		expect(task["executionRefusalReason"]).toBe("receipt_mismatch")
		expect(task["initiateTaskLoop"]).not.toHaveBeenCalled()
		expect(task.emit).not.toHaveBeenCalled()
	})

	it("preserves a newer pending action without recursively approving it after stale finish refusal", async () => {
		const newerAction: PendingTaskAction = {
			...createAction,
			actionId: "newer-action",
			approvalText: JSON.stringify({ tool: "newTask", action: "newer" }),
		}
		const provider = createCompletionProvider()
		const task = createCompletionTask(provider, { taskId: "task-1", parentTaskId: "parent-1" })
		task.setPendingTaskAction(finishAction)
		task.ask = vi.fn<Task["ask"]>().mockImplementationOnce(async () => {
			// A newer action arrives while the old approval is outstanding.
			task.setPendingTaskAction(newerAction)
			return { response: "yesButtonClicked" }
		})
		provider.reopenParentFromDelegation.mockResolvedValue(false)

		await task["resumePendingTaskAction"](finishAction)

		expect(task.ask).toHaveBeenCalledExactlyOnceWith("tool", finishAction.approvalText, false)
		expect(task.ask).not.toHaveBeenCalledWith("tool", newerAction.approvalText, false)
		expect(task.ask).not.toHaveBeenCalledWith("completion_result", "", false)
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledTimes(1)
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledWith(
			expect.objectContaining({ pendingActionId: "finish-action" }),
		)
		const request = await provider.prepareDelegatedCompletion.mock.results[0].value
		expect(request?.finish).toEqual(finishAction)
		expect(provider.reopenParentFromDelegation.mock.calls[0][0].request).toBe(request)
		expect(provider.prepareDelegatedCompletion.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(task.ask).mock.invocationCallOrder[0],
		)
		expect(vi.mocked(task.ask).mock.invocationCallOrder[0]).toBeLessThan(
			provider.reopenParentFromDelegation.mock.invocationCallOrder[0],
		)
		expect(provider.clearPendingTaskAction).not.toHaveBeenCalled()
		expect(provider.setPendingTaskAction).not.toHaveBeenCalled()
		expect(provider.completeTask).not.toHaveBeenCalled()
		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		expect(task.emit).not.toHaveBeenCalled()
		expect(task["pendingAction"]).toEqual(newerAction)
		expect(task.executionBlocked).toBe(true)
		expect(task["initiateTaskLoop"]).not.toHaveBeenCalled()
		await task["resumePendingTaskAction"](newerAction)
		expect(task.ask).toHaveBeenCalledTimes(1)
		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
	})

	it("continues with denied queued feedback after durable persistence", async () => {
		const provider = createCompletionProvider()
		const task = createCompletionTask(provider, { taskId: "task-1", parentTaskId: "parent-1" })
		task.setPendingTaskAction(finishAction)
		task.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Revise this",
			queuedMessageId: "queued-1",
		})

		await task["resumePendingTaskAction"](finishAction)

		expect(task.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith("queued-1", "Revise this", undefined)
		const initiateTaskLoop = vi.mocked(task["initiateTaskLoop"])
		expect(initiateTaskLoop).toHaveBeenCalledWith([
			expect.objectContaining({ type: "tool_result", tool_use_id: "finish-action" }),
		])
		const persist = vi.mocked(task.persistQueuedFeedbackAndAcknowledge)
		expect(persist.mock.invocationCallOrder[0]).toBeLessThan(initiateTaskLoop.mock.invocationCallOrder[0])
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(provider.completeTask).not.toHaveBeenCalled()
		expect(task.emit).not.toHaveBeenCalled()
	})

	it("does not continue when durable queued feedback persistence fails", async () => {
		const provider = createCompletionProvider()
		const task = createCompletionTask(provider)
		task.setPendingTaskAction(createAction)
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		task.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Revise this",
			queuedMessageId: "queued-1",
		})
		task.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)
		const initiateTaskLoop = task["initiateTaskLoop"]

		await task["resumePendingTaskAction"](createAction)
		expect(error).toHaveBeenCalledWith(
			"Pending action execution stopped:",
			expect.objectContaining({ message: expect.stringContaining("task loop was not resumed") }),
		)
		expect(task.executionBlocked).toBe(true)
		expect(provider.denyTaskDelegation).not.toHaveBeenCalled()
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("records ordinary feedback when a restored action is denied", async () => {
		const provider = createCompletionProvider()
		const task = createCompletionTask(provider)
		task.setPendingTaskAction(createAction)
		task.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: "No" })

		await task["resumePendingTaskAction"](createAction)

		expect(task.say).toHaveBeenCalledWith("user_feedback", "No", undefined)
		expect(provider.denyTaskDelegation).toHaveBeenCalledExactlyOnceWith(task, createAction)
		expect(task["initiateTaskLoop"]).not.toHaveBeenCalled()
	})

	it("does not resume the model when the user denies restored delegation", async () => {
		const provider = createCompletionProvider()
		const task = createCompletionTask(provider)
		task.setPendingTaskAction(createAction)
		task.ask = vi.fn().mockResolvedValue({ response: "noButtonClicked" })
		const initiateTaskLoop = task["initiateTaskLoop"]

		await task["resumePendingTaskAction"](createAction)

		expect(provider.denyTaskDelegation).toHaveBeenCalledExactlyOnceWith(task, createAction)
		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("fails clearly when the provider is unavailable", async () => {
		const task = createCompletionTask()
		const error = vi.spyOn(console, "error").mockImplementation(() => {})

		await task["resumePendingTaskAction"](createAction)
		expect(error).toHaveBeenCalledWith(
			"Pending action execution stopped:",
			expect.objectContaining({ message: expect.stringContaining("Provider unavailable") }),
		)
		expect(task.executionBlocked).toBe(true)
		expect(task.ask).not.toHaveBeenCalled()
		expect(task["initiateTaskLoop"]).not.toHaveBeenCalled()
	})
})
