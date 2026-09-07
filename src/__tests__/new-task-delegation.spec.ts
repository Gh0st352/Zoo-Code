// npx vitest run __tests__/new-task-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import { RooCodeEventName } from "@roo-code/types"
import { createCompletionProvider, createCompletionTask } from "./helpers/completion-fixtures"

describe("Task.startSubtask() metadata-driven delegation", () => {
	it("Routes to provider.delegateParentAndOpenChild without pausing parent", async () => {
		const provider = createCompletionProvider()
		provider.createTask = vi.fn()
		const childTask = createCompletionTask(provider, { taskId: "child-1" })
		provider.delegateParentAndOpenChild.mockResolvedValue(childTask)
		const parent = createCompletionTask(provider, { taskId: "parent-1" })

		const child = await parent.startSubtask("Do something", [], "code")
		const action = parent.getPendingTaskAction()!
		expect(provider.setPendingTaskAction).toHaveBeenCalledWith(parent.taskId, action, parent)
		expect(provider.validateTaskDelegation).toHaveBeenCalledWith(parent, action)

		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith({
			origin: parent,
			pendingActionId: action.actionId,
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		expect(child.taskId).toBe("child-1")

		// Parent should not be paused and no paused/unpaused events should be emitted
		expect(Reflect.get(parent, "isPaused")).not.toBe(true)
		expect(parent.childTaskId).toBeUndefined()
		const emittedEvents = vi.mocked(parent.emit).mock.calls.map((call) => call[0])
		expect(emittedEvents).not.toContain(RooCodeEventName.TaskPaused)
		expect(emittedEvents).not.toContain(RooCodeEventName.TaskUnpaused)

		// Legacy path not used
		expect(provider.createTask).not.toHaveBeenCalled()
	})
})
