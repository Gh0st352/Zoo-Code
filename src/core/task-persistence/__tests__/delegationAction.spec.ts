import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { DelegationAction, HistoryItem, PendingTaskAction } from "@roo-code/types"
import { TaskHistoryStore } from "../TaskHistoryStore"
import {
	assertDelegationAdmission,
	commitDelegation,
	delegationBlocked,
	delegationState,
	failDelegation,
	reconcileDelegationResult,
	reserveDelegation,
} from "../taskLifecycle"
import { saveApiMessages, readApiMessages, withDelegationFailure } from "../apiMessages"
import { saveTaskMessages } from "../taskMessages"
import { mergeHistoryDelta } from "../taskStoreConcurrency"
import * as safeJson from "../../../utils/safeWriteJson"
import { mergeApiMessageSnapshots } from "../mergeMessageSnapshots"

const intent: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "call",
	approvalText: "{}",
	message: "Child",
	mode: "code",
	todos: [],
}
const parent = (overrides: Partial<HistoryItem> = {}): HistoryItem => ({
	id: "parent",
	number: 1,
	ts: 1,
	task: "Parent",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	pendingAction: intent,
	...overrides,
})
const receipt = (overrides: Partial<DelegationAction> = {}): DelegationAction => ({
	actionId: "call",
	intent,
	childId: "child",
	operationId: "operation",
	ownerToken: "runtime",
	generation: 0,
	revision: 0,
	phase: "prepared",
	attempts: 1,
	resultTs: 3,
	...overrides,
})

describe("delegation action reducers", () => {
	it.each(["interrupted", "completed"] as const)(
		"refuses %s parents without relaxing ordinary transitions",
		(status) => {
			expect(() => reserveDelegation(parent({ status }), receipt())).toThrow()
		},
	)
	it("preserves valid nested ownership and interrupted-child replacement", () => {
		const upstream = parent({ id: "root", status: "delegated", awaitingChildId: "parent" })
		const child = parent({ id: "old", parentTaskId: "parent", status: "interrupted" })
		const p = parent({ parentTaskId: "root", status: "delegated", awaitingChildId: "old", childIds: ["old"] })
		const reserved = reserveDelegation(p, receipt(), upstream, child)
		const committed = commitDelegation(reserved, receipt(), upstream, child)
		expect(committed).toMatchObject({
			parentTaskId: "root",
			status: "delegated",
			awaitingChildId: "child",
			childIds: ["old", "child"],
		})
		expect(() => reserveDelegation(p, receipt(), upstream, { ...child, status: "active" })).toThrow()
		expect(() => reserveDelegation(p, receipt(), { ...upstream, awaitingChildId: "replacement" }, child)).toThrow()
	})
	it.each(["generation", "action", "revision", "owner"])("refuses stale %s at commit", (change) => {
		const reserved = reserveDelegation(parent(), receipt())
		const changed =
			change === "generation"
				? { ...reserved, executionGeneration: 1 }
				: change === "action"
					? { ...reserved, pendingAction: { ...intent, message: "different" } }
					: change === "revision"
						? { ...reserved, lifecycleRevision: 2 }
						: {
								...reserved,
								delegation: { version: 1 as const, actions: [receipt({ ownerToken: "new" })] },
							}
		expect(() => commitDelegation(changed, receipt())).toThrow()
	})
	it("failure, result repair, clear and repeated reload are an absorbing autonomous state", () => {
		let item = failDelegation(reserveDelegation(parent(), receipt()), receipt(), "failed", "Invalid parent")
		for (let reload = 0; reload < 10; reload++) {
			item = reconcileDelegationResult(structuredClone(item), receipt())
			expect(delegationBlocked(item)).toBe(true)
			expect(() => assertDelegationAdmission(item, intent)).toThrow()
			expect(delegationState(item).actions[0].attempts).toBe(1)
		}
	})
	it("does not let a stale failure overwrite committed success, a replacement or new generation", () => {
		const reserved = reserveDelegation(parent(), receipt())
		for (const item of [
			commitDelegation(reserved, receipt()),
			{ ...reserved, pendingAction: { ...intent, actionId: "new" } },
			{ ...reserved, executionGeneration: 1 },
		]) {
			expect(failDelegation(item, receipt(), "failed", "late")).toBe(item)
		}
	})
	it("defaults old histories safely and retains unknown recovery versions", () => {
		expect(delegationBlocked(parent())).toBe(false)
		expect(delegationBlocked(reserveDelegation(parent(), receipt()))).toBe(true)
		expect(delegationBlocked(parent({ delegation: { version: 2, blocked: true } }))).toBe(true)
	})
	it("ordinary deltas cannot remove receipts or manufacture execution authority", () => {
		const disk = failDelegation(parent(), receipt(), "failed", "stop")
		const merged = mergeHistoryDelta(disk, parent(), {
			delegation: undefined,
			executionGeneration: 20,
			lifecycleRevision: 99,
			tokensIn: 4,
		})
		expect(merged.delegation).toEqual(disk.delegation)
		expect(merged.executionGeneration).toBeUndefined()
		expect(merged.tokensIn).toBe(4)
	})
	it("does not invent missing native results or replace durable success", () => {
		expect(withDelegationFailure([], receipt())).toEqual([])
		const messages = [
			{
				role: "user" as const,
				content: [{ type: "tool_result" as const, tool_use_id: "call", content: "success" }],
			},
		]
		expect(withDelegationFailure(messages, receipt())).toBe(messages)
	})
	it("stale snapshots cannot overwrite a durable tool outcome or remove other results", () => {
		const disk = [
			{
				role: "user",
				ts: 3,
				messageId: "result",
				content: [
					{ type: "tool_result", tool_use_id: "call", is_error: true, content: "failed" },
					{ type: "tool_result", tool_use_id: "other", content: "other result" },
				],
			},
		]
		const incoming = [
			{
				role: "user",
				ts: 3,
				messageId: "result",
				content: [
					{ type: "tool_result", tool_use_id: "call", content: "false success" },
					{ type: "text", text: "feedback" },
				],
			},
		]
		expect(mergeApiMessageSnapshots(disk, incoming)).toEqual([
			{ ...disk[0], content: [...disk[0].content, { type: "text", text: "feedback" }] },
		])
	})
})

describe("authoritative delegation persistence (real locks and files)", () => {
	let directory: string
	let a: TaskHistoryStore
	let b: TaskHistoryStore
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-action-"))
		a = new TaskHistoryStore(directory)
		b = new TaskHistoryStore(directory)
		await a.upsert(parent())
		await b.reconcile()
	})
	afterEach(async () => {
		a.dispose()
		b.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})
	it("refuses an authoritative interruption hidden by a stale cache", async () => {
		await b.atomicReadAndUpdate("parent", (item) => ({ ...item, status: "interrupted" }))
		expect(a.get("parent")?.status).toBeUndefined()
		await expect(a.lifecycleCommand("parent", (item) => reserveDelegation(item, receipt()))).rejects.toThrow(
			"interrupted",
		)
	})
	it("competing commands reserve only one child for the same action", async () => {
		const outcomes = await Promise.allSettled([
			a.lifecycleCommand("parent", (item) => reserveDelegation(item, receipt())),
			b.lifecycleCommand("parent", (item) =>
				reserveDelegation(item, receipt({ childId: "other", operationId: "other" })),
			),
		])
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
		expect(delegationState(await a.readAuthoritative("parent")).actions).toHaveLength(1)
	})
	it("post-commit write-through rejection remains success", async () => {
		const notifying = new TaskHistoryStore(directory, {
			onWrite: async () => {
				throw new Error("notification")
			},
		})
		try {
			await notifying.lifecycleCommand("parent", (item) => reserveDelegation(item, receipt()))
			await expect(
				notifying.lifecycleCommand("parent", (item) => commitDelegation(item, receipt())),
			).resolves.toMatchObject({ status: "delegated" })
		} finally {
			notifying.dispose()
		}
	})
	it.each(["before", "after", "unknown"] as const)(
		"classifies a %s-write fault using authoritative read-back",
		async (stage) => {
			const write = safeJson.safeWriteJson
			vi.spyOn(safeJson, "safeWriteJson").mockImplementationOnce(async (...args) => {
				if (stage === "after") await write(...args)
				if (stage === "unknown")
					await fs.writeFile(path.join(directory, "tasks", "parent", "history_item.json"), "{unreadable")
				throw new Error("injected write fault")
			})
			const command = a.lifecycleCommand("parent", (item) => reserveDelegation(item, receipt()))
			if (stage === "after")
				await expect(command).resolves.toMatchObject({
					delegation: { actions: [expect.objectContaining({ phase: "prepared" })] },
				})
			else
				await expect(command).rejects.toMatchObject({
					certainty: stage === "before" ? "not_committed" : "uncertain",
				})
		},
	)
	it("unreadable metadata never becomes an empty replacement", async () => {
		const file = path.join(directory, "tasks", "parent", "history_item.json")
		await fs.writeFile(file, "{invalid")
		await expect(a.lifecycleCommand("parent", (item) => reserveDelegation(item, receipt()))).rejects.toMatchObject({
			kind: "invalid",
		})
		expect(await fs.readFile(file, "utf8")).toBe("{invalid")
	})
	it("a durable prepared prefix survives failed failure recording and fresh store reconstruction", async () => {
		await a.lifecycleCommand("parent", (item) => reserveDelegation(item, receipt()))
		await expect(
			a.lifecycleCommand("parent", () => {
				throw new Error("storage unavailable")
			}),
		).rejects.toThrow()
		await b.invalidate("parent")
		expect(delegationBlocked(await b.readAuthoritative("parent"))).toBe(true)
		await expect(
			b.lifecycleCommand("parent", (item) => reserveDelegation(item, receipt({ childId: "new" }))),
		).rejects.toThrow()
	})
	it("failure repair remains idempotent after API result saved but UI history unavailable", async () => {
		await saveApiMessages({
			taskId: "parent",
			globalStoragePath: directory,
			messages: [
				{ role: "assistant", ts: 2, content: [{ type: "tool_use", id: "call", name: "new_task", input: {} }] },
			],
		})
		const failed = await a.lifecycleCommand("parent", (item) => failDelegation(item, receipt(), "failed", "stop"))
		const action = delegationState(failed).actions[0]
		await expect(a.repairDelegationFailure("parent", action)).rejects.toThrow()
		expect(delegationBlocked(await a.readAuthoritative("parent"))).toBe(true)
		await saveTaskMessages({
			taskId: "parent",
			globalStoragePath: directory,
			messages: [{ type: "say", say: "text", ts: 1, text: "Parent" }],
		})
		await b.repairDelegationFailure("parent", action)
		await a.repairDelegationFailure("parent", action)
		const messages = await readApiMessages({ taskId: "parent", globalStoragePath: directory })
		expect(messages).toHaveLength(2)
		expect(messages[1].content).toEqual([expect.objectContaining({ tool_use_id: "call", is_error: true })])
		expect((await a.readAuthoritative("parent")).pendingAction).toBeUndefined()
	})
	it("metadata saves preserve detached lineage and current receipts", async () => {
		await a.upsert(parent({ parentTaskId: "root" }))
		const stale = a.get("parent")!
		await b.invalidate("parent")
		await b.atomicReadAndUpdate("parent", (item) => ({ ...item, parentTaskId: undefined }))
		await a.updateMessageMetadata({ ...stale, tokensIn: 25 })
		expect(await a.readAuthoritative("parent")).toMatchObject({ tokensIn: 25 })
		expect((await a.readAuthoritative("parent")).parentTaskId).toBeUndefined()
	})
})
