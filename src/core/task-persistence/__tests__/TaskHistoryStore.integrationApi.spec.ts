import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import type {
	DelegationAction,
	DelegatedCompletionRequest,
	ExecutionCommandResult,
	HistoryItem,
	TaskRecoveryRequest,
} from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
import type { ExecutionHost } from "../executionHost"
import {
	claimNewExecution,
	commitDelegation,
	completionState,
	executionClaim,
	executionToken,
	failDelegation,
	interruptExecution,
	prepareDelegatedCompletion,
	reserveDelegation,
	settleExecution,
} from "../taskLifecycle"
import { readApiMessages, saveApiMessages } from "../apiMessages"
import { readTaskMessages, saveTaskMessages } from "../taskMessages"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import * as safeJson from "../../../utils/safeWriteJson"

// Keep real advisory locks; the wrapper exposes a deterministic post-acquisition barrier.
vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("proper-lockfile")>()
	return { ...actual }
})

const host = (session = "original", probeProcess: ExecutionHost["probeProcess"] = async () => "unknown") => ({
	identity: {
		hostSessionId: session,
		processId: session === "original" ? 111 : 222,
		machineId: "machine",
		machineProof: "local" as const,
	},
	probeProcess,
})
const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})
function applied(result: ExecutionCommandResult) {
	expect(result.kind).toBe("applied")
	if (result.kind !== "applied") throw new Error(result.reason)
	return result
}
function signal() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("provider persistence integration APIs (real files and advisory locks)", () => {
	let directory: string
	let a: TaskHistoryStore
	const stores: TaskHistoryStore[] = []
	function store(providerId = "provider", executionHost = host()) {
		const next = new TaskHistoryStore(directory, { providerId, executionHost })
		stores.push(next)
		return next
	}
	const file = (id: string, name: string = GlobalFileNames.historyItem) => path.join(directory, "tasks", id, name)
	const seed = (history: HistoryItem) => safeJson.safeWriteJson(file(history.id), history)
	const active = (id: string, extra: Partial<HistoryItem> = {}) =>
		claimNewExecution(item(id, extra), a.ownerForRuntime(id))
	function reservation(parent: HistoryItem, childId: string, upstream?: HistoryItem) {
		const intent: DelegationAction["intent"] = {
			kind: "create_subtask",
			actionId: `create-${childId}`,
			approvalText: "{}",
			message: childId,
			mode: "code",
			todos: [],
		}
		const receipt: DelegationAction = {
			actionId: intent.actionId,
			intent,
			operationId: `create-operation-${childId}`,
			childId,
			ownerToken: executionClaim(parent).owner.runtimeId,
			executionToken: executionToken(parent),
			generation: parent.executionGeneration!,
			revision: parent.lifecycleRevision!,
			phase: "prepared",
			attempts: 1,
			resultTs: 3,
		}
		return { parent: reserveDelegation({ ...parent, pendingAction: intent }, receipt, upstream), receipt }
	}
	function delegation(parent: HistoryItem, childId: string, upstream?: HistoryItem) {
		const reserved = reservation(parent, childId, upstream)
		return {
			parent: commitDelegation(reserved.parent, reserved.receipt, upstream),
			child: active(childId, {
				parentTaskId: parent.id,
				rootTaskId: parent.rootTaskId ?? parent.id,
				delegationOrigin: { parentId: parent.id, operationId: reserved.receipt.operationId },
			}),
			receipt: { ...reserved.receipt, phase: "committed" as const },
		}
	}
	async function transcripts(parent: HistoryItem, receipt: DelegationAction) {
		await saveApiMessages({
			taskId: parent.id,
			globalStoragePath: directory,
			messages: [
				{
					messageId: "creating-tool",
					ts: 2,
					role: "assistant",
					content: [{ type: "tool_use", id: receipt.actionId, name: "new_task", input: {} }],
				},
			],
		})
		await saveTaskMessages({
			taskId: parent.id,
			globalStoragePath: directory,
			messages: [{ messageId: "original-ui", ts: 1, type: "say", say: "text", text: "Original" }],
		})
	}
	async function finish(parent: HistoryItem, child: HistoryItem, creating: DelegationAction) {
		const intent: DelegatedCompletionRequest["finish"] = {
			kind: "finish_subtask",
			actionId: `finish-${child.id}`,
			approvalText: "{}",
			parentTaskId: parent.id,
			result: "Finished",
		}
		const pending = await a.lifecycleCommand(
			child.id,
			(current) => ({ ...current, pendingAction: intent }),
			[],
			true,
			executionToken(child),
		)
		const request: DelegatedCompletionRequest = {
			operationId: `complete-${child.id}`,
			parentToken: executionToken(parent),
			childToken: executionToken(pending),
			parentRevision: parent.lifecycleRevision!,
			childRevision: pending.lifecycleRevision!,
			creating,
			finish: intent,
			resultTs: 5,
		}
		return { child: pending, request }
	}
	async function seedCompletion() {
		const graph = delegation(active("parent"), "child")
		await seed(graph.parent)
		await seed(graph.child)
		await transcripts(graph.parent, graph.receipt)
		return { ...graph, ...(await finish(graph.parent, graph.child, graph.receipt)) }
	}
	async function recovery(id: string): Promise<TaskRecoveryRequest> {
		const preview = await a.previewRecovery(id)
		return {
			scope: preview.scope,
			choice: preview.choices[0],
			intent: "explicit_user_resume",
			owner: a.ownerForRuntime(`resumed-${id}`),
		}
	}
	function snapshot(history: HistoryItem): Parameters<TaskHistoryStore["saveExecutionSnapshot"]>[1] {
		return {
			apiMessages: [{ messageId: "snapshot-api", ts: 10, role: "user", content: "Captured API" }],
			clineMessages: [{ messageId: "snapshot-ui", ts: 10, type: "say", say: "text", text: "Captured UI" }],
			metadata: { ...history, tokensIn: 42, mode: "code" },
			merge: true,
		}
	}
	async function contents(id: string) {
		return Promise.all(
			[GlobalFileNames.historyItem, GlobalFileNames.apiConversationHistory, GlobalFileNames.uiMessages].map(
				(name) => fs.readFile(file(id, name), "utf8"),
			),
		)
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-persistence-api-"))
		a = store()
	})
	afterEach(async () => {
		for (const next of stores.splice(0)) next.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it.each([false, true])(
		"saves both transcripts with merge=%s without granting metadata authority",
		async (merge) => {
			const graph = await seedCompletion()
			const incoming = snapshot(graph.child)
			incoming.merge = merge
			await saveApiMessages({
				taskId: "child",
				globalStoragePath: directory,
				messages: [{ messageId: "existing-api", ts: 1, role: "user", content: "Existing" }],
			})
			await saveTaskMessages({
				taskId: "child",
				globalStoragePath: directory,
				messages: [{ messageId: "existing-ui", ts: 1, type: "say", say: "text", text: "Existing" }],
			})
			incoming.metadata = {
				...incoming.metadata!,
				status: "completed",
				parentTaskId: "forged",
				rootTaskId: "forged",
				execution: { version: 99 },
				executionGeneration: 99,
				pendingAction: undefined,
				delegationOrigin: undefined,
				delegatedCompletion: { version: 99 },
			}
			await expect(a.saveExecutionSnapshot(graph.request.childToken, incoming)).resolves.toBeUndefined()
			expect(await readApiMessages({ taskId: "child", globalStoragePath: directory })).toHaveLength(merge ? 2 : 1)
			expect(await readTaskMessages({ taskId: "child", globalStoragePath: directory })).toHaveLength(
				merge ? 2 : 1,
			)
			expect(await a.readAuthoritative("child")).toEqual({
				...graph.child,
				tokensIn: 42,
				mode: "code",
			})
		},
	)
	it.each(["local queue", "storage lock"])("clones input and token before waiting on the %s", async (boundary) => {
		const history = active("task")
		await seed(history)
		const entered = signal()
		const release = signal()
		const write = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (target, data, options) => {
			if (target === file("blocker")) {
				entered.resolve()
				await release.promise
			}
			await write(target, data, options)
		})
		const blocker = boundary === "local queue" ? a : store()
		const blocking = blocker.claimNewTask(item("blocker"), blocker.ownerForRuntime("blocker"))
		await entered.promise
		const incoming = snapshot(history)
		incoming.apiMessages![0].content = [{ type: "text", text: "Captured API" }]
		const token = executionToken(history)
		const saving = a.saveExecutionSnapshot(token, incoming)
		try {
			const content = incoming.apiMessages![0].content
			if (Array.isArray(content) && content[0].type === "text") content[0].text = "Late API"
			incoming.clineMessages![0].text = "Late UI"
			incoming.metadata!.mode = "ask"
			incoming.metadata!.tokensIn = 99
			token.owner.runtimeId = "late-owner"
			token.generation++
		} finally {
			release.resolve()
		}
		applied(await blocking)
		await saving
		expect((await readApiMessages({ taskId: "task", globalStoragePath: directory }))[0].content).toEqual([
			{ type: "text", text: "Captured API" },
		])
		expect((await readTaskMessages({ taskId: "task", globalStoragePath: directory }))[0].text).toBe("Captured UI")
		expect(await a.readAuthoritative("task")).toMatchObject({
			tokensIn: 42,
			mode: "code",
		})
	})
	it.each(["api", "ui", "metadata"])("holds storage authority through the %s snapshot write", async (stage) => {
		const history = active("task")
		await seed(history)
		const entered = signal()
		const release = signal()
		const target = file(
			"task",
			stage === "api"
				? GlobalFileNames.apiConversationHistory
				: stage === "ui"
					? GlobalFileNames.uiMessages
					: GlobalFileNames.historyItem,
		)
		const write = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (name, data, options) => {
			if (name === target) {
				entered.resolve()
				await release.promise
			}
			await write(name, data, options)
		})
		const saving = a.saveExecutionSnapshot(executionToken(history), snapshot(history))
		await entered.promise
		const peer = store()
		const cancelling = peer.interruptTask(executionToken(history))
		try {
			expect(await lockfile.check(path.join(directory, ".task-lifecycle"), { realpath: false })).toBe(true)
			expect(executionClaim(await a.readAuthoritative("task")).phase).toBe("active")
		} finally {
			release.resolve()
		}
		await saving
		expect(applied(await cancelling).history).toMatchObject({ status: "interrupted", tokensIn: 42 })
		const before = await contents("task")
		await expect(a.saveExecutionSnapshot(executionToken(history), snapshot(history))).rejects.toThrow(
			"stale_generation",
		)
		expect(await contents("task")).toEqual(before)
	})
	it.each(["peer", "settled", "suspended", "mismatched metadata", "missing"])(
		"refuses a %s snapshot before any write",
		async (variant) => {
			let history = active("task")
			if (variant === "settled") history = settleExecution(history, executionToken(history), true)
			if (variant === "suspended") history = interruptExecution(history, executionToken(history))
			if (variant !== "missing") await seed(history)
			const incoming = snapshot(history)
			if (variant === "mismatched metadata") incoming.metadata!.id = "other"
			const writes = vi.spyOn(safeJson, "safeWriteJson")
			await expect(
				(variant === "peer" ? store("observer") : a).saveExecutionSnapshot(executionToken(history), incoming),
			).rejects.toThrow()
			expect(writes).not.toHaveBeenCalled()
			if (variant === "missing") await expect(fs.stat(file("task"))).rejects.toMatchObject({ code: "ENOENT" })
		},
	)
	it("permits only the exact prepared parent's flush, not blocked/failed or replacement-owned reservations", async () => {
		const reserved = reservation(active("parent"), "child")
		await seed(reserved.parent)
		await a.saveExecutionSnapshot(executionToken(reserved.parent), snapshot(reserved.parent))
		expect(await a.guardExecution(executionToken(reserved.parent))).toMatchObject({ reason: "recovery_required" })
		for (const history of [
			failDelegation(reserved.parent, reserved.receipt, "failed", "Failed"),
			failDelegation(reserved.parent, reserved.receipt, "uncertain", "Uncertain"),
			{
				...reserved.parent,
				delegation: { version: 1 as const, actions: [{ ...reserved.receipt, phase: "failed" as const }] },
			},
			{
				...reserved.parent,
				delegation: {
					version: 1 as const,
					actions: [
						{ ...reserved.receipt, executionToken: { ...executionToken(reserved.parent), generation: 99 } },
					],
				},
			},
		]) {
			await seed(history)
			const writes = vi.spyOn(safeJson, "safeWriteJson")
			writes.mockClear()
			await expect(a.saveExecutionSnapshot(executionToken(history), snapshot(history))).rejects.toThrow(
				"recovery_required",
			)
			expect(writes).not.toHaveBeenCalled()
		}
	})
	it("rejects a queued final snapshot after an earlier cancellation fences its immutable token", async () => {
		const history = active("task")
		await seed(history)
		await a.saveExecutionSnapshot(executionToken(history), snapshot(history))
		const entered = signal()
		const release = signal()
		const write = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (target, data, options) => {
			if (target === file("task")) {
				entered.resolve()
				await release.promise
			}
			await write(target, data, options)
		})
		const cancelling = a.interruptTask(executionToken(history))
		await entered.promise
		const saving = a.saveExecutionSnapshot(executionToken(history), snapshot(history))
		const refused = expect(saving).rejects.toThrow("stale_generation")
		release.resolve()
		const fenced = applied(await cancelling)
		const before = await contents("task")
		await refused
		expect(await contents("task")).toEqual(before)
		expect(await a.readAuthoritative("task")).toEqual(fenced.history)
	})
	it("allows provider cleanup using the exact fenced token, never the stale or settled token", async () => {
		const running = active("task")
		await seed(running)
		const captured = snapshot(running)
		const interrupted = applied(await a.interruptTask(executionToken(running)))
		await expect(a.saveExecutionSnapshot(executionToken(running), captured, true)).rejects.toThrow(
			"stale_generation",
		)
		await a.saveExecutionSnapshot(interrupted.token, captured, true)
		expect(await a.readAuthoritative("task")).toEqual({
			...interrupted.history,
			tokensIn: 42,
			mode: "code",
		})
		const settled = applied(await a.settleTaskExecution(interrupted.token, true))
		const before = await contents("task")
		await expect(a.saveExecutionSnapshot(settled.token, captured, true)).rejects.toThrow("not_active")
		expect(await contents("task")).toEqual(before)
	})
	it("rejects peer cleanup and leaves completed authority untouched during local cleanup", async () => {
		const history = active("task")
		await seed(history)
		const captured = snapshot(history)
		const completed = applied(await a.completeStandaloneTask(executionToken(history), "Done"))
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		await expect(store("peer").saveExecutionSnapshot(completed.token, captured, true)).rejects.toThrow(
			"owner_mismatch",
		)
		expect(writes).not.toHaveBeenCalled()
		await a.saveExecutionSnapshot(completed.token, captured, true)
		expect(await a.readAuthoritative("task")).toEqual({ ...completed.history, tokensIn: 42, mode: "code" })
	})
	it("allows a provider's active prepared flush but no snapshot over a completion prefix", async () => {
		const reserved = reservation(active("task"), "unused")
		await seed(reserved.parent)
		await a.saveExecutionSnapshot(executionToken(reserved.parent), snapshot(reserved.parent), true)
		const graph = await seedCompletion()
		await seed(prepareDelegatedCompletion(graph.parent, graph.child, graph.request))
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		for (const history of [graph.parent, graph.child]) {
			await expect(a.saveExecutionSnapshot(executionToken(history), snapshot(history), true)).rejects.toThrow(
				"completion_pending",
			)
		}
		expect(writes).not.toHaveBeenCalled()
	})

	it.each(["recovery", "completion"])(
		"rechecks %s scope after the actual file-lock wait, before mutation",
		async (command) => {
			const graph = await seedCompletion()
			const running = active("task")
			await seed(settleExecution(running, executionToken(running), true))
			const request = await recovery("task")
			const before = await contents("parent")
			const taskBefore = await fs.readFile(file("task"), "utf8")
			const entered = signal()
			const release = signal()
			const lock = lockfile.lock
			const target = file(command === "recovery" ? "task" : "parent")
			vi.spyOn(lockfile, "lock").mockImplementation(async (name, options) => {
				const unlock = await lock(name, options)
				if (name === target) {
					entered.resolve()
					await release.promise
				}
				return unlock
			})
			let current = true
			const result =
				command === "recovery"
					? a.recoverTask(request, () => current)
					: a.completeDelegatedTask(graph.request, () => current)
			await entered.promise
			current = false
			release.resolve()
			expect(await result).toMatchObject({ kind: "refused", reason: "stale_scope" })
			expect(await contents("parent")).toEqual(before)
			expect(await fs.readFile(file("task"), "utf8")).toBe(taskBefore)
			expect(await a.readAuthoritative("child")).toEqual(graph.child)
		},
	)
	it.each(["recovery", "completion"])(
		"captures immutable %s command intent before awaiting persistence",
		async (command) => {
			const graph = await seedCompletion()
			const running = active("task")
			await seed(settleExecution(running, executionToken(running), true))
			const request = await recovery("task")
			const recovering = command === "recovery" ? a.recoverTask(request) : a.completeDelegatedTask(graph.request)
			request.owner.runtimeId = "late-owner"
			request.scope.revision++
			graph.request.finish.result = "Late result"
			graph.request.childToken.generation++
			expect(await recovering).toMatchObject({ kind: command === "recovery" ? "applied" : "completed" })
			if (command === "recovery")
				expect(executionClaim(await a.readAuthoritative("task")).owner.runtimeId).toBe("resumed-task")
			else expect((await a.readAuthoritative("child")).completionResultSummary).toBe("Finished")
		},
	)
	it("finishes a prepared completion even if focus changes after its durable prefix", async () => {
		const graph = await seedCompletion()
		let current = true
		const write = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (target, data, options) => {
			await write(target, data, options)
			if (target === file("parent")) current = false
		})
		expect(await a.completeDelegatedTask(graph.request, () => current)).toMatchObject({ kind: "completed" })
		expect(current).toBe(false)
		expect(completionState(await a.readAuthoritative("parent")).receipts[0].phase).toBe("committed")
		expect(await readApiMessages({ taskId: "parent", globalStoragePath: directory })).toHaveLength(2)
	})
	it("returns an authorized local leaf through settled nonlocal ancestors without pre-transferring them", async () => {
		const ab = delegation(active("a"), "b")
		const bc = delegation(ab.child, "c", ab.parent)
		for (const history of [ab.parent, bc.parent, bc.child]) await seed(history)
		await transcripts(ab.parent, ab.receipt)
		await transcripts(bc.parent, bc.receipt)
		a = store(
			"restarted",
			host("restarted", async () => "ESRCH"),
		)
		await a.initialize()
		const resumedC = applied(await a.recoverTask(await recovery("c")))
		const originalB = await a.readAuthoritative("b")
		const originalA = await a.readAuthoritative("a")
		const cFinish = await finish(originalB, resumedC.history, bc.receipt)
		const completed = await a.completeDelegatedTask(cFinish.request)
		expect(completed.kind).toBe("completed")
		if (completed.kind !== "completed") throw new Error(completed.kind)
		expect(executionClaim(completed.parent)).toEqual(executionClaim(originalB))
		expect(completed.parent).toMatchObject({ status: "active", parentTaskId: "a" })
		expect(await a.readAuthoritative("a")).toEqual(originalA)
		expect(await a.completeDelegatedTask(cFinish.request)).toMatchObject({ kind: "duplicate" })
		const resumedB = applied(
			await a.transferTaskExecution(executionToken(completed.parent), a.ownerForRuntime("b-return"), true),
		)
		expect(await a.guardExecution(resumedB.token)).toMatchObject({ kind: "allowed" })
		const bFinish = await finish(originalA, resumedB.history, ab.receipt)
		expect(await a.completeDelegatedTask(bFinish.request)).toMatchObject({ kind: "completed" })
		expect(executionClaim(await a.readAuthoritative("a"))).toEqual(executionClaim(originalA))
	})
	it.each(["token", "revision", "receipt", "upstream"])(
		"validates %s before writing a settled nonlocal ancestor",
		async (variant) => {
			const ab = delegation(active("root"), "parent")
			const graph = delegation(ab.child, "child", ab.parent)
			for (const history of [ab.parent, graph.parent, graph.child]) await seed(history)
			await transcripts(graph.parent, graph.receipt)
			a = store(
				"restarted",
				host("restarted", async () => "ESRCH"),
			)
			await a.initialize()
			const child = applied(await a.recoverTask(await recovery("child")))
			const parent = await a.readAuthoritative("parent")
			const completing = await finish(parent, child.history, graph.receipt)
			if (variant === "token") completing.request.parentToken.generation++
			if (variant === "revision") completing.request.parentRevision++
			if (variant === "receipt") completing.request.creating.operationId = "wrong"
			if (variant === "upstream") await seed({ ...(await a.readAuthoritative("root")), awaitingChildId: "other" })
			const before = await contents("parent")
			const writes = vi.spyOn(safeJson, "safeWriteJson")
			expect(await a.completeDelegatedTask(completing.request)).toMatchObject({ kind: "refused" })
			expect(writes).not.toHaveBeenCalled()
			expect(await contents("parent")).toEqual(before)
		},
	)
	it.each(["live", "unknown", "dead but unrepaired"])(
		"refuses a %s peer parent before completion writes",
		async (variant) => {
			const graph = await seedCompletion()
			const probe = vi
				.fn<ExecutionHost["probeProcess"]>()
				.mockResolvedValue(variant === "dead but unrepaired" ? "ESRCH" : "unknown")
			a = store("provider", host("original", probe))
			const peer = store("peer", variant === "live" ? host() : host("peer"))
			const peerParent = {
				...graph.parent,
				execution: { ...executionClaim(graph.parent), owner: peer.ownerForRuntime("parent") },
			}
			await seed(peerParent)
			graph.request.parentToken = executionToken(peerParent)
			const writes = vi.spyOn(safeJson, "safeWriteJson")
			expect(await a.completeDelegatedTask(graph.request)).toMatchObject({
				kind: "refused",
				reason: variant === "live" ? "owner_live" : "owner_unknown",
			})
			expect(writes).not.toHaveBeenCalled()
			if (variant !== "live") expect(probe).toHaveBeenCalledOnce()
		},
	)

	it("abandons exact cleaned lineage parent-first, preserving provenance without runtime activation", async () => {
		const graph = delegation(active("parent"), "child")
		const child = settleExecution(graph.child, executionToken(graph.child), true)
		await seed(graph.parent)
		await seed(child)
		await a.reconcile()
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		const result = await a.abandonTaskDelegation(executionToken(graph.parent), executionToken(child))
		expect(result.kind).toBe("applied")
		if (result.kind !== "applied") throw new Error(result.reason)
		expect(writes.mock.calls.map(([target]) => target)).toEqual([file("parent"), file("child")])
		expect(result.parent).toMatchObject({
			status: "active",
			childIds: ["child"],
			executionGeneration: 2,
			execution: { phase: "suspended", cleanupPending: false },
		})
		expect(result.parent.awaitingChildId).toBeUndefined()
		expect(result.child).toMatchObject({
			status: "interrupted",
			executionGeneration: child.executionGeneration! + 1,
			execution: { phase: "settled", cleanupPending: false },
			lineageProvenance: { parentTaskId: "parent", rootTaskId: "parent" },
		})
		expect(result.child.parentTaskId).toBeUndefined()
		expect(result.child.rootTaskId).toBeUndefined()
		expect(result.child.delegationOrigin).toEqual(child.delegationOrigin)
		expect(await a.guardExecution(executionToken(result.parent))).toMatchObject({
			kind: "refused",
			reason: "not_active",
		})
		expect((await a.previewRecovery("child")).choices).toEqual(["resume_independent"])
		await a.updateMessageMetadata({ ...child, tokensIn: 10 })
		await a.upsert({ ...graph.parent, tokensIn: 11 })
		expect((await a.readAuthoritative("child")).parentTaskId).toBeUndefined()
		expect((await a.readAuthoritative("parent")).awaitingChildId).toBeUndefined()
		expect(await a.abandonTaskDelegation(executionToken(graph.parent), executionToken(child))).toMatchObject({
			kind: "refused",
			reason: "stale_generation",
		})
	})
	it.each(["parent", "child"])("preserves safe state after an abandonment %s-write failure", async (stage) => {
		const graph = delegation(active("parent"), "child")
		const child = settleExecution(graph.child, executionToken(graph.child), true)
		await seed(graph.parent)
		await seed(child)
		const write = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (target, data, options) => {
			if (target === file(stage)) throw new Error("injected write failure")
			await write(target, data, options)
		})
		await expect(a.abandonTaskDelegation(executionToken(graph.parent), executionToken(child))).rejects.toThrow()
		vi.restoreAllMocks()
		expect(await a.readAuthoritative("child")).toEqual(child)
		if (stage === "parent") {
			expect(await a.readAuthoritative("parent")).toEqual(graph.parent)
		} else {
			const parent = await a.readAuthoritative("parent")
			expect(parent.status).toBe("active")
			expect(parent.awaitingChildId).toBeUndefined()
			expect(executionClaim(parent).phase).toBe("suspended")
			expect(a.get("parent")).toEqual(parent)
			expect((await a.previewRecovery("child")).choices).toEqual(["resume_independent"])
			expect(await a.abandonTaskDelegation(executionToken(graph.parent), executionToken(child))).toMatchObject({
				kind: "refused",
				reason: "stale_generation",
			})
		}
	})
	it.each(["parent", "child"])("recognizes an after-rename abandonment %s write by read-back", async (stage) => {
		const graph = delegation(active("parent"), "child")
		const child = settleExecution(graph.child, executionToken(graph.child), true)
		await seed(graph.parent)
		await seed(child)
		const write = safeJson.safeWriteJson
		let injected = false
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (target, data, options) => {
			await write(target, data, options)
			if (!injected && target === file(stage)) {
				injected = true
				throw new Error("after rename")
			}
		})
		expect(await a.abandonTaskDelegation(executionToken(graph.parent), executionToken(child))).toMatchObject({
			kind: "applied",
		})
		expect(injected).toBe(true)
		expect((await a.readAuthoritative("parent")).awaitingChildId).toBeUndefined()
		expect((await a.readAuthoritative("child")).parentTaskId).toBeUndefined()
	})
	it("abandons a settled peer child while preserving exact upstream ownership and prior provenance", async () => {
		const upstream = delegation(active("root"), "parent")
		const graph = delegation(upstream.child, "child", upstream.parent)
		const child = settleExecution(graph.child, executionToken(graph.child), true)
		child.lineageProvenance = { parentTaskId: "historic", rootTaskId: "historic-root" }
		child.execution = { ...executionClaim(child), owner: store("peer").ownerForRuntime("old-child") }
		for (const history of [upstream.parent, graph.parent, child]) await seed(history)
		const result = await a.abandonTaskDelegation(executionToken(graph.parent), executionToken(child))
		expect(result.kind).toBe("applied")
		if (result.kind !== "applied") throw new Error(result.reason)
		expect(result.parent.parentTaskId).toBe("root")
		expect(result.child.lineageProvenance).toEqual(child.lineageProvenance)
		expect(await a.readAuthoritative("root")).toEqual(upstream.parent)
	})
	it("throws rather than reporting refusal after the parent abandonment prefix commits", async () => {
		const graph = delegation(active("parent"), "child")
		const child = settleExecution(graph.child, executionToken(graph.child), true)
		await seed(graph.parent)
		await seed(child)
		const write = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (target, data, options) => {
			if (target === file("child"))
				await write(target, { ...child, lifecycleRevision: child.lifecycleRevision! + 1 })
			await write(target, data, options)
		})
		await expect(a.abandonTaskDelegation(executionToken(graph.parent), executionToken(child))).rejects.toThrow(
			"stale_revision",
		)
		expect((await a.readAuthoritative("parent")).awaitingChildId).toBeUndefined()
		expect((await a.readAuthoritative("child")).parentTaskId).toBe("parent")
	})
	it("refuses abandonment over a completion prefix before either lineage write", async () => {
		const graph = await seedCompletion()
		await seed(prepareDelegatedCompletion(graph.parent, graph.child, graph.request))
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		expect(await a.abandonTaskDelegation(graph.request.parentToken, graph.request.childToken)).toMatchObject({
			kind: "refused",
			reason: "completion_pending",
		})
		expect(writes).not.toHaveBeenCalled()
	})
	it.each(["live child", "pending cleanup", "stale child", "peer parent", "active parent", "upstream mismatch"])(
		"refuses abandonment with %s before any write",
		async (variant) => {
			const upstream = delegation(active("root"), "parent")
			const graph = delegation(upstream.child, "child", upstream.parent)
			let child = settleExecution(graph.child, executionToken(graph.child), true)
			if (variant === "live child") child = graph.child
			if (variant === "pending cleanup") child = interruptExecution(graph.child, executionToken(graph.child))
			let parent = graph.parent
			if (variant === "peer parent")
				parent = {
					...parent,
					execution: { ...executionClaim(parent), owner: store("peer").ownerForRuntime("parent") },
				}
			if (variant === "active parent")
				parent = { ...parent, execution: { ...executionClaim(parent), phase: "active" } }
			await seed(
				variant === "upstream mismatch" ? { ...upstream.parent, awaitingChildId: "other" } : upstream.parent,
			)
			await seed(parent)
			await seed(child)
			const childToken = executionToken(child)
			if (variant === "stale child") childToken.generation++
			const writes = vi.spyOn(safeJson, "safeWriteJson")
			expect(await a.abandonTaskDelegation(executionToken(parent), childToken)).toMatchObject({ kind: "refused" })
			expect(writes).not.toHaveBeenCalled()
		},
	)
	it.each(["live", "unknown"])("refuses %s peer transfer despite a supplied cleanup boolean", async (variant) => {
		const peer = store("peer", variant === "live" ? host() : host("peer"))
		const history = claimNewExecution(item("task"), peer.ownerForRuntime("task"))
		await seed(history)
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		expect(
			await a.transferTaskExecution(executionToken(history), a.ownerForRuntime("replacement"), true),
		).toMatchObject({
			kind: "refused",
			reason: variant === "live" ? "owner_live" : "owner_unknown",
		})
		expect(writes).not.toHaveBeenCalled()
	})
	it("preserves same-provider suspended transfer and permits exact settled peer transfer", async () => {
		const graph = delegation(active("parent"), "child")
		await seed(graph.parent)
		await seed(graph.child)
		const local = applied(
			await a.transferTaskExecution(executionToken(graph.parent), a.ownerForRuntime("replacement"), true),
		)
		expect(executionClaim(local.history).phase).toBe("suspended")
		expect(local.history.awaitingChildId).toBe("child")
		const peer = store("peer")
		const stopped = applied(await a.settleTaskExecution(executionToken(graph.child), true))
		expect(await peer.transferTaskExecution(stopped.token, peer.ownerForRuntime("child"), false)).toMatchObject({
			kind: "refused",
			reason: "cleanup_pending",
		})
		const moved = applied(await peer.transferTaskExecution(stopped.token, peer.ownerForRuntime("child"), true))
		expect(moved.history.status).toBe("interrupted")
		expect(executionClaim(moved.history).phase).toBe("suspended")
	})
})
