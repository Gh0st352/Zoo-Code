import * as fs from "fs/promises"
import type { DelegationAction, ExecutionToken, HistoryItem } from "@roo-code/types"

import { Task, type TaskOptions } from "../../core/task/Task"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { TaskHistoryStore } from "../../core/task-persistence/TaskHistoryStore"
import { makeExtensionContext, makeUri } from "../../test-utils/vscode"
import { commitDelegation, reserveDelegation } from "../../core/task-persistence/taskLifecycle"
import { claimWebviewHistory, installWebviewHistoryFiles } from "./webview-fixtures"

/** Unrelated host services are inert; ownership and persistence remain real. */
export function createTaskProvider(storage: string) {
	const provider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
		context: makeExtensionContext({ globalStorageUri: makeUri(storage) }),
		taskHistoryStore: new TaskHistoryStore(storage),
		getState: vi.fn(async () => ({ mode: "code", autoApprovalEnabled: false })),
		log: vi.fn<ClineProvider["log"]>(),
		postMessageToWebview: vi.fn<ClineProvider["postMessageToWebview"]>().mockResolvedValue(undefined),
		postStateToWebviewThrottled: vi.fn<ClineProvider["postStateToWebviewThrottled"]>(),
		flushPostStateToWebviewThrottled: vi
			.fn<ClineProvider["flushPostStateToWebviewThrottled"]>()
			.mockResolvedValue(undefined),
		postClineMessagesSnapshot: vi.fn<ClineProvider["postClineMessagesSnapshot"]>().mockResolvedValue(undefined),
		postClineMessageAppended: vi.fn<ClineProvider["postClineMessageAppended"]>().mockResolvedValue(undefined),
		postClineMessageUpdated: vi.fn<ClineProvider["postClineMessageUpdated"]>().mockResolvedValue(undefined),
		isClineMessagesPartialCoalescingActive: () => false,
	})
	provider["ownedExecutions"] = new Map()
	provider["recoveryPreviewSequence"] = 0
	return provider
}

/** Preserve suite-specific transcript fixtures while making history metadata authoritative. */
export function installTaskHistoryFiles() {
	const read = vi.mocked(fs.readFile).getMockImplementation()
	const files = installWebviewHistoryFiles()
	const readStored = vi.mocked(fs.readFile).getMockImplementation()!
	vi.mocked(fs.readFile).mockImplementation(async (...args) => {
		try {
			return await readStored(...args)
		} catch (error) {
			if (String(args[0]).endsWith("history_item.json") || !read) throw error
			return read(...args)
		}
	})
	return files
}

/**
 * Build synthetic prior history through the real store BEFORE constructing a Task.
 * This is not history adoption: every ID must be absent, and interrupted/completed
 * records must use explicit recovery/observer setup instead. Runtime guards and
 * snapshot writes remain the production implementation.
 */
export async function claimTaskOptions(options: TaskOptions): Promise<TaskOptions> {
	const { provider, historyItem, parentTask } = options
	const store = provider.taskHistoryStore
	const history: HistoryItem = historyItem ?? {
		id: options.taskId ?? crypto.randomUUID(),
		number: 1,
		ts: Date.now(),
		task: options.task ?? "Test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}
	const { pendingAction, ...newHistory } = history
	let token: ExecutionToken
	if (parentTask) {
		const parentToken = parentTask.executionToken
		if (!parentToken) throw new Error("Delegation fixture requires a claimed parent")
		const intent = {
			kind: "create_subtask",
			actionId: `create-${history.id}`,
			approvalText: "{}",
			message: history.task,
			mode: "code",
			todos: [],
		} as const
		const parent = await store.lifecycleCommand(
			parentTask.taskId,
			(current) => ({ ...current, pendingAction: { ...intent, todos: [] } }),
			[],
			true,
			parentToken,
		)
		const receipt: DelegationAction = {
			actionId: intent.actionId,
			operationId: `delegate-${history.id}`,
			childId: history.id,
			ownerToken: parentToken.owner.runtimeId,
			executionToken: parentToken,
			generation: parentToken.generation,
			revision: parent.lifecycleRevision!,
			phase: "prepared",
			attempts: 1,
			resultTs: Date.now(),
			intent: { ...intent, todos: [] },
		}
		await store.lifecycleCommand(
			parent.id,
			(current, related) =>
				reserveDelegation(
					current,
					receipt,
					related.get(current.parentTaskId ?? ""),
					related.get(current.awaitingChildId ?? ""),
				),
			[],
			true,
			parentToken,
		)
		const claim = await store.claimDelegationChild(
			{
				...newHistory,
				parentTaskId: parent.id,
				rootTaskId: parent.rootTaskId ?? parent.id,
				delegationOrigin: { parentId: parent.id, operationId: receipt.operationId },
			},
			store.ownerForRuntime(`runtime-${history.id}`),
			parentToken,
			receipt,
		)
		if (claim.kind !== "applied") throw new Error(`Child claim refused: ${claim.reason}`)
		await store.lifecycleCommand(
			parent.id,
			(current, related) =>
				commitDelegation(
					current,
					receipt,
					related.get(current.parentTaskId ?? ""),
					related.get(current.awaitingChildId ?? ""),
				),
			[history.id],
			true,
			parentToken,
		)
		token = Object.freeze({ ...claim.token, owner: Object.freeze({ ...claim.token.owner }) })
	} else {
		token = (await claimWebviewHistory(provider, newHistory)).executionToken
	}
	if (pendingAction) {
		await store.lifecycleCommand(history.id, (current) => ({ ...current, pendingAction }), [], true, token)
	}
	return {
		...options,
		taskId: history.id,
		historyItem: historyItem ? await store.readAuthoritative(history.id) : undefined,
		executionToken: token,
		onCreated: (task) => {
			provider["rememberExecution"](token, task)
			options.onCreated?.(task)
		},
	}
}

export async function createClaimedTask(options: TaskOptions): Promise<Task> {
	return new Task(await claimTaskOptions(options))
}
