// npx vitest run __tests__/single-open-invariant.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { type OutputChannel } from "vscode"
import { TelemetryService } from "@roo-code/telemetry"
import type { DelegationAction, HistoryItem, PendingTaskAction } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { Task } from "../core/task/Task"
import { TaskRegistry } from "../core/task/TaskRegistry"
import { TaskScheduler } from "../core/task/TaskScheduler"
import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"
import { executionClaim, reserveDelegation } from "../core/task-persistence/taskLifecycle"
import { safeWriteJson } from "../utils/safeWriteJson"
import { API } from "../extension/api"
import * as apiModule from "../api"
import * as ignoreController from "../core/ignore/RooIgnoreController"
import { makeExtensionContext, makeUri } from "../test-utils/vscode"

describe("Single-open-task invariant", () => {
	let directory: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	let scheduler: TaskScheduler
	const tasks: Task[] = []

	beforeEach(async () => {
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
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-single-open-"))
		store = new TaskHistoryStore(directory)
		await store.initialize()
		scheduler = new TaskScheduler()
		vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined)
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
			emit: vi.fn(),
			log: vi.fn(),
			postMessageToWebview: vi.fn(),
			syncFocusedTaskToWebview: vi.fn(),
			postStateToWebview: vi.fn(),
			postStateToWebviewThrottled: vi.fn(),
			flushPostStateToWebviewThrottled: vi.fn(),
			postClineMessagesSnapshot: vi.fn(),
			postClineMessageAppended: vi.fn(),
			postClineMessageUpdated: vi.fn(),
			taskCreationCallback: (task: Task) => tasks.push(task),
		})
	})

	afterEach(async () => {
		for (const task of tasks.splice(0)) await provider["stopOwnedTask"](task)
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})
	const history = (id: string): HistoryItem => ({
		id,
		number: 1,
		ts: 1,
		task: "Task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	})
	const create = (id: string) => provider.createTask("", undefined, undefined, { taskId: id, startTask: false })

	it("User-initiated create: closes existing before opening new", async () => {
		const existing = await create("existing-1")
		const remove = vi.spyOn(provider, "removeClineFromStack"),
			add = vi.spyOn(provider, "addClineToStack")
		const task = await provider.createTask("New task")
		expect(remove).toHaveBeenCalledTimes(1)
		expect(add).toHaveBeenCalledExactlyOnceWith(task)
		expect(scheduler.schedule).toHaveBeenCalledTimes(1)
		expect(remove.mock.invocationCallOrder[0]).toBeLessThan(add.mock.invocationCallOrder[0])
		expect(existing.cleanupSettled).toBe(true)
		expect(executionClaim(await store.readAuthoritative(existing.taskId)).phase).toBe("settled")
		expect(provider.getCurrentTaskStack()).toEqual([task.taskId])
		expect(await task.guardExecution()).toBe(true)
	})

	it("Subtask create: keeps existing task open when parentTask and its reserved child claim are provided", async () => {
		const parent = await create("parent-1")
		const intent: PendingTaskAction = {
			kind: "create_subtask",
			actionId: "create-child",
			approvalText: "{}",
			mode: "code",
			message: "Subtask",
			todos: [],
		}
		await provider.setPendingTaskAction(parent.taskId, intent, parent)
		parent.setPendingTaskAction(intent)
		const parentItem = await store.readAuthoritative(parent.taskId)
		const receipt: DelegationAction = {
			actionId: intent.actionId,
			intent,
			operationId: "delegate-child",
			childId: "child",
			ownerToken: parent.instanceId,
			executionToken: parent.executionToken,
			generation: parent.executionGeneration,
			revision: parentItem.lifecycleRevision!,
			phase: "prepared",
			attempts: 1,
			resultTs: 1,
		}
		await store.lifecycleCommand(
			parent.taskId,
			(item) => reserveDelegation(item, receipt),
			[],
			true,
			parent.executionToken,
		)
		const claim = await store.claimDelegationChild(
			{
				...history("child"),
				parentTaskId: parent.taskId,
				rootTaskId: parent.taskId,
				delegationOrigin: { parentId: parent.taskId, operationId: receipt.operationId },
			},
			store.ownerForRuntime("child-runtime"),
			parent.executionToken!,
			receipt,
		)
		if (claim.kind !== "applied") throw new Error(claim.reason)
		provider["rememberExecution"](claim.token)
		const remove = vi.spyOn(provider, "removeClineFromStack"),
			add = vi.spyOn(provider, "addClineToStack")
		const child = await provider.createTask(
			"Subtask",
			undefined,
			parent,
			{ taskId: claim.token.taskId, startTask: false },
			{},
			() => provider.getCurrentTask() === parent,
			claim.token,
		)
		expect(remove).not.toHaveBeenCalled()
		expect(add).toHaveBeenCalledExactlyOnceWith(child)
		expect(provider.getCurrentTaskStack()).toEqual([parent.taskId, child.taskId])
		expect(parent.cleanupSettled).toBe(false)
		// Construction is not a committed handoff or permission to launch the child.
		expect(scheduler.schedule).not.toHaveBeenCalled()
		expect(await child.guardExecution()).toBe(false)
	})

	it.each([undefined, "active", "completed"] as const)(
		"History resume closes current before inspecting ownerless %s history without scheduling it (non-rehydrating case)",
		async (status) => {
			const existing = await create("existing")
			const item = { ...history("hist-1"), status }
			await store.upsert(item)
			await safeWriteJson(path.join(directory, "tasks", item.id, "ui_messages.json"), [])
			await safeWriteJson(path.join(directory, "tasks", item.id, "api_conversation_history.json"), [])
			const before = await store.readAuthoritative(item.id)
			const remove = vi.spyOn(provider, "removeClineFromStack")
			const task = await provider.createTaskWithHistoryItem(item)
			expect(task).toBeTruthy()
			expect(remove).toHaveBeenCalledTimes(1)
			expect(existing.cleanupSettled).toBe(true)
			expect(provider.getCurrentTaskStack()).toEqual([item.id])
			expect(provider.getCurrentTask()).toBe(task)
			expect(task.executionToken).toBeUndefined()
			expect(await task.guardExecution()).toBe(false)
			expect(scheduler.schedule).not.toHaveBeenCalled()
			expect(await store.readAuthoritative(item.id)).toEqual(before)
		},
	)

	it("History resume schedules a retained authorized task after closing a different current task", async () => {
		const retained = await create("retained")
		const action: PendingTaskAction = {
			kind: "create_subtask",
			actionId: "pending-approval",
			approvalText: "{}",
			mode: "code",
			message: "Child",
			todos: [],
		}
		await provider.setPendingTaskAction(retained.taskId, action, retained)
		retained.setPendingTaskAction(action)
		const current = await create("different-current")
		expect(retained.cleanupSettled).toBe(true)
		const remove = vi.spyOn(provider, "removeClineFromStack")
		const prepare = vi.spyOn(provider, "performPreparationTasks")
		const task = await provider.createTaskWithHistoryItem(await store.readAuthoritative(retained.taskId))
		expect(remove).toHaveBeenCalledTimes(1)
		expect(prepare).toHaveBeenCalledExactlyOnceWith(task)
		expect(remove.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0])
		expect(current.cleanupSettled).toBe(true)
		expect(provider.getCurrentTaskStack()).toEqual([retained.taskId])
		expect(task.executionToken?.generation).toBeGreaterThan(retained.executionToken!.generation)
		expect(scheduler.schedule).toHaveBeenCalledTimes(1)
		expect(await task.guardExecution()).toBe(true)
	})

	it("History resume path wires scheduler in authorized rehydrating (in-place) case", async () => {
		const existing = await create("hist-rehydrate-1")
		const remove = vi.spyOn(provider, "removeClineFromStack")
		const oldToken = existing.executionToken
		const task = await provider.createTaskWithHistoryItem(await store.readAuthoritative(existing.taskId))
		expect(scheduler.schedule).toHaveBeenCalledTimes(1)
		expect(remove).not.toHaveBeenCalled()
		expect(provider.getCurrentTaskStack()).toEqual([existing.taskId])
		expect(provider.getCurrentTask()).toBe(task)
		expect(existing.cleanupSettled).toBe(true)
		expect(existing.executionToken).toBe(oldToken)
		expect(task.executionToken?.generation).toBeGreaterThan(oldToken!.generation)
		expect(await existing.guardExecution()).toBe(false)
		expect(await task.guardExecution()).toBe(true)
	})

	it("serializes concurrent history resumes before mutating the task registry and rejects superseded scope", async () => {
		const existing = await create("hist-concurrent-1")
		const item = await store.readAuthoritative(existing.taskId)
		let releaseFirst!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const read = store.readAuthoritative.bind(store)
		const reading = vi.spyOn(store, "readAuthoritative").mockImplementationOnce(async (id) => {
			await gate
			return read(id)
		})
		const abort = vi.spyOn(existing, "abortTask"),
			remove = vi.spyOn(provider, "removeClineFromStack")
		vi.mocked(provider.getState).mockClear()
		const first = provider.createTaskWithHistoryItem(item)
		const rejected = expect(first).rejects.toMatchObject({ reason: "stale_scope" })
		await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1))
		const second = provider.createTaskWithHistoryItem(item)
		expect(provider.getState).not.toHaveBeenCalled()
		expect(provider.getCurrentTask()).toBe(existing)
		expect(abort).not.toHaveBeenCalled()
		releaseFirst()
		await rejected
		const task = await second
		expect(task).not.toBe(existing)
		expect(abort).toHaveBeenCalledWith(true)
		expect(remove).not.toHaveBeenCalled()
		expect(provider.getCurrentTaskStack()).toEqual([item.id])
		expect(provider.getCurrentTask()).toBe(task)
		expect(scheduler.schedule).toHaveBeenCalledTimes(1)
		expect(await task.guardExecution()).toBe(true)
	})

	it("IPC StartNewTask path closes current before new task", async () => {
		const existing = await create("existing-ipc")
		const remove = vi.spyOn(provider, "removeClineFromStack"),
			start = vi.spyOn(provider, "createTask")
		// The IPC event subscription is shell-only; task construction/cleanup remain real.
		vi.spyOn(provider, "on").mockReturnValue(provider)
		vi.spyOn(provider, "getValues").mockReturnValue({})
		const output: OutputChannel = {
			name: "test",
			append: vi.fn(),
			appendLine: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}
		const api = new API(output, provider, undefined, false)
		const taskId = await api.startNewTask({ configuration: {}, text: "hello", images: undefined, newTab: false })
		expect(taskId).toBe(provider.getCurrentTask()?.taskId)
		expect(remove).toHaveBeenCalledTimes(1)
		expect(start).toHaveBeenCalledTimes(1)
		expect(remove.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0])
		expect(existing.cleanupSettled).toBe(true)
		expect(provider.getCurrentTaskStack()).toEqual([taskId])
	})
})
