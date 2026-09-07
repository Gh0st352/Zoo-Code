// npx vitest run __tests__/nested-delegation-resume.spec.ts

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
import { completionState, delegationState, executionClaim } from "../core/task-persistence/taskLifecycle"
import { readApiMessages } from "../core/task-persistence/apiMessages"
import { readTaskMessages } from "../core/task-persistence/taskMessages"
import { attemptCompletionTool } from "../core/tools/AttemptCompletionTool"
import * as apiModule from "../api"
import * as ignoreController from "../core/ignore/RooIgnoreController"
import * as environment from "../core/environment/getEnvironmentDetails"
import { makeExtensionContext, makeUri } from "../test-utils/vscode"

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

describe("Nested delegation resume (A → B → C)", () => {
	let directory: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	let scheduler: BoundedScheduler
	const tasks: Task[] = []

	const emit = vi.fn<(event: string, ...args: unknown[]) => boolean>().mockReturnValue(true)

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
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-nested-completion-"))
		store = new TaskHistoryStore(directory)
		await store.initialize()
		scheduler = new BoundedScheduler()
		const context = makeExtensionContext({ globalStorageUri: makeUri(directory) })
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
			postMessageToWebview: vi.fn(),
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
	})

	afterEach(async () => {
		scheduler.queued.length = 0
		for (const task of tasks.splice(0)) await provider["stopOwnedTask"](task)
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function delegate(parent: Task, actionId: string) {
		const intent: PendingTaskAction = {
			kind: "create_subtask",
			actionId,
			approvalText: "{}",
			mode: "code",
			message: "Child",
			todos: [],
		}
		await parent.overwriteClineMessages([{ ts: 1, type: "say", say: "text", text: parent.taskId }])
		await parent.overwriteApiConversationHistory([
			{ ts: 1, role: "assistant", content: [{ type: "tool_use", id: actionId, name: "new_task", input: {} }] },
		])
		await provider.setPendingTaskAction(parent.taskId, intent, parent)
		parent.setPendingTaskAction(intent)
		expect(await provider.validateTaskDelegation(parent, intent)).toBe(true)
		const child = await provider.delegateParentAndOpenChild({
			parentTaskId: parent.taskId,
			origin: parent,
			pendingActionId: actionId,
			mode: "code",
			message: "Child",
			initialTodos: [],
		})
		expect(delegationState(await store.readAuthoritative(parent.taskId)).actions).toEqual([
			expect.objectContaining({
				actionId,
				childId: child.taskId,
				phase: "committed",
				executionToken: parent.executionToken,
			}),
		])
		expect(parent.cleanupSettled).toBe(true)
		scheduler.queued.length = 0
		return child
	}

	it("C completes → reopens B; then B completes → reopens A; emits correct events; no resume_task asks", async () => {
		const a = await provider.createTask("", undefined, undefined, { taskId: "A", startTask: false })
		const b = await delegate(a, "create-B")
		const c = await delegate(b, "create-C")
		// The first completion also routes without relying on a live parent reference.
		Object.assign(c, { parentTask: undefined })
		const ask = vi.spyOn(Task.prototype, "ask")
		const reopen = vi.spyOn(provider, "createTaskWithHistoryItem")
		const prepare = vi.spyOn(provider, "prepareDelegatedCompletion")
		const complete = vi.spyOn(provider, "reopenParentFromDelegation")
		const handleError = vi.fn()
		const approve = vi.fn(async () => {
			const request = await prepare.mock.results.at(-1)!.value
			expect(request).toBeDefined()
			expect(Object.isFrozen(request)).toBe(true)
			expect(Object.isFrozen(request!.finish)).toBe(true)
			return true
		})
		async function finish(task: Task, result: string, actionId: string) {
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			const token = task.executionToken
			await attemptCompletionTool.execute({ result }, task, {
				toolCallId: actionId,
				askApproval: vi.fn(),
				handleError,
				pushToolResult: vi.fn(),
				askFinishSubTaskApproval: approve,
				toolDescription: () => "finish",
			})
			expect(task.executionToken).toBe(token)
			expect(executionClaim(await store.readAuthoritative(task.taskId)).phase).toBe("settled")
			expect(task.cleanupSettled).toBe(true)
			expect(complete).toHaveBeenLastCalledWith(
				expect.objectContaining({
					origin: task,
					pendingActionId: actionId,
					request: await prepare.mock.results.at(-1)!.value,
				}),
			)
		}

		await finish(c, "C finished", "finish-C")
		const resumedB = provider.getCurrentTask()!
		expect(resumedB.taskId).toBe(b.taskId)
		expect(resumedB).not.toBe(b)
		expect(resumedB.parentTask).toBeUndefined()
		expect(resumedB.parentTaskId).toBe(a.taskId)
		expect(await resumedB.guardExecution()).toBe(true)
		expect(await store.readAuthoritative(a.taskId)).toMatchObject({
			status: "delegated",
			awaitingChildId: b.taskId,
		})
		expect(provider.emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationCompleted,
			b.taskId,
			c.taskId,
			"C finished",
		)
		expect(provider.emit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, b.taskId, c.taskId)
		await scheduler.drain()
		expect(resumedB.skipPrevResponseIdOnce).toBe(true)

		await finish(resumedB, "B finished", "finish-B")
		expect(provider.getCurrentTask()?.taskId).toBe(a.taskId)
		await scheduler.drain()
		expect(provider.getCurrentTask()?.skipPrevResponseIdOnce).toBe(true)
		expect(approve).toHaveBeenCalledTimes(2)
		expect(handleError).not.toHaveBeenCalled()
		expect(ask).not.toHaveBeenCalled()
		expect(reopen).toHaveBeenCalledTimes(2)
		for (const [, options] of reopen.mock.calls)
			expect(options).toMatchObject({ startTask: false, executionToken: expect.any(Object) })
		const events = emit.mock.calls.filter(
			([name]) =>
				name === RooCodeEventName.TaskDelegationCompleted || name === RooCodeEventName.TaskDelegationResumed,
		)
		expect(events).toEqual([
			[RooCodeEventName.TaskDelegationCompleted, b.taskId, c.taskId, "C finished"],
			[RooCodeEventName.TaskDelegationResumed, b.taskId, c.taskId],
			[RooCodeEventName.TaskDelegationCompleted, a.taskId, b.taskId, "B finished"],
			[RooCodeEventName.TaskDelegationResumed, a.taskId, b.taskId],
		])
		for (const [parent, child, creatingId, finishId, result] of [
			[a, b, "create-B", "finish-B", "B finished"],
			[b, c, "create-C", "finish-C", "C finished"],
		] as const) {
			const history = await store.readAuthoritative(parent.taskId)
			expect(history.awaitingChildId).toBeUndefined()
			expect(history.completedByChildId).toBe(child.taskId)
			expect(completionState(history).receipts).toEqual([
				expect.objectContaining({
					phase: "committed",
					creating: expect.objectContaining({ actionId: creatingId }),
					finish: expect.objectContaining({ actionId: finishId, result }),
				}),
			])
			expect(await readTaskMessages({ taskId: parent.taskId, globalStoragePath: directory })).toEqual(
				expect.arrayContaining([expect.objectContaining({ say: "subtask_result", text: result })]),
			)
			const api = await readApiMessages({ taskId: parent.taskId, globalStoragePath: directory })
			expect(api).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "user",
						content: expect.arrayContaining([
							{ type: "tool_result", tool_use_id: creatingId, content: result },
						]),
					}),
				]),
			)
		}
	})
})
