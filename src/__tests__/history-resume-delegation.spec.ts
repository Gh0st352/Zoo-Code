// npx vitest run __tests__/history-resume-delegation.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { RooCodeEventName, type PendingTaskAction } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { ClineProvider } from "../core/webview/ClineProvider"
import { Task } from "../core/task/Task"
import { TaskRegistry } from "../core/task/TaskRegistry"
import { TaskScheduler } from "../core/task/TaskScheduler"
import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"
import { completionState, executionClaim } from "../core/task-persistence/taskLifecycle"
import * as apiMessages from "../core/task-persistence/apiMessages"
import * as taskMessages from "../core/task-persistence/taskMessages"
import * as safeJson from "../utils/safeWriteJson"
import * as apiModule from "../api"
import * as ignoreController from "../core/ignore/RooIgnoreController"
import * as environment from "../core/environment/getEnvironmentDetails"
import { makeExtensionContext, makeUri } from "../test-utils/vscode"
import { attemptCompletionTool } from "../core/tools/AttemptCompletionTool"

class BoundedScheduler extends TaskScheduler {
	readonly queued: Array<{ task: Task; run: () => Promise<void> }> = []
	override schedule(task: Task, run: () => Promise<void>): Promise<void> {
		this.queued.push({ task, run })
		return Promise.resolve()
	}
	async drain() {
		const next = this.queued.shift()
		if (next) await super.schedule(next.task, next.run)
	}
}

describe("History resume delegation - parent metadata transitions", () => {
	let directory: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	let parent: Task
	let child: Task
	let scheduler: BoundedScheduler
	const tasks: Task[] = []
	const emit = vi.fn<(event: string, ...args: unknown[]) => boolean>().mockReturnValue(true)
	const creating: PendingTaskAction = {
		kind: "create_subtask",
		actionId: "create-child",
		approvalText: "{}",
		mode: "code",
		message: "Child",
		todos: [],
	}

	beforeEach(async () => {
		emit.mockClear()
		const prototype = ignoreController.RooIgnoreController.prototype
		vi.spyOn(ignoreController, "RooIgnoreController").mockImplementation(function () {
			return Object.assign(Object.create(prototype) as ignoreController.RooIgnoreController, {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				validateAccess: () => true,
			})
		})
		vi.spyOn(apiModule, "buildApiHandler").mockImplementation(() => ({
			getModel: () => ({ id: "offline", info: { contextWindow: 10000, supportsPromptCache: false } }),
			countTokens: vi.fn().mockResolvedValue(1),
			createMessage: () => {
				throw new Error("Unexpected model request")
			},
		}))
		vi.spyOn(environment, "getEnvironmentDetails").mockResolvedValue("<environment_details />")
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-history-completion-"))
		store = new TaskHistoryStore(directory)
		await store.initialize()
		scheduler = new BoundedScheduler()
		const context = makeExtensionContext({ globalStorageUri: makeUri(directory) })
		// Real provider, Task, store and cleanup; only shell services and model-loop work are isolated.
		provider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			context,
			contextProxy: { globalStorageUri: context.globalStorageUri, getValue: () => undefined },
			taskHistoryStore: store,
			taskRegistry: new TaskRegistry(),
			taskScheduler: scheduler,
			taskEventListeners: new WeakMap(),
			clineMessagesSeqByTaskId: new Map(),
			delegationTransitionLocks: new Map(),
			delegationApprovals: new WeakMap(),
			completionApprovals: new WeakMap(),
			ownedExecutions: new Map(),
			cleanupOperations: new WeakMap(),
			delegationEpoch: 0,
			recoveryPreviewSequence: 0,
			recoveryInFlight: false,
			historyTaskCreationQueue: Promise.resolve(),
			_disposed: false,
			customModesManager: { getCustomModes: async () => [] },
			providerSettingsManager: { getModeConfigId: async () => undefined, listConfig: async () => [] },
			getPendingEditOperation: () => undefined,
			getState: vi.fn().mockResolvedValue({
				mode: "code",
				apiConfiguration: {},
				enableCheckpoints: false,
				organizationAllowList: { allowAll: true },
				autoApprovalEnabled: false,
			}),
			setValues: vi.fn(),
			updateGlobalState: vi.fn(),
			handleModeSwitch: vi.fn(),
			emit,
			log: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			syncFocusedTaskToWebview: vi.fn(),
			postStateToWebviewThrottled: vi.fn(),
			flushPostStateToWebviewThrottled: vi.fn(),
			postClineMessagesSnapshot: vi.fn(),
			postClineMessageAppended: vi.fn(),
			postClineMessageUpdated: vi.fn(),
			taskCreationCallback: (task: Task) => {
				tasks.push(task)
				task["initiateTaskLoop"] = vi.fn().mockResolvedValue(undefined)
			},
		})
		parent = await provider.createTask("", undefined, undefined, { taskId: "parent", startTask: false })
		await parent.overwriteClineMessages([{ ts: 1, type: "ask", ask: "tool", text: "Old tool" }])
		await parent.overwriteApiConversationHistory([
			{ ts: 1, role: "user", content: "Old request" },
			{
				ts: 2,
				role: "assistant",
				content: [{ type: "tool_use", id: creating.actionId, name: "new_task", input: {} }],
			},
		])
		await provider.setPendingTaskAction(parent.taskId, creating, parent)
		parent.setPendingTaskAction(creating)
		expect(await provider.validateTaskDelegation(parent, creating)).toBe(true)
		child = await provider.delegateParentAndOpenChild({
			parentTaskId: parent.taskId,
			origin: parent,
			pendingActionId: creating.actionId,
			mode: "code",
			message: "Child",
			initialTodos: [],
		})
		scheduler.queued.length = 0
		vi.spyOn(provider, "createTaskWithHistoryItem")
		vi.spyOn(provider, "removeClineFromStack")
		vi.spyOn(store, "completeDelegatedTask")
		vi.spyOn(store, "atomicUpdatePair")
		vi.mocked(provider.emit).mockClear()
	})

	afterEach(async () => {
		scheduler.queued.length = 0
		// The provider owns settlement. Never lend its fenced cleanup token to a Task.
		for (const task of tasks.splice(0)) await provider["stopOwnedTask"](task)
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function completion(result = "Done", task = child) {
		const finish: Extract<PendingTaskAction, { kind: "finish_subtask" }> = {
			kind: "finish_subtask",
			actionId: `finish-${task.taskId}`,
			approvalText: "{}",
			parentTaskId: parent.taskId,
			result,
		}
		await provider.setPendingTaskAction(task.taskId, finish, task)
		task.setPendingTaskAction(finish)
		const request = await provider.prepareDelegatedCompletion(task, finish)
		expect(request).toBeDefined()
		if (!request) throw new Error("Completion approval was not captured")
		expect(Object.isFrozen(request)).toBe(true)
		expect(Object.isFrozen(request.childToken.owner)).toBe(true)
		return {
			origin: task,
			request,
			parentTaskId: parent.taskId,
			childTaskId: task.taskId,
			completionResultSummary: result,
			pendingActionId: finish.actionId,
		}
	}
	const ui = () => taskMessages.readTaskMessages({ taskId: parent.taskId, globalStoragePath: directory })
	const api = () => apiMessages.readApiMessages({ taskId: parent.taskId, globalStoragePath: directory })
	const apiPath = () => path.join(directory, "tasks", parent.taskId, "api_conversation_history.json")

	async function expectNoCompletion(params: Awaited<ReturnType<typeof completion>>) {
		const before = await Promise.all([
			store.readAuthoritative(parent.taskId),
			store.readAuthoritative(child.taskId),
			ui(),
			api(),
		])
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(false)
		expect(writes).not.toHaveBeenCalled()
		expect(
			await Promise.all([
				store.readAuthoritative(parent.taskId),
				store.readAuthoritative(child.taskId),
				ui(),
				api(),
			]),
		).toEqual(before)
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(store.atomicUpdatePair).not.toHaveBeenCalled()
	}

	it("rejects a stale restored completion action before changing parent or child state", async () => {
		const params = await completion()
		await expectNoCompletion({ ...params, pendingActionId: "stale-action" })
		expect(store.completeDelegatedTask).not.toHaveBeenCalled()
	})

	it("rejects an ownership change detected inside the strict completion boundary before transcript writes", async () => {
		const params = await completion()
		const complete = TaskHistoryStore.prototype.completeDelegatedTask.bind(store)
		vi.mocked(store.completeDelegatedTask).mockImplementationOnce(async (...args) => {
			await store.lifecycleCommand(
				child.taskId,
				(item) => ({ ...item, pendingAction: { ...params.request.finish, actionId: "replacement-action" } }),
				[],
				true,
				child.executionToken,
			)
			return complete(...args)
		})
		const beforeUi = await ui(),
			beforeApi = await api()
		await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(false)
		expect(store.completeDelegatedTask).toHaveBeenCalledTimes(1)
		expect(await vi.mocked(store.completeDelegatedTask).mock.results[0].value).toMatchObject({ kind: "refused" })
		expect(await ui()).toEqual(beforeUi)
		expect(await api()).toEqual(beforeApi)
		expect((await store.readAuthoritative(child.taskId)).pendingAction?.actionId).toBe("replacement-action")
		expect(completionState(await store.readAuthoritative(parent.taskId)).receipts).toEqual([])
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("reopenParentFromDelegation refuses a contradictory active parent awaiting the returning child", async () => {
		const params = await completion("Child done")
		const history = await store.readAuthoritative(parent.taskId)
		// Deliberate legacy contradiction, not an authorized active-parent normalization.
		await safeJson.safeWriteJson(path.join(directory, "tasks", parent.taskId, "history_item.json"), {
			...history,
			status: "active",
		})
		await expectNoCompletion(params)
		expect((await store.readAuthoritative(parent.taskId)).awaitingChildId).toBe(child.taskId)
	})

	it("reopenParentFromDelegation injects subtask_result into both UI and API histories", async () => {
		const params = await completion("Subtask completed successfully")
		const originalUi = await ui(),
			originalApi = await api()
		await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
		expect(await ui()).toEqual([
			...originalUi,
			expect.objectContaining({
				messageId: `completion:${params.request.operationId}:ui`,
				type: "say",
				say: "subtask_result",
				text: params.completionResultSummary,
			}),
		])
		expect(await api()).toEqual([
			...originalApi,
			expect.objectContaining({
				role: "user",
				messageId: `completion:${params.request.operationId}:result`,
				content: [
					{ type: "tool_result", tool_use_id: creating.actionId, content: params.completionResultSummary },
				],
			}),
		])
	})

	it("hydrates the reopened parent from locked merge results without authoritative rewrites", async () => {
		const params = await completion()
		const save = taskMessages.saveTaskMessages
		vi.spyOn(taskMessages, "saveTaskMessages").mockImplementationOnce(async (options) => {
			await save({
				...options,
				messages: [{ ts: 3, type: "say", say: "text", text: "concurrent UI" }],
				merge: true,
			})
			return save(options)
		})
		// A concurrent API tail must survive exact creating-call routing too.
		await safeJson.safeWriteJson(apiPath(), [
			...(await api()),
			{ messageId: "concurrent-api", ts: 3, role: "assistant", content: "concurrent API" },
		])
		const overwriteUi = vi.spyOn(Task.prototype, "overwriteClineMessages")
		const overwriteApi = vi.spyOn(Task.prototype, "overwriteApiConversationHistory")
		await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
		expect(overwriteUi).toHaveBeenCalledWith(await ui(), false)
		expect(overwriteApi).toHaveBeenCalledWith(await api(), false)
		expect(provider.getCurrentTask()?.clineMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: "Old tool" }),
				expect.objectContaining({ text: "concurrent UI" }),
				expect.objectContaining({ say: "subtask_result", text: "Done" }),
			]),
		)
		expect(provider.getCurrentTask()?.apiConversationHistory).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ content: "Old request" }),
				expect.objectContaining({ content: "concurrent API" }),
				expect.objectContaining({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: creating.actionId, content: "Done" }],
				}),
			]),
		)
	})

	it("does not reopen or overwrite a parent when its UI history cannot be read", async () => {
		const params = await completion()
		vi.spyOn(taskMessages, "readTaskMessages").mockRejectedValueOnce(new Error("history unavailable"))
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		await expect(provider.reopenParentFromDelegation(params)).rejects.toThrow("history unavailable")
		expect(writes).not.toHaveBeenCalled()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(store.atomicUpdatePair).not.toHaveBeenCalled()
		expect(child.cleanupSettled).toBe(false)
	})

	it("does not reopen or overwrite a parent when its API history cannot be read", async () => {
		const params = await completion()
		vi.spyOn(apiMessages, "readApiMessagesForCompletion").mockRejectedValueOnce(
			new Error("api history unavailable"),
		)
		const readUi = vi.spyOn(taskMessages, "readTaskMessages"),
			writes = vi.spyOn(safeJson, "safeWriteJson")
		await expect(provider.reopenParentFromDelegation(params)).rejects.toThrow("api history unavailable")
		expect(readUi).not.toHaveBeenCalled()
		expect(writes).not.toHaveBeenCalled()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(store.atomicUpdatePair).not.toHaveBeenCalled()
	})

	it("reopenParentFromDelegation injects tool_result for the exact creating new_task tool_use", async () => {
		const params = await completion("Subtask completed via tool_result")
		// The latest tool by name must NOT steal this child's result.
		await safeJson.safeWriteJson(apiPath(), [
			...(await api()),
			{
				ts: 4,
				role: "assistant",
				content: [{ type: "tool_use", id: "later-new-task", name: "new_task", input: {} }],
			},
		])
		await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
		const messages = await api()
		expect(messages).toHaveLength(4)
		expect(messages[2]).toMatchObject({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: creating.actionId, content: "Subtask completed via tool_result" },
			],
		})
		// Strict completion keeps the exact approved result, not the former synthetic text envelope.
		expect(messages[3].content).toEqual([{ type: "tool_use", id: "later-new-task", name: "new_task", input: {} }])
	})

	it("reopenParentFromDelegation refuses missing new_task tool_use instead of injecting plain text", async () => {
		const params = await completion("Subtask completed without tool_use")
		await safeJson.safeWriteJson(apiPath(), [{ ts: 1, role: "user", content: "Create a subtask" }])
		await expectNoCompletion(params)
		expect(await vi.mocked(store.completeDelegatedTask).mock.results[0].value).toMatchObject({
			kind: "refused",
			reason: "receipt_mismatch",
		})
	})

	it("reopenParentFromDelegation sets skipPrevResponseIdOnce via resumeAfterDelegation", async () => {
		const resume = vi.spyOn(Task.prototype, "resumeAfterDelegation")
		await expect(provider.reopenParentFromDelegation(await completion())).resolves.toBe(true)
		await scheduler.drain()
		expect(provider.getCurrentTask()?.skipPrevResponseIdOnce).toBe(true)
		expect(resume).toHaveBeenCalledTimes(1)
	})

	it("reopenParentFromDelegation emits events in correct order: TaskDelegationCompleted → TaskDelegationResumed", async () => {
		await expect(provider.reopenParentFromDelegation(await completion("Summary"))).resolves.toBe(true)
		const completed = emit.mock.calls.findIndex(([event]) => event === RooCodeEventName.TaskDelegationCompleted)
		const resumed = emit.mock.calls.findIndex(([event]) => event === RooCodeEventName.TaskDelegationResumed)
		expect(completed).toBeGreaterThanOrEqual(0)
		expect(resumed).toBeGreaterThan(completed)
		expect(vi.mocked(store.completeDelegatedTask).mock.invocationCallOrder[0]).toBeLessThan(
			emit.mock.invocationCallOrder[completed],
		)
		expect(child.cleanupSettled).toBe(true)
		expect(executionClaim(await store.readAuthoritative(child.taskId)).phase).toBe("settled")
	})

	it.each(["UI", "API"] as const)(
		"reopenParentFromDelegation preserves completion but pauses on %s hydration failure (RPD-06)",
		async (history) => {
			const params = await completion("Subtask finished despite overwrite failures")
			const overwriteUi = vi.spyOn(Task.prototype, "overwriteClineMessages")
			const overwriteApi = vi.spyOn(Task.prototype, "overwriteApiConversationHistory")
			;(history === "UI" ? overwriteUi : overwriteApi).mockRejectedValueOnce(
				new Error(`${history} overwrite failed`),
			)
			await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
			expect(overwriteUi).toHaveBeenCalledTimes(1)
			expect(overwriteApi).toHaveBeenCalledTimes(history === "API" ? 1 : 0)
			expect(scheduler.queued).toHaveLength(0)
			expect(provider.emit).toHaveBeenCalledWith(
				RooCodeEventName.TaskDelegationCompleted,
				parent.taskId,
				child.taskId,
				params.completionResultSummary,
			)
			expect(provider.emit).not.toHaveBeenCalledWith(
				RooCodeEventName.TaskDelegationResumed,
				parent.taskId,
				child.taskId,
			)
			expect(provider.log).toHaveBeenCalledWith(expect.stringContaining(`${history} overwrite failed`))
			expect((await store.readAuthoritative(child.taskId)).status).toBe("completed")
			expect((await store.readAuthoritative(parent.taskId)).awaitingChildId).toBeUndefined()
			expect(await provider.getCurrentTask()?.guardExecution()).toBe(false)
		},
	)

	it("reopenParentFromDelegation does NOT emit TaskPaused or TaskUnpaused (new flow only)", async () => {
		await expect(provider.reopenParentFromDelegation(await completion())).resolves.toBe(true)
		const names = emit.mock.calls.map(([name]) => name)
		expect(names).toContain(RooCodeEventName.TaskDelegationResumed)
		for (const name of [RooCodeEventName.TaskPaused, RooCodeEventName.TaskUnpaused, RooCodeEventName.TaskSpawned])
			expect(names).not.toContain(name)
	})

	it("reopenParentFromDelegation leaves a different current task untouched and refuses stale focus (RPD-02)", async () => {
		const params = await completion("Child done without being current")
		const different = await provider.createTask("", undefined, undefined, { startTask: false })
		vi.mocked(provider.removeClineFromStack).mockClear()
		await expectNoCompletion(params)
		expect(provider.getCurrentTask()).toBe(different)
		expect(store.completeDelegatedTask).not.toHaveBeenCalled()
	})

	it("reopenParentFromDelegation propagates strict completion persistence failure — parent not reopened (RPD-04)", async () => {
		const params = await completion()
		const beforeUi = await ui(),
			beforeApi = await api()
		vi.spyOn(safeJson, "safeWriteJson").mockRejectedValueOnce(new Error("prepared receipt write failed"))
		await expect(provider.reopenParentFromDelegation(params)).rejects.toThrow("Lifecycle write not_committed")
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(await ui()).toEqual(beforeUi)
		expect(await api()).toEqual(beforeApi)
	})

	it("reopenParentFromDelegation aborts parent reopen when all persistence paths fail (RPD-05)", async () => {
		const params = await completion()
		const write = vi.spyOn(safeJson, "safeWriteJson").mockRejectedValue(new Error("all persistence unavailable"))
		const fallback = vi.spyOn(provider, "updateTaskHistory")
		await expect(provider.reopenParentFromDelegation(params)).rejects.toThrow("Lifecycle write not_committed")
		expect(write).toHaveBeenCalledTimes(1)
		expect(fallback).not.toHaveBeenCalled()
		expect(store.atomicUpdatePair).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.cleanupSettled).toBe(false)
		write.mockRestore()
	})

	it("handles empty histories conservatively without synthesizing an unowned completion", async () => {
		const params = await completion("Result")
		await safeJson.safeWriteJson(apiPath(), [])
		await safeJson.safeWriteJson(path.join(directory, "tasks", parent.taskId, "ui_messages.json"), [])
		await expectNoCompletion(params)
		expect(await ui()).toEqual([])
		expect(await api()).toEqual([])
	})

	it("reopenParentFromDelegation aborts when parent is already active (stale-delegation guard)", async () => {
		const params = await completion()
		await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
		vi.mocked(provider.createTaskWithHistoryItem).mockClear()
		vi.mocked(provider.removeClineFromStack).mockClear()
		await expectNoCompletion(params)
		expect((await store.readAuthoritative(parent.taskId)).status).toBe("active")
	})

	it("reopenParentFromDelegation aborts when in-process cancellation failed closed", async () => {
		const params = await completion()
		const interrupt = vi.spyOn(store, "interruptTask").mockRejectedValueOnce(new Error("fence unavailable"))
		await provider["stopOwnedTask"](child)
		expect(interrupt).toHaveBeenCalled()
		expect(provider["ownedExecutions"].get(child.taskId)?.snapshotFailed).toBe(true)
		await expectNoCompletion(params)
	})

	it("reopenParentFromDelegation aborts when parent awaits a different child (stale-delegation guard)", async () => {
		const params = await completion()
		// Inject a newer graph observation after preapproval; it must never be overwritten.
		const history = await store.readAuthoritative(parent.taskId)
		await safeJson.safeWriteJson(path.join(directory, "tasks", parent.taskId, "history_item.json"), {
			...history,
			awaitingChildId: "other-child",
			delegatedToId: "other-child",
		})
		await expectNoCompletion(params)
		expect((await store.readAuthoritative(parent.taskId)).awaitingChildId).toBe("other-child")
	})

	it("serializes delegation transitions and continues after a rejected predecessor", async () => {
		const calls: string[] = []
		let rejectFirst!: (error: Error) => void
		const first = provider["runDelegationTransition"]("parent-lock", async () => {
			calls.push("first")
			await new Promise<void>((_resolve, reject) => {
				rejectFirst = reject
			})
		})
		const second = provider["runDelegationTransition"]("parent-lock", async () => {
			calls.push("second")
			return "done"
		})
		await Promise.resolve()
		expect(calls).toEqual(["first"])
		rejectFirst(new Error("first transition failed"))
		await expect(first).rejects.toThrow("first transition failed")
		await expect(second).resolves.toBe("done")
		expect(calls).toEqual(["first", "second"])
	})

	it("reopenParentFromDelegation posts taskHistoryItemUpdated for both records when view is launched", async () => {
		provider.isViewLaunched = true
		const params = await completion()
		vi.mocked(provider.postMessageToWebview).mockClear()
		await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
		const posts = vi.mocked(provider.postMessageToWebview)
		const updates = posts.mock.calls.filter(([message]) => message.type === "taskHistoryItemUpdated")
		expect(updates).toHaveLength(2)
		expect(updates).toEqual(
			expect.arrayContaining([
				[
					expect.objectContaining({
						taskHistoryItem: expect.objectContaining({ id: child.taskId, status: "completed" }),
					}),
				],
				[
					expect.objectContaining({
						taskHistoryItem: expect.objectContaining({ id: parent.taskId, status: "active" }),
					}),
				],
			]),
		)
		for (const call of updates)
			expect(vi.mocked(store.completeDelegatedTask).mock.invocationCallOrder[0]).toBeLessThan(
				posts.mock.invocationCallOrder[posts.mock.calls.indexOf(call)],
			)
	})

	it("reopenParentFromDelegation does NOT post taskHistoryItemUpdated when view is not launched", async () => {
		provider.isViewLaunched = false
		await expect(provider.reopenParentFromDelegation(await completion())).resolves.toBe(true)
		expect(
			vi
				.mocked(provider.postMessageToWebview)
				.mock.calls.filter(([message]) => message.type === "taskHistoryItemUpdated"),
		).toHaveLength(0)
	})

	it.each([0, 1])(
		"completion notification failure for record %s does not suppress the other record or replay completion",
		async (failedIndex) => {
			provider.isViewLaunched = true
			const params = await completion()
			const posts = vi.mocked(provider.postMessageToWebview)
			posts.mockClear()
			if (failedIndex === 1) posts.mockResolvedValueOnce(undefined)
			posts.mockRejectedValueOnce(new Error("view unavailable"))
			await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
			expect(posts.mock.calls.filter(([message]) => message.type === "taskHistoryItemUpdated")).toHaveLength(2)
			expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("Post-commit notification failed"))
			expect(provider.getCurrentTask()?.taskId).toBe(parent.taskId)
			expect(provider.emit).toHaveBeenCalledWith(
				RooCodeEventName.TaskDelegationResumed,
				parent.taskId,
				child.taskId,
			)
			await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(false)
			expect(store.completeDelegatedTask).toHaveBeenCalledTimes(1)
			expect((await ui()).filter((message) => message.say === "subtask_result")).toHaveLength(1)
		},
	)

	describe("strict completion handoff correctness", () => {
		it("after reopenParentFromDelegation, child completion precedes parent activation and reopening", async () => {
			const params = await completion("Child done")
			const runtimeToken = child.executionToken
			const persist = vi.fn(store["persistLifecycle"].bind(store))
			store["persistLifecycle"] = persist
			await expect(provider.reopenParentFromDelegation(params)).resolves.toBe(true)
			const updates = persist.mock.calls.map(([, item]) => item)
			const preparedIndex = updates.findIndex((item) =>
				completionState(item).receipts.some((entry) => entry.phase === "prepared"),
			)
			const childIndex = updates.findIndex((item) => item.id === child.taskId && item.status === "completed")
			const parentIndex = updates.findIndex((item) => item.id === parent.taskId && item.status === "active")
			expect(preparedIndex).toBeGreaterThanOrEqual(0)
			expect(childIndex).toBeGreaterThan(preparedIndex)
			expect(parentIndex).toBeGreaterThan(childIndex)
			expect(updates[childIndex]).toMatchObject({
				status: "completed",
				completionResultSummary: "Child done",
				pendingAction: undefined,
			})
			expect(updates[parentIndex]).toMatchObject({
				status: "active",
				completedByChildId: child.taskId,
				completionResultSummary: "Child done",
				awaitingChildId: undefined,
				delegatedToId: undefined,
				childIds: [child.taskId],
			})
			expect(vi.mocked(provider.createTaskWithHistoryItem).mock.invocationCallOrder[0]).toBeGreaterThan(
				persist.mock.invocationCallOrder[parentIndex],
			)
			expect(provider.removeClineFromStack).toHaveBeenCalledExactlyOnceWith()
			expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith(
				expect.objectContaining({ status: "active", completedByChildId: child.taskId }),
				expect.objectContaining({
					startTask: false,
					executionToken: provider.getCurrentTask()?.executionToken,
					isCurrent: expect.any(Function),
				}),
			)
			expect(child.executionToken).toBe(runtimeToken)
			expect(provider["ownedExecutions"].get(child.taskId)?.token.generation).toBeGreaterThan(
				runtimeToken!.generation,
			)
			expect(store.atomicUpdatePair).not.toHaveBeenCalled()
		})
	})

	describe("Issue #566 — manual stop/resume of a delegated subtask", () => {
		it("reopens the parent after a subtask is cancelled mid-stream, explicitly resumed, and completes", async () => {
			await provider["stopOwnedTask"](child)
			expect((await store.readAuthoritative(child.taskId)).status).toBe("interrupted")
			expect((await store.readAuthoritative(parent.taskId)).awaitingChildId).toBe(child.taskId)
			const observer = await provider.createTaskWithHistoryItem(await store.readAuthoritative(child.taskId))
			expect(observer.executionToken).toBeUndefined()
			expect(scheduler.queued).toHaveLength(0)
			const prompt = await provider.previewTaskRecovery(child.taskId)
			expect(prompt.choices).toContain("resume_linked")
			await expect(
				provider.recoverTask({
					taskId: child.taskId,
					promptId: prompt.promptId,
					choice: "resume_linked",
					intent: "explicit_user_resume",
				}),
			).resolves.toMatchObject({ kind: "applied" })
			const resumed = provider.getCurrentTask()!
			expect(resumed).not.toBe(observer)
			expect(resumed.parentTask).toBeUndefined()
			expect(resumed.parentTaskId).toBe(parent.taskId)
			expect(await resumed.guardExecution()).toBe(true)
			scheduler.queued.length = 0
			vi.spyOn(resumed, "say").mockResolvedValue(undefined)
			const prepare = vi.spyOn(provider, "prepareDelegatedCompletion")
			const approve = vi.fn(async () => {
				expect(prepare).toHaveBeenCalledTimes(1)
				expect(Object.isFrozen(await prepare.mock.results[0].value)).toBe(true)
				return true
			})
			await attemptCompletionTool.execute({ result: "Child finished after resume" }, resumed, {
				toolCallId: "finish-resumed",
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: vi.fn(),
				askFinishSubTaskApproval: approve,
				toolDescription: () => "finish",
			})
			expect(approve).toHaveBeenCalledTimes(1)
			expect(provider.getCurrentTask()?.taskId).toBe(parent.taskId)
			expect((await store.readAuthoritative(child.taskId)).status).toBe("completed")
			expect(await store.readAuthoritative(parent.taskId)).toMatchObject({
				status: "active",
				completedByChildId: child.taskId,
			})
			expect((await store.readAuthoritative(parent.taskId)).awaitingChildId).toBeUndefined()
			expect(provider.emit).toHaveBeenCalledWith(
				RooCodeEventName.TaskDelegationCompleted,
				parent.taskId,
				child.taskId,
				"Child finished after resume",
			)
			expect(provider.emit).toHaveBeenCalledWith(
				RooCodeEventName.TaskDelegationResumed,
				parent.taskId,
				child.taskId,
			)
		})
	})
})
