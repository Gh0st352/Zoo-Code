import * as vscode from "vscode"
import crypto from "crypto"

import { type PendingTaskAction } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { ExecutionAuthorityError } from "../task-persistence/taskLifecycle"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		if (!(await task.guardExecution())) return
		const { result } = params
		const { handleError, pushToolResult, askFinishSubTaskApproval, toolCallId } = callbacks

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			task.consecutiveMistakeCount = 0

			await task.say("completion_result", result, undefined, false)
			if (!(await task.guardExecution())) return
			const provider = task.providerRef.deref()
			if (!provider) {
				task.executionBlocked = true
				return
			}

			// History navigation has no token. A live linked task must use the exact
			// pre-approval receipt; failed routing cannot become standalone completion.
			if (task.parentTaskId) {
				const finish: Extract<PendingTaskAction, { kind: "finish_subtask" }> = {
					kind: "finish_subtask",
					actionId: toolCallId ? sanitizeToolUseId(toolCallId) : `internal-${crypto.randomUUID()}`,
					approvalText: JSON.stringify({ tool: "finishTask" }),
					parentTaskId: task.parentTaskId,
					result,
				}
				await provider.setPendingTaskAction(task.taskId, finish, task)
				if (!(await task.guardExecution())) return
				task.setPendingTaskAction(finish)
				const request = await provider.prepareDelegatedCompletion(task, finish)
				if (!request) {
					task.executionBlocked = true
					return
				}
				if (!(await task.guardExecution())) return
				task.flushTelemetryInstallment("attempt_completion")
				const approved = await askFinishSubTaskApproval()
				if (!(await task.guardExecution())) return
				if (!approved) {
					pushToolResult(formatResponse.toolDenied())
					return
				}
				await provider.reopenParentFromDelegation({
					origin: task,
					request,
					parentTaskId: task.parentTaskId,
					childTaskId: task.taskId,
					completionResultSummary: result,
					pendingActionId: finish.actionId,
				})
				task.executionBlocked = true
				return
			}

			task.emitFinalTokenUsageUpdate()
			task.flushTelemetryInstallment("attempt_completion")

			const { response, text, images, queuedMessageId } = await task.ask("completion_result", "", false)
			if (!(await task.guardExecution())) return

			if (response === "yesButtonClicked") {
				try {
					await provider.completeTask(task, result)
				} finally {
					task.executionBlocked = true
				}
				return
			}

			// User provided feedback - push tool result to continue the conversation
			if (queuedMessageId) {
				const persisted = await task.persistQueuedFeedbackAndAcknowledge(queuedMessageId, text, images)
				if (!persisted) {
					throw new Error(`Failed to persist queued completion feedback ${queuedMessageId}`)
				}
			} else {
				await task.say("user_feedback", text ?? "", images)
			}

			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			if (error instanceof ExecutionAuthorityError || task.parentTaskId) {
				task.executionBlocked = true
				return
			}
			if (!(await task.guardExecution())) return
			await handleError("inspecting site", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		if (!(await task.guardExecution())) return
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
