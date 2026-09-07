import type { ExecutionCommandResult, HistoryItem } from "@roo-code/types"

import { Task } from "../core/task/Task"
import { executionClaim, executionToken } from "../core/task-persistence/taskLifecycle"
import { safeWriteJson } from "../utils/safeWriteJson"
import { claimTaskOptions, createTaskProvider, installTaskHistoryFiles } from "./helpers/task-fixtures"

vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	realpath: vi.fn(async (value: string) => value),
	readdir: vi.fn().mockResolvedValue([]),
	mkdir: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn(),
	unlink: vi.fn(),
}))
vi.mock("../utils/safeWriteJson", () => ({ LOCK_STALE_MS: 31_000, safeWriteJson: vi.fn() }))
vi.mock("proper-lockfile", () => ({ lock: vi.fn(async () => async () => {}) }))

function applied(result: ExecutionCommandResult) {
	if (result.kind !== "applied") throw new Error(result.reason)
	return result
}

describe("ClineProvider.abandonSubtask()", () => {
	const storage = "/test/abandonment"
	let provider: ReturnType<typeof createTaskProvider>
	let files: ReturnType<typeof installTaskHistoryFiles>
	let parent: HistoryItem
	let child: HistoryItem
	let interruptedChild: HistoryItem

	beforeEach(async () => {
		files = installTaskHistoryFiles()
		provider = createTaskProvider(storage)
		const parentOptions = await claimTaskOptions({
			provider,
			apiConfiguration: {},
			taskId: "parent-1",
			task: "Parent",
		})
		// Only the parent's identity is needed to prepare the real store handoff.
		const parentTask = Object.assign(Object.create(Task.prototype) as Task, {
			taskId: "parent-1",
			executionToken: parentOptions.executionToken,
		})
		const childOptions = await claimTaskOptions({
			provider,
			apiConfiguration: {},
			taskId: "child-1",
			task: "Child",
			parentTask,
		})
		parent = await provider.taskHistoryStore.readAuthoritative("parent-1")
		const interrupted = applied(await provider.taskHistoryStore.interruptTask(childOptions.executionToken!))
		interruptedChild = interrupted.history
		child = applied(await provider.taskHistoryStore.settleTaskExecution(interrupted.token, true)).history
		provider["rememberExecution"](executionToken(child))
		vi.mocked(safeWriteJson).mockClear()
	})

	afterEach(() => {
		provider.taskHistoryStore.dispose()
		files.restore()
		vi.restoreAllMocks()
	})

	it("severs both links, broadcasts durable records, and leaves the parent nonexecuting", async () => {
		const store = provider.taskHistoryStore
		const staleChild = executionToken(child)
		expect(await provider.abandonSubtask(child.id)).toBe(true)
		const updatedParent = await store.readAuthoritative(parent.id)
		const updatedChild = await store.readAuthoritative(child.id)
		expect(updatedParent).toMatchObject({ status: "active", childIds: [child.id] })
		expect(updatedParent.awaitingChildId).toBeUndefined()
		expect(updatedParent.delegatedToId).toBeUndefined()
		expect(updatedChild.status).toBe("interrupted")
		expect(updatedChild.parentTaskId).toBeUndefined()
		expect(updatedChild.rootTaskId).toBeUndefined()
		expect(updatedChild.lineageProvenance).toEqual({ parentTaskId: parent.id, rootTaskId: parent.id })
		expect(executionClaim(updatedParent).phase).toBe("suspended")
		expect(await store.guardExecution(executionToken(updatedParent))).toMatchObject({ kind: "refused" })
		// A stale completion or snapshot cannot reattach the detached child.
		expect(await store.completeStandaloneTask(staleChild, "late")).toMatchObject({ kind: "refused" })
		await expect(store.saveExecutionSnapshot(staleChild, { metadata: child }, true)).rejects.toThrow()
		expect(await store.readAuthoritative(child.id)).toEqual(updatedChild)
		expect(provider.postMessageToWebview.mock.calls).toEqual([
			[{ type: "taskHistoryItemUpdated", taskHistoryItem: updatedParent }],
			[{ type: "taskHistoryItemUpdated", taskHistoryItem: updatedChild }],
		])
		const writes = vi.mocked(safeWriteJson).mock.calls.map((call) => call[0].replaceAll("\\", "/"))
		expect(writes).toEqual([
			expect.stringContaining("/parent-1/history_item.json"),
			expect.stringContaining("/child-1/history_item.json"),
		])
	})

	it("refuses before cleanup settles instead of closing a live child or severing its link", async () => {
		const store = provider.taskHistoryStore
		const original = child
		child = interruptedChild
		files.seedHistory(storage, child)
		const evict = vi.spyOn(provider, "evictCurrentTask").mockResolvedValue(undefined)
		expect(await provider.abandonSubtask(child.id)).toBe(false)
		expect(evict).not.toHaveBeenCalled()
		expect(safeWriteJson).not.toHaveBeenCalled()
		expect(await store.readAuthoritative(child.id)).toEqual(child)
		files.seedHistory(storage, original)
		expect(await provider.abandonSubtask(child.id)).toBe(true)
	})

	it("does not evict an unrelated current task when abandoning a settled child", async () => {
		const evict = vi.spyOn(provider, "evictCurrentTask").mockResolvedValue(undefined)
		const current = Object.assign(Object.create(Task.prototype) as Task, { taskId: "unrelated" })
		vi.spyOn(provider, "getCurrentTask").mockReturnValue(current)
		expect(await provider.abandonSubtask(child.id)).toBe(true)
		expect(evict).not.toHaveBeenCalled()
	})

	it("returns false without writes when the child is still active", async () => {
		files.seedHistory(storage, { ...child, status: "active" })
		expect(await provider.abandonSubtask(child.id)).toBe(false)
		expect(safeWriteJson).not.toHaveBeenCalled()
	})

	it("rechecks fresh child state under the store lock after the provider precheck", async () => {
		const store = provider.taskHistoryStore
		const abandon = store.abandonTaskDelegation.bind(store)
		vi.spyOn(store, "abandonTaskDelegation").mockImplementationOnce(async (...args) => {
			files.seedHistory(storage, { ...child, status: "completed" })
			return abandon(...args)
		})
		expect(await provider.abandonSubtask(child.id)).toBe(false)
		expect(safeWriteJson).not.toHaveBeenCalled()
		expect(await store.readAuthoritative(parent.id)).toEqual(parent)
	})

	it("returns false when the child has no parent", async () => {
		files.seedHistory(storage, { ...child, parentTaskId: undefined, rootTaskId: undefined })
		expect(await provider.abandonSubtask(child.id)).toBe(false)
		expect(safeWriteJson).not.toHaveBeenCalled()
	})

	it("returns false when the parent is no longer delegated to the child", async () => {
		files.seedHistory(storage, {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		})
		expect(await provider.abandonSubtask(child.id)).toBe(false)
		expect(safeWriteJson).not.toHaveBeenCalled()
	})

	it("returns false when the parent's current handoff points at another child", async () => {
		files.seedHistory(storage, { ...parent, awaitingChildId: "other-child", delegatedToId: "other-child" })
		expect(await provider.abandonSubtask(child.id)).toBe(false)
		expect(safeWriteJson).not.toHaveBeenCalled()
	})

	it.each(["unknown owner", "pending cleanup", "failed snapshot"])("refuses a parent with %s", async (reason) => {
		const retained = provider["ownedExecutions"].get(parent.id)!
		if (reason === "unknown owner") provider["ownedExecutions"].delete(parent.id)
		if (reason === "pending cleanup") retained.cleanupSettled = false
		if (reason === "failed snapshot") retained.snapshotFailed = true
		expect(await provider.abandonSubtask(child.id)).toBe(false)
		expect(safeWriteJson).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})
})
