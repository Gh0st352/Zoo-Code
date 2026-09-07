// npx vitest run __tests__/removeClineFromStack-delegation.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { RooCodeEventName, type DelegationAction, type ExecutionCommandResult, type HistoryItem } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskRegistry } from "../core/task/TaskRegistry"
import { type Task } from "../core/task/Task"
import { makeProviderStub as legacyProviderStub } from "./helpers/provider-stub"
import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"
import {
	commitDelegation,
	executionClaim,
	executionToken,
	reserveDelegation,
} from "../core/task-persistence/taskLifecycle"

// These tests exercise provider commands, not constructor integrations. Initialize
// the real command state explicitly; do not add fallback behavior to production.
function makeProviderStub<T extends object>(fields: T): ClineProvider {
	const provider = legacyProviderStub(fields)
	Object.setPrototypeOf(provider, ClineProvider.prototype)
	provider["ownedExecutions"] = new Map()
	provider["cleanupOperations"] = new WeakMap()
	provider["delegationApprovals"] = new WeakMap()
	provider["completionApprovals"] = new WeakMap()
	provider["delegationEpoch"] = 0
	provider["recoveryPreviewSequence"] = 0
	provider["taskEventListeners"] ??= new WeakMap()
	for (const task of provider["taskRegistry"].getAll()) {
		task.dispose ??= vi.fn<Task["dispose"]>().mockResolvedValue(undefined)
		task.awaitExecutionCleanup ??= vi.fn<Task["awaitExecutionCleanup"]>().mockResolvedValue(true)
	}
	return provider
}

const privateClineProvider = ClineProvider.prototype

// Runtime removal never mutates delegation metadata. Authoritative completion
// commands own parent reactivation; stop/evict interrupts only the owned child.

function buildMockProvider(opts: {
	childTaskId: string
	parentTaskId?: string
	parentHistoryItem?: Record<string, unknown>
	childStatus?: string
}) {
	const childTask = {
		taskId: opts.childTaskId,
		instanceId: "inst-1",
		parentTaskId: opts.parentTaskId,
		emit: vi.fn(),
		abortTask: vi.fn().mockResolvedValue(undefined),
	}

	const updateTaskHistory = vi.fn().mockResolvedValue([])
	const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
		if (id === opts.parentTaskId && opts.parentHistoryItem) {
			return { historyItem: { ...opts.parentHistoryItem } }
		}
		throw new Error("Task not found")
	})

	const taskHistoryStoreData: Record<string, unknown> = {}
	if (opts.childStatus) {
		taskHistoryStoreData[opts.childTaskId] = { status: opts.childStatus }
	}

	const provider = makeProviderStub({
		clineStack: [childTask] as unknown as Task[],
		taskEventListeners: new Map(),
		log: vi.fn(),
		getTaskWithId,
		updateTaskHistory,
		taskHistoryStore: { get: (id: string) => taskHistoryStoreData[id] },
	})

	return { provider, childTask, updateTaskHistory, getTaskWithId }
}

describe("ClineProvider.removeClineFromStack() — pure lifecycle, no delegation side effects", () => {
	it("removes the focused task, aborts it, and clears listeners", async () => {
		const { provider, childTask } = buildMockProvider({ childTaskId: "child-1" })
		const cleanup = vi.fn()
		const task = provider.getCurrentTask()!
		provider["taskEventListeners"].set(task, [cleanup])
		expect(provider["taskRegistry"].length).toBe(1)

		await privateClineProvider.removeClineFromStack.call(provider)

		expect(provider["taskRegistry"].length).toBe(0)
		expect(childTask.abortTask).toHaveBeenCalledWith(true)
		expect(childTask.emit).toHaveBeenCalledWith(expect.stringContaining("taskUnfocused"))
		expect(cleanup).toHaveBeenCalledOnce()
		expect(provider["taskEventListeners"].has(task)).toBe(false)
	})

	it("removes the focused task even when it is not the top stack entry", async () => {
		const focusedTask = {
			taskId: "focused-1",
			instanceId: "focused-inst",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}
		const topTask = {
			taskId: "top-1",
			instanceId: "top-inst",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}
		const provider = makeProviderStub({
			tasks: [focusedTask, topTask] as unknown as Task[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId: vi.fn(),
			updateTaskHistory: vi.fn(),
		})
		provider["taskRegistry"].setCurrent("focused-1")

		await privateClineProvider.removeClineFromStack.call(provider)

		expect(provider["taskRegistry"].taskIds).toEqual(["top-1"])
		expect(provider["taskRegistry"].current).toBe(topTask)
		expect(focusedTask.abortTask).toHaveBeenCalledWith(true)
		expect(topTask.abortTask).not.toHaveBeenCalled()
	})

	it("does NOT mutate parent metadata when a delegated child is popped (repair removed)", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
			},
		})

		await privateClineProvider.removeClineFromStack.call(provider)

		expect(provider["taskRegistry"].length).toBe(0)
		// Navigation/disposal must never silently flip the parent to active
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT mutate parent metadata when the child is interrupted", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				status: "delegated",
				awaitingChildId: "child-1",
			},
			childStatus: "interrupted",
		})

		await privateClineProvider.removeClineFromStack.call(provider)

		expect(provider["taskRegistry"].length).toBe(0)
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT mutate parent metadata for a non-delegated (top-level) task", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "standalone-1",
		})

		await privateClineProvider.removeClineFromStack.call(provider)

		expect(provider["taskRegistry"].length).toBe(0)
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("handles empty stack gracefully", async () => {
		const provider = makeProviderStub({
			clineStack: [] as Task[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId: vi.fn(),
			updateTaskHistory: vi.fn(),
		})

		await expect(privateClineProvider.removeClineFromStack.call(provider)).resolves.not.toThrow()

		expect(provider["getTaskWithId"]).not.toHaveBeenCalled()
		expect(provider["updateTaskHistory"]).not.toHaveBeenCalled()
	})
})

describe("authoritative stop and eviction of delegated children", () => {
	let directory: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	const history = (id: string): HistoryItem => ({
		id,
		number: 1,
		ts: 1,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	})
	const applied = (result: ExecutionCommandResult) => {
		expect(result.kind).toBe("applied")
		if (result.kind !== "applied") throw new Error(result.reason)
		return result
	}
	async function claimedTask(linked = true) {
		const parent = applied(await store.claimNewTask(history("parent-1"), store.ownerForRuntime("parent")))
		let child: Extract<ExecutionCommandResult, { kind: "applied" }>
		if (linked) {
			const intent = {
				kind: "create_subtask" as const,
				actionId: "create",
				approvalText: "{}",
				message: "Child",
				mode: "code",
				todos: [],
			}
			const pending = await store.lifecycleCommand(
				"parent-1",
				(item) => ({ ...item, pendingAction: intent }),
				[],
				false,
				parent.token,
			)
			const receipt: DelegationAction = {
				actionId: intent.actionId,
				intent,
				operationId: "operation",
				childId: "child-1",
				ownerToken: parent.token.owner.runtimeId,
				executionToken: parent.token,
				generation: parent.token.generation,
				revision: pending.lifecycleRevision!,
				phase: "prepared",
				attempts: 1,
				resultTs: 2,
			}
			await store.lifecycleCommand(
				"parent-1",
				(item) => reserveDelegation(item, receipt),
				[],
				false,
				parent.token,
			)
			child = applied(
				await store.claimDelegationChild(
					{
						...history("child-1"),
						parentTaskId: "parent-1",
						rootTaskId: "parent-1",
						delegationOrigin: { parentId: "parent-1", operationId: receipt.operationId },
					},
					store.ownerForRuntime("child"),
					parent.token,
					receipt,
				),
			)
			await store.lifecycleCommand(
				"parent-1",
				(item) => commitDelegation(item, receipt),
				["child-1"],
				false,
				parent.token,
			)
		} else {
			child = applied(await store.claimNewTask(history("child-1"), store.ownerForRuntime("child")))
		}
		const runtime = {
			taskId: child.history.id,
			instanceId: child.token.owner.runtimeId,
			parentTaskId: child.history.parentTaskId,
			executionToken: child.token,
			apiConversationHistory: [],
			clineMessages: [],
			executionBlocked: false,
			emit: vi.fn<Task["emit"]>(),
			getPendingTaskAction: vi.fn<Task["getPendingTaskAction"]>(),
			abortTask: vi.fn<Task["abortTask"]>().mockResolvedValue(undefined),
			dispose: vi.fn<Task["dispose"]>().mockResolvedValue(undefined),
			awaitExecutionCleanup: vi.fn<Task["awaitExecutionCleanup"]>().mockResolvedValue(true),
			guardExecution: vi.fn<Task["guardExecution"]>(
				async () => (await store.guardExecution(child.token)).kind === "allowed",
			),
			getTokenUsage: vi
				.fn<Task["getTokenUsage"]>()
				.mockReturnValue({ totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, contextTokens: 0 }),
			toolUsage: {},
		} satisfies Partial<Task>
		// A provider-cleanup double deliberately omits Task's unrelated editor/API machinery.
		const task = runtime as unknown as Task
		provider["taskRegistry"].push(task)
		provider["rememberExecution"](child.token, task)
		return { task, runtime, child, parent: await store.readAuthoritative("parent-1") }
	}
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-eviction-"))
		store = new TaskHistoryStore(directory)
		provider = makeProviderStub({
			taskHistoryStore: store,
			taskRegistry: new TaskRegistry(),
			emit: vi.fn<ClineProvider["emit"]>(),
		})
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		store.dispose()
		await fs.rm(directory, { recursive: true, force: true })
	})
	it("marks an active delegated child interrupted and leaves the entire parent record unchanged before view sync", async () => {
		const { task, child, parent } = await claimedTask()
		const observed: HistoryItem[][] = []
		vi.mocked(provider.syncFocusedTaskToWebview).mockImplementation(async () => {
			observed.push([await store.readAuthoritative("child-1"), await store.readAuthoritative("parent-1")])
		})
		await provider.evictCurrentTask()
		expect(await store.readAuthoritative("child-1")).toMatchObject({
			status: "interrupted",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
		})
		expect(executionClaim(await store.readAuthoritative("child-1"))).toMatchObject({
			phase: "settled",
			cleanupPending: false,
		})
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(observed).toEqual([[await store.readAuthoritative("child-1"), parent]])
		expect(task.executionToken).toEqual(child.token)
		expect(await store.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "stale_generation" })
		expect(provider.getCurrentTask()).toBeUndefined()
	})
	it("does not write again when an already interrupted runtime is stopped twice", async () => {
		const { task, runtime } = await claimedTask()
		await provider["stopOwnedTask"](task)
		const before = await store.readAuthoritative("child-1")
		const interrupt = vi.spyOn(store, "interruptTask")
		const settle = vi.spyOn(store, "settleTaskExecution")
		await provider["stopOwnedTask"](task)
		expect(interrupt).not.toHaveBeenCalled()
		expect(settle).not.toHaveBeenCalled()
		expect(await store.readAuthoritative("child-1")).toEqual(before)
		expect(runtime.abortTask).toHaveBeenCalledTimes(1)
	})
	it("does not mutate either record after another command detaches the settled child", async () => {
		const { task, child, parent } = await claimedTask()
		const stopped = applied(await store.settleTaskExecution(child.token, true))
		const detached = await store.abandonTaskDelegation(executionToken(parent), stopped.token)
		expect(detached.kind).toBe("applied")
		const before = [await store.readAuthoritative("parent-1"), await store.readAuthoritative("child-1")]
		await provider["stopOwnedTask"](task)
		expect([await store.readAuthoritative("parent-1"), await store.readAuthoritative("child-1")]).toEqual(before)
		expect(before[1].parentTaskId).toBeUndefined()
	})
	it("refuses a stale eviction fence when cancellation wins the storage lock", async () => {
		const { task, child, parent } = await claimedTask()
		const cancelling = store.interruptTask(child.token)
		const stopping = provider["stopOwnedTask"](task)
		const paused = applied(await cancelling)
		await stopping
		expect(await store.readAuthoritative("child-1")).toEqual(paused.history)
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(await store.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "stale_generation" })
		expect(executionClaim(paused.history).cleanupPending).toBe(true)
	})
	it("logs a failed fence but cleans the runtime without claiming settlement", async () => {
		const { task, runtime, child } = await claimedTask()
		vi.spyOn(store, "interruptTask").mockRejectedValue(new Error("store unavailable"))
		const settle = vi.spyOn(store, "settleTaskExecution")
		await expect(provider["stopOwnedTask"](task)).resolves.toBeUndefined()
		expect(provider["log"]).toHaveBeenCalledWith(expect.stringContaining("Fence/snapshot failed for child-1"))
		expect(runtime.abortTask).toHaveBeenCalledWith(true)
		expect(runtime.executionBlocked).toBe(true)
		expect(settle).not.toHaveBeenCalled()
		expect(await store.readAuthoritative("child-1")).toEqual(child.history)
	})
	it("removing an interrupted child for parent navigation never repairs the parent to active", async () => {
		const { task, parent } = await claimedTask()
		await provider["stopOwnedTask"](task)
		const before = await store.readAuthoritative("child-1")
		await provider.removeClineFromStack()
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(await store.readAuthoritative("child-1")).toEqual(before)
	})
	it("navigation away interrupts the child without clearing any parent delegation pointer", async () => {
		const { parent } = await claimedTask()
		await provider.evictCurrentTask()
		expect((await store.readAuthoritative("child-1")).status).toBe("interrupted")
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(parent).toMatchObject({ status: "delegated", awaitingChildId: "child-1", delegatedToId: "child-1" })
	})
	it("eviction fences before cleanup and waits for cleanup before settlement", async () => {
		const { runtime, child } = await claimedTask()
		let release!: (settled: boolean) => void
		runtime.awaitExecutionCleanup.mockReturnValue(
			new Promise<boolean>((resolve) => {
				release = resolve
			}),
		)
		const settle = vi.spyOn(store, "settleTaskExecution")
		const evicting = provider.evictCurrentTask()
		await vi.waitFor(() => expect(runtime.awaitExecutionCleanup).toHaveBeenCalledOnce())
		expect(await store.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "stale_generation" })
		expect(settle).not.toHaveBeenCalled()
		expect(executionClaim(await store.readAuthoritative("child-1")).cleanupPending).toBe(true)
		release(true)
		await evicting
		expect(settle).toHaveBeenCalledOnce()
		expect(provider["taskRegistry"].length).toBe(0)
	})
	it("does not issue an interruption command when there is no current task", async () => {
		const interrupt = vi.spyOn(store, "interruptTask")
		await provider.evictCurrentTask()
		expect(interrupt).not.toHaveBeenCalled()
	})
	it("stops a standalone task without mutating an unrelated parent", async () => {
		const { parent } = await claimedTask(false)
		await provider.evictCurrentTask()
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(await store.readAuthoritative("child-1")).toMatchObject({ status: "interrupted" })
		expect((await store.readAuthoritative("child-1")).parentTaskId).toBeUndefined()
	})
	it("propagates settlement failure without evicting or releasing uncertain cleanup authority", async () => {
		const { task } = await claimedTask()
		vi.spyOn(store, "settleTaskExecution").mockRejectedValue(new Error("lock contention"))
		await expect(provider.evictCurrentTask()).rejects.toThrow("lock contention")
		expect(provider.getCurrentTask()).toBe(task)
		expect(task.executionBlocked).toBe(true)
		expect(executionClaim(await store.readAuthoritative("child-1")).cleanupPending).toBe(true)
	})
	it("persists completed status and cleanup settlement before re-emitting completion", async () => {
		const { task } = await claimedTask(false)
		const completedAtEmission: HistoryItem[] = []
		vi.mocked(provider.emit).mockImplementation((event) => {
			if (event === RooCodeEventName.TaskCompleted) completedAtEmission.push(store.get(task.taskId)!)
			return true
		})
		expect(await provider.completeTask(task, "Done")).toBe(true)
		const completed = await store.readAuthoritative(task.taskId)
		expect(completed).toMatchObject({ status: "completed", completionResultSummary: "Done" })
		expect(executionClaim(completed)).toMatchObject({ phase: "settled", cleanupPending: false })
		expect(completedAtEmission).toEqual([completed])
		expect(provider.emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			task.taskId,
			task.getTokenUsage(),
			task.toolUsage,
		)
	})
	it("skips the write and public event when the record is already completed", async () => {
		const { task, child } = await claimedTask(false)
		const completed = applied(await store.completeStandaloneTask(child.token, "Already done"))
		const complete = vi.spyOn(store, "completeStandaloneTask")
		expect(await provider.completeTask(task, "Late result")).toBe(false)
		expect(complete).not.toHaveBeenCalled()
		expect(provider.emit).not.toHaveBeenCalled()
		expect(await store.readAuthoritative(task.taskId)).toEqual(completed.history)
	})
	it("skips completion writes and events when authoritative history is missing", async () => {
		const { task } = await claimedTask(false)
		await fs.rm(path.join(directory, "tasks", task.taskId), { recursive: true, force: true })
		const complete = vi.spyOn(store, "completeStandaloneTask")
		expect(await provider.completeTask(task, "Missing task")).toBe(false)
		expect(complete).not.toHaveBeenCalled()
		expect(provider.emit).not.toHaveBeenCalled()
		await expect(store.readAuthoritative(task.taskId)).rejects.toThrow()
	})
	it("propagates completion persistence errors without announcing success or releasing the claim", async () => {
		const { task, child } = await claimedTask(false)
		vi.spyOn(store, "completeStandaloneTask").mockRejectedValue(new Error("disk full"))
		const settle = vi.spyOn(store, "settleTaskExecution")
		await expect(provider.completeTask(task, "Not durable")).rejects.toThrow("disk full")
		expect(provider.emit).not.toHaveBeenCalled()
		expect(settle).not.toHaveBeenCalled()
		expect(await store.readAuthoritative(task.taskId)).toEqual(child.history)
	})
})
