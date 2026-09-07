// pnpm --filter zoo-code test core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { TaskHistoryStore, assertValidTransition } from "../TaskHistoryStore"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

const writeJson = async (filePath: string, data: unknown): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
}

const safeWriteJsonMock = vi.hoisted(() => vi.fn())

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: safeWriteJsonMock, LOCK_STALE_MS: 31_000 }))

safeWriteJsonMock.mockImplementation(writeJson)

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	}
}

function makeRepairIntent(parent: HistoryItem, child: HistoryItem): object {
	return {
		version: 1,
		operationId: "delegation-repair-test",
		parentTaskId: parent.id,
		childTaskId: child.id,
		expected: {
			parent: {
				status: "delegated",
				awaitingChildId: child.id,
				delegatedToId: parent.delegatedToId,
			},
			child: {
				status: "active",
				parentTaskId: child.parentTaskId,
				rootTaskId: child.rootTaskId,
			},
		},
		target: { childStatus: "interrupted", parentStatus: "active" },
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// assertValidTransition — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

describe("assertValidTransition", () => {
	describe("valid transitions", () => {
		it("active → delegated", () => {
			expect(() => assertValidTransition("active", "delegated")).not.toThrow()
		})

		it("active → completed", () => {
			expect(() => assertValidTransition("active", "completed")).not.toThrow()
		})

		it("active → interrupted", () => {
			expect(() => assertValidTransition("active", "interrupted")).not.toThrow()
		})

		it("delegated → active", () => {
			expect(() => assertValidTransition("delegated", "active")).not.toThrow()
		})

		it("interrupted → completed", () => {
			expect(() => assertValidTransition("interrupted", "completed")).not.toThrow()
		})

		it("undefined (implicit active) → delegated", () => {
			expect(() => assertValidTransition(undefined, "delegated")).not.toThrow()
		})

		it("undefined (implicit active) → completed", () => {
			expect(() => assertValidTransition(undefined, "completed")).not.toThrow()
		})
	})

	describe("invalid transitions — throw", () => {
		it("delegated → completed", () => {
			expect(() => assertValidTransition("delegated", "completed")).toThrow(
				"Invalid task status transition: delegated → completed",
			)
		})

		it("delegated → delegated (self-loop)", () => {
			expect(() => assertValidTransition("delegated", "delegated")).toThrow(
				"Invalid task status transition: delegated → delegated",
			)
		})

		it("completed → active", () => {
			expect(() => assertValidTransition("completed", "active")).toThrow(
				"Invalid task status transition: completed → active",
			)
		})

		it("completed → delegated", () => {
			expect(() => assertValidTransition("completed", "delegated")).toThrow(
				"Invalid task status transition: completed → delegated",
			)
		})

		it("interrupted → active", () => {
			expect(() => assertValidTransition("interrupted", "active")).toThrow(
				"Invalid task status transition: interrupted → active",
			)
		})

		it("active → active (self-loop)", () => {
			expect(() => assertValidTransition("active", "active")).toThrow(
				"Invalid task status transition: active → active",
			)
		})

		it("undefined (implicit active) → delegated is valid", () => {
			expect(() => assertValidTransition(undefined, "delegated")).not.toThrow()
		})
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// Legacy observer initialization: no execution proof means no lifecycle mutation.
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore conservative reconciliation", () => {
	let directory: string
	const stores: TaskHistoryStore[] = []
	const file = (id: string) => path.join(directory, "tasks", id, GlobalFileNames.historyItem)
	function createStore() {
		const store = new TaskHistoryStore(directory)
		stores.push(store)
		return store
	}
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-observer-"))
		safeWriteJsonMock.mockClear().mockImplementation(writeJson)
	})
	afterEach(async () => {
		for (const store of stores.splice(0)) store.dispose()
		await fs.rm(directory, { recursive: true, force: true })
	})
	it.each(["missing", "completed", "active", "interrupted", "delegated", "implicit", "no_pointer"])(
		"leaves ownerless %s delegation inspectable and byte-identical across reloads",
		async (state) => {
			const parent = makeItem({
				id: "parent",
				status: "delegated",
				childIds: ["child"],
				awaitingChildId: state === "no_pointer" ? "" : "child",
				delegatedToId: "child",
			})
			const child = makeItem({
				id: "child",
				parentTaskId: "parent",
				rootTaskId: "parent",
				status:
					state === "completed"
						? "completed"
						: state === "interrupted"
							? "interrupted"
							: state === "delegated"
								? "delegated"
								: state === "implicit"
									? undefined
									: "active",
			})
			const records = state === "missing" ? [parent] : [parent, child]
			for (const record of records) await writeJson(file(record.id), record)
			const before = await Promise.all(records.map((record) => fs.readFile(file(record.id), "utf8")))
			for (let reload = 0; reload < 3; reload++) {
				const store = createStore()
				await store.initialize()
				for (const record of records) expect(store.get(record.id)).toEqual(record)
				store.dispose()
			}
			expect(await Promise.all(records.map((record) => fs.readFile(file(record.id), "utf8")))).toEqual(before)
			expect(safeWriteJsonMock).not.toHaveBeenCalled()
		},
	)
	it.each(["none", "child", "both", "newer", "missing", "malformed"])(
		"quarantines v1 repair at %s prefix without modifying histories",
		async (prefix) => {
			const parent = makeItem({
				id: "parent",
				status: "delegated",
				awaitingChildId: "child",
				delegatedToId: "child",
			})
			const child = makeItem({ id: "child", status: "active", parentTaskId: "parent" })
			const records = [
				prefix === "both"
					? { ...parent, status: "active" as const, awaitingChildId: undefined, delegatedToId: undefined }
					: parent,
				prefix === "child" || prefix === "both"
					? { ...child, status: "interrupted" as const }
					: prefix === "newer"
						? { ...child, executionGeneration: 40, delegation: { version: 8, opaque: true } }
						: child,
			]
			for (const record of records) await writeJson(file(record.id), record)
			if (prefix === "missing") await fs.unlink(file(child.id))
			const present = prefix === "missing" ? records.slice(0, 1) : records
			const before = await Promise.all(present.map((record) => fs.readFile(file(record.id), "utf8")))
			const journal = path.join(directory, "tasks", GlobalFileNames.delegationRepairIntent)
			await writeJson(journal, prefix === "malformed" ? { invalid: true } : makeRepairIntent(parent, child))
			await createStore().initialize()
			expect(await Promise.all(present.map((record) => fs.readFile(file(record.id), "utf8")))).toEqual(before)
			expect(safeWriteJsonMock).not.toHaveBeenCalled()
			expect(
				(await fs.readdir(path.dirname(journal))).filter((name) =>
					name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
				),
			).toHaveLength(1)
			await expect(fs.access(journal)).rejects.toThrow()
		},
	)
	it("migrates ownerless histories without repairing or manufacturing a completion result", async () => {
		const parent = makeItem({ id: "parent", status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const child = makeItem({ id: "child", status: "completed", completionResultSummary: "Done" })
		for (const record of [parent, child]) await fs.mkdir(path.dirname(file(record.id)), { recursive: true })
		const store = createStore()
		await store.initialize()
		await store.migrateFromGlobalState([parent, child])
		expect(store.get(parent.id)).toEqual(parent)
		expect(store.get(child.id)).toEqual(child)
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// upsert — transition guard enforcement at the write boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore upsert transition guard", () => {
	let tmpDir: string
	let store: TaskHistoryStore

	async function seedItems(items: HistoryItem[]): Promise<void> {
		const tasksDir = path.join(tmpDir, "tasks")
		await fs.mkdir(tasksDir, { recursive: true })
		for (const item of items) {
			const taskDir = path.join(tasksDir, item.id)
			await fs.mkdir(taskDir, { recursive: true })
			await fs.writeFile(path.join(taskDir, "history_item.json"), JSON.stringify(item))
		}
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "upsert-guard-test-"))
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("rejects completed → active transition, preserving the completed status", async () => {
		const item = makeItem({ id: "task-guard-1", status: "completed" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Fire-and-forget late save: tries to write status: "active" over "completed"
		await expect(store.upsert({ ...item, status: "active" })).rejects.toThrow(
			"Invalid task status transition: completed → active",
		)

		// The completed status must be preserved in the cache
		expect(store.get("task-guard-1")?.status).toBe("completed")
	})

	it("rejects delegated → completed transition", async () => {
		// Must include a live active child so reconciliation doesn't repair the parent to active
		const child = makeItem({ id: "child-guard-2", status: "interrupted" })
		const item = makeItem({ id: "task-guard-2", status: "delegated", awaitingChildId: "child-guard-2" })
		await seedItems([child, item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Confirm reconciliation left the delegated status alone
		expect(store.get("task-guard-2")?.status).toBe("delegated")

		await expect(store.upsert({ ...item, status: "completed" })).rejects.toThrow(
			"Invalid task status transition: delegated → completed",
		)

		expect(store.get("task-guard-2")?.status).toBe("delegated")
	})

	it("allows valid active → completed transition", async () => {
		const item = makeItem({ id: "task-guard-3", status: "active" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "completed" })).resolves.toBeDefined()
		expect(store.get("task-guard-3")?.status).toBe("completed")
	})

	it("rejects interrupted → active transition, preserving the interrupted status", async () => {
		const item = makeItem({ id: "task-guard-interrupted", status: "interrupted" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "active" })).rejects.toThrow(
			"Invalid task status transition: interrupted → active",
		)
		expect(store.get("task-guard-interrupted")?.status).toBe("interrupted")
	})

	it("allows valid interrupted → completed transition", async () => {
		const item = makeItem({ id: "task-guard-interrupted-complete", status: "interrupted" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "completed" })).resolves.toBeDefined()
		expect(store.get("task-guard-interrupted-complete")?.status).toBe("completed")
	})

	it("allows first insert with status: active (no prior record to transition from)", async () => {
		const item = makeItem({ id: "task-guard-new", status: "active" })
		// Do NOT seed — this is the very first write for this task
		await expect(store.upsert(item)).resolves.toBeDefined()
		expect(store.get("task-guard-new")?.status).toBe("active")
	})

	it("allows writing status: active over a legacy item with status: undefined (implicit active → active no-op)", async () => {
		// Legacy items pre-dating the status field have status: undefined, which normalizes
		// to "active". Writing status: "active" must not throw as an invalid self-loop.
		const item = makeItem({ id: "task-guard-legacy" })
		const { status: _status, ...legacyItem } = item
		await seedItems([legacyItem])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "active" })).resolves.toBeDefined()
		expect(store.get("task-guard-legacy")?.status).toBe("active")
	})

	it("allows upsert without a status field (no-op on status)", async () => {
		const item = makeItem({ id: "task-guard-4", status: "completed" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Omitting status entirely — no transition should be validated
		const { status: _omit, ...noStatus } = item
		await expect(store.upsert(noStatus as HistoryItem)).resolves.toBeDefined()
		// Status is preserved from the existing cache entry
		expect(store.get("task-guard-4")?.status).toBe("completed")
	})

	it("atomicReadAndUpdate enforces the upsertCore transition guard on status changes", async () => {
		// atomicReadAndUpdate now flows through upsertCore without skipTransitionCheck,
		// so invalid transitions are rejected at the store boundary.
		const item = makeItem({ id: "task-atomic-guard", status: "active" })
		await store.upsert(item)

		// active → delegated via atomicReadAndUpdate — valid, must succeed
		await expect(
			store.atomicReadAndUpdate("task-atomic-guard", (current) => ({
				...current,
				status: "delegated" as const,
				awaitingChildId: "some-child",
			})),
		).resolves.toBeDefined()
		expect(store.get("task-atomic-guard")?.status).toBe("delegated")

		// delegated → completed via atomicReadAndUpdate — invalid, must throw
		await expect(
			store.atomicReadAndUpdate("task-atomic-guard", (current) => ({
				...current,
				status: "completed" as const,
			})),
		).rejects.toThrow("Invalid task status transition: delegated → completed")
	})
})
