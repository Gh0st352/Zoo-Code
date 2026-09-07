import { RooCodeEventName, TodoItem } from "@roo-code/types"

import { AttemptCompletionToolUse } from "../../../shared/tools"

// Mock the formatResponse module before importing the tool
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		toolResult: vi.fn((msg: string) => `Result: ${msg}`),
		toolDenied: vi.fn(() => "Denied"),
	},
}))

// Mock vscode module
vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("vscode")>()
	return {
		...actual,
		workspace: { ...actual.workspace, getConfiguration: vi.fn() },
	}
})

// Mock Package module
vi.mock("../../../shared/package", () => ({
	Package: {
		name: "zoo-code",
	},
}))

import { attemptCompletionTool, AttemptCompletionCallbacks } from "../AttemptCompletionTool"
import { Task } from "../../task/Task"
import { AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import { createCompletionProvider, createCompletionTask } from "../../../__tests__/helpers/completion-fixtures"
import { ExecutionAuthorityError } from "../../task-persistence/taskLifecycle"
import * as vscode from "vscode"

function configuration(preventCompletionWithOpenTodos = false): vscode.WorkspaceConfiguration {
	return {
		get: vi.fn().mockReturnValue(preventCompletionWithOpenTodos),
		has: vi.fn(),
		inspect: vi.fn(),
		update: vi.fn().mockResolvedValue(undefined),
	}
}

describe("attemptCompletionTool", () => {
	let mockTask: Task
	let provider: ReturnType<typeof createCompletionProvider>
	let mockPushToolResult: ReturnType<typeof vi.fn<PushToolResult>>
	let mockAskApproval: ReturnType<typeof vi.fn<AskApproval>>
	let mockHandleError: ReturnType<typeof vi.fn<HandleError>>
	let mockToolDescription: ReturnType<typeof vi.fn<() => string>>
	let mockAskFinishSubTaskApproval: ReturnType<typeof vi.fn<() => Promise<boolean>>>
	let mockGetConfiguration: ReturnType<typeof vi.fn<typeof vscode.workspace.getConfiguration>>

	beforeEach(() => {
		mockPushToolResult = vi.fn<PushToolResult>()
		mockAskApproval = vi.fn<AskApproval>()
		mockHandleError = vi.fn<HandleError>()
		mockToolDescription = vi.fn<() => string>()
		mockAskFinishSubTaskApproval = vi.fn<() => Promise<boolean>>()
		mockGetConfiguration = vi.fn<typeof vscode.workspace.getConfiguration>(() => configuration())

		// Setup vscode mock
		vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

		provider = createCompletionProvider()
		mockTask = createCompletionTask(provider)
	})

	describe("todo list validation", () => {
		it("should allow completion when there is no todo list", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = undefined

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not call pushToolResult with an error for empty todo list
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when todo list is empty", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = []

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should prevent completion when there are pending todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue(configuration(true))

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are in-progress todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithInProgress: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "in_progress" },
			]

			mockTask.todoList = todosWithInProgress

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue(configuration(true))

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are mixed incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const mixedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
				{ id: "3", content: "Third task", status: "in_progress" },
			]

			mockTask.todoList = mixedTodos

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue(configuration(true))

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is disabled even with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Ensure the setting is disabled (default behavior)
			mockGetConfiguration.mockReturnValue(configuration(false))

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not prevent completion when setting is disabled
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when setting is enabled with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting
			mockGetConfiguration.mockReturnValue(configuration(true))

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should prevent completion when setting is enabled and there are incomplete todos
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is enabled but all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			// Enable the setting
			mockGetConfiguration.mockReturnValue(configuration(true))

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should allow completion when setting is enabled but all todos are completed
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		describe("tool failure guardrail", () => {
			it("should prevent completion when a previous tool failed in the current turn", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = true

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				const mockSay = vi.fn()
				mockTask.say = mockSay

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockSay).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
			})

			it("should allow completion when no tools failed", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = false

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockTask.consecutiveMistakeCount).toBe(0)
				expect(mockTask.recordToolError).not.toHaveBeenCalled()
			})
		})

		describe("completion lifecycle", () => {
			it("delegates an authorized subtask completion using the immutable preapproval request", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = provider
				mockTask = createCompletionTask(mockProvider, {
					taskId: "child-1",
					parentTaskId: "parent-1",
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-attempt-completion",
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).toHaveBeenCalled()
				const finish = {
					kind: "finish_subtask",
					actionId: "call-attempt-completion",
					approvalText: JSON.stringify({ tool: "finishTask" }),
					parentTaskId: "parent-1",
					result: "9",
				}
				expect(mockProvider.setPendingTaskAction).toHaveBeenCalledExactlyOnceWith("child-1", finish, mockTask)
				expect(mockTask.setPendingTaskAction).toHaveBeenCalledExactlyOnceWith(finish)
				expect(mockProvider.prepareDelegatedCompletion).toHaveBeenCalledExactlyOnceWith(mockTask, finish)
				const request = await mockProvider.prepareDelegatedCompletion.mock.results[0].value
				expect(Object.isFrozen(request)).toBe(true)
				expect(Object.isFrozen(request?.finish)).toBe(true)
				expect(request?.childToken).toEqual(mockTask.executionToken)
				expect(mockProvider.setPendingTaskAction.mock.invocationCallOrder[0]).toBeLessThan(
					mockProvider.prepareDelegatedCompletion.mock.invocationCallOrder[0],
				)
				expect(mockProvider.prepareDelegatedCompletion.mock.invocationCallOrder[0]).toBeLessThan(
					mockAskFinishSubTaskApproval.mock.invocationCallOrder[0],
				)
				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					origin: mockTask,
					request,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
					pendingActionId: "call-attempt-completion",
				})
				expect(mockProvider.reopenParentFromDelegation.mock.calls[0][0].request).toBe(request)
				expect(mockAskFinishSubTaskApproval.mock.invocationCallOrder[0]).toBeLessThan(
					mockProvider.reopenParentFromDelegation.mock.invocationCallOrder[0],
				)
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(mockProvider.completeTask).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalled()
				expect(mockTask.executionBlocked).toBe(true)
			})

			it("stops without standalone completion when parent delegation becomes stale after approval", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = provider
				mockProvider.reopenParentFromDelegation.mockResolvedValue(false)
				mockTask = createCompletionTask(mockProvider, {
					taskId: "child-1",
					parentTaskId: "parent-1",
				})
				mockTask.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: "revise", images: [] })
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-stale-completion",
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					origin: mockTask,
					request: await mockProvider.prepareDelegatedCompletion.mock.results[0].value,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
					pendingActionId: "call-stale-completion",
				})
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
				expect(mockProvider.completeTask).not.toHaveBeenCalled()
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalledWith("")
				expect(mockTask["pendingAction"]?.actionId).toBe("call-stale-completion")
				expect(mockTask.executionBlocked).toBe(true)
				expect(mockTask.emit).not.toHaveBeenCalled()
				// Flush once per validated attempt_completion call, before delegation is
				// attempted, independent of whether delegation succeeds.
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
				// Even a transient refusal cannot retry, prompt, clear intent or emit again.
				mockProvider.reopenParentFromDelegation.mockResolvedValue(true)
				await attemptCompletionTool.handle(mockTask, block, callbacks)
				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledTimes(1)
				expect(mockProvider.prepareDelegatedCompletion).toHaveBeenCalledTimes(1)
				expect(mockAskFinishSubTaskApproval).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockProvider.completeTask).not.toHaveBeenCalled()
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalled()
			})

			it("does not resume the parent when the parent is no longer awaiting this child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = provider
				// The provider owns authoritative parent linkage validation.
				mockProvider.prepareDelegatedCompletion.mockResolvedValue(undefined)
				mockTask = createCompletionTask(mockProvider, {
					taskId: "child-1",
					parentTaskId: "parent-1",
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockProvider.prepareDelegatedCompletion).toHaveBeenCalledTimes(1)
				expect(mockProvider.completeTask).not.toHaveBeenCalled()
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockTask.flushTelemetryInstallment).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(mockTask.executionBlocked).toBe(true)
			})

			it("refuses an interrupted subtask even when its parent still awaits that child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = provider
				mockTask = createCompletionTask(mockProvider, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					executionBlocked: true,
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockProvider.setPendingTaskAction).not.toHaveBeenCalled()
				expect(mockProvider.prepareDelegatedCompletion).not.toHaveBeenCalled()
				expect(mockProvider.completeTask).not.toHaveBeenCalled()
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockTask.say).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalled()
				expect(mockTask.flushTelemetryInstallment).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(mockTask.executionBlocked).toBe(true)
			})

			it("does not resume the parent when the parent is active but awaiting a different child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = provider
				// Parent mismatch is an authority refusal, before any prompt or write.
				mockProvider.setPendingTaskAction.mockRejectedValue(new ExecutionAuthorityError("parent_mismatch"))
				mockTask = createCompletionTask(mockProvider, {
					taskId: "child-1",
					parentTaskId: "parent-1",
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockProvider.setPendingTaskAction).toHaveBeenCalledTimes(1)
				expect(mockProvider.prepareDelegatedCompletion).not.toHaveBeenCalled()
				expect(mockTask.setPendingTaskAction).not.toHaveBeenCalled()
				expect(mockProvider.completeTask).not.toHaveBeenCalled()
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockTask.flushTelemetryInstallment).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(mockTask.executionBlocked).toBe(true)
			})

			it("routes accepted completion through the provider without emitting a raw TaskCompleted event", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
				expect(provider.completeTask).toHaveBeenCalledExactlyOnceWith(mockTask, "2")
				expect(vi.mocked(mockTask.ask).mock.invocationCallOrder[0]).toBeLessThan(
					provider.completeTask.mock.invocationCallOrder[0],
				)
				expect(mockTask.executionBlocked).toBe(true)
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					"task_1",
					expect.anything(),
					expect.anything(),
				)
			})

			it("reports telemetry but does not emit the public TaskCompleted event when user provides follow-up feedback", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "Different question now: what is 3+3?",
					images: [],
				})

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				// Telemetry is reported on every model-initiated attempt_completion call,
				// regardless of whether the user accepts, declines, or gives feedback.
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
				// Only the provider may publish completion after durable acceptance.
				expect(provider.completeTask).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("<user_message>"))
			})

			it("durably persists queued completion feedback before continuing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "One more change",
					queuedMessageId: "queued-1",
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockTask.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith(
					"queued-1",
					"One more change",
					undefined,
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("One more change"))
				expect(
					vi.mocked(mockTask.persistQueuedFeedbackAndAcknowledge).mock.invocationCallOrder[0],
				).toBeLessThan(mockPushToolResult.mock.invocationCallOrder[0])
				expect(provider.completeTask).not.toHaveBeenCalled()
			})

			it("does not continue when queued completion feedback persistence fails", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "One more change",
					queuedMessageId: "queued-1",
				})
				mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockHandleError).toHaveBeenCalledWith(
					"inspecting site",
					expect.objectContaining({ message: expect.stringContaining("queued-1") }),
				)
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(provider.completeTask).not.toHaveBeenCalled()
			})

			it("records image-only completion feedback before continuing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					images: ["data:image/png;base64,feedback"],
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", ["data:image/png;base64,feedback"])
				expect(mockPushToolResult).toHaveBeenCalledTimes(1)
				expect(provider.completeTask).not.toHaveBeenCalled()
			})

			it("retains internal pending metadata and stops when delegation without a native action id is stale", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				const mockProvider = provider
				mockProvider.reopenParentFromDelegation.mockResolvedValue(false)
				mockTask = createCompletionTask(mockProvider, {
					taskId: "child-1",
					parentTaskId: "parent-1",
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				const request = await mockProvider.prepareDelegatedCompletion.mock.results[0].value
				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledExactlyOnceWith({
					origin: mockTask,
					request,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "Done",
					pendingActionId: expect.stringMatching(/^internal-/),
				})
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
				expect(mockTask["pendingAction"]).toEqual(request?.finish)
				expect(mockProvider.completeTask).not.toHaveBeenCalled()
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(mockTask.executionBlocked).toBe(true)
			})
		})
	})
})

describe("attemptCompletionTool telemetry invariants", () => {
	let provider: ReturnType<typeof createCompletionProvider>
	beforeEach(() => {
		provider = createCompletionProvider()
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration())
	})
	function makeTask(overrides: Partial<Task> = {}): Task {
		return createCompletionTask(provider, overrides)
	}

	it("does not emit a duplicate telemetry installment when replaying an already-completed subtask from history", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}
		const task = makeTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
			// History navigation is observational, never a claimed runtime.
			executionToken: undefined,
			executionBlocked: true,
			toolUsage: { read_file: { attempts: 5, failures: 0 } },
			messageCounts: { user: 3, assistant: 4 },
		})
		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).not.toHaveBeenCalled()
		expect(provider.completeTask).not.toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(provider.setPendingTaskAction).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("does not emit the public TaskCompleted event when replaying an already-completed subtask from history", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}
		const task = makeTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
			executionToken: undefined,
			executionBlocked: true,
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		})
		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
		expect(provider.completeTask).not.toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(provider.setPendingTaskAction).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("requests durable provider completion only after acceptance, with one telemetry installment and no raw event", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}

		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		})

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
		expect(provider.completeTask).toHaveBeenCalledExactlyOnceWith(task, "done")
		expect(task.executionBlocked).toBe(true)
		expect(task.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			"task_1",
			expect.anything(),
			expect.anything(),
		)
	})

	it("still reports telemetry for a model-initiated completion even when the user provides follow-up feedback instead of accepting", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}

		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "one more thing", images: [] }),
		})

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
		expect(provider.completeTask).not.toHaveBeenCalled()
		expect(task.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})
})
