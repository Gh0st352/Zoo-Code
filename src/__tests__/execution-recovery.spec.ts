import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import { TelemetryService } from "@roo-code/telemetry"
import {
	RooCodeEventName,
	type TaskProviderEvents,
	type HistoryItem,
	type PendingTaskAction,
	type TaskRecoveryDecision,
	type ChatInput,
} from "@roo-code/types"
import { Task } from "../core/task/Task"
import { TaskRegistry } from "../core/task/TaskRegistry"
import { TaskScheduler } from "../core/task/TaskScheduler"
import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"
import { executionClaim, executionToken, delegationState } from "../core/task-persistence/taskLifecycle"
import { readApiMessages, saveApiMessages } from "../core/task-persistence/apiMessages"
import { readTaskMessages, saveTaskMessages } from "../core/task-persistence/taskMessages"
import { ClineProvider } from "../core/webview/ClineProvider"
import { webviewMessageHandler } from "../core/webview/webviewMessageHandler"
import { makeExtensionContext, makeUri } from "../test-utils/vscode"
import type { ExecutionHost } from "../core/task-persistence/executionHost"
import * as safeJson from "../utils/safeWriteJson"

// Preserve real advisory locking while exposing a configurable barrier seam.
vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("proper-lockfile")>()
	return { ...actual }
})

vi.mock("../core/ignore/RooIgnoreController")
vi.mock("../api", () => ({
	buildApiHandler: () => ({
		getModel: () => ({ id: "offline", info: { contextWindow: 10000, supportsImages: false } }),
		createMessage: vi.fn(() => {
			throw new Error("Unexpected model request")
		}),
	}),
}))

// Bound observation of scheduling without replacing admission or Task execution.
// Only empty new tasks are drained; recovery/handoff tests assert their queued continuation.
class BoundedScheduler extends TaskScheduler {
	readonly queued: Array<{ task: Task; run: () => Promise<void> }> = []
	override schedule(task: Task, run: () => Promise<void>): Promise<void> {
		this.queued.push({ task, run })
		return Promise.resolve()
	}
	async drain(limit = 2): Promise<void> {
		for (let index = 0; index < limit && this.queued.length; index++) {
			const next = this.queued.shift()!
			await super.schedule(next.task, next.run)
		}
	}
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("real provider / Task / store execution authority and recovery", () => {
	let storage: string
	const stores: TaskHistoryStore[] = []
	const tasks: Task[] = []
	const schedulers: BoundedScheduler[] = []

	async function shell(host?: ExecutionHost) {
		const store = new TaskHistoryStore(storage, { executionHost: host })
		stores.push(store)
		await store.initialize()
		const scheduler = new BoundedScheduler()
		schedulers.push(scheduler)
		const context = makeExtensionContext({ globalStorageUri: makeUri(storage) })
		// VS Code shell services are not this boundary. Initialize every stateful
		// production field used here explicitly; production has no mock fallbacks.
		const provider: ClineProvider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
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
			customModesManager: { getCustomModes: async () => [], dispose: vi.fn() },
			providerSettingsManager: { getModeConfigId: async () => undefined, listConfig: async () => [] },
			getPendingEditOperation: () => undefined,
			getState: vi.fn().mockResolvedValue({
				mode: "code",
				apiConfiguration: {},
				enableCheckpoints: false,
				organizationAllowList: { allowAll: true },
				autoApprovalEnabled: false,
			}),
			setValues: vi.fn(async () => {}),
			updateGlobalState: vi.fn(async () => {}),
			handleModeSwitch: vi.fn(async () => {}),
			log: vi.fn(),
			emit: vi.fn<(event: keyof TaskProviderEvents, ...args: unknown[]) => boolean>(() => true),
			postMessageToWebview: vi.fn(async () => {}),
			syncFocusedTaskToWebview: vi.fn(async () => {}),
			postStateToWebviewThrottled: vi.fn(async () => {}),
			flushPostStateToWebviewThrottled: vi.fn(async () => {}),
			postClineMessagesSnapshot: vi.fn(async () => {}),
			postClineMessageAppended: vi.fn(async () => {}),
			postClineMessageUpdated: vi.fn(async () => {}),
			taskCreationCallback: (task: Task) => tasks.push(task),
			_postStateToWebviewThrottled: { cancel: vi.fn() },
			disposables: [],
			webviewDisposables: [],
			pendingThemeFixtureProbes: new Map(),
			clearAllPendingEditOperations: vi.fn(),
			flushGlobalStateWriteThrough: vi.fn(),
			removeAllListeners: vi.fn(),
		})
		return { provider, store, scheduler }
	}

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-execution-recovery-"))
	})
	afterEach(async () => {
		for (const scheduler of schedulers.splice(0)) scheduler.queued.length = 0
		for (const task of tasks.splice(0)) {
			await task.abortTask(true)
			await task.dispose()
		}
		for (const store of stores.splice(0)) store.dispose()
		vi.restoreAllMocks()
		await fs.rm(storage, { recursive: true, force: true })
	})

	async function seedMessages(task: Task, text = "Original") {
		await task.overwriteClineMessages([{ ts: 1, type: "say", say: "text", text }])
		await task.overwriteApiConversationHistory([{ ts: 1, role: "user", content: text }])
	}

	/** Hold the real safeWriteJson file lock before its disk read and merge callback. */
	function holdHistoryMerge(taskId: string, select: (item: HistoryItem) => boolean) {
		const entered = deferred(),
			release = deferred()
		const target = path.join(storage, "tasks", taskId, "history_item.json")
		const write = safeJson.safeWriteJson
		const lock = lockfile.lock
		let selected = false,
			held = false
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (file, data, options) => {
			// The selected target is a history record, not a transcript write.
			if (file === target && select(data as HistoryItem)) selected = true
			await write(file, data, options)
		})
		vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			const unlock = await lock(file, options)
			if (file === target && selected && !held) {
				held = true
				entered.resolve()
				await release.promise
			}
			return unlock
		})
		return { entered: entered.promise, release: release.resolve }
	}

	async function decision(provider: ClineProvider): Promise<TaskRecoveryDecision> {
		const taskId = provider.getCurrentTask()!.taskId
		const prompt = await provider.previewTaskRecovery(taskId)
		if (!prompt.choices[0]) throw new Error(prompt.reason)
		return { taskId, promptId: prompt.promptId, choice: prompt.choices[0], intent: "explicit_user_resume" }
	}

	async function delegate(provider: ClineProvider, parent: Task, id = "create") {
		await parent.overwriteApiConversationHistory([
			...parent.apiConversationHistory,
			{ ts: Date.now(), role: "assistant", content: [{ type: "tool_use", id, name: "new_task", input: {} }] },
		])
		const action: PendingTaskAction = {
			kind: "create_subtask",
			actionId: id,
			approvalText: "{}",
			mode: "code",
			message: "Child",
			todos: [],
		}
		await provider.setPendingTaskAction(parent.taskId, action, parent)
		parent.setPendingTaskAction(action)
		expect(await provider.validateTaskDelegation(parent, action)).toBe(true)
		return provider.delegateParentAndOpenChild({
			parentTaskId: parent.taskId,
			origin: parent,
			pendingActionId: id,
			message: "Child",
			mode: "code",
			initialTodos: [],
		})
	}

	async function completion(provider: ClineProvider, child: Task) {
		const finish: Extract<PendingTaskAction, { kind: "finish_subtask" }> = {
			kind: "finish_subtask",
			actionId: `finish-${child.taskId}`,
			approvalText: "{}",
			parentTaskId: child.parentTaskId!,
			result: "Done",
		}
		await provider.setPendingTaskAction(child.taskId, finish, child)
		child.setPendingTaskAction(finish)
		const request = await provider.prepareDelegatedCompletion(child, finish)
		expect(request).toBeDefined()
		return {
			origin: child,
			request: request!,
			parentTaskId: finish.parentTaskId,
			childTaskId: child.taskId,
			completionResultSummary: finish.result,
			pendingActionId: finish.actionId,
		}
	}

	it("preclaims before construction/preparation and observer initialization never disturbs a live peer", async () => {
		const a = await shell()
		const prepare = vi.spyOn(a.provider, "performPreparationTasks")
		const task = await a.provider.createTask("", undefined, undefined, { taskId: "new", startTask: false })
		expect(executionToken(await a.store.readAuthoritative(task.taskId))).toEqual(task.executionToken)
		expect(prepare).toHaveBeenCalledWith(task)
		await seedMessages(task)
		const before = await a.store.readAuthoritative(task.taskId)
		const b = await shell()
		const bPreparation = vi.spyOn(b.provider, "performPreparationTasks")
		const observer = await b.provider.createTaskWithHistoryItem(before)
		expect(observer.executionToken).toBeUndefined()
		expect(observer.apiConversationHistory[0].content).toBe("Original")
		expect(bPreparation).not.toHaveBeenCalled()
		expect(b.scheduler.queued).toHaveLength(0)
		expect((await b.provider.previewTaskRecovery(task.taskId)).choices).toEqual([])
		expect(await a.store.readAuthoritative(task.taskId)).toEqual(before)
		expect(await task.guardExecution()).toBe(true)
		await b.provider.evictCurrentTask()
		expect(await a.store.readAuthoritative(task.taskId)).toEqual(before)
	})

	it.each(["legacy", "interrupted", "completed"])("generic opening never claims %s history", async (kind) => {
		const { provider, store, scheduler } = await shell()
		if (kind === "legacy") {
			const item: HistoryItem = {
				id: kind,
				number: 1,
				ts: 1,
				task: "Original",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			await store.upsert(item)
			await saveTaskMessages({
				taskId: kind,
				globalStoragePath: storage,
				messages: [{ ts: 1, type: "say", say: "text", text: "Original" }],
			})
			await saveApiMessages({
				taskId: kind,
				globalStoragePath: storage,
				messages: [{ role: "user", content: "Original" }],
			})
		} else {
			const task = await provider.createTask("", undefined, undefined, { taskId: kind, startTask: false })
			await seedMessages(task)
			if (kind === "completed") expect(await provider.completeTask(task, "Done")).toBe(true)
			else await provider.cancelTask()
		}
		const before = await store.readAuthoritative(kind)
		const task = await provider.createTaskWithHistoryItem(before)
		expect(task.executionToken).toBeUndefined()
		expect(scheduler.queued).toHaveLength(0)
		expect(await store.readAuthoritative(kind)).toEqual(before)

		// Characterize the blocked-send boundary with real Tasks and temporary history.
		// Generic input must stay refused; the missing recovery UI is not permission
		// to bypass the owner guard or reactivate completed/legacy histories.
		const originalMessages = structuredClone(task.clineMessages)
		vi.mocked(provider.log)
			.mockClear()
			.mockImplementation((line) => console.info(line))
		for (const type of ["askResponse", "queueMessage"] as const) {
			await webviewMessageHandler(provider, {
				type,
				taskId: kind,
				askResponse: "messageResponse",
				text: "follow up",
			})
			expect(provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"reason":"execution_guard"'))
			expect(provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"hasExecutionToken":false'))
		}
		await webviewMessageHandler(provider, {
			type: "submitChatMessage",
			chatInput: {
				kind: "queue",
				requestId: `blocked-${kind}`,
				text: "preserve draft",
				images: [],
				scope: { taskId: task.taskId, instanceId: task.instanceId },
			},
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatInputResult",
			chatInputResult: { requestId: `blocked-${kind}`, kind: "refused", reason: "execution_refused" },
		})
		expect(task.clineMessages).toEqual(originalMessages)
		expect(task.messageQueueService.messages).toEqual([])
		expect(task.api.createMessage).not.toHaveBeenCalled()
		expect(scheduler.queued).toHaveLength(0)
		expect(await store.readAuthoritative(kind)).toEqual(before)
	})

	it("delivers ordinary text to a live claimed follow-up ask without recovery", async () => {
		const { provider, scheduler } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		vi.mocked(provider.log)
			.mockClear()
			.mockImplementation((line) => console.info(line))
		const waiting = task.ask("followup", JSON.stringify({ question: "Continue?", suggest: [] })).then(
			(value) => ({ kind: "answered", value }),
			(error: unknown) => ({ kind: "failed", error }),
		)
		try {
			await vi.waitFor(() => {
				expect(task.clineMessages.at(-1)).toMatchObject({ ask: "followup" })
				expect(task.clineMessages.at(-1)?.partial).not.toBe(true)
			})
			const input: ChatInput = {
				kind: "response",
				requestId: "live-reply",
				text: "follow up",
				images: [],
				scope: { taskId: task.taskId, instanceId: task.instanceId },
				askTs: task.clineMessages.at(-1)!.ts,
			}
			await Promise.all(
				[1, 2].map(() => webviewMessageHandler(provider, { type: "submitChatMessage", chatInput: input })),
			)
			expect(await waiting).toMatchObject({
				kind: "answered",
				value: { response: "messageResponse", text: "follow up" },
			})
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "chatInputResult",
				chatInputResult: { requestId: "live-reply", kind: "accepted", taskId: task.taskId },
			})
			expect(task.executionBlocked).toBe(false)
			expect(task.api.createMessage).not.toHaveBeenCalled()
			expect(scheduler.queued).toHaveLength(0)
		} finally {
			await task.abortTask(true)
			await waiting
		}
	})

	it("acknowledges one fresh claimed send and refuses stale or failed input without transcript effects", async () => {
		const { provider, scheduler } = await shell()
		const input: ChatInput = { kind: "new", scope: null, requestId: "fresh-send", text: "new input", images: [] }
		await Promise.all(
			[1, 2].map(() => webviewMessageHandler(provider, { type: "submitChatMessage", chatInput: input })),
		)
		const task = provider.getCurrentTask()!
		expect(await task.guardExecution()).toBe(true)
		expect(scheduler.queued).toHaveLength(1)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatInputResult",
			chatInputResult: { requestId: input.requestId, kind: "accepted", taskId: task.taskId },
		})
		await seedMessages(task)
		const before = structuredClone(task.clineMessages)
		await webviewMessageHandler(provider, {
			type: "submitChatMessage",
			chatInput: {
				kind: "queue",
				scope: { taskId: task.taskId, instanceId: "old-runtime" },
				requestId: "stale",
				text: "wrong",
				images: [],
			},
		})
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "chatInputResult",
			chatInputResult: { requestId: "stale", kind: "refused", reason: "stale_scope" },
		})
		vi.mocked(provider.getState).mockRejectedValueOnce(new Error("image resolution failed"))
		await webviewMessageHandler(provider, {
			type: "submitChatMessage",
			chatInput: {
				kind: "queue",
				scope: { taskId: task.taskId, instanceId: task.instanceId },
				requestId: "failed",
				text: "keep",
				images: [],
			},
		})
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "chatInputResult",
			chatInputResult: { requestId: "failed", kind: "refused", reason: "input_failed" },
		})
		expect(task.clineMessages).toEqual(before)
		expect(task.messageQueueService.messages).toEqual([])
		expect(task.api.createMessage).not.toHaveBeenCalled()
		expect(scheduler.queued).toHaveLength(1)
	})

	it("a new-task message creates a claimed task instead of requiring history recovery", async () => {
		const { provider, scheduler } = await shell()
		vi.mocked(provider.log).mockImplementation((line) => console.info(line))
		await webviewMessageHandler(provider, { type: "newTask", text: "new task input" })
		const task = provider.getCurrentTask()!
		expect(task.executionToken).toBeDefined()
		expect(await task.guardExecution()).toBe(true)
		expect(scheduler.queued).toHaveLength(1)
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining('"stage":"created"'))
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "invoke", invoke: "newChat" })
	})

	it("cancellation fences immediately but never settles before actual outstanding cleanup", async () => {
		const { provider, store } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		const work = deferred()
		void task.trackExecutionWork(work.promise)
		const fenced = deferred()
		const interrupt = store.interruptTask.bind(store)
		vi.spyOn(store, "interruptTask").mockImplementation(async (token) => {
			const result = await interrupt(token)
			fenced.resolve()
			return result
		})
		const cancelling = provider.cancelTask()
		await fenced.promise
		expect(executionClaim(await store.readAuthoritative(task.taskId))).toMatchObject({
			phase: "suspended",
			cleanupPending: true,
		})
		expect(await provider.completeTask(task, "late")).toBe(false)
		work.resolve()
		await cancelling
		expect(task.cleanupSettled).toBe(true)
		expect(executionClaim(await store.readAuthoritative(task.taskId))).toMatchObject({
			phase: "settled",
			cleanupPending: false,
		})
		expect(task.executionToken?.generation).toBe(1)
		expect(provider.getCurrentTask()?.executionToken).toBeUndefined()
	})

	it("same-provider pending approval leave/return transfers only after cleanup and fences old callbacks", async () => {
		const { provider, store, scheduler } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		const action: PendingTaskAction = {
			kind: "create_subtask",
			actionId: "pending",
			approvalText: "{}",
			mode: "code",
			message: "Child",
			todos: [],
		}
		await provider.setPendingTaskAction(task.taskId, action, task)
		task.setPendingTaskAction(action)
		await provider.createTask("", undefined, undefined, { taskId: "other", startTask: false })
		expect(task.cleanupSettled).toBe(true)
		const restored = await provider.createTaskWithHistoryItem(await store.readAuthoritative(task.taskId), {
			startTask: false,
		})
		expect(restored.executionToken?.generation).toBeGreaterThan(task.executionToken!.generation)
		expect(await restored.guardExecution()).toBe(true)
		expect(await task.guardExecution()).toBe(false)
		expect(await provider.completeTask(task, "stale")).toBe(false)
		expect(scheduler.queued).toHaveLength(0)
	})

	it("same-ID active replacement waits for cleanup, transfers before preparation and never removes focus", async () => {
		const { provider, store, scheduler } = await shell()
		const original = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(original)
		const work = deferred()
		void original.trackExecutionWork(work.promise)
		const cleanup = vi.spyOn(original, "awaitExecutionCleanup")
		const transfer = vi.spyOn(store, "transferTaskExecution")
		const remove = vi.spyOn(provider, "removeClineFromStack")
		const replace = vi.spyOn(provider["taskRegistry"], "replace")
		const prepare = vi.spyOn(provider, "performPreparationTasks").mockImplementation(async (task) => {
			expect(task.executionToken).toEqual(executionToken(await store.readAuthoritative(task.taskId)))
			expect(original.cleanupSettled).toBe(true)
		})
		const replacing = provider.createTaskWithHistoryItem(await store.readAuthoritative(original.taskId), {
			startTask: false,
		})
		try {
			await vi.waitFor(() => expect(cleanup).toHaveBeenCalled())
			expect(provider.getCurrentTask()).toBe(original)
			expect(transfer).not.toHaveBeenCalled()
			expect(prepare).not.toHaveBeenCalled()
		} finally {
			work.resolve()
		}
		const replacement = await replacing
		expect(remove).not.toHaveBeenCalled()
		expect(replace).toHaveBeenCalledExactlyOnceWith(original.taskId, replacement)
		expect(prepare).toHaveBeenCalledExactlyOnceWith(replacement)
		expect(provider.getCurrentTask()).toBe(replacement)
		expect(await replacement.guardExecution()).toBe(true)
		expect(await original.guardExecution()).toBe(false)
		expect(scheduler.queued).toHaveLength(0)
	})

	it("different-ID history navigation preserves the prior stack entry without executing it", async () => {
		const { provider, store, scheduler } = await shell()
		const previous = await provider.createTask("", undefined, undefined, { startTask: false })
		const outgoing = await provider.createTask("", undefined, undefined, { startTask: false })
		// A multi-entry registry is supported independently of persisted delegation.
		provider["taskRegistry"].push(previous)
		provider["taskRegistry"].push(outgoing)
		const history: HistoryItem = {
			id: "observer",
			number: 1,
			ts: 1,
			task: "Observer",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		await store.upsert(history)
		await saveApiMessages({ taskId: history.id, globalStoragePath: storage, messages: [] })
		await saveTaskMessages({ taskId: history.id, globalStoragePath: storage, messages: [] })
		const previousHistory = await store.readAuthoritative(previous.taskId)
		const prepare = vi.spyOn(provider, "performPreparationTasks")
		const observer = await provider.createTaskWithHistoryItem(history)
		expect(provider["taskRegistry"].getAll()).toEqual([previous, observer])
		expect(provider.getCurrentTask()).toBe(observer)
		expect(observer.executionToken).toBeUndefined()
		expect(await store.readAuthoritative(previous.taskId)).toEqual(previousHistory)
		expect(prepare).not.toHaveBeenCalled()
		expect(scheduler.queued).toHaveLength(0)
	})

	it("same-ID transfer cannot commit after cancellation starts during its file-lock wait", async () => {
		const { provider, store, scheduler } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		const barrier = holdHistoryMerge(
			task.taskId,
			(item) => executionClaim(item).owner.runtimeId !== task.instanceId,
		)
		const transfer = vi.spyOn(store, "transferTaskExecution")
		const replacing = provider.createTaskWithHistoryItem(await store.readAuthoritative(task.taskId))
		const rejected = expect(replacing).rejects.toMatchObject({ reason: "stale_scope" })
		await barrier.entered
		const cancelling = provider.cancelTask()
		const cancelled = expect(cancelling).resolves.toBeUndefined()
		barrier.release()
		await Promise.all([rejected, cancelled])
		expect(transfer).toHaveBeenCalledTimes(1)
		expect(await transfer.mock.results[0].value).toMatchObject({ kind: "refused", reason: "stale_scope" })
		expect(executionClaim(await store.readAuthoritative(task.taskId)).owner.runtimeId).toBe(task.instanceId)
		expect(provider.getCurrentTask()?.executionToken).toBeUndefined()
		expect(scheduler.queued).toHaveLength(0)
	})

	it.each(["settings", "initial state"])(
		"an older creation waiting for %s cannot steal newer focus",
		async (stage) => {
			const { provider, store, scheduler } = await shell()
			const entered = deferred(),
				release = deferred()
			if (stage === "settings") {
				vi.spyOn(provider, "setValues").mockImplementationOnce(async () => {
					entered.resolve()
					await release.promise
				})
			} else {
				const state = await provider.getState()
				vi.spyOn(provider, "getState").mockImplementationOnce(async () => {
					entered.resolve()
					await release.promise
					return state
				})
			}
			const claim = vi.spyOn(store, "claimNewTask")
			const older = provider.createTask("", undefined, undefined, { taskId: "older", startTask: false })
			const rejected = expect(older).rejects.toMatchObject({ reason: "stale_scope" })
			await entered.promise
			const newer = await provider.createTask("", undefined, undefined, { taskId: "newer", startTask: false })
			release.resolve()
			await rejected
			expect(provider.getCurrentTask()).toBe(newer)
			expect(claim).toHaveBeenCalledTimes(1)
			expect(claim.mock.calls[0][0].id).toBe("newer")
			expect(await newer.guardExecution()).toBe(true)
			expect(scheduler.queued).toHaveLength(0)
		},
	)

	it.each(["set", "clear"])(
		"pending intent %s refuses navigation during the real file-lock wait",
		async (command) => {
			const { provider, store } = await shell()
			const task = await provider.createTask("", undefined, undefined, { startTask: false })
			await seedMessages(task)
			const action: PendingTaskAction = {
				kind: "create_subtask",
				actionId: "pending",
				approvalText: "{}",
				mode: "code",
				message: "Child",
				todos: [],
			}
			if (command === "clear") await provider.setPendingTaskAction(task.taskId, action, task)
			const before = await store.readAuthoritative(task.taskId)
			const barrier = holdHistoryMerge(task.taskId, () => true)
			const pending =
				command === "set"
					? provider.setPendingTaskAction(task.taskId, action, task)
					: provider.clearPendingTaskAction(task.taskId, action.actionId, task)
			const rejected = expect(pending).rejects.toMatchObject({ reason: "stale_scope" })
			await barrier.entered
			const navigating = provider.createTask("", undefined, undefined, { startTask: false })
			barrier.release()
			await rejected
			const other = await navigating
			expect((await store.readAuthoritative(task.taskId)).pendingAction).toEqual(before.pendingAction)
			expect(provider.getCurrentTask()).toBe(other)
		},
	)

	it("no-op lifecycle admission checks scope after the final asynchronous lineage read", async () => {
		const { provider, store } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		const before = await store.readAuthoritative(task.taskId)
		const write = vi.spyOn(safeJson, "safeWriteJson")
		let current = true
		await expect(
			store.lifecycleCommand(
				task.taskId,
				(item) => {
					queueMicrotask(() => {
						current = false
					})
					return item
				},
				[],
				false,
				task.executionToken,
				() => current,
			),
		).rejects.toMatchObject({ reason: "stale_scope" })
		expect(write).not.toHaveBeenCalled()
		expect(await store.readAuthoritative(task.taskId)).toEqual(before)
	})

	it.each([
		["reserve", "cancel"],
		["commit", "cancel"],
		["reserve", "navigate"],
		["commit", "navigate"],
	])("delegation %s loses to %s at the safeWriteJson merge boundary", async (stage, action) => {
		const { provider, store, scheduler } = await shell()
		const parent = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(parent)
		const barrier = holdHistoryMerge(parent.taskId, (item) =>
			delegationState(item).actions.some(
				(action) => action.phase === (stage === "reserve" ? "prepared" : "committed"),
			),
		)
		const delegating = delegate(provider, parent)
		const rejected = expect(delegating).rejects.toMatchObject({ reason: "stale_scope" })
		await barrier.entered
		const leaving =
			action === "cancel"
				? provider.cancelTask()
				: provider.createTask("", undefined, undefined, { startTask: false })
		barrier.release()
		const [, other] = await Promise.all([rejected, leaving])
		const history = await store.readAuthoritative(parent.taskId)
		expect(history.awaitingChildId).toBeUndefined()
		expect(delegationState(history).actions.some((action) => action.phase === "committed")).toBe(false)
		expect(scheduler.queued).toHaveLength(0)
		if (action === "cancel") expect(provider.getCurrentTask()?.executionToken).toBeUndefined()
		else expect(provider.getCurrentTask()).toBe(other)
		expect(provider.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegated,
			expect.anything(),
			expect.anything(),
		)
	})

	it.each(["owner", "generation", "phase", "cleanup", "blocked", "runtime blocked"] as const)(
		"delegation commit refuses a prepared child's changed %s despite unchanged status and lineage",
		async (change) => {
			const { provider, store, scheduler } = await shell()
			const parent = await provider.createTask("", undefined, undefined, { startTask: false })
			await seedMessages(parent)
			const create = provider.createTask.bind(provider)
			vi.spyOn(provider, "createTask").mockImplementation(async (...args) => {
				const child = await create(...args)
				const history = await store.readAuthoritative(child.taskId)
				const claim = executionClaim(history)
				if (change === "owner") claim.owner.runtimeId = "replacement-owner"
				if (change === "generation") history.executionGeneration = ++claim.generation
				if (change === "phase") claim.phase = "suspended"
				if (change === "cleanup") claim.cleanupPending = true
				if (change === "blocked")
					history.delegation = {
						version: 1,
						actions: [],
						blocked: { actionId: "blocked", generation: claim.generation, reason: "recovery_required" },
					}
				if (change === "runtime blocked") child.executionBlocked = true
				// Deliberately conflicting external metadata; status and lineage remain valid.
				await fs.writeFile(
					path.join(storage, "tasks", child.taskId, "history_item.json"),
					JSON.stringify({ ...history, execution: claim }),
				)
				return child
			})
			const reasons = {
				owner: "owner_mismatch",
				generation: "stale_generation",
				phase: "not_active",
				cleanup: "cleanup_pending",
				blocked: "recovery_required",
				"runtime blocked": "stale_scope",
			}
			await expect(delegate(provider, parent)).rejects.toMatchObject({ reason: reasons[change] })
			const history = await store.readAuthoritative(parent.taskId)
			expect(history.awaitingChildId).toBeUndefined()
			expect(delegationState(history).actions[0]).toMatchObject({ phase: "failed", reason: reasons[change] })
			expect(scheduler.queued).toHaveLength(0)
		},
	)

	it.each(["cancel", "navigate"])("standalone completion refuses %s before its first write", async (action) => {
		const { provider, store } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		const barrier = holdHistoryMerge(task.taskId, (item) => item.status === "completed")
		const completing = provider.completeTask(task, "Stale result")
		await barrier.entered
		const leaving =
			action === "cancel"
				? provider.cancelTask()
				: provider.createTask("", undefined, undefined, { startTask: false })
		barrier.release()
		expect(await completing).toBe(false)
		await leaving
		const history = await store.readAuthoritative(task.taskId)
		expect(history.status).toBe("interrupted")
		expect(history.completionResultSummary).toBeUndefined()
		expect(provider.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})

	it("accepted standalone completion finishes cleanup and transcript before notification after focus moves", async () => {
		const { provider, store } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		task.apiConversationHistory.push({
			messageId: "accepted",
			role: "assistant",
			content: "Accepted result",
			ts: 2,
		})
		const accepted = structuredClone(task.apiConversationHistory)
		const committed = deferred(),
			release = deferred()
		const complete = store.completeStandaloneTask.bind(store)
		vi.spyOn(store, "completeStandaloneTask").mockImplementation(async (...args) => {
			const result = await complete(...args)
			committed.resolve()
			await release.promise
			return result
		})
		const save = store.saveExecutionSnapshot.bind(store)
		const order: string[] = []
		vi.spyOn(store, "saveExecutionSnapshot").mockImplementation(async (...args) => {
			await save(...args)
			if (args[2]) {
				expect(await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })).toEqual(accepted)
				order.push("durable")
			}
		})
		vi.mocked(provider.emit).mockImplementation((event) => {
			if (event === RooCodeEventName.TaskCompleted) order.push("notified")
			return true
		})
		const completing = provider.completeTask(task, "Accepted result")
		await committed.promise
		const other = await provider.createTask("", undefined, undefined, { startTask: false })
		expect(order).toEqual([])
		release.resolve()
		expect(await completing).toBe(true)
		expect(order).toEqual(["durable", "notified"])
		expect(provider.getCurrentTask()).toBe(other)
		expect(task.cleanupSettled).toBe(true)
		expect(executionClaim(await store.readAuthoritative(task.taskId)).phase).toBe("settled")
	})

	it("wrong prompt/task/choice, double recovery and cancelled-generation callbacks cannot run", async () => {
		const { provider, store, scheduler } = await shell()
		const original = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(original)
		await provider.cancelTask()
		const request = await decision(provider)
		for (const invalid of [
			{ ...request, promptId: "wrong" },
			{ ...request, taskId: "wrong" },
			{ ...request, choice: "resume_linked" as const },
		])
			expect((await provider.recoverTask(invalid)).kind).toBe("refused")
		const [first, second] = await Promise.all([provider.recoverTask(request), provider.recoverTask(request)])
		expect(first.kind).toBe("applied")
		expect(second).toMatchObject({ kind: "refused", reason: "stale_scope" })
		expect(scheduler.queued).toHaveLength(1)
		expect(provider.getCurrentTask()?.executionToken).toBeDefined()
		expect(await provider.completeTask(original, "stale")).toBe(false)
		expect((await store.readAuthoritative(original.taskId)).status).toBe("active")
	})

	it("scope changes during the real recovery commit refuse without a new runtime", async () => {
		const { provider, store, scheduler } = await shell()
		const original = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(original)
		await provider.cancelTask()
		const request = await decision(provider)
		const entered = deferred(),
			release = deferred()
		const recover = store.recoverTask.bind(store)
		vi.spyOn(store, "recoverTask").mockImplementation(async (...args) => {
			entered.resolve()
			await release.promise
			return recover(...args)
		})
		const recovering = provider.recoverTask(request)
		await entered.promise
		const other = await provider.createTask("", undefined, undefined, { startTask: false })
		release.resolve()
		expect(await recovering).toMatchObject({ kind: "refused", reason: "stale_scope" })
		expect(provider.getCurrentTask()).toBe(other)
		expect(scheduler.queued).toHaveLength(0)
	})

	it("focus loss after durable recovery settles the unlaunched claim instead of stealing focus", async () => {
		const { provider, store, scheduler } = await shell()
		const original = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(original)
		await provider.cancelTask()
		const request = await decision(provider)
		const committed = deferred(),
			release = deferred()
		const recover = store.recoverTask.bind(store)
		vi.spyOn(store, "recoverTask").mockImplementation(async (...args) => {
			const result = await recover(...args)
			committed.resolve()
			await release.promise
			return result
		})
		const recovering = provider.recoverTask(request)
		await committed.promise
		const other = await provider.createTask("", undefined, undefined, { startTask: false })
		release.resolve()
		expect((await recovering).kind).toBe("applied")
		expect(provider.getCurrentTask()).toBe(other)
		expect(executionClaim(await store.readAuthoritative(original.taskId)).phase).toBe("settled")
		expect(scheduler.queued).toHaveLength(0)
	})

	it("exact immutable approval completes once, persists history before events and schedules parent once", async () => {
		const { provider, store, scheduler } = await shell()
		const parent = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(parent)
		const child = await delegate(provider, parent)
		expect(parent.cleanupSettled).toBe(true)
		expect(executionClaim(await store.readAuthoritative(parent.taskId)).phase).toBe("suspended")
		const params = await completion(provider, child)
		expect(Object.isFrozen(params.request.finish)).toBe(true)
		const before = await readApiMessages({ taskId: parent.taskId, globalStoragePath: storage })
		expect(await provider.reopenParentFromDelegation({ ...params, request: structuredClone(params.request) })).toBe(
			false,
		)
		expect(await readApiMessages({ taskId: parent.taskId, globalStoragePath: storage })).toEqual(before)
		expect(await provider.reopenParentFromDelegation(params)).toBe(true)
		expect(await provider.reopenParentFromDelegation(params)).toBe(false)
		expect(child.executionToken).toEqual(params.request.childToken)
		expect(child.cleanupSettled).toBe(true)
		expect((await store.readAuthoritative(child.taskId)).status).toBe("completed")
		const resumed = provider.getCurrentTask()!
		expect(resumed.taskId).toBe(parent.taskId)
		expect(resumed).not.toBe(parent)
		expect(resumed.clineMessages.filter((message) => message.say === "subtask_result")).toHaveLength(1)
		expect(scheduler.queued.filter((entry) => entry.task === resumed)).toHaveLength(1)
		expect(
			vi.mocked(provider.emit).mock.calls.filter((call) => call[0] === RooCodeEventName.TaskCompleted),
		).toHaveLength(1)
		expect(await provider.completeTask(parent, "stale")).toBe(false)
	})

	it("changed finish action refuses before any parent transcript or event effect", async () => {
		const { provider, store } = await shell()
		const parent = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(parent)
		const child = await delegate(provider, parent)
		const params = await completion(provider, child)
		const before = await readTaskMessages({ taskId: parent.taskId, globalStoragePath: storage })
		const api = await readApiMessages({ taskId: parent.taskId, globalStoragePath: storage })
		await store.lifecycleCommand(
			child.taskId,
			(item) => ({ ...item, pendingAction: { ...params.request.finish, result: "changed" } }),
			[],
			false,
			child.executionToken,
		)
		vi.mocked(provider.emit).mockClear()
		expect(await provider.reopenParentFromDelegation(params)).toBe(false)
		expect(await readTaskMessages({ taskId: parent.taskId, globalStoragePath: storage })).toEqual(before)
		expect(await readApiMessages({ taskId: parent.taskId, globalStoragePath: storage })).toEqual(api)
		expect(provider.emit).not.toHaveBeenCalled()
	})

	it("cancellation during a committed completion cleans the child without scheduling the parent", async () => {
		const { provider, store, scheduler } = await shell()
		const parent = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(parent)
		const child = await delegate(provider, parent)
		const params = await completion(provider, child)
		const committed = deferred(),
			release = deferred()
		const complete = store.completeDelegatedTask.bind(store)
		vi.spyOn(store, "completeDelegatedTask").mockImplementation(async (...args) => {
			const result = await complete(...args)
			committed.resolve()
			await release.promise
			return result
		})
		const completing = provider.reopenParentFromDelegation(params)
		await committed.promise
		await provider.cancelTask()
		release.resolve()
		expect(await completing).toBe(true)
		expect(provider.getCurrentTask()?.taskId).toBe(child.taskId)
		expect(provider.getCurrentTask()?.executionToken).toBeUndefined()
		expect(scheduler.queued.filter((entry) => entry.task.taskId === parent.taskId)).toHaveLength(0)
		expect(executionClaim(await store.readAuthoritative(child.taskId)).phase).toBe("settled")
		expect(executionClaim(await store.readAuthoritative(parent.taskId)).phase).toBe("suspended")
		expect(await provider.reopenParentFromDelegation(params)).toBe(false)
	})

	it("preview focus changes during publication invalidate the prompt after the await", async () => {
		const { provider, store } = await shell()
		const original = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(original)
		await provider.cancelTask()
		const before = await store.readAuthoritative(original.taskId)
		const posted = deferred(),
			release = deferred()
		vi.spyOn(provider, "postMessageToWebview").mockImplementation(async (message) => {
			if (message.type === "taskRecovery") {
				posted.resolve()
				await release.promise
			}
		})
		const preview = provider.previewTaskRecovery(original.taskId)
		const rejected = expect(preview).rejects.toMatchObject({ reason: "stale_scope" })
		await posted.promise
		const other = await provider.createTask("", undefined, undefined, { startTask: false })
		release.resolve()
		await rejected
		expect(provider.getCurrentTask()).toBe(other)
		expect(provider["recoveryPrompt"]).toBeUndefined()
		expect(await store.readAuthoritative(original.taskId)).toEqual(before)
	})

	it("observer installation survives a stale automatic preview without retaining usable authority", async () => {
		const { provider, store, scheduler } = await shell()
		const original = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(original)
		await provider.cancelTask()
		const before = await store.readAuthoritative(original.taskId)
		let posted = false
		vi.spyOn(provider, "postMessageToWebview").mockImplementation(async (message) => {
			if (message.type !== "taskRecovery") return
			posted = true
			// External metadata can change during publication even when focus is unchanged.
			await fs.writeFile(
				path.join(storage, "tasks", original.taskId, "history_item.json"),
				JSON.stringify({
					...before,
					lifecycleRevision: before.lifecycleRevision! + 1,
				}),
			)
		})
		const observer = await provider.createTaskWithHistoryItem(before)
		expect(posted).toBe(true)
		expect(provider.getCurrentTask()).toBe(observer)
		expect(observer.executionToken).toBeUndefined()
		expect(provider["recoveryPrompt"]).toBeUndefined()
		expect(scheduler.queued).toHaveLength(0)
	})

	it("changed authoritative action invalidates a displayed recovery scope", async () => {
		const { provider, store, scheduler } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		await provider.cancelTask()
		const request = await decision(provider)
		const history = await store.readAuthoritative(task.taskId)
		// Simulate conflicting external metadata; no ordinary local writer can add
		// intent to a settled history. The real command must still reject disk changes.
		await fs.writeFile(
			path.join(storage, "tasks", task.taskId, "history_item.json"),
			JSON.stringify({
				...history,
				pendingAction: {
					kind: "create_subtask",
					actionId: "changed",
					approvalText: "{}",
					mode: "code",
					message: "changed",
					todos: [],
				},
			}),
		)
		expect(await provider.recoverTask(request)).toMatchObject({ kind: "refused", reason: "stale_scope" })
		expect(scheduler.queued).toHaveLength(0)
	})

	it("actual cleanup failure retains the fenced claim and a peer cannot recover it", async () => {
		const { provider, store } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		vi.spyOn(task.diffViewProvider, "revertChanges").mockRejectedValue(new Error("editor cleanup failed"))
		task.diffViewProvider.isEditing = true
		await provider.cancelTask()
		expect(task.cleanupSettled).toBe(false)
		expect(executionClaim(await store.readAuthoritative(task.taskId))).toMatchObject({
			cleanupPending: true,
			phase: "suspended",
		})
		const peer = await shell()
		await peer.provider.createTaskWithHistoryItem(await store.readAuthoritative(task.taskId))
		expect(await peer.provider.previewTaskRecovery(task.taskId)).toMatchObject({
			choices: [],
			reason: "cleanup_pending",
		})
	})

	it("real scheduler admits an empty claimed Task and refuses its cancelled queued incarnation", async () => {
		const { provider, scheduler } = await shell()
		const task = await provider.createTask()
		const run = vi.spyOn(task, "run")
		await scheduler.drain()
		expect(run).toHaveBeenCalledTimes(1)
		expect(task.api.createMessage).not.toHaveBeenCalled()
		const stopped = await provider.createTask()
		const stoppedRun = vi.spyOn(stopped, "run")
		await provider.evictCurrentTask()
		await scheduler.drain()
		expect(stoppedRun).not.toHaveBeenCalled()
		expect(scheduler.waiting).toBe(0)
	})

	it("shutdown settles its cleaned suspended ancestors but never a peer claim", async () => {
		const local = await shell()
		const parent = await local.provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(parent)
		const child = await delegate(local.provider, parent)
		const peer = await shell()
		const peerTask = await peer.provider.createTask("", undefined, undefined, { startTask: false })
		const before = await peer.store.readAuthoritative(peerTask.taskId)
		await local.provider.dispose()
		expect(executionClaim(await peer.store.readAuthoritative(parent.taskId)).phase).toBe("settled")
		expect(executionClaim(await peer.store.readAuthoritative(child.taskId)).phase).toBe("settled")
		expect(await peer.store.readAuthoritative(peerTask.taskId)).toEqual(before)
		expect(await peerTask.guardExecution()).toBe(true)
	})

	it("new task preparation failure fences and cleans the preclaim", async () => {
		const { provider, store } = await shell()
		vi.spyOn(provider, "performPreparationTasks").mockRejectedValue(new Error("preparation failed"))
		await expect(
			provider.createTask("", undefined, undefined, { taskId: "failed-start", startTask: false }),
		).rejects.toThrow("preparation failed")
		expect(executionClaim(await store.readAuthoritative("failed-start"))).toMatchObject({
			phase: "settled",
			cleanupPending: false,
		})
	})

	it("a failed final snapshot keeps ownership even when disposal succeeds", async () => {
		const { provider, store } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		const save = store.saveExecutionSnapshot.bind(store)
		vi.spyOn(store, "saveExecutionSnapshot").mockImplementation(async (token, snapshot, cleanup) => {
			if (cleanup) throw new Error("final snapshot unavailable")
			return save(token, snapshot, cleanup)
		})
		await provider.cancelTask()
		expect(task.cleanupSettled).toBe(true)
		await provider.dispose()
		expect(executionClaim(await store.readAuthoritative(task.taskId))).toMatchObject({
			phase: "suspended",
			cleanupPending: true,
		})
	})

	it("a retained pending approval cannot transfer after a later cleanup fence failure", async () => {
		const { provider, store, scheduler } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		const action: PendingTaskAction = {
			kind: "create_subtask",
			actionId: "pending",
			approvalText: "{}",
			mode: "code",
			message: "Child",
			todos: [],
		}
		await provider.setPendingTaskAction(task.taskId, action, task)
		task.setPendingTaskAction(action)
		await provider.createTask("", undefined, undefined, { startTask: false })
		const owned = provider["ownedExecutions"].get(task.taskId)!
		expect(owned).toMatchObject({ cleanupSettled: true, pendingApproval: true })
		vi.spyOn(store, "interruptTask").mockRejectedValueOnce(new Error("cleanup fence unavailable"))
		await provider["stopOwnedTask"](task)
		expect(owned).toMatchObject({ cleanupSettled: true, pendingApproval: true, snapshotFailed: true })
		const before = await store.readAuthoritative(task.taskId)
		const transfer = vi.spyOn(store, "transferTaskExecution")
		const observer = await provider.createTaskWithHistoryItem(before)
		expect(observer.executionToken).toBeUndefined()
		expect(observer.executionBlocked).toBe(true)
		expect(transfer).not.toHaveBeenCalled()
		expect(provider["ownedExecutions"].get(task.taskId)).toBe(owned)
		expect(await store.readAuthoritative(task.taskId)).toEqual(before)
		expect(scheduler.queued).toHaveLength(0)
	})

	it("failed same-ID snapshots retain blocked ownership and never enable a later replacement", async () => {
		const { provider, store, scheduler } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		const save = vi.spyOn(store, "saveExecutionSnapshot").mockRejectedValueOnce(new Error("snapshot failed"))
		await expect(provider.createTaskWithHistoryItem(await store.readAuthoritative(task.taskId))).rejects.toThrow(
			"snapshot failed",
		)
		expect(provider.getCurrentTask()).toBe(task)
		expect(task.cleanupSettled).toBe(true)
		expect(task.executionBlocked).toBe(true)
		const owned = provider["ownedExecutions"].get(task.taskId)!
		expect(owned.snapshotFailed).toBe(true)
		save.mockRestore()
		const transfer = vi.spyOn(store, "transferTaskExecution")
		const settle = vi.spyOn(store, "settleTaskExecution")
		const observer = await provider.createTaskWithHistoryItem(await store.readAuthoritative(task.taskId))
		expect(observer.executionToken).toBeUndefined()
		expect(await provider.completeTask(task, "Late result")).toBe(false)
		expect(transfer).not.toHaveBeenCalled()
		expect(settle).not.toHaveBeenCalled()
		expect(provider["ownedExecutions"].get(task.taskId)).toBe(owned)
		expect(scheduler.queued).toHaveLength(0)
	})

	it.each(["approval", "commit", "transfer"])(
		"parent snapshot failure blocks delegated completion at %s",
		async (stage) => {
			const { provider, store, scheduler } = await shell()
			const parent = await provider.createTask("", undefined, undefined, { startTask: false })
			await seedMessages(parent)
			const child = await delegate(provider, parent)
			const params = await completion(provider, child)
			const owned = provider["ownedExecutions"].get(parent.taskId)!
			const before = await store.readAuthoritative(parent.taskId)
			const transfers = vi.spyOn(store, "transferTaskExecution")
			const command = vi.spyOn(store, "completeDelegatedTask")
			const failSnapshot = async () => {
				vi.spyOn(store, "saveExecutionSnapshot").mockRejectedValueOnce(new Error("retained snapshot failed"))
				// Preserve its exact suspended parent token while testing the provider's
				// cleanup-failure latch, rather than replacing the durable claim in a fixture.
				vi.spyOn(store, "interruptTask").mockResolvedValueOnce({
					kind: "applied",
					history: before,
					token: owned.token,
				})
				await provider["stopOwnedTask"](parent)
				expect(owned).toMatchObject({ snapshotFailed: true, cleanupSettled: true })
			}
			if (stage === "transfer") {
				command.mockRestore()
				const original = store.completeDelegatedTask.bind(store)
				vi.spyOn(store, "completeDelegatedTask").mockImplementation(async (...args) => {
					const result = await original(...args)
					await failSnapshot()
					return result
				})
				expect(await provider.reopenParentFromDelegation(params)).toBe(true)
			} else {
				await failSnapshot()
				if (stage === "approval") {
					const finish = child.getPendingTaskAction()
					if (finish?.kind !== "finish_subtask") throw new Error("Missing finish intent")
					expect(await provider.prepareDelegatedCompletion(child, finish)).toBeUndefined()
				} else expect(await provider.reopenParentFromDelegation(params)).toBe(false)
				expect(command).not.toHaveBeenCalled()
				expect(await store.readAuthoritative(parent.taskId)).toEqual(before)
			}
			expect(transfers).not.toHaveBeenCalled()
			expect(provider["ownedExecutions"].get(parent.taskId)).toBe(owned)
			expect(parent.executionBlocked).toBe(true)
			expect(scheduler.queued.filter((entry) => entry.task.taskId === parent.taskId)).toHaveLength(0)
		},
	)

	it("denied receipt stays truthful through explicit recovery and backend state follows only current focus", async () => {
		const { provider, store, scheduler } = await shell()
		const task = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(task)
		await task.overwriteApiConversationHistory([
			{ role: "assistant", content: [{ type: "tool_use", id: "denied-call", name: "new_task", input: {} }] },
		])
		const action: PendingTaskAction = {
			kind: "create_subtask",
			actionId: "denied-call",
			approvalText: "{}",
			message: "Child",
			mode: "code",
			todos: [],
		}
		await provider.setPendingTaskAction(task.taskId, action, task)
		task.setPendingTaskAction(action)
		await provider.denyTaskDelegation(task, action)
		const before = await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })
		expect(delegationState(await store.readAuthoritative(task.taskId)).actions[0]).toMatchObject({
			phase: "denied",
			reason: "wrong_intent",
			resultWritten: true,
		})
		const prompt = await provider.previewTaskRecovery(task.taskId)
		expect((await provider.getStateToPostToWebview()).taskRecovery).toEqual(prompt)
		expect(
			await provider.recoverTask({ ...prompt, choice: "resume_independent", intent: "explicit_user_resume" }),
		).toMatchObject({ kind: "refused", reason: "wrong_intent" })
		// The public decision schema is strict: presentation fields are not authority.
		expect(
			(
				await provider.recoverTask({
					taskId: task.taskId,
					promptId: prompt.promptId,
					choice: "resume_independent",
					intent: "explicit_user_resume",
				})
			).kind,
		).toBe("applied")
		expect(await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })).toEqual(before)
		expect(delegationState(await store.readAuthoritative(task.taskId)).blocked).toBeUndefined()
		expect(scheduler.queued).toHaveLength(1)
		expect((await provider.getStateToPostToWebview()).taskRecovery).toBeNull()
	})

	it("linked recovery preserves ownership, abandonment resumes independently without reattaching", async () => {
		const { provider, store } = await shell()
		const parent = await provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(parent)
		const child = await delegate(provider, parent)
		await provider.cancelTask()
		const linked = await decision(provider)
		expect(linked.choice).toBe("resume_linked")
		expect((await provider.recoverTask(linked)).kind).toBe("applied")
		expect(provider.getCurrentTask()?.parentTaskId).toBe(parent.taskId)
		await provider.cancelTask()
		expect(await provider.abandonSubtask(child.taskId)).toBe(true)
		const independent = await decision(provider)
		expect(independent.choice).toBe("resume_independent")
		expect((await provider.recoverTask(independent)).kind).toBe("applied")
		expect(provider.getCurrentTask()?.parentTaskId).toBeUndefined()
		expect((await store.readAuthoritative(parent.taskId)).awaitingChildId).toBeUndefined()
	})

	it("confirmed-dead nested chain resumes C then transfers settled foreign B and A exactly once", async () => {
		const host = (session: string, processId: number): ExecutionHost => ({
			identity: { hostSessionId: session, processId, machineId: "test-machine", machineProof: "local" },
			probeProcess: async () => "ESRCH",
		})
		const a = await shell(host("dead", 100))
		const root = await a.provider.createTask("", undefined, undefined, { startTask: false })
		await seedMessages(root)
		const middle = await delegate(a.provider, root, "create-b")
		await seedMessages(middle)
		const leaf = await delegate(a.provider, middle, "create-c")
		// Positive owner-death proof belongs to the store host seam, not absence from a stack.
		const b = await shell(host("new", 200))
		expect(executionClaim(await b.store.readAuthoritative(root.taskId)).phase).toBe("settled")
		expect((await b.store.readAuthoritative(leaf.taskId)).status).toBe("interrupted")
		await b.provider.createTaskWithHistoryItem(await b.store.readAuthoritative(leaf.taskId))
		expect((await b.provider.recoverTask(await decision(b.provider))).kind).toBe("applied")
		expect(
			await b.provider.reopenParentFromDelegation(await completion(b.provider, b.provider.getCurrentTask()!)),
		).toBe(true)
		expect(b.provider.getCurrentTask()?.taskId).toBe(middle.taskId)
		expect(
			await b.provider.reopenParentFromDelegation(await completion(b.provider, b.provider.getCurrentTask()!)),
		).toBe(true)
		expect(b.provider.getCurrentTask()?.taskId).toBe(root.taskId)
		expect(await b.provider.completeTask(b.provider.getCurrentTask()!, "All done")).toBe(true)
		expect((await b.store.readAuthoritative(root.taskId)).status).toBe("completed")
		expect(await root.guardExecution()).toBe(false)
	})
})
