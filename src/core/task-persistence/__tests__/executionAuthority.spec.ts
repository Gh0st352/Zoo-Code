import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type {
	DelegationAction,
	DelegatedCompletionRequest,
	ExecutionCommandResult,
	ExecutionOwner,
	HistoryItem,
	PendingTaskAction,
	TaskRecoveryRequest,
} from "@roo-code/types"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { type ExecutionHost, probeExecutionOwner } from "../executionHost"
import {
	assertExecutionAllowed,
	assertValidTransition,
	claimNewExecution,
	commitDelegation,
	completionState,
	executionClaim,
	executionToken,
	failDelegation,
	interruptExecution,
	previewTaskRecovery,
	recoverTaskExecution,
	repairDeadExecution,
	reserveDelegation,
	settleExecution,
	transferExecution,
	validateDelegatedCompletion,
} from "../taskLifecycle"
import { mergeHistoryDelta, mergeTaskMessageMetadata } from "../taskStoreConcurrency"
import { readApiMessages, saveApiMessages } from "../apiMessages"
import { readTaskMessages, saveTaskMessages } from "../taskMessages"
import * as safeJson from "../../../utils/safeWriteJson"
import { GlobalFileNames } from "../../../shared/globalFileNames"

const host = (session = "host", probe: ExecutionHost["probeProcess"] = async () => "unknown"): ExecutionHost => ({
	identity: {
		hostSessionId: session,
		processId: session === "host" ? 111 : 222,
		machineId: "machine",
		machineProof: "local",
	},
	probeProcess: probe,
})
const owner = (runtimeId = "runtime"): ExecutionOwner => ({ ...host().identity, providerId: "provider", runtimeId })
const item = (id = "task", extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})
const active = (id = "task", extra: Partial<HistoryItem> = {}) => claimNewExecution(item(id, extra), owner(id))
const applied = (result: ExecutionCommandResult) => {
	expect(result.kind).toBe("applied")
	if (result.kind !== "applied") throw new Error(result.reason)
	return result
}
const intent = (id: string): Extract<PendingTaskAction, { kind: "create_subtask" }> => ({
	kind: "create_subtask",
	actionId: `create-${id}`,
	approvalText: "{}",
	message: id,
	mode: "code",
	todos: [],
})
function delegation(parent: HistoryItem, childId: string, upstream?: HistoryItem) {
	const action = intent(childId)
	const p = { ...parent, pendingAction: action }
	const receipt: DelegationAction = {
		actionId: action.actionId,
		intent: action,
		operationId: `operation-${childId}`,
		childId,
		ownerToken: executionClaim(p).owner.runtimeId,
		executionToken: executionToken(p),
		generation: p.executionGeneration!,
		revision: p.lifecycleRevision!,
		phase: "prepared",
		attempts: 1,
		resultTs: 3,
	}
	const reserved = reserveDelegation(p, receipt, upstream)
	const child = active(childId, {
		parentTaskId: parent.id,
		rootTaskId: parent.rootTaskId ?? parent.id,
		delegationOrigin: { parentId: parent.id, operationId: receipt.operationId },
	})
	return {
		parent: commitDelegation(reserved, receipt, upstream),
		child,
		receipt: { ...receipt, phase: "committed" as const },
	}
}
function completion(
	parent: HistoryItem,
	child: HistoryItem,
	receipt: DelegationAction,
): { child: HistoryItem; request: DelegatedCompletionRequest } {
	const finish: DelegatedCompletionRequest["finish"] = {
		kind: "finish_subtask",
		actionId: `finish-${child.id}`,
		approvalText: "{}",
		parentTaskId: parent.id,
		result: "Finished",
	}
	return {
		child: { ...child, pendingAction: finish },
		request: {
			operationId: `complete-${child.id}`,
			parentToken: executionToken(parent),
			childToken: executionToken(child),
			parentRevision: parent.lifecycleRevision!,
			childRevision: child.lifecycleRevision!,
			creating: receipt,
			finish,
			resultTs: 5,
		},
	}
}
function recovery(history: HistoryItem, parent?: HistoryItem): TaskRecoveryRequest {
	const preview = previewTaskRecovery(history, parent)
	return {
		scope: preview.scope,
		choice: preview.choices[0],
		intent: "explicit_user_resume",
		owner: owner("replacement"),
	}
}

describe("execution authority reducers", () => {
	it("missing and unknown metadata never grant execution", () => {
		for (const history of [item(), item("task", { execution: { version: 20 } })]) {
			expect(() => assertExecutionAllowed(history, executionToken(active()))).toThrow()
			expect(previewTaskRecovery(history).choices).toEqual([])
		}
	})
	it("interruption fences immediately and cleanup-pending prevents recovery/transfer", () => {
		const running = active()
		const paused = interruptExecution(running, executionToken(running))
		expect(paused.executionGeneration).toBe(2)
		expect(() => assertExecutionAllowed(paused, executionToken(running))).toThrow("stale_generation")
		expect(previewTaskRecovery(paused).reason).toBe("cleanup_pending")
		expect(() => transferExecution(paused, executionToken(paused), owner("new"), false)).toThrow("cleanup_pending")
		const settled = settleExecution(paused, executionToken(paused), true)
		const resumed = recoverTaskExecution(settled, recovery(settled))
		expect(resumed.status).toBe("active")
		expect(() => recoverTaskExecution(resumed, recovery(settled))).toThrow("stale_generation")
		expect(() => assertValidTransition("interrupted", "active")).toThrow()
	})
	it.each(["intent", "choice", "revision", "generation", "owner", "action", "task"])(
		"refuses wrong recovery %s without mutation",
		(change) => {
			const settled = settleExecution(active(), executionToken(active()), true)
			const request = recovery(settled)
			if (change === "intent") Object.assign(request, { intent: "automatic_approval" })
			if (change === "choice") request.choice = "resume_linked"
			if (change === "revision") request.scope.revision++
			if (change === "generation") request.scope.generation++
			if (change === "owner") request.scope.claim!.owner.runtimeId = "other"
			if (change === "action") request.scope.action = intent("other")
			if (change === "task") request.scope.taskId = "other"
			const before = structuredClone(settled)
			expect(() => recoverTaskExecution(settled, request)).toThrow()
			expect(settled).toEqual(before)
		},
	)
	it("linked recovery preserves the original receipt; independent recovery never reattaches", () => {
		const graph = delegation(active("parent"), "child")
		const paused = settleExecution(graph.child, executionToken(graph.child), true)
		const resumed = recoverTaskExecution(paused, recovery(paused, graph.parent), graph.parent)
		expect(resumed.parentTaskId).toBe("parent")
		expect(() => delegation(resumed, "nested", graph.parent)).not.toThrow()
		const replaced = { ...graph.parent, awaitingChildId: "other", delegatedToId: "other" }
		const independent = recoverTaskExecution(paused, recovery(paused, replaced), replaced)
		expect(independent.parentTaskId).toBeUndefined()
		expect(independent.rootTaskId).toBeUndefined()
		expect(independent.lineageProvenance).toEqual({ parentTaskId: "parent", rootTaskId: "parent" })
		expect(independent.delegationOrigin).toEqual(paused.delegationOrigin)
		expect(previewTaskRecovery(paused, { ...graph.parent, status: "active" }).choices).toEqual([])
	})
	it("dead-owner repair preserves nested delegation and pending evidence", () => {
		const ab = delegation(active("a"), "b")
		const bc = delegation(ab.child, "c", ab.parent)
		const leaf = { ...bc.child, pendingAction: intent("pending") }
		const a = repairDeadExecution(ab.parent, executionToken(ab.parent))
		const b = repairDeadExecution(bc.parent, executionToken(bc.parent))
		const c = repairDeadExecution(leaf, executionToken(leaf))
		expect(a.status).toBe("delegated")
		expect(b.status).toBe("delegated")
		expect(c.status).toBe("interrupted")
		expect(c.pendingAction).toEqual(leaf.pendingAction)
		expect(b.awaitingChildId).toBe("c")
		expect(previewTaskRecovery(c, b).reason).toBe("action_mismatch")
		expect(previewTaskRecovery(b, a, c).choices).toEqual(["retain_delegation"])
	})
	it("completed tasks and live descendants cannot be resumed", () => {
		const graph = delegation(active("parent"), "child")
		const paused = repairDeadExecution(graph.parent, executionToken(graph.parent))
		expect(previewTaskRecovery(paused, undefined, graph.child).reason).toBe("descendant_owned")
		expect(previewTaskRecovery({ ...paused, status: "completed" }).reason).toBe("completed")
	})
	it("failed action needs durable result and stays unusable after explicit resume", () => {
		const p = active("parent")
		const graph = delegation(p, "child")
		const receipt = { ...graph.receipt, phase: "prepared" as const }
		const failed = failDelegation({ ...p, pendingAction: receipt.intent }, receipt, "failed", "denied")
		const settled = settleExecution(failed, executionToken(failed), true)
		expect(previewTaskRecovery(settled).reason).toBe("result_repair_required")
	})
	it("recovery binds the current parent revision and owner rather than only its ID", () => {
		const graph = delegation(active("parent"), "child")
		const paused = settleExecution(graph.child, executionToken(graph.child), true)
		const request = recovery(paused, graph.parent)
		const movedParent = transferExecution(
			graph.parent,
			executionToken(graph.parent),
			owner("parent-replaced"),
			true,
		)
		expect(() => recoverTaskExecution(paused, request, movedParent)).toThrow("stale_scope")
	})
	it("independent recovery scope survives serialization beside a legacy non-owning parent", () => {
		const graph = delegation(active("parent"), "child")
		const paused = settleExecution(graph.child, executionToken(graph.child), true)
		const legacy = item("parent")
		const request: TaskRecoveryRequest = JSON.parse(JSON.stringify(recovery(paused, legacy)))
		expect(recoverTaskExecution(paused, request, legacy).parentTaskId).toBeUndefined()
	})
	it("ordinary merges preserve all command-owned fields, including unknown future metadata", () => {
		const disk = active()
		const forged = {
			...disk,
			execution: { version: 99 },
			status: "completed" as const,
			tokensIn: 10,
			delegation: { version: 1 as const, actions: [] },
			executionGeneration: 77,
			pendingAction: intent("forged"),
		}
		expect(mergeHistoryDelta(disk, forged, forged)).toEqual({ ...disk, tokensIn: 10 })
		expect(mergeTaskMessageMetadata(disk, forged)).toEqual({ ...disk, tokensIn: 10 })
	})
	it("strict completion rejects interrupted legacy callbacks and wrong creating receipt", () => {
		const graph = delegation(active("parent"), "child")
		const c = completion(graph.parent, graph.child, graph.receipt)
		expect(() => validateDelegatedCompletion(graph.parent, c.child, c.request)).not.toThrow()
		expect(() =>
			validateDelegatedCompletion(graph.parent, { ...c.child, status: "interrupted" }, c.request),
		).toThrow()
		expect(() =>
			validateDelegatedCompletion(graph.parent, c.child, {
				...c.request,
				creating: { ...graph.receipt, childId: "wrong" },
			}),
		).toThrow("receipt_mismatch")
	})
	it("stale parent/child identity and max generation refuse before a completion prefix can exist", () => {
		const graph = delegation(active("parent"), "child")
		const c = completion(graph.parent, graph.child, graph.receipt)
		expect(() =>
			validateDelegatedCompletion(
				{ ...graph.parent, awaitingChildId: "new-child", delegatedToId: "new-child" },
				c.child,
				c.request,
			),
		).toThrow()
		expect(() =>
			validateDelegatedCompletion(
				graph.parent,
				{ ...c.child, delegationOrigin: { parentId: "parent", operationId: "wrong" } },
				c.request,
			),
		).toThrow()
		const exhausted = {
			...c.child,
			executionGeneration: Number.MAX_SAFE_INTEGER,
			execution: { ...executionClaim(c.child), generation: Number.MAX_SAFE_INTEGER },
		}
		expect(() =>
			validateDelegatedCompletion(graph.parent, exhausted, {
				...c.request,
				childToken: executionToken(exhausted),
			}),
		).toThrow("metadata_unknown")
	})
})

describe("owner process proof", () => {
	it("same session stays live even if an injected PID probe says ESRCH", async () => {
		const probe = vi.fn<ExecutionHost["probeProcess"]>().mockResolvedValue("ESRCH")
		expect(await probeExecutionOwner(executionClaim(active()), host("host", probe))).toBe("live")
		expect(probe).not.toHaveBeenCalled()
	})
	it.each(["present", "unknown", "ESRCH"] as const)("cross-process proof: %s", async (result) => {
		expect(
			await probeExecutionOwner(
				executionClaim(active()),
				host("other", async () => result),
			),
		).toBe(result === "ESRCH" ? "dead" : "unknown")
	})
	it("different/ambiguous machine, reused current PID, probe rejection and unknown proof are conservative", async () => {
		const claim = executionClaim(active())
		for (const identity of [
			{ ...host("other").identity, machineId: "elsewhere" },
			{ ...host("other").identity, machineProof: "unknown" as const },
			{ ...host("other").identity, processId: claim.owner.processId },
		])
			expect(await probeExecutionOwner(claim, { identity, probeProcess: async () => "ESRCH" })).toBe("unknown")
		expect(
			await probeExecutionOwner(
				claim,
				host("other", async () => {
					throw new Error("EPERM")
				}),
			),
		).toBe("unknown")
	})
})

describe("storage-scoped execution and completion (real safeWriteJson/locks)", () => {
	let directory: string
	let a: TaskHistoryStore
	let b: TaskHistoryStore
	const stores: TaskHistoryStore[] = []
	function store(providerId: string, executionHost = host()) {
		const next = new TaskHistoryStore(directory, { providerId, executionHost })
		stores.push(next)
		return next
	}
	async function seed(history: HistoryItem) {
		await safeJson.safeWriteJson(path.join(directory, "tasks", history.id, GlobalFileNames.historyItem), history)
	}
	async function seedCompletion() {
		const graph = delegation(active("parent"), "child")
		const c = completion(graph.parent, graph.child, graph.receipt)
		await seed(graph.parent)
		await seed(c.child)
		await saveApiMessages({
			taskId: "parent",
			globalStoragePath: directory,
			messages: [
				{
					role: "assistant",
					ts: 2,
					content: [{ type: "tool_use", id: graph.receipt.actionId, name: "new_task", input: {} }],
				},
			],
		})
		await saveTaskMessages({
			taskId: "parent",
			globalStoragePath: directory,
			messages: [{ ts: 1, type: "say", say: "text", text: "Original" }],
		})
		return { ...graph, ...c }
	}
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-execution-"))
		a = store("provider")
		b = store("observer")
	})
	afterEach(async () => {
		for (const next of stores.splice(0)) next.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})
	it("new task claim rejects existing/legacy histories; observer initialization cannot steal or interrupt", async () => {
		const claimed = applied(await a.claimNewTask(item(), a.ownerForRuntime("runtime")))
		await b.initialize()
		expect(await b.readAuthoritative("task")).toEqual(claimed.history)
		expect(await b.guardExecution(claimed.token)).toMatchObject({ kind: "refused", reason: "owner_mismatch" })
		expect(await b.interruptTask(claimed.token)).toMatchObject({ kind: "refused", reason: "owner_mismatch" })
		expect(await b.claimNewTask(item(), b.ownerForRuntime("new"))).toMatchObject({ kind: "refused" })
		await seed(item("legacy"))
		expect((await b.previewRecovery("legacy")).choices).toEqual([])
	})
	it("claimed child cannot execute before exact parent commit; cancellation invalidates its reservation", async () => {
		const p = applied(await a.claimNewTask(item("parent"), a.ownerForRuntime("parent")))
		const graph = delegation(p.history, "child")
		const pending = await a.lifecycleCommand(
			"parent",
			(current) => ({ ...current, pendingAction: graph.receipt.intent }),
			[],
			false,
			p.token,
		)
		const prepared = { ...graph.receipt, revision: pending.lifecycleRevision!, phase: "prepared" as const }
		await a.lifecycleCommand("parent", (current) => reserveDelegation(current, prepared), [], false, p.token)
		const child = applied(
			await a.claimDelegationChild(
				item("child", {
					parentTaskId: "parent",
					rootTaskId: "parent",
					delegationOrigin: { parentId: "parent", operationId: prepared.operationId },
				}),
				a.ownerForRuntime("child"),
				p.token,
				prepared,
			),
		)
		expect(await a.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "parent_mismatch" })
		await a.lifecycleCommand("parent", (current) => commitDelegation(current, prepared), ["child"], false, p.token)
		expect(await a.guardExecution(child.token)).toMatchObject({ kind: "allowed" })
		const interrupted = applied(await a.interruptTask(child.token))
		expect(interrupted.history.status).toBe("interrupted")
		expect(await a.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "stale_generation" })
	})
	it("cancellation between reservation and commit refuses the old generation and preserves prepared evidence", async () => {
		const p = applied(await a.claimNewTask(item("parent"), a.ownerForRuntime("parent")))
		const graph = delegation(p.history, "child")
		const pending = await a.lifecycleCommand(
			"parent",
			(current) => ({ ...current, pendingAction: graph.receipt.intent }),
			[],
			false,
			p.token,
		)
		const receipt = { ...graph.receipt, phase: "prepared" as const, revision: pending.lifecycleRevision! }
		await a.lifecycleCommand("parent", (current) => reserveDelegation(current, receipt), [], false, p.token)
		await a.interruptTask(p.token)
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		await expect(
			a.lifecycleCommand("parent", (current) => commitDelegation(current, receipt), [], false, p.token),
		).rejects.toThrow()
		expect(writes).not.toHaveBeenCalled()
		expect((await a.readAuthoritative("parent")).delegation).toMatchObject({
			actions: [{ phase: "prepared", operationId: receipt.operationId }],
		})
	})
	it("standalone completion fences callbacks but retains cleanup ownership until explicit settlement", async () => {
		const p = applied(await a.claimNewTask(item(), a.ownerForRuntime("runtime")))
		const completed = applied(await a.completeStandaloneTask(p.token, "Done"))
		expect(completed.history.status).toBe("completed")
		expect(executionClaim(completed.history)).toMatchObject({ phase: "suspended", cleanupPending: true })
		expect(await a.completeStandaloneTask(p.token, "late")).toMatchObject({
			kind: "refused",
			reason: "stale_generation",
		})
		const settled = applied(await a.settleTaskExecution(completed.token, true))
		expect(settled.history.status).toBe("completed")
		expect((await a.previewRecovery("task")).choices).toEqual([])
	})
	it("ordinary saves cannot create authority or change claimed status/receipts even with a refreshed cache", async () => {
		const claimed = applied(await a.claimNewTask(item(), a.ownerForRuntime("runtime")))
		const paused = applied(await a.settleTaskExecution(claimed.token, true))
		await b.reconcile()
		await b.updateMessageMetadata({ ...claimed.history, tokensIn: 20, delegation: { version: 1, actions: [] } })
		await b.upsert({ ...claimed.history, tokensIn: 25 })
		expect(await a.readAuthoritative("task")).toEqual({ ...paused.history, tokensIn: 25 })
		await expect(b.upsert(active("forged"))).rejects.toThrow("metadata_missing")
		await expect(b.lifecycleCommand("task", (current) => ({ ...current, status: "active" }))).rejects.toThrow()
	})
	it("failed/denied results repair durably before resume, and failed identities cannot be retried", async () => {
		const p = active("parent")
		const graph = delegation(p, "child")
		const receipt = { ...graph.receipt, phase: "prepared" as const }
		const failed = failDelegation({ ...p, pendingAction: receipt.intent }, receipt, "denied", "User denied")
		await seed(settleExecution(failed, executionToken(failed), true))
		await saveApiMessages({
			taskId: "parent",
			globalStoragePath: directory,
			messages: [
				{
					role: "assistant",
					ts: 2,
					content: [{ type: "tool_use", id: receipt.actionId, name: "new_task", input: {} }],
				},
			],
		})
		await saveTaskMessages({
			taskId: "parent",
			globalStoragePath: directory,
			messages: [{ ts: 1, type: "say", say: "text", text: "Parent" }],
		})
		expect((await a.previewRecovery("parent")).reason).toBe("result_repair_required")
		await a.repairDelegationFailure("parent", { ...receipt, phase: "denied", reason: "User denied" })
		const preview = await a.previewRecovery("parent")
		const resumed = applied(
			await a.recoverTask({
				scope: preview.scope,
				choice: "resume_independent",
				intent: "explicit_user_resume",
				owner: a.ownerForRuntime("resumed"),
			}),
		)
		expect(resumed.history.pendingAction).toBeUndefined()
		expect(() =>
			reserveDelegation(
				{ ...resumed.history, pendingAction: receipt.intent },
				{
					...receipt,
					generation: resumed.token.generation,
					revision: resumed.history.lifecycleRevision!,
					executionToken: resumed.token,
				},
			),
		).toThrow()
		expect((await readApiMessages({ taskId: "parent", globalStoragePath: directory }))[1].content).toEqual([
			{ type: "tool_result", tool_use_id: receipt.actionId, content: "User denied", is_error: true },
		])
	})
	it("prepared and uncertain actions remain blocked after owner death and reload", async () => {
		const p = active("parent")
		const graph = delegation(p, "child")
		for (const phase of ["prepared", "uncertain"] as const) {
			await seed({
				...p,
				pendingAction: graph.receipt.intent,
				delegation: { version: 1, actions: [{ ...graph.receipt, phase }] },
			})
			const dead = store(
				`dead-${phase}`,
				host("other", async () => "ESRCH"),
			)
			await dead.initialize()
			expect((await dead.previewRecovery("parent")).choices).toEqual([])
			expect((await dead.readAuthoritative("parent")).pendingAction).toEqual(graph.receipt.intent)
		}
	})
	it("a conflicting existing success never becomes a repaired failed action or permits activation", async () => {
		const p = active("parent")
		const graph = delegation(p, "child")
		const receipt = { ...graph.receipt, phase: "prepared" as const }
		const failed = failDelegation({ ...p, pendingAction: receipt.intent }, receipt, "failed", "Failed")
		await seed(settleExecution(failed, executionToken(failed), true))
		await saveApiMessages({
			taskId: "parent",
			globalStoragePath: directory,
			messages: [
				{
					role: "assistant",
					ts: 2,
					content: [{ type: "tool_use", id: receipt.actionId, name: "new_task", input: {} }],
				},
				{
					role: "user",
					ts: 3,
					content: [{ type: "tool_result", tool_use_id: receipt.actionId, content: "Success" }],
				},
			],
		})
		await expect(
			a.repairDelegationFailure("parent", { ...receipt, phase: "failed", reason: "Failed" }),
		).rejects.toThrow("transcript_conflict")
		expect((await a.previewRecovery("parent")).reason).toBe("result_repair_required")
		expect((await a.readAuthoritative("parent")).pendingAction).toEqual(receipt.intent)
	})
	it("expired timestamps and unknown peers do not repair; fresh positive absence does", async () => {
		const graph = delegation(active("parent"), "child")
		await seed(graph.parent)
		await seed({ ...graph.child, ts: 0 })
		const unknown = store(
			"unknown",
			host("other", async () => "present"),
		)
		await unknown.initialize()
		expect((await unknown.readAuthoritative("child")).status).toBe("active")
		const dead = store(
			"dead",
			host("other", async () => "ESRCH"),
		)
		await dead.initialize()
		expect(await dead.readAuthoritative("child")).toMatchObject({
			status: "interrupted",
			parentTaskId: "parent",
			executionGeneration: 2,
		})
		expect(await dead.readAuthoritative("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })
		expect((await dead.previewRecovery("child")).choices).toEqual(["resume_linked"])
	})
	it("transfer requires outgoing token and cleanup, fences old callbacks, and provider release is scoped", async () => {
		const first = applied(await a.claimNewTask(item(), a.ownerForRuntime("runtime")))
		expect(await b.transferTaskExecution(first.token, b.ownerForRuntime("new"), false)).toMatchObject({
			kind: "refused",
			reason: "cleanup_pending",
		})
		expect(await b.transferTaskExecution(first.token, b.ownerForRuntime("new"), true)).toMatchObject({
			kind: "refused",
			reason: "owner_live",
		})
		expect(await a.readAuthoritative("task")).toEqual(first.history)
		expect(await a.guardExecution(first.token)).toMatchObject({ kind: "allowed" })
		const settled = applied(await a.settleTaskExecution(first.token, true))
		expect(await b.transferTaskExecution(first.token, b.ownerForRuntime("new"), true)).toMatchObject({
			kind: "refused",
			reason: "stale_generation",
		})
		const second = applied(await b.transferTaskExecution(settled.token, b.ownerForRuntime("new"), true))
		expect(second.history.status).toBe("interrupted")
		expect(executionClaim(second.history)).toMatchObject({ phase: "suspended", cleanupPending: false })
		expect(await b.guardExecution(second.token)).toMatchObject({ kind: "refused", reason: "not_active" })
		expect(await a.completeStandaloneTask(first.token, "stale")).toMatchObject({
			kind: "refused",
			reason: "owner_mismatch",
		})
		expect(await a.releaseProviderClaims([second.token], true)).toMatchObject([
			{ kind: "refused", reason: "owner_mismatch" },
		])
		expect(await b.readAuthoritative("task")).toEqual(second.history)
		// Transfer changes ownership, not interrupted status. Release the suspended
		// claim before taking a fresh, explicitly approved recovery scope.
		applied(await b.settleTaskExecution(second.token, true))
		const preview = await b.previewRecovery("task")
		expect(preview.choices).toEqual(["resume_independent"])
		const resumed = applied(
			await b.recoverTask({
				scope: preview.scope,
				choice: "resume_independent",
				intent: "explicit_user_resume",
				owner: b.ownerForRuntime("resumed"),
			}),
		)
		expect(await b.guardExecution(resumed.token)).toMatchObject({ kind: "allowed" })
		expect(await b.completeStandaloneTask(second.token, "stale transferred callback")).toMatchObject({
			kind: "refused",
			reason: "owner_mismatch",
		})
		expect(await b.readAuthoritative("task")).toEqual(resumed.history)
		const paused = applied(await b.interruptTask(resumed.token))
		expect(await b.settleTaskExecution(paused.token, false)).toMatchObject({
			kind: "refused",
			reason: "cleanup_pending",
		})
		b.dispose()
		expect(executionClaim(await a.readAuthoritative("task")).cleanupPending).toBe(true)
	})
	it("scoped explicit recovery applies once and stale request writes nothing", async () => {
		const first = applied(await a.claimNewTask(item(), a.ownerForRuntime("runtime")))
		await a.settleTaskExecution(first.token, true)
		const preview = await a.previewRecovery("task")
		const request: TaskRecoveryRequest = {
			scope: preview.scope,
			owner: a.ownerForRuntime("resumed"),
			choice: "resume_independent",
			intent: "explicit_user_resume",
		}
		const next = applied(await a.recoverTask(request))
		const write = vi.spyOn(safeJson, "safeWriteJson")
		expect(await a.recoverTask(request)).toMatchObject({ kind: "refused", reason: "stale_generation" })
		expect(write).not.toHaveBeenCalled()
		expect(await a.guardExecution(next.token)).toMatchObject({ kind: "allowed" })
	})
	it("completion refusal happens before ANY transcript/metadata write", async () => {
		const graph = await seedCompletion()
		const write = vi.spyOn(safeJson, "safeWriteJson")
		for (const request of [
			{ ...graph.request, creating: { ...graph.receipt, actionId: "wrong" } },
			{ ...graph.request, childToken: { ...graph.request.childToken, generation: 100 } },
			{ ...graph.request, finish: { ...graph.request.finish, result: "wrong" } },
		])
			expect(await a.completeDelegatedTask(request)).toMatchObject({ kind: "refused" })
		expect(write).not.toHaveBeenCalled()
	})
	it.each(["wrong_tool", "duplicate_call", "missing_call", "existing_result"])(
		"rejects %s transcript before writes",
		async (variant) => {
			const graph = await seedCompletion()
			const use = {
				type: "tool_use" as const,
				id: graph.receipt.actionId,
				name: variant === "wrong_tool" ? "read_file" : "new_task",
				input: {},
			}
			await saveApiMessages({
				taskId: "parent",
				globalStoragePath: directory,
				messages: [
					{
						role: "assistant",
						ts: 2,
						content: variant === "missing_call" ? [] : variant === "duplicate_call" ? [use, use] : [use],
					},
					...(variant === "existing_result"
						? [
								{
									role: "user" as const,
									ts: 3,
									content: [
										{
											type: "tool_result" as const,
											tool_use_id: graph.receipt.actionId,
											content: "failed",
											is_error: true,
										},
									],
								},
							]
						: []),
				],
			})
			const write = vi.spyOn(safeJson, "safeWriteJson")
			expect(await a.completeDelegatedTask(graph.request)).toMatchObject({ kind: "refused" })
			expect(write).not.toHaveBeenCalled()
		},
	)
	it("valid completion is durable before return, duplicate is side-effect free, parent needs exact transfer", async () => {
		const graph = await seedCompletion()
		expect(await a.completeDelegatedTask(graph.request)).toMatchObject({ kind: "completed" })
		expect((await readApiMessages({ taskId: "parent", globalStoragePath: directory }))[1].content).toEqual([
			{ type: "tool_result", tool_use_id: graph.receipt.actionId, content: "Finished" },
		])
		expect(await readTaskMessages({ taskId: "parent", globalStoragePath: directory })).toHaveLength(2)
		const write = vi.spyOn(safeJson, "safeWriteJson")
		expect(await a.completeDelegatedTask(graph.request)).toMatchObject({ kind: "duplicate" })
		expect(write).not.toHaveBeenCalled()
		const parent = await a.readAuthoritative("parent")
		expect(await a.guardExecution(executionToken(parent))).toMatchObject({ kind: "refused", reason: "not_active" })
		const resumed = applied(
			await a.transferTaskExecution(executionToken(parent), a.ownerForRuntime("returned"), true),
		)
		expect(await a.guardExecution(resumed.token)).toMatchObject({ kind: "allowed" })
		const completedChild = await a.readAuthoritative("child")
		expect(executionClaim(completedChild).cleanupPending).toBe(true)
		await expect(a.delete("child")).rejects.toThrow("cleanup_pending")
		expect(await a.settleTaskExecution(executionToken(completedChild), true)).toMatchObject({ kind: "applied" })
		expect(await a.completeDelegatedTask(graph.request)).toMatchObject({ kind: "duplicate" })
	})
	it.each(["api", "ui", "child", "parent"])(
		"withholds execution and repairs %s-write partial durability idempotently",
		async (stage) => {
			const graph = await seedCompletion()
			const original = safeJson.safeWriteJson
			let triggered = false
			vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (file, data, options) => {
				const target =
					stage === "api"
						? file.endsWith(GlobalFileNames.apiConversationHistory)
						: stage === "ui"
							? file.endsWith(GlobalFileNames.uiMessages)
							: stage === "child"
								? file.includes(`${path.sep}child${path.sep}`)
								: file.includes(`${path.sep}parent${path.sep}`) &&
									completionState(data as HistoryItem).receipts.some((r) => r.phase === "committed")
				if (!triggered && target) {
					triggered = true
					throw new Error(`fault-${stage}`)
				}
				await original(file, data, options)
			})
			await expect(a.completeDelegatedTask(graph.request)).rejects.toThrow()
			vi.restoreAllMocks()
			expect(triggered).toBe(true)
			expect(await a.guardExecution(graph.request.childToken)).toMatchObject({ kind: "refused" })
			expect(await a.completeDelegatedTask(graph.request)).toMatchObject({
				kind: "refused",
				reason: "completion_pending",
			})
			expect(await b.repairDelegatedCompletion("parent", graph.request.operationId)).toMatchObject({
				kind: "refused",
				reason: "owner_live",
			})
			expect(await a.repairDelegatedCompletion("parent", graph.request.operationId)).toMatchObject({
				kind: "completed",
			})
			expect(await a.repairDelegatedCompletion("parent", graph.request.operationId)).toMatchObject({
				kind: "duplicate",
			})
			expect(await readApiMessages({ taskId: "parent", globalStoragePath: directory })).toHaveLength(2)
			expect(await readTaskMessages({ taskId: "parent", globalStoragePath: directory })).toHaveLength(2)
		},
	)
	it("cancellation racing completion has one linearized outcome and cannot overwrite a newer handoff", async () => {
		const graph = await seedCompletion()
		const cancelled = await a.interruptTask(graph.request.childToken)
		expect(cancelled.kind).toBe("applied")
		const writes = vi.spyOn(safeJson, "safeWriteJson")
		expect(await a.completeDelegatedTask(graph.request)).toMatchObject({ kind: "refused" })
		expect(writes).not.toHaveBeenCalled()
	})
	it("holds the storage lock across first transcript write so competing cancellation cannot commit a stale update", async () => {
		const graph = await seedCompletion()
		const peer = store("provider")
		let release!: () => void
		let entered!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const ready = new Promise<void>((resolve) => {
			entered = resolve
		})
		const original = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (file, data, options) => {
			if (file.endsWith(GlobalFileNames.apiConversationHistory)) {
				entered()
				await barrier
			}
			await original(file, data, options)
		})
		const completing = a.completeDelegatedTask(graph.request)
		await ready
		const cancelling = peer.interruptTask(graph.request.childToken)
		try {
			expect((await a.readAuthoritative("child")).status).toBe("active")
			expect(completionState(await a.readAuthoritative("parent")).receipts[0].phase).toBe("prepared")
		} finally {
			release()
		}
		expect(await completing).toMatchObject({ kind: "completed" })
		expect(await cancelling).toMatchObject({ kind: "refused", reason: "stale_generation" })
	})
	it("dead-owner completion prefix repairs without activating any runtime", async () => {
		const graph = await seedCompletion()
		const original = safeJson.safeWriteJson
		vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (file, data, options) => {
			if (file.endsWith(GlobalFileNames.uiMessages)) throw new Error("power loss")
			await original(file, data, options)
		})
		await expect(a.completeDelegatedTask(graph.request)).rejects.toThrow()
		vi.restoreAllMocks()
		const dead = store(
			"dead",
			host("other", async () => "ESRCH"),
		)
		await dead.initialize()
		expect(completionState(await dead.readAuthoritative("parent")).receipts[0].phase).toBe("prepared")
		expect(await dead.repairDelegatedCompletion("parent", graph.request.operationId)).toMatchObject({
			kind: "completed",
		})
		expect((await dead.previewRecovery("parent")).choices).toEqual([])
		await dead.repairConfirmedDeadOwners()
		expect((await dead.previewRecovery("parent")).choices).toEqual(["resume_independent"])
	})
	it.each(["child", "parent"])(
		"classifies an after-rename %s commit exception by authoritative read-back",
		async (taskId) => {
			const graph = await seedCompletion()
			const original = safeJson.safeWriteJson
			let injected = false
			vi.spyOn(safeJson, "safeWriteJson").mockImplementation(async (file, data, options) => {
				await original(file, data, options)
				if (
					!injected &&
					file.endsWith(GlobalFileNames.historyItem) &&
					file.includes(`${path.sep}${taskId}${path.sep}`) &&
					(taskId === "child" ||
						completionState(data as HistoryItem).receipts.some((receipt) => receipt.phase === "committed"))
				) {
					injected = true
					throw new Error("after rename")
				}
			})
			expect(await a.completeDelegatedTask(graph.request)).toMatchObject({ kind: "completed" })
			expect(injected).toBe(true)
			expect(await a.completeDelegatedTask(graph.request)).toMatchObject({ kind: "duplicate" })
		},
	)
	it("nested dead-owner recovery completes C into B then B into A without losing lineage", async () => {
		const ab = delegation(active("a"), "b")
		const bc = delegation(ab.child, "c", ab.parent)
		for (const history of [ab.parent, bc.parent, bc.child]) await seed(history)
		const dead = store(
			"dead",
			host("other", async () => "ESRCH"),
		)
		await dead.initialize()
		const preview = await dead.previewRecovery("c")
		const c = applied(
			await dead.recoverTask({
				scope: preview.scope,
				choice: "resume_linked",
				intent: "explicit_user_resume",
				owner: dead.ownerForRuntime("c-new"),
			}),
		)
		// Reconstruct suspended ancestors after positively confirmed death, preserving their graph roles.
		const oldB = await dead.readAuthoritative("b")
		const bClaim = applied(
			await dead.transferTaskExecution(executionToken(oldB), dead.ownerForRuntime("b-new"), true),
		)
		const oldA = await dead.readAuthoritative("a")
		const aClaim = applied(
			await dead.transferTaskExecution(executionToken(oldA), dead.ownerForRuntime("a-new"), true),
		)
		for (const [p, receipt] of [
			[bClaim.history, bc.receipt],
			[aClaim.history, ab.receipt],
		] as const) {
			await saveApiMessages({
				taskId: p.id,
				globalStoragePath: directory,
				messages: [
					{
						role: "assistant",
						ts: 2,
						content: [{ type: "tool_use", id: receipt.actionId, name: "new_task", input: {} }],
					},
				],
			})
			await saveTaskMessages({
				taskId: p.id,
				globalStoragePath: directory,
				messages: [{ ts: 1, type: "say", say: "text", text: p.id }],
			})
		}
		const cFinish = completion(bClaim.history, c.history, bc.receipt)
		const pendingC = await dead.lifecycleCommand(
			"c",
			(current) => ({ ...current, pendingAction: cFinish.request.finish }),
			[],
			true,
			c.token,
		)
		cFinish.request.childRevision = pendingC.lifecycleRevision!
		expect(await dead.completeDelegatedTask(cFinish.request)).toMatchObject({ kind: "completed" })
		const returnedB = await dead.readAuthoritative("b")
		const runningB = applied(
			await dead.transferTaskExecution(executionToken(returnedB), dead.ownerForRuntime("b-return"), true),
		)
		expect(await dead.guardExecution(runningB.token)).toMatchObject({ kind: "allowed" })
		const bFinish = completion(aClaim.history, runningB.history, ab.receipt)
		const pendingB = await dead.lifecycleCommand(
			"b",
			(current) => ({ ...current, pendingAction: bFinish.request.finish }),
			[],
			true,
			runningB.token,
		)
		bFinish.request.childRevision = pendingB.lifecycleRevision!
		expect(await dead.completeDelegatedTask(bFinish.request)).toMatchObject({ kind: "completed" })
		expect(await dead.readAuthoritative("a")).toMatchObject({ status: "active", completedByChildId: "b" })
	})
	it("legacy repair journal is quarantined at every prefix, never reinterpreted", async () => {
		const graph = await seedCompletion()
		const file = path.join(directory, "tasks", GlobalFileNames.delegationRepairIntent)
		await safeJson.safeWriteJson(file, {
			version: 1,
			parentTaskId: "parent",
			childTaskId: "child",
			target: { childStatus: "interrupted", parentStatus: "active" },
		})
		await b.initialize()
		expect(await b.readAuthoritative("parent")).toEqual(graph.parent)
		expect(await b.readAuthoritative("child")).toEqual(graph.child)
		expect((await fs.readdir(path.dirname(file))).some((name) => name.includes("quarantine-"))).toBe(true)
	})
})
