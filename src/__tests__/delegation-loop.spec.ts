import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { RooCodeEventName, type HistoryItem } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../core/task/Task"
import { TaskRegistry } from "../core/task/TaskRegistry"
import { TaskScheduler } from "../core/task/TaskScheduler"
import { LifecycleWriteError, TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"
import { delegationState } from "../core/task-persistence/taskLifecycle"
import { readApiMessages, saveApiMessages } from "../core/task-persistence/apiMessages"
import { readTaskMessages, saveTaskMessages } from "../core/task-persistence/taskMessages"
import { ClineProvider } from "../core/webview/ClineProvider"
import { newTaskTool } from "../core/tools/NewTaskTool"
import { presentAssistantMessage } from "../core/assistant-message/presentAssistantMessage"
import { makeExtensionContext, makeUri } from "../test-utils/vscode"

vi.mock("../core/ignore/RooIgnoreController")
vi.mock("../api", () => ({
	buildApiHandler: () => ({
		getModel: () => ({ id: "offline", info: { contextWindow: 10000, supportsImages: false } }),
		createMessage: () => {
			throw new Error("Unexpected model request")
		},
	}),
}))

// Only the environment is replaced. Delegation, stack cleanup, approval policy,
// persistence, reconstruction, replay and the semaphore gate are production code.
class BoundedScheduler extends TaskScheduler {
	readonly queued: Array<{ task: Task; run: () => Promise<void> }> = []
	admissions = 0
	override schedule(task: Task, run: () => Promise<void>): Promise<void> {
		this.queued.push({ task, run })
		return Promise.resolve()
	}
	async drain(limit = 2): Promise<void> {
		for (let index = 0; index < limit && this.queued.length; index++) {
			const next = this.queued.shift()!
			this.admissions++
			await super.schedule(next.task, next.run)
		}
	}
}

describe("failed delegation containment across reconstruction and replay", () => {
	let storage: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	let scheduler: BoundedScheduler
	const tasks: Task[] = []

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-delegation-loop-"))
		store = new TaskHistoryStore(storage)
		scheduler = new BoundedScheduler()
		const context = makeExtensionContext({ globalStorageUri: makeUri(storage) })
		// Construct the provider's real method surface without starting VS Code shell
		// services, migrations or startup orphan repair (a separate test boundary).
		provider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			context,
			contextProxy: { globalStorageUri: context.globalStorageUri, getValue: () => undefined },
			taskHistoryStore: store,
			taskRegistry: new TaskRegistry(),
			taskScheduler: scheduler,
			taskEventListeners: new Map(),
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
			customModesManager: { getCustomModes: async () => [] },
			providerSettingsManager: { getModeConfigId: async () => undefined, listConfig: async () => [] },
			getState: vi.fn().mockResolvedValue({
				mode: "code",
				apiConfiguration: {},
				enableCheckpoints: false,
				organizationAllowList: { allowAll: true },
				autoApprovalEnabled: true,
				alwaysAllowSubtasks: true,
			}),
			setValues: vi.fn().mockResolvedValue(undefined),
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			getPendingEditOperation: () => undefined,
			log: vi.fn((message: string) => console.info(message)),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			syncFocusedTaskToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			postClineMessagesSnapshot: vi.fn().mockResolvedValue(undefined),
			postClineMessageAppended: vi.fn().mockResolvedValue(undefined),
			postClineMessageUpdated: vi.fn().mockResolvedValue(undefined),
			taskCreationCallback: (task: Task) => {
				tasks.push(task)
			},
		})
	})

	afterEach(async () => {
		scheduler.queued.length = 0
		for (const task of tasks.splice(0)) {
			await task.abortTask(true)
			await task.dispose()
		}
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(storage, { recursive: true, force: true })
	})

	it.each(["automatic", "global-disabled", "subtask-disabled"])(
		"refuses an interrupted parent before approval/allocation and never replays (%s)",
		async (approval) => {
			vi.mocked(provider.getState).mockResolvedValue({
				...(await provider.getState()),
				autoApprovalEnabled: approval !== "global-disabled",
				alwaysAllowSubtasks: approval !== "subtask-disabled",
			})
			const history: HistoryItem = {
				id: "interrupted-parent",
				number: 1,
				ts: 1,
				task: "Original parent",
				status: "interrupted",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				pendingAction: {
					kind: "create_subtask",
					actionId: "create-original",
					approvalText: "{}",
					mode: "code",
					message: "Child",
					todos: [],
				},
			}
			await store.upsert(history)
			await saveTaskMessages({
				taskId: history.id,
				globalStoragePath: storage,
				messages: [{ ts: 1, type: "say", say: "text", text: history.task }],
			})
			await saveApiMessages({
				taskId: history.id,
				globalStoragePath: storage,
				messages: [
					{ role: "user", content: history.task, ts: 1 },
					{
						role: "assistant",
						ts: 2,
						content: [
							{
								type: "tool_use",
								id: "create-original",
								name: "new_task",
								input: { mode: "code", message: "Child" },
							},
						],
					},
				],
			})
			const task = await provider.createTaskWithHistoryItem(history, { startTask: false })
			await task.overwriteClineMessages(
				await readTaskMessages({ taskId: history.id, globalStoragePath: storage }),
				false,
			)
			await task.overwriteApiConversationHistory(
				await readApiMessages({ taskId: history.id, globalStoragePath: storage }),
				false,
			)
			const allocations = vi.spyOn(provider, "createTask")
			const restorations = vi.spyOn(provider, "createTaskWithHistoryItem")
			const replay = vi.spyOn(Task.prototype, "run")
			const apiRequest = vi.spyOn(task.api, "createMessage")
			const askApproval = vi.fn(
				async () =>
					(await task.ask("tool", JSON.stringify({ tool: "newTask" }), false)).response ===
					"yesButtonClicked",
			)
			if (approval !== "automatic") {
				// Explicitly approve the initial call only. Restored approvals receive a
				// stop, never a synthetic automatic yes. The baseline therefore cannot spin.
				task.on(RooCodeEventName.Message, ({ message }) => {
					if (message.ask === "tool") void task.handleWebviewAskResponse("yesButtonClicked")
				})
			}
			await newTaskTool.execute({ mode: "code", message: "Child" }, task, {
				askApproval,
				toolCallId: "create-original",
				pushToolResult: vi.fn(),
				handleError: async (_context, error) => {
					console.info("initial delegation error", error)
				},
			})
			if (approval === "automatic") await scheduler.drain(2)
			console.info("bounded delegation baseline", {
				approval,
				allocations: allocations.mock.calls.length,
				restorations: restorations.mock.calls.length,
				replay: replay.mock.calls.length,
				queued: scheduler.queued.length,
				admissions: scheduler.admissions,
			})
			expect(allocations.mock.calls.length).toBe(0)
			expect(askApproval).not.toHaveBeenCalled()
			expect(restorations).not.toHaveBeenCalled()
			expect(scheduler.queued).toHaveLength(0)
			expect(apiRequest).not.toHaveBeenCalled()
			for (let reload = 0; reload < 3; reload++) {
				await store.invalidate(history.id)
				const restored = await provider.createTaskWithHistoryItem(await store.readAuthoritative(history.id))
				expect(restored.executionBlocked).toBe(true)
				expect(restored.clineMessages.some((message) => message.say === "error")).toBe(false)
				await scheduler.drain()
			}
			const persisted = await store.readAuthoritative(history.id)
			// An ownerless legacy history is observational, including its unresolved
			// intent. No authority may be manufactured to write a failure receipt.
			expect(persisted.pendingAction?.actionId).toBe("create-original")
			expect(persisted.execution).toBeUndefined()
			expect(persisted).toEqual(history)
			const api = await readApiMessages({ taskId: history.id, globalStoragePath: storage })
			const results = api
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.filter((block) => block.type === "tool_result")
			expect(results).toEqual([])
			expect(allocations.mock.calls.length).toBe(0)
			expect(scheduler.queued).toHaveLength(0)
		},
	)

	async function activeParent() {
		const task = await provider.createTask("Parent", undefined, undefined, {
			taskId: "active-parent",
			startTask: false,
		})
		const history: HistoryItem = {
			id: "active-parent",
			number: 1,
			ts: 1,
			task: "Parent",
			status: "active",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		await saveTaskMessages({
			taskId: history.id,
			globalStoragePath: storage,
			messages: [{ ts: 1, type: "say", say: "text", text: "Parent" }],
		})
		await saveApiMessages({
			taskId: history.id,
			globalStoragePath: storage,
			messages: [
				{
					role: "assistant",
					ts: 2,
					content: [{ type: "tool_use", id: "create-active", name: "new_task", input: {} }],
				},
			],
		})
		await task.overwriteClineMessages(
			await readTaskMessages({ taskId: task.taskId, globalStoragePath: storage }),
			false,
		)
		await task.overwriteApiConversationHistory(
			await readApiMessages({ taskId: task.taskId, globalStoragePath: storage }),
			false,
		)
		return task
	}

	async function execute(task: Task) {
		await newTaskTool.execute({ mode: "code", message: "Child" }, task, {
			toolCallId: "create-active",
			askApproval: async (_type, text) => (await task.ask("tool", text, false)).response === "yesButtonClicked",
			pushToolResult: vi.fn(),
			handleError: async (_context, error) => {
				throw error
			},
		})
	}

	it("commits once before scheduler admission and retains success after notification failure", async () => {
		const task = await activeParent()
		Object.assign(provider, { isViewLaunched: true })
		vi.mocked(provider.postMessageToWebview).mockRejectedValue(new Error("webview unavailable"))
		const allocations = vi.spyOn(provider, "createTask")
		await execute(task)
		const item = await store.readAuthoritative(task.taskId)
		const receipt = delegationState(item).actions[0]
		expect(receipt.phase).toBe("committed")
		expect(item.awaitingChildId).toBe(receipt.childId)
		expect(await store.readAuthoritative(receipt.childId)).toMatchObject({ parentTaskId: task.taskId })
		expect(scheduler.queued).toHaveLength(1)
		const child = provider.getCurrentTask()!
		const run = vi.spyOn(child, "run").mockResolvedValue(undefined)
		await scheduler.drain()
		expect(run).toHaveBeenCalledTimes(1)
		for (let delivery = 0; delivery < 10; delivery++) {
			await expect(
				provider.delegateParentAndOpenChild({
					parentTaskId: task.taskId,
					origin: task,
					pendingActionId: "create-active",
					message: "Child",
					mode: "code",
					initialTodos: [],
				}),
			).rejects.toThrow("Stale")
		}
		expect(allocations).toHaveBeenCalledTimes(1)
		expect(delegationState(await store.readAuthoritative(task.taskId)).blocked).toBeUndefined()
	})

	it("late interruption restores histories once without scheduling and closes only its own paused child", async () => {
		const task = await activeParent()
		const create = provider.createTask.bind(provider)
		vi.spyOn(provider, "createTask").mockImplementation(async (...args) => {
			const child = await create(...args)
			await store.interruptTask(task.executionToken!)
			return child
		})
		const restore = vi.spyOn(provider, "createTaskWithHistoryItem")
		await execute(task)
		const current = provider.getCurrentTask()!
		expect(current.taskId).toBe(task.taskId)
		expect(current.executionBlocked).toBe(true)
		expect(current.clineMessages[0].text).toBe("Parent")
		expect(current.apiConversationHistory).toHaveLength(1)
		expect(restore).toHaveBeenCalledTimes(1)
		expect(scheduler.queued).toHaveLength(0)
		const receipt = delegationState(await store.readAuthoritative(task.taskId)).actions[0]
		expect(receipt.phase).toBe("prepared")
		// A fenced caller cannot overwrite its receipt or delete its claimed child.
		expect((await store.readAuthoritative(receipt.childId)).status).toBe("interrupted")
	})

	it("cancellation during flush prevents allocation and does not undo the stop", async () => {
		const task = await activeParent()
		vi.spyOn(task, "flushPendingToolResultsToHistory").mockImplementation(async () => {
			await task.abortTask(true)
			return true
		})
		const allocation = vi.spyOn(provider, "createTask")
		await execute(task)
		expect(allocation).not.toHaveBeenCalled()
		expect(task.abort).toBe(true)
		expect(scheduler.queued).toHaveLength(0)
		expect(delegationState(await store.readAuthoritative(task.taskId)).blocked).toBeDefined()
	})

	it("navigation during preparation does not evict the new view or restore the old parent", async () => {
		const task = await activeParent()
		vi.mocked(provider.handleModeSwitch).mockImplementation(async () => {
			await provider.evictCurrentTask()
		})
		const restore = vi.spyOn(provider, "createTaskWithHistoryItem")
		const allocation = vi.spyOn(provider, "createTask")
		await execute(task)
		expect(restore).not.toHaveBeenCalled()
		expect(allocation).not.toHaveBeenCalled()
		expect(scheduler.queued).toHaveLength(0)
	})

	it("uncertain commit retains the paused child and blocks history replay", async () => {
		const task = await activeParent()
		const command = store.lifecycleCommand.bind(store)
		vi.spyOn(store, "lifecycleCommand").mockImplementation(async (...args) => {
			if (args[2]?.length) throw new LifecycleWriteError("uncertain", { cause: new Error("unresolved write") })
			return command(...args)
		})
		await execute(task)
		const item = await store.readAuthoritative(task.taskId)
		const action = delegationState(item).actions[0]
		expect(action.phase).toBe("uncertain")
		expect(action.reason).toBe("history_io_error")
		expect(await store.readAuthoritative(action.childId)).toBeDefined()
		expect(provider.getCurrentTask()?.executionBlocked).toBe(true)
		expect(scheduler.queued).toHaveLength(0)
		expect(await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })).toHaveLength(1)
	})

	it("manual denial persists one error and does not resume model execution", async () => {
		const task = await activeParent()
		await newTaskTool.execute({ mode: "code", message: "Child" }, task, {
			toolCallId: "create-active",
			askApproval: async () => false,
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		})
		expect(delegationState(await store.readAuthoritative(task.taskId)).actions[0].phase).toBe("denied")
		expect(task.executionBlocked).toBe(true)
		expect(task.isStreaming).toBe(false)
		expect(task.isWaitingForFirstChunk).toBe(false)
		expect(scheduler.queued).toHaveLength(0)
		const original = await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })
		await task.overwriteApiConversationHistory([])
		expect(await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })).toEqual(original)
		await expect(task.recursivelyMakeClineRequests([])).resolves.toBe(true)
		task.start()
		await presentAssistantMessage(task)
		expect(scheduler.queued).toHaveLength(0)
	})

	it("a child installation exception restores once without leaving a runnable child", async () => {
		const task = await activeParent()
		const create = provider.createTask.bind(provider)
		vi.spyOn(provider, "createTask").mockImplementation(async (...args) => {
			await create(...args)
			throw new Error("installation notification failed")
		})
		await execute(task)
		expect(provider.getCurrentTask()?.taskId).toBe(task.taskId)
		expect(provider.getCurrentTask()?.executionBlocked).toBe(true)
		expect(scheduler.queued).toHaveLength(0)
		const action = delegationState(await store.readAuthoritative(task.taskId)).actions[0]
		expect(action.reason).toBe("recovery_required")
		expect((await store.readAuthoritative(action.childId)).status).toBe("interrupted")
	})

	it("a missing upstream owner still permits durable containment of the current action", async () => {
		const task = await activeParent()
		const item = await store.readAuthoritative(task.taskId)
		// Seed a contradictory disk record to represent corrupt/legacy lineage;
		// ordinary claimed metadata writers correctly refuse this mutation.
		await fs.writeFile(
			path.join(storage, "tasks", task.taskId, "history_item.json"),
			JSON.stringify({ ...item, parentTaskId: "missing-owner" }),
		)
		await execute(task)
		expect(task.executionBlocked).toBe(true)
		expect((await store.readAuthoritative(task.taskId)).parentTaskId).toBe("missing-owner")
		expect(scheduler.queued).toHaveLength(0)
	})

	it("cancellation while the committed child is queued prevents its run", async () => {
		const task = await activeParent()
		await execute(task)
		const child = provider.getCurrentTask()!
		const run = vi.spyOn(child, "run")
		await child.abortTask(true)
		await scheduler.drain()
		expect(run).not.toHaveBeenCalled()
		expect(scheduler.waiting).toBe(0)
	})

	it("valid restored intent waits for manual approval when auto-approval is disabled", async () => {
		const original = await activeParent()
		const action = {
			kind: "create_subtask" as const,
			actionId: "create-active",
			approvalText: JSON.stringify({ tool: "newTask" }),
			mode: "code",
			message: "Child",
			todos: [],
		}
		await provider.setPendingTaskAction(original.taskId, action, original)
		original.setPendingTaskAction(action)
		vi.mocked(provider.getState).mockResolvedValue({ ...(await provider.getState()), autoApprovalEnabled: false })
		const restored = await provider.createTaskWithHistoryItem(await store.readAuthoritative(original.taskId))
		let promptReady!: () => void
		const ready = new Promise<void>((resolve) => {
			promptReady = resolve
		})
		restored.on(RooCodeEventName.Message, ({ message }) => {
			if (message.ask === "tool") promptReady()
		})
		const allocate = vi.spyOn(provider, "createTask")
		const running = scheduler.drain(1)
		await ready
		expect(allocate).not.toHaveBeenCalled()
		await restored.handleWebviewAskResponse("noButtonClicked")
		await running
		expect(delegationState(await store.readAuthoritative(original.taskId)).actions[0].phase).toBe("denied")
		expect(scheduler.queued).toHaveLength(0)
	})

	it("internal delegation without a native call ID records UI failure without inventing an API tool result", async () => {
		const task = await activeParent()
		await newTaskTool.execute({ mode: "code", message: "Child" }, task, {
			askApproval: vi.fn(async () => false),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		})
		const item = await store.readAuthoritative(task.taskId)
		expect(delegationState(item).actions[0].actionId).toMatch(/^internal-/)
		expect(provider.getCurrentTask()?.clineMessages.some((message) => message.say === "error")).toBe(true)
		expect(await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })).toHaveLength(1)
	})

	it("same-ID intent replacement during approval cannot inherit the old approval", async () => {
		const task = await activeParent()
		const allocation = vi.spyOn(provider, "createTask")
		await newTaskTool.execute({ mode: "code", message: "Child" }, task, {
			toolCallId: "create-active",
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			askApproval: async () => {
				await store.lifecycleCommand(
					task.taskId,
					(item) => ({
						...item,
						pendingAction: { ...item.pendingAction!, message: "Replacement" },
					}),
					[],
					false,
					task.executionToken,
				)
				return true
			},
		})
		expect(allocation).not.toHaveBeenCalled()
		expect((await store.readAuthoritative(task.taskId)).pendingAction).toMatchObject({ message: "Replacement" })
	})
})
