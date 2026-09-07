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
import { delegationState, executionClaim } from "../core/task-persistence/taskLifecycle"
import { makeExtensionContext, makeUri } from "../test-utils/vscode"
import * as ignoreController from "../core/ignore/RooIgnoreController"
import * as apiModule from "../api"

// Observe the handoff before admitting its callback through the real semaphore.
class BoundedScheduler extends TaskScheduler {
	readonly queued: Array<{ task: Task; run: () => Promise<void> }> = []
	override schedule(task: Task, run: () => Promise<void>): Promise<void> {
		this.queued.push({ task, run })
		return Promise.resolve()
	}
	async drain(): Promise<void> {
		const next = this.queued.shift()
		if (next) await super.schedule(next.task, next.run)
	}
}

const intent: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "create",
	mode: "code",
	message: "Child",
	todos: [],
	approvalText: "{}",
}
describe("ClineProvider delegation admission and commit", () => {
	let directory: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	let parent: Task
	let scheduler: BoundedScheduler
	const tasks: Task[] = []
	beforeEach(async () => {
		// Explicit spies also cover Task's transitive imports on the Windows runner.
		const ignorePrototype = ignoreController.RooIgnoreController.prototype
		vi.spyOn(ignoreController, "RooIgnoreController").mockImplementation(function () {
			return Object.assign(Object.create(ignorePrototype) as ignoreController.RooIgnoreController, {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				validateAccess: vi.fn(() => true),
			})
		})
		vi.spyOn(apiModule, "buildApiHandler").mockImplementation(() => ({
			getModel: () => ({
				id: "offline",
				info: { contextWindow: 10000, supportsImages: false, supportsPromptCache: false },
			}),
			countTokens: vi.fn().mockResolvedValue(1),
			createMessage: () => {
				throw new Error("Unexpected model request")
			},
		}))
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-provider-delegate-"))
		store = new TaskHistoryStore(directory)
		await store.initialize()
		scheduler = new BoundedScheduler()
		const context = makeExtensionContext({ globalStorageUri: makeUri(directory) })
		// Only VS Code shell services and the model loop are mocked. Runtime claims,
		// cleanup, construction, persistence and delegation use their real contracts.
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
			ownedExecutions: new Map(),
			cleanupOperations: new WeakMap(),
			completionApprovals: new WeakMap(),
			recoveryPrompt: undefined,
			recoveryInFlight: false,
			recoveryPreviewSequence: 0,
			delegationEpoch: 0,
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
			setValues: vi.fn().mockResolvedValue(undefined),
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			log: vi.fn(),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			syncFocusedTaskToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			postClineMessagesSnapshot: vi.fn().mockResolvedValue(undefined),
			postClineMessageAppended: vi.fn().mockResolvedValue(undefined),
			postClineMessageUpdated: vi.fn().mockResolvedValue(undefined),
			taskCreationCallback: (task: Task) => tasks.push(task),
		})
		vi.spyOn(Task.prototype, "run").mockResolvedValue(undefined)
		parent = await provider.createTask("", undefined, undefined, { taskId: "parent", startTask: false })
		await parent.overwriteClineMessages([{ ts: 1, type: "say", say: "text", text: "Parent" }])
		await prepare(intent)
		vi.spyOn(provider, "createTask")
		vi.spyOn(provider, "removeClineFromStack")
		vi.spyOn(provider, "createTaskWithHistoryItem")
	})
	afterEach(async () => {
		scheduler.queued.length = 0
		for (const task of tasks.splice(0)) {
			await task.abortTask(true)
			await task.dispose()
		}
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})
	async function prepare(action: PendingTaskAction) {
		await parent.overwriteApiConversationHistory([
			...parent.apiConversationHistory,
			{
				role: "assistant",
				ts: Date.now(),
				content: [{ type: "tool_use", id: action.actionId, name: "new_task", input: {} }],
			},
		])
		await provider.setPendingTaskAction(parent.taskId, action, parent)
		parent.setPendingTaskAction(action)
		expect(await provider.validateTaskDelegation(parent, action)).toBe(true)
	}
	const delegate = (action: PendingTaskAction = intent) =>
		provider.delegateParentAndOpenChild({
			parentTaskId: parent.taskId,
			pendingActionId: action.actionId,
			origin: parent,
			message: "Child",
			mode: "code",
			initialTodos: [],
		})

	it("rejects a stale action before destructive side effects", async () => {
		await expect(
			provider.delegateParentAndOpenChild({
				parentTaskId: "parent",
				origin: parent,
				pendingActionId: "old",
				message: "Child",
				mode: "code",
				initialTodos: [],
			}),
		).rejects.toThrow("Pending action mismatch")
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
	})
	it("clears matching pending intent and schedules only after the durable receipt commits", async () => {
		const child = await delegate()
		expect(child.run).not.toHaveBeenCalled()
		expect(scheduler.queued.map((entry) => entry.task)).toEqual([child])
		await scheduler.drain()
		const item = await store.readAuthoritative("parent")
		expect(item).toMatchObject({ status: "delegated", awaitingChildId: child.taskId })
		expect(item.pendingAction).toBeUndefined()
		expect(delegationState(item).actions[0].phase).toBe("committed")
		expect(child.run).toHaveBeenCalledTimes(1)
		expect(provider.emit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent", child.taskId)
		expect(provider.handleModeSwitch).toHaveBeenCalledWith("code")
	})
	it("keeps paused child execution behind the parent commit", async () => {
		const command = store.lifecycleCommand.bind(store)
		vi.spyOn(store, "lifecycleCommand").mockImplementation(async (...args) => {
			const current = provider.getCurrentTask()
			if (current && current !== parent) {
				expect(current.run).not.toHaveBeenCalled()
				expect(scheduler.queued).toHaveLength(0)
			}
			return command(...args)
		})
		await delegate()
	})
	it("rejects an interrupted parent before child allocation or further writes", async () => {
		expect(await store.interruptTask(parent.executionToken!)).toMatchObject({ kind: "applied" })
		const interrupted = await store.readAuthoritative("parent")
		await expect(delegate()).rejects.toThrow("Stale delegation caller")
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(parent.executionBlocked).toBe(true)
		expect(await store.readAuthoritative("parent")).toEqual(interrupted)
		expect(scheduler.queued).toHaveLength(0)
	})
	it("preserves interrupted-child replacement and its historical child list", async () => {
		const old = await delegate()
		scheduler.queued.length = 0
		await provider.cancelTask()
		expect(executionClaim(await store.readAuthoritative(old.taskId)).phase).toBe("settled")
		expect(parent.cleanupSettled).toBe(true)
		expect(await store.settleTaskExecution(parent.executionToken!, parent.cleanupSettled)).toMatchObject({
			kind: "applied",
		})
		await provider.createTaskWithHistoryItem(await store.readAuthoritative("parent"), { startTask: false })
		const prompt = await provider.previewTaskRecovery("parent")
		expect(prompt.choices).toContain("retain_delegation")
		expect(
			await provider.recoverTask({
				taskId: "parent",
				promptId: prompt.promptId,
				choice: "retain_delegation",
				intent: "explicit_user_resume",
			}),
		).toMatchObject({ kind: "applied" })
		parent = provider.getCurrentTask()!
		scheduler.queued.length = 0
		const replacement = { ...intent, actionId: "replacement" }
		await prepare(replacement)
		const child = await delegate(replacement)
		expect((await store.readAuthoritative("parent")).childIds).toEqual([old.taskId, child.taskId])
	})
	it("refuses replacing a live child without allocating another", async () => {
		const child = await delegate()
		const before = await store.readAuthoritative("parent")
		vi.mocked(provider.createTask).mockClear()
		vi.mocked(provider.removeClineFromStack).mockClear()
		await expect(delegate()).rejects.toThrow("Stale delegation caller")
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(provider.getCurrentTask()).toBe(child)
		expect(await child.guardExecution()).toBe(true)
		expect(await store.readAuthoritative("parent")).toEqual(before)
	})
	it("retains a replacement action when old preparation fails", async () => {
		vi.mocked(provider.handleModeSwitch).mockImplementation(async () => {
			await store.lifecycleCommand(
				"parent",
				(item) => ({
					...item,
					pendingAction: { ...intent, actionId: "replacement" },
				}),
				[],
				true,
				parent.executionToken,
			)
		})
		await expect(delegate()).rejects.toThrow()
		expect((await store.readAuthoritative("parent")).pendingAction?.actionId).toBe("replacement")
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})
	it("post-commit notification failure cannot roll back a committed child", async () => {
		Object.assign(provider, { isViewLaunched: true })
		vi.mocked(provider.postMessageToWebview).mockRejectedValue(new Error("notification"))
		const child = await delegate()
		expect(await store.readAuthoritative(child.taskId)).toBeDefined()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})
	it("flush failure blocks before teardown or allocation", async () => {
		vi.spyOn(parent, "flushPendingToolResultsToHistory").mockResolvedValue(false)
		await expect(delegate()).rejects.toThrow("not durable")
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(delegationState(await store.readAuthoritative("parent")).blocked).toBeDefined()
		const blocked = await store.readAuthoritative("parent")
		const observer = provider.getCurrentTask()
		expect(observer?.executionToken).toBeUndefined()
		expect(observer?.executionBlocked).toBe(true)
		const restorations = vi.mocked(provider.createTaskWithHistoryItem).mock.calls.length
		for (let retry = 0; retry < 3; retry++) await expect(delegate()).rejects.toThrow("Stale delegation caller")
		expect(provider.getCurrentTask()).toBe(observer)
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledTimes(restorations)
		expect(await store.readAuthoritative("parent")).toEqual(blocked)
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(scheduler.queued).toHaveLength(0)
	})
})
