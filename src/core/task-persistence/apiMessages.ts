import * as path from "path"
import * as fs from "fs/promises"

import { Anthropic } from "@anthropic-ai/sdk"
import type { DelegationAction, DelegatedCompletionReceipt } from "@roo-code/types"
import deepEqual from "fast-deep-equal"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { ensureMessageIdentifiers, mergeApiMessageSnapshots } from "./mergeMessageSnapshots"
import { getErrorCode, readFileWithMissingRetry } from "./readFileWithMissingRetry"
import { ExecutionAuthorityError } from "./taskLifecycle"

export type ApiMessage = Anthropic.MessageParam & {
	messageId?: string
	ts?: number
	isSummary?: boolean
	id?: string
	// For reasoning items stored in API history
	type?: "reasoning"
	summary?: any[]
	encrypted_content?: string
	text?: string
	// For OpenRouter reasoning_details array format (used by Gemini 3, etc.)
	reasoning_details?: any[]
	// For DeepSeek/Z.ai interleaved thinking: reasoning_content that must be preserved during tool call sequences
	// See: https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
	reasoning_content?: string
	// For non-destructive condense: unique identifier for summary messages
	condenseId?: string
	// For non-destructive condense: points to the condenseId of the summary that replaces this message
	// Messages with condenseParent are filtered out when sending to API if the summary exists
	condenseParent?: string
	// For non-destructive truncation: unique identifier for truncation marker messages
	truncationId?: string
	// For non-destructive truncation: points to the truncationId of the marker that hides this message
	// Messages with truncationParent are filtered out when sending to API if the marker exists
	truncationParent?: string
	// Identifies a message as a truncation boundary marker
	isTruncationMarker?: boolean
}

export type ApiMessagesReadErrorKind = "invalid" | "io_error"

export class ApiMessagesReadError extends Error {
	constructor(
		public readonly kind: ApiMessagesReadErrorKind,
		message: string,
		public readonly originalError?: unknown,
	) {
		super(message)
		this.name = "ApiMessagesReadError"
	}
}

function parseApiMessages(fileContent: string, taskId: string, filePath: string): ApiMessage[] {
	let parsedData: unknown
	try {
		parsedData = JSON.parse(fileContent)
	} catch (error) {
		throw new ApiMessagesReadError(
			"invalid",
			`Failed to parse API conversation history for ${taskId} at ${filePath}`,
			error,
		)
	}

	if (!Array.isArray(parsedData)) {
		throw new ApiMessagesReadError(
			"invalid",
			`API conversation history for ${taskId} at ${filePath} must be an array, got ${typeof parsedData}`,
		)
	}

	return parsedData
}

async function readApiMessagesFile(taskId: string, filePath: string): Promise<ApiMessage[] | undefined> {
	let fileContent: string
	try {
		fileContent = await readFileWithMissingRetry(filePath)
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			return undefined
		}
		throw new ApiMessagesReadError(
			"io_error",
			`Failed to read API conversation history for ${taskId} at ${filePath}`,
			error,
		)
	}

	return parseApiMessages(fileContent, taskId, filePath)
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)

	const currentMessages = await readApiMessagesFile(taskId, filePath)
	if (currentMessages !== undefined) {
		return currentMessages
	}

	const oldPath = path.join(taskDir, "claude_messages.json")
	const legacyMessages = await readApiMessagesFile(taskId, oldPath)
	if (legacyMessages === undefined) {
		return []
	}

	// Persist the successfully parsed legacy history before deleting its source.
	// The next ordinary task-history save may not happen until after user input,
	// so returning the in-memory data alone would leave a data-loss window.
	console.warn(
		`[readApiMessages] Migrating legacy API conversation history for task ${taskId} from claude_messages.json to api_conversation_history.json.`,
	)
	await safeWriteJson(filePath, legacyMessages, { merge: mergeApiMessageSnapshots })

	try {
		await fs.unlink(oldPath)
	} catch (error) {
		throw new ApiMessagesReadError(
			"io_error",
			`Failed to remove migrated API conversation history for ${taskId} at ${oldPath}`,
			error,
		)
	}
	return legacyMessages
}

export async function saveApiMessages({
	messages,
	taskId,
	globalStoragePath,
	merge = false,
}: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
	merge?: boolean
}): Promise<ApiMessage[]> {
	ensureMessageIdentifiers(messages)
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)
	let savedMessages = messages
	await safeWriteJson(
		filePath,
		messages,
		merge
			? {
					merge: (existing, incoming) => {
						savedMessages = mergeApiMessageSnapshots(existing, incoming) as ApiMessage[]
						return savedMessages
					},
				}
			: undefined,
	)
	return savedMessages
}

/** Repair the original call, not the latest tool by name. Never replace a result. */
export function withDelegationFailure(messages: ApiMessage[], receipt: DelegationAction): ApiMessage[] {
	if (
		messages.some(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "tool_result" && block.tool_use_id === receipt.actionId),
		)
	)
		return messages
	const index = messages.findIndex(
		(message) =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some(
				(block) => block.type === "tool_use" && block.id === receipt.actionId && block.name === "new_task",
			),
	)
	// Internal/legacy calls without a native identity receive only a UI receipt.
	if (index === -1) return messages
	const result: Anthropic.ToolResultBlockParam = {
		type: "tool_result",
		tool_use_id: receipt.actionId,
		is_error: true,
		content: receipt.reason ?? "Delegation stopped",
	}
	const updated = [...messages]
	const next = messages[index + 1]
	if (next?.role === "user") {
		updated[index + 1] = {
			...next,
			content: [
				result,
				...(Array.isArray(next.content) ? next.content : [{ type: "text" as const, text: next.content }]),
			],
		}
	} else {
		updated.splice(index + 1, 0, {
			role: "user",
			content: [result],
			ts: receipt.resultTs,
			messageId: `delegation:${receipt.operationId}:result`,
		})
	}
	return updated
}

export async function saveDelegationFailureResult(
	taskId: string,
	globalStoragePath: string,
	receipt: DelegationAction,
): Promise<void> {
	const filePath = path.join(
		await getTaskDirectoryPath(globalStoragePath, taskId),
		GlobalFileNames.apiConversationHistory,
	)
	await safeWriteJson(filePath, [], {
		merge: (existing) => {
			if (!Array.isArray(existing))
				throw new ApiMessagesReadError("invalid", `Cannot repair unreadable history for ${taskId}`)
			const messages: ApiMessage[] = existing
			const results = messages.flatMap((message) =>
				message.role === "user" && Array.isArray(message.content)
					? message.content.filter(
							(block) => block.type === "tool_result" && block.tool_use_id === receipt.actionId,
						)
					: [],
			)
			if (
				results.length &&
				(results.length !== 1 ||
					results[0].type !== "tool_result" ||
					!results[0].is_error ||
					results[0].content !== (receipt.reason ?? "Delegation stopped"))
			)
				throw new ExecutionAuthorityError("transcript_conflict")
			return withDelegationFailure(messages, receipt)
		},
	})
}

/** Unlike ordinary history loading, this read never migrates/writes before authority validation. */
export async function readApiMessagesForCompletion(taskId: string, globalStoragePath: string): Promise<ApiMessage[]> {
	const directory = await getTaskDirectoryPath(globalStoragePath, taskId)
	const messages = await readApiMessagesFile(taskId, path.join(directory, GlobalFileNames.apiConversationHistory))
	if (messages === undefined) throw new ExecutionAuthorityError("history_missing")
	return messages
}

/** Exact native identity, exactly one actual new_task use, and immutable durable outcome. */
export function withDelegationCompletion(messages: ApiMessage[], receipt: DelegatedCompletionReceipt): ApiMessage[] {
	if (receipt.finish.kind !== "finish_subtask") throw new ExecutionAuthorityError("action_mismatch")
	const calls = messages.flatMap((message, index) =>
		message.role === "assistant" && Array.isArray(message.content)
			? message.content
					.filter((block) => block.type === "tool_use" && block.id === receipt.creating.actionId)
					.map((block) => ({ index, block }))
			: [],
	)
	if (calls.length !== 1 || calls[0].block.type !== "tool_use" || calls[0].block.name !== "new_task")
		throw new ExecutionAuthorityError("receipt_mismatch")
	const results = messages.flatMap((message) =>
		message.role === "user" && Array.isArray(message.content)
			? message.content.filter(
					(block) => block.type === "tool_result" && block.tool_use_id === receipt.creating.actionId,
				)
			: [],
	)
	if (results.length) {
		if (
			results.length !== 1 ||
			results[0].type !== "tool_result" ||
			results[0].is_error ||
			results[0].content !== receipt.finish.result
		)
			throw new ExecutionAuthorityError("transcript_conflict")
		return messages
	}
	const result: Anthropic.ToolResultBlockParam = {
		type: "tool_result",
		tool_use_id: receipt.creating.actionId,
		content: receipt.finish.result,
	}
	const index = calls[0].index
	const updated = [...messages]
	const next = messages[index + 1]
	if (next?.role === "user") {
		updated[index + 1] = {
			...next,
			content: [
				result,
				...(Array.isArray(next.content) ? next.content : [{ type: "text" as const, text: next.content }]),
			],
		}
	} else {
		updated.splice(index + 1, 0, {
			role: "user",
			content: [result],
			ts: receipt.resultTs,
			messageId: `completion:${receipt.operationId}:result`,
		})
	}
	return updated
}

/** Called only while the store holds the storage lifecycle lock. */
export async function saveDelegationCompletionResult(
	taskId: string,
	globalStoragePath: string,
	receipt: DelegatedCompletionReceipt,
): Promise<ApiMessage[]> {
	const current = await readApiMessagesForCompletion(taskId, globalStoragePath)
	const updated = withDelegationCompletion(current, receipt)
	if (updated === current) return current
	await safeWriteJson(
		path.join(await getTaskDirectoryPath(globalStoragePath, taskId), GlobalFileNames.apiConversationHistory),
		updated,
		{
			merge: (disk) => {
				if (!deepEqual(disk, current)) throw new ExecutionAuthorityError("transcript_conflict")
				return updated
			},
		},
	)
	return updated
}
