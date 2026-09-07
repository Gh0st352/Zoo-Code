import assert from "node:assert/strict"
import type {
	DelegatedCompletionRequest,
	DelegationAction,
	ExecutionOwner,
	HistoryItem,
	TaskRecoveryRequest,
} from "../packages/types/src/history"
import {
	abandonExecutionDelegation,
	assertDelegationAdmission,
	assertExecutionAllowed,
	assertExecutionToken,
	assertNoCompletionPrefix,
	assertValidTransition,
	claimNewExecution,
	commitDelegation,
	commitDelegatedCompletion,
	completionState,
	delegationBlocked,
	delegationState,
	executionClaim,
	executionToken,
	failDelegation,
	hasExactDelegation,
	interruptExecution,
	LifecycleTransitionError,
	prepareDelegatedCompletion,
	previewTaskRecovery,
	reconcileDelegationResult,
	recoverTaskExecution,
	repairDeadExecution,
	reserveDelegation,
	settleExecution,
	transferExecution,
	validateCompletionPrefix,
	validateDelegatedCompletion,
} from "../src/core/task-persistence/taskLifecycle"
import {
	createExecutionHost,
	probeExecutionOwner,
	type ExecutionHost,
} from "../src/core/task-persistence/executionHost"
import { mergeHistoryDelta, mergeTaskMessageMetadata } from "../src/core/task-persistence/taskStoreConcurrency"

// Independent bounded products, not a Cartesian composition with the graph/cleanup/parser models.
const MAX_DEPTH = 24
const MAX_STATES = 50_000
const MAX_GENERATION = 8
const MAX_REVISION = 16
const ownerA: ExecutionOwner = {
	hostSessionId: "host-a",
	providerId: "provider-a",
	runtimeId: "runtime-a",
	processId: 101,
	machineId: "proven-machine",
	machineProof: "local",
}
const ownerB: ExecutionOwner = {
	...ownerA,
	hostSessionId: "host-b",
	providerId: "provider-b",
	runtimeId: "runtime-b",
	processId: 202,
}

export function ownedTask(id: string, parentTaskId?: string): HistoryItem {
	return claimNewExecution(
		{
			id,
			number: 1,
			ts: 1,
			task: id,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "active",
			childIds: [],
			parentTaskId,
			rootTaskId: parentTaskId,
		},
		{ ...ownerA, runtimeId: id },
	)
}

/** Production reserve -> exclusive child claim -> parent commit endpoints. No filesystem claim. */
export function delegate(parent: HistoryItem, childId: string, upstream?: HistoryItem, awaited?: HistoryItem) {
	const intent = {
		kind: "create_subtask" as const,
		actionId: `create-${childId}`,
		approvalText: "{}",
		mode: "code",
		message: childId,
		todos: [],
	}
	const pending = { ...parent, pendingAction: intent, lifecycleRevision: parent.lifecycleRevision! + 1 }
	const token = executionToken(pending)
	const receipt: DelegationAction = {
		actionId: intent.actionId,
		intent,
		operationId: `delegate-${childId}`,
		childId,
		ownerToken: token.owner.runtimeId,
		executionToken: token,
		generation: token.generation,
		revision: pending.lifecycleRevision,
		phase: "prepared",
		attempts: 1,
		resultTs: 1,
	}
	const reserved = reserveDelegation(pending, receipt, upstream, awaited)
	const child = claimNewExecution(
		{
			id: childId,
			number: 2,
			ts: 2,
			task: childId,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "active",
			parentTaskId: parent.id,
			rootTaskId: parent.rootTaskId ?? parent.id,
			childIds: [],
			delegationOrigin: { parentId: parent.id, operationId: receipt.operationId },
		},
		{ ...token.owner, runtimeId: childId },
	)
	return { parent: commitDelegation(reserved, receipt, upstream, awaited), child }
}

export function finishChild(child: HistoryItem): HistoryItem {
	assert(child.parentTaskId)
	return {
		...child,
		lifecycleRevision: child.lifecycleRevision! + 1,
		pendingAction: {
			kind: "finish_subtask",
			actionId: `finish-${child.id}`,
			approvalText: "{}",
			parentTaskId: child.parentTaskId,
			result: `${child.id} result`,
		},
	}
}

export function completionRequest(parent: HistoryItem, child: HistoryItem): DelegatedCompletionRequest {
	const finish = child.pendingAction
	assert(finish?.kind === "finish_subtask")
	const creating = delegationState(parent).actions.find(
		(entry) => entry.operationId === child.delegationOrigin?.operationId,
	)
	assert(creating)
	return structuredClone({
		operationId: `completion-${child.id}`,
		parentToken: executionToken(parent),
		childToken: executionToken(child),
		parentRevision: parent.lifecycleRevision!,
		childRevision: child.lifecycleRevision!,
		creating,
		finish,
		resultTs: 3,
	})
}

function refused(action: () => unknown): boolean {
	try {
		action()
		return false
	} catch (error) {
		if (!(error instanceof LifecycleTransitionError)) throw error
		return true
	}
}

function host(owner: ExecutionOwner, proof: "local" | "unknown", absent: boolean): ExecutionHost {
	return {
		identity: {
			hostSessionId: owner.hostSessionId,
			processId: owner.processId,
			machineId: owner.machineId,
			machineProof: proof,
		},
		probeProcess: async () => (absent ? "ESRCH" : "unknown"),
	}
}

interface Step<S> {
	action: string
	state: S
}
interface Domain<S> {
	name: string
	initial: S
	next(state: S): Promise<Step<S>[]>
	check(state: S, before?: S, action?: string): void
	landmarks: Record<string, (state: S) => boolean>
}

/** Every edge, including refusal/self edges, is checked. No silent frontier truncation. */
async function explore<S>(domain: Domain<S>) {
	const key = (state: S) => JSON.stringify(state)
	const queue = [{ state: domain.initial, trace: [] as Step<S>[] }]
	const visited = new Set([key(domain.initial)])
	const actions = new Set<string>(),
		landmarks = new Set<string>()
	let edges = 0,
		depth = 0
	for (let index = 0; index < queue.length; index++) {
		const { state, trace } = queue[index]!
		let attempted: Step<S> | undefined
		try {
			domain.check(state)
			for (const [name, predicate] of Object.entries(domain.landmarks)) if (predicate(state)) landmarks.add(name)
			for (const step of await domain.next(state)) {
				attempted = step
				edges++
				actions.add(step.action)
				domain.check(step.state, state, step.action)
				if (visited.has(key(step.state))) continue
				assert(trace.length < MAX_DEPTH, `Unseen successor at depth budget: ${step.action}`)
				visited.add(key(step.state))
				assert(visited.size <= MAX_STATES, "State budget exhausted")
				depth = Math.max(depth, trace.length + 1)
				queue.push({ state: step.state, trace: [...trace, step] })
			}
		} catch (error) {
			throw new Error(
				`${domain.name}: ${String(error)}\nBounds: depth=${MAX_DEPTH}, states=${MAX_STATES}\n` +
					JSON.stringify(
						[{ action: "initial", state: domain.initial }, ...trace, ...(attempted ? [attempted] : [])],
						null,
						2,
					),
				{ cause: error },
			)
		}
	}
	console.log(`  ${domain.name}: ${visited.size} states, ${edges} edges, reached depth ${depth}`)
	return { states: visited.size, edges, actions, landmarks, depth }
}

type RecoveryState = {
	item: HistoryItem
	parent?: HistoryItem
	child?: HistoryItem
	request?: TaskRecoveryRequest
	scopeCurrent: boolean
	interrupts: number
	settlements: number
	transfers: number
	recoveries: number
	repairs: number
	dead: boolean
	recoveredChoice?: string
}
const recoveryInvariantNames = [
	"well-formed bounded claim/revision",
	"no implicit interrupted activation",
	"no blocked scheduler admission",
	"stale callback fencing",
	"observer initialization is nonmutating",
	"failed receipt/result identity immutable",
	"original failed action unusable after recovery",
	"metadata cannot replace authority/lineage",
	"exact linked ownership or explicit independent provenance",
	"scope refusal and duplicate recovery are effect-free",
	"cleanup before settlement/transfer",
	"generation/revision monotonicity",
] as const

function recoverySeeds(): Array<{ name: string; initial: RecoveryState }> {
	const linked = delegate(ownedTask("parent"), "task")
	const detached = delegate(ownedTask("parent"), "task")
	const settledChild = settleExecution(detached.child, executionToken(detached.child), true)
	const abandoned = abandonExecutionDelegation(
		detached.parent,
		settledChild,
		executionToken(detached.parent),
		executionToken(settledChild),
	)
	const nested = delegate(ownedTask("task"), "descendant")
	const pending = {
		...ownedTask("task"),
		pendingAction: {
			kind: "create_subtask" as const,
			actionId: "failed-call",
			approvalText: "{}",
			mode: "code",
			message: "failed-child",
			todos: [],
		},
	}
	const receipt: DelegationAction = {
		actionId: "failed-call",
		operationId: "failed-op",
		childId: "failed-child",
		intent: pending.pendingAction,
		ownerToken: "task",
		executionToken: executionToken(pending),
		generation: 1,
		revision: 1,
		phase: "prepared",
		attempts: 1,
		resultTs: 1,
	}
	const failed = failDelegation(reserveDelegation(pending, receipt), receipt, "failed", "refused")
	return [
		{ name: "independent", item: ownedTask("task") },
		{ name: "linked", item: linked.child, parent: linked.parent },
		{ name: "detached", item: abandoned.child, parent: abandoned.parent },
		// Actual parent-first abandonment prefix: old settled child lineage remains on disk.
		{ name: "abandon-prefix", item: settledChild, parent: abandoned.parent },
		{ name: "failed-result", item: failed },
		{
			name: "retain-delegation",
			item: nested.parent,
			child: settleExecution(nested.child, executionToken(nested.child), true),
		},
	].map(({ name, ...graph }) => ({
		name,
		initial: {
			...graph,
			scopeCurrent: true,
			interrupts: 0,
			settlements: 0,
			transfers: 0,
			recoveries: 0,
			repairs: 0,
			dead: false,
		},
	}))
}

function recoveryDomain(name: string, initial: RecoveryState): Domain<RecoveryState> {
	const oldToken = executionToken(initial.item)
	const failedReceipt = delegationState(initial.item).actions.find((entry) => entry.phase === "failed")
	return {
		name: `ownership/recovery:${name}`,
		initial,
		landmarks: {
			"explicit-linked-resume": (s) => s.recoveredChoice === "resume_linked",
			"explicit-independent-resume": (s) => s.recoveredChoice === "resume_independent",
			"retain-interrupted-descendant": (s) => s.recoveredChoice === "retain_delegation",
			"settled-owner-transfer": (s) => s.transfers > 0,
			"known-dead-repair": (s) => s.repairs > 0,
			"failed-result-repaired-before-resume": (s) => !!failedReceipt && s.recoveries === 1,
			"cancelled-recovery-approval": (s) => !!s.request && !s.scopeCurrent && s.recoveries === 0,
			"detached-provenance-retained": (s) => s.recoveries === 1 && !!s.item.lineageProvenance?.parentTaskId,
		},
		async next(s) {
			const steps: Step<RecoveryState>[] = []
			const add = (action: string, patch: Partial<RecoveryState> = {}) =>
				steps.push({ action, state: { ...s, ...patch } })
			const attempt = (action: string, reduce: () => HistoryItem, patch: Partial<RecoveryState>) => {
				try {
					add(action, { ...patch, item: reduce() })
				} catch (error) {
					if (!(error instanceof LifecycleTransitionError)) throw error
					add(`${action}-refused`)
				}
			}
			const claim = executionClaim(s.item),
				token = executionToken(s.item)
			// Observe the same production liveness probe used by initialize/repairConfirmedDeadOwners.
			for (const [label, observer] of [
				["live", host(claim.owner, "local", true)],
				["unknown", host({ ...ownerB, hostSessionId: "observer", processId: 303 }, "unknown", true)],
			] as const) {
				assert.notEqual(await probeExecutionOwner(claim, observer), "dead")
				add(`observer-${label}-refused`)
			}
			if (!s.dead) add("host-death", { dead: true })
			if (
				s.dead &&
				!s.repairs &&
				claim.owner.hostSessionId === ownerA.hostSessionId &&
				claim.phase !== "settled"
			) {
				assert.equal(await probeExecutionOwner(claim, host(ownerB, "local", true)), "dead")
				attempt("repair-known-dead", () => repairDeadExecution(s.item, token), { repairs: 1 })
			}
			if (!s.interrupts && claim.phase !== "settled")
				attempt("interrupt", () => interruptExecution(s.item, token, s.parent), { interrupts: 1 })
			if (s.settlements < 2 && claim.phase !== "settled") {
				assert(refused(() => settleExecution(s.item, token, false)))
				add("cleanup-unconfirmed-refused")
				attempt("settle-cleanup", () => settleExecution(s.item, token, true), {
					settlements: s.settlements + 1,
				})
			}
			if (!s.transfers && claim.phase === "settled") {
				assert(refused(() => transferExecution(s.item, token, ownerB, false)))
				attempt("transfer-settled", () => transferExecution(s.item, token, ownerB, true), { transfers: 1 })
			}
			const failure = delegationState(s.item).actions.find(
				(entry) => entry.phase === "failed" && !entry.resultWritten,
			)
			if (failure) attempt("repair-failed-result", () => reconcileDelegationResult(s.item, failure), {})
			const preview = previewTaskRecovery(s.item, s.parent, s.child)
			if (!s.request && preview.choices.length)
				add("capture-explicit-recovery", {
					request: {
						scope: preview.scope,
						intent: "explicit_user_resume",
						choice: preview.choices[0]!,
						owner: ownerB,
					},
				})
			if (s.request) {
				if (s.scopeCurrent) add("revoke-recovery-scope", { scopeCurrent: false })
				if (!s.scopeCurrent) add("recovery-scope-refused")
				else
					attempt("explicit-recovery", () => recoverTaskExecution(s.item, s.request!, s.parent, s.child), {
						recoveries: s.recoveries + 1,
						recoveredChoice: s.request.choice,
					})
				if (s.recoveries) {
					assert(refused(() => recoverTaskExecution(s.item, s.request!, s.parent, s.child)))
					add("duplicate-recovery-refused")
				}
			}
			const blocked = refused(() => assertExecutionAllowed(s.item, token, s.parent, s.child))
			add(blocked ? "scheduler-refused" : "scheduler-authorized")
			if (
				token.generation !== oldToken.generation ||
				JSON.stringify(token.owner) !== JSON.stringify(oldToken.owner)
			) {
				assert(refused(() => assertExecutionAllowed(s.item, oldToken, s.parent, s.child)))
				assert(refused(() => interruptExecution(s.item, oldToken, s.parent)))
				assert(refused(() => settleExecution(s.item, oldToken, true)))
				assert(refused(() => transferExecution(s.item, oldToken, ownerB, true)))
				add("stale-callback-refused")
			}
			return steps
		},
		check(s, before, action) {
			const claim = executionClaim(s.item)
			assert(claim.generation <= MAX_GENERATION && s.item.lifecycleRevision! <= MAX_REVISION)
			assert(s.recoveries <= 1 && s.transfers <= 1 && s.repairs <= 1 && s.interrupts <= 1 && s.settlements <= 2)
			if (s.item.status === "interrupted") {
				assert(refused(() => assertValidTransition("interrupted", "active")))
				assert(refused(() => assertValidTransition("interrupted", "delegated")))
			}
			if (claim.phase !== "active" || claim.cleanupPending || delegationBlocked(s.item))
				assert(refused(() => assertExecutionAllowed(s.item, executionToken(s.item), s.parent, s.child)))
			if (s.item.parentTaskId && claim.phase === "active" && !delegationBlocked(s.item))
				assert(hasExactDelegation(s.parent, s.item))
			if (s.recoveredChoice === "resume_independent") {
				assert.equal(s.item.parentTaskId, undefined)
				assert.equal(s.item.rootTaskId, undefined)
				if (initial.item.lineageProvenance)
					assert.deepEqual(s.item.lineageProvenance, initial.item.lineageProvenance)
				else if (initial.item.parentTaskId)
					assert.deepEqual(s.item.lineageProvenance, {
						parentTaskId: initial.item.parentTaskId,
						rootTaskId: initial.item.rootTaskId,
					})
			}
			// Test all protected fields by presenting the initial/stale snapshot to production merges.
			const metadata = { ...initial.item, tokensOut: 7 }
			assert.deepEqual(mergeTaskMessageMetadata(s.item, metadata), { ...s.item, tokensOut: 7 })
			assert.deepEqual(mergeHistoryDelta(s.item, metadata, metadata), { ...s.item, tokensOut: 7 })
			if (failedReceipt) {
				const entry = delegationState(s.item).actions.find((r) => r.operationId === failedReceipt.operationId)!
				assert.deepEqual({ ...entry, resultWritten: undefined }, { ...failedReceipt, resultWritten: undefined })
				assert(
					refused(() =>
						assertDelegationAdmission(
							{ ...s.item, pendingAction: failedReceipt.intent },
							failedReceipt.intent,
							s.parent,
							s.child,
						),
					),
				)
				if (s.recoveries) assert.equal(entry.resultWritten, true)
			}
			if (before) {
				assert(s.item.executionGeneration! >= before.item.executionGeneration!)
				assert(s.item.lifecycleRevision! >= before.item.lifecycleRevision!)
				assert.deepEqual(s.parent, before.parent)
				assert.deepEqual(s.child, before.child)
				if (action?.endsWith("refused") || action?.startsWith("observer-") || action?.startsWith("scheduler-"))
					assert.deepEqual(s, before)
				if (before.item.status === "interrupted" && s.item.status === "active") {
					assert.equal(action, "explicit-recovery")
					assert(before.scopeCurrent && before.request?.intent === "explicit_user_resume")
				}
				if (s.item.executionGeneration !== before.item.executionGeneration)
					assert(s.item.lifecycleRevision! > before.item.lifecycleRevision!)
			}
		},
	}
}

type CompletionPhase = "idle" | "validated" | "prepared" | "api" | "ui" | "child" | "done" | "refused"
type CompletionState = {
	parent: HistoryItem
	child: HistoryItem
	request?: DelegatedCompletionRequest
	phase: CompletionPhase
	locked: boolean
	scopeCurrent: boolean
	crashed: boolean
	faultUsed: boolean
	repairedAt?: CompletionPhase
	cancelled: boolean
	transferred: boolean
	replaced: boolean
	api: string[]
	ui: string[]
}
const completionInvariantNames = [
	"authoritative approval and ownership before prepared receipt",
	"prepared before API before UI before child before parent",
	"all incomplete prefixes gate both participants",
	"compatible idempotent repair",
	"refusal/duplicate no new transcript",
	"cancel before prepare refuses; after prepare cannot split commit",
	"no result into wrong parent",
	"completion leaves parent nonexecuting and fences child callbacks",
] as const

function completionDomain(): Domain<CompletionState> {
	const graph = delegate(ownedTask("parent"), "child")
	const initial: CompletionState = {
		...graph,
		child: finishChild(graph.child),
		phase: "idle",
		locked: false,
		scopeCurrent: true,
		crashed: false,
		faultUsed: false,
		cancelled: false,
		transferred: false,
		replaced: false,
		api: [],
		ui: [],
	}
	return {
		name: "completion-prefix/approval",
		initial,
		landmarks: {
			"cancel-before-prepare-refused": (s) => s.cancelled && s.phase === "refused",
			"cancel-after-prepare-commits": (s) => !s.scopeCurrent && s.phase === "done",
			"approval-owner-change-refused": (s) => s.transferred && s.phase === "refused",
			"approval-intent-change-refused": (s) => s.replaced && s.phase === "refused",
			...Object.fromEntries(
				(["prepared", "api", "ui", "child"] as const).map((phase) => [
					`${phase}-prefix-repaired`,
					(s: CompletionState) => s.repairedAt === phase && s.phase === "done",
				]),
			),
			"parent-committed-prefix": (s) => s.phase === "done",
			"scope-revoked-at-write-boundary": (s) => s.phase === "validated" && !s.scopeCurrent,
		},
		async next(s) {
			const steps: Step<CompletionState>[] = []
			const add = (action: string, patch: Partial<CompletionState> = {}) =>
				steps.push({ action, state: { ...s, ...patch } })
			if (s.scopeCurrent) add("revoke-completion-scope", { scopeCurrent: false })
			if (s.phase === "idle" && !s.request)
				add("capture-finish-approval", { request: completionRequest(s.parent, s.child) })
			if (s.phase === "idle" && s.request) {
				if (!s.cancelled)
					add("cancel-before-commit", {
						child: interruptExecution(s.child, executionToken(s.child), s.parent),
						cancelled: true,
					})
				if (!s.transferred)
					add("transfer-during-approval", {
						child: transferExecution(
							s.child,
							executionToken(s.child),
							{ ...ownerA, runtimeId: "replacement" },
							true,
						),
						transferred: true,
					})
				if (!s.replaced)
					add("replace-finish-during-approval", {
						child: {
							...s.child,
							pendingAction: { ...s.request.finish, result: "replacement-result" },
							lifecycleRevision: s.child.lifecycleRevision! + 1,
						},
						replaced: true,
					})
				try {
					assert.equal(validateDelegatedCompletion(s.parent, s.child, s.request), undefined)
					add("validate-completion-under-lock", { phase: "validated", locked: true })
				} catch (error) {
					if (!(error instanceof LifecycleTransitionError)) throw error
					add("completion-authority-refused", { phase: "refused" })
				}
			}
			if (s.phase === "validated") {
				// Scope can change during read-only preflight/path resolution/file-lock acquisition.
				// Store persistLifecycle checks it synchronously at the actual first write boundary.
				if (!s.scopeCurrent) add("completion-scope-refused", { phase: "refused", locked: false })
				else
					add("prepare-completion", {
						parent: prepareDelegatedCompletion(s.parent, s.child, s.request!),
						phase: "prepared",
					})
			}
			const receipt = completionState(s.parent).receipts[0]
			if (receipt?.phase === "prepared") {
				// Queued cancellation cannot mutate between writes; after a crash the prefix still rejects it.
				assert(refused(() => interruptExecution(s.child, executionToken(s.child), s.parent)))
				add("prefix-cancellation-refused")
				if (s.locked && !s.faultUsed) add("crash-prefix", { locked: false, crashed: true, faultUsed: true })
				if (s.crashed) {
					validateCompletionPrefix(s.parent, s.child, receipt)
					for (const proof of ["local", "unknown"] as const) {
						const observer = proof === "local" ? host(ownerA, proof, true) : host(ownerB, proof, true)
						assert.notEqual(await probeExecutionOwner(executionClaim(s.child), observer), "dead")
						add(proof === "local" ? "live-peer-repair-refused" : "unknown-peer-repair-refused")
					}
					// finishCompletionPrefix replays API/UI/child steps even after a child commit.
					// Stable result IDs and receipt-derived targets must make that replay idempotent.
					// This abstracts logical transcript writes; real transcript parsing has separate tests.
					add("repair-compatible-prefix", {
						locked: true,
						crashed: false,
						repairedAt: s.phase,
						phase: "prepared",
					})
				}
				if (s.locked) {
					validateCompletionPrefix(s.parent, s.child, receipt)
					if (s.phase === "prepared") add("write-api-result", { api: [receipt.operationId], phase: "api" })
					if (s.phase === "api") add("write-ui-result", { ui: [receipt.operationId], phase: "ui" })
					if (s.phase === "ui")
						add("commit-child", {
							child: commitDelegatedCompletion(s.parent, s.child, receipt).child,
							phase: "child",
						})
					if (s.phase === "child")
						add("commit-parent", {
							parent: commitDelegatedCompletion(s.parent, s.child, receipt).parent,
							phase: "done",
							locked: false,
						})
				}
			}
			if (s.phase === "done") {
				assert.equal(validateDelegatedCompletion(s.parent, s.child, s.request!)?.phase, "committed")
				add("duplicate-completion")
			}
			return steps
		},
		check(s, before, action) {
			const receipt = completionState(s.parent).receipts[0]
			assert(s.api.length <= 1 && s.ui.length <= s.api.length)
			if (s.phase === "idle" || s.phase === "validated" || s.phase === "refused") {
				assert.deepEqual(s.api, [])
				assert.deepEqual(s.ui, [])
				assert.equal(receipt, undefined)
				assert.deepEqual(s.parent, initial.parent)
			}
			if (receipt) {
				assert.equal(receipt.parentToken.taskId, s.parent.id)
				assert.equal(receipt.creating.childId, s.child.id)
				assert.deepEqual(receipt.finish, initial.child.pendingAction)
				if (s.api.length) assert.deepEqual(s.api, [receipt.operationId])
				if (s.ui.length) assert.deepEqual(s.ui, [receipt.operationId])
			}
			if (receipt?.phase === "prepared") {
				validateCompletionPrefix(s.parent, s.child, receipt)
				for (const [item, parent] of [
					[s.parent, undefined],
					[s.child, s.parent],
				] as const) {
					assert(refused(() => assertExecutionAllowed(item, executionToken(item), parent)))
					assert(refused(() => assertNoCompletionPrefix(item, parent)))
					assert.deepEqual(previewTaskRecovery(item, parent).choices, [])
				}
			}
			if (s.child.status === "completed") {
				assert.equal(s.api.length, 1)
				assert.equal(s.ui.length, 1)
			}
			if (s.phase === "done") {
				assert.equal(s.child.status, "completed")
				assert.equal(s.parent.awaitingChildId, undefined)
				assert.equal(s.parent.completedByChildId, s.child.id)
				assert.equal(receipt?.phase, "committed")
				assert.notEqual(executionClaim(s.parent).phase, "active")
				assert(refused(() => assertExecutionToken(s.child, s.request!.childToken)))
			}
			if (before) {
				if ((action?.endsWith("refused") && s.phase === before.phase) || action === "duplicate-completion")
					assert.deepEqual(s, before)
				if (action === "prepare-completion") assert(before.scopeCurrent && before.request)
				if (["write-api-result", "write-ui-result", "commit-child", "commit-parent"].includes(action!))
					assert(before.locked)
				if (s.api.length > before.api.length) assert.equal(before.phase, "prepared")
				if (s.ui.length > before.ui.length) assert.equal(before.phase, "api")
				if (before.api.length) assert.deepEqual(s.api, before.api)
				if (before.ui.length) assert.deepEqual(s.ui, before.ui)
				if (before.child.status === "completed") assert.deepEqual(s.child, before.child)
			}
		},
	}
}

/** Large nested/host boundaries remain deterministic reducer scenarios, not invented liveness. */
async function representativeScenarios(): Promise<string[]> {
	const landmarks: string[] = []
	const ab = delegate(ownedTask("A"), "B")
	const bc = delegate(ab.child, "C", ab.parent)
	let a = ab.parent,
		b = bc.parent,
		c = bc.child
	const observer = host(ownerB, "local", true)
	for (const current of [a, b, c]) assert.equal(await probeExecutionOwner(executionClaim(current), observer), "dead")
	a = repairDeadExecution(a, executionToken(a))
	b = repairDeadExecution(b, executionToken(b))
	c = repairDeadExecution(c, executionToken(c))
	assert.equal(a.status, "delegated")
	assert.equal(b.status, "delegated")
	assert.equal(c.status, "interrupted")
	assert(hasExactDelegation(a, b) && hasExactDelegation(b, c))
	assert.deepEqual(previewTaskRecovery(b, a, c).choices, ["retain_delegation"])
	const resume = (item: HistoryItem, parent?: HistoryItem) =>
		recoverTaskExecution(
			item,
			{
				scope: previewTaskRecovery(item, parent).scope,
				intent: "explicit_user_resume",
				choice: "resume_linked",
				owner: ownerB,
			},
			parent,
		)
	c = finishChild(resume(c, b))
	let request = completionRequest(b, c)
	b = prepareDelegatedCompletion(b, c, request, a)
	let receipt = completionState(b).receipts[0]!
	assert(refused(() => repairDeadExecution(b, executionToken(b))))
	// Observer dead-owner prefix repair: proof for both claims precedes reduction, never launch.
	for (const current of [b, c])
		assert(
			["dead", "settled"].includes(
				await probeExecutionOwner(
					executionClaim(current),
					host({ ...ownerA, hostSessionId: "third-host", processId: 303 }, "local", true),
				),
			),
		)
	;({ parent: b, child: c } = commitDelegatedCompletion(b, c, receipt, a))
	assert.equal(b.status, "active")
	assert.equal(executionClaim(b).phase, "settled")
	assert(refused(() => assertExecutionAllowed(b, executionToken(b), a)))
	b = finishChild(transferExecution(b, executionToken(b), ownerB, true))
	request = completionRequest(a, b)
	a = prepareDelegatedCompletion(a, b, request)
	receipt = completionState(a).receipts[0]!
	;({ parent: a, child: b } = commitDelegatedCompletion(a, b, receipt))
	assert.equal(a.completedByChildId, "B")
	assert.equal(b.completedByChildId, "C")
	assert.equal(b.status, "completed")
	assert.equal(c.status, "completed")
	landmarks.push("known-dead-nested-chain-retained-and-unwound", "dead-owner-prefix-repair-without-launch")

	// Explicit linked resume followed by a NEW nested delegation preserves both ancestors.
	const linked = delegate(ownedTask("root"), "middle")
	const interrupted = settleExecution(linked.child, executionToken(linked.child), true)
	const middle = resume(interrupted, linked.parent)
	const nested = delegate(middle, "leaf", linked.parent)
	assert(hasExactDelegation(linked.parent, nested.parent) && hasExactDelegation(nested.parent, nested.child))
	landmarks.push("authorized-interrupted-middle-delegates-new-leaf")

	// Legacy/unknown records are inspection-only, not compatible active-parent normalization.
	const legacy = {
		...ownedTask("legacy"),
		execution: undefined,
		executionGeneration: undefined,
		lifecycleRevision: undefined,
	}
	for (const item of [legacy, { ...legacy, execution: { version: 99 } }]) {
		assert.deepEqual(previewTaskRecovery(item).choices, [])
		assert(refused(() => assertExecutionAllowed(item, executionToken(ownedTask("legacy")))))
	}
	assert.equal(createExecutionHost().identity.machineProof, "unknown")
	const compatible = { ...linked.parent, status: "active" as const }
	assert.deepEqual(previewTaskRecovery(interrupted, compatible).choices, [])
	assert(refused(() => claimNewExecution(linked.child, ownerB)))
	landmarks.push("legacy-unknown-and-active-parent-inspection-only", "default-machine-proof-unknown")

	// Strict completion identity/lineage/revision guards: every refusal preserves both input records.
	const pair = delegate(ownedTask("parent"), "child")
	const child = finishChild(pair.child),
		expected = completionRequest(pair.parent, child)
	const mutations: DelegatedCompletionRequest[] = [
		{ ...expected, parentRevision: expected.parentRevision + 1 },
		{ ...expected, childRevision: expected.childRevision + 1 },
		{ ...expected, parentToken: { ...expected.parentToken, generation: 99 } },
		{ ...expected, childToken: { ...expected.childToken, owner: ownerB } },
		{ ...expected, creating: { ...expected.creating, operationId: "unrelated" } },
		{ ...expected, finish: { ...expected.finish, result: "changed" } },
	]
	const before = structuredClone(pair.parent)
	for (const request of mutations) assert(refused(() => prepareDelegatedCompletion(pair.parent, child, request)))
	assert.deepEqual(pair.parent, before)
	const prepared = prepareDelegatedCompletion(pair.parent, child, expected)
	const prefix = completionState(prepared).receipts[0]!
	assert(refused(() => validateCompletionPrefix({ ...prepared, awaitingChildId: "other" }, child, prefix)))
	assert(refused(() => validateCompletionPrefix(prepared, { ...child, lifecycleRevision: 99 }, prefix)))
	landmarks.push("strict-completion-authority-and-conflicting-prefix-refusal")

	const stopped = settleExecution(pair.child, executionToken(pair.child), true)
	const preview = previewTaskRecovery(stopped, pair.parent)
	const recovery: TaskRecoveryRequest = {
		scope: preview.scope,
		intent: "explicit_user_resume",
		choice: "resume_linked",
		owner: ownerB,
	}
	for (const parent of [
		{ ...pair.parent, lifecycleRevision: pair.parent.lifecycleRevision! + 1 },
		{ ...pair.parent, awaitingChildId: "other-child" },
		{ ...pair.parent, execution: { ...executionClaim(pair.parent), owner: ownerB } },
	])
		assert(refused(() => recoverTaskExecution(stopped, recovery, parent)))
	assert(
		refused(() =>
			recoverTaskExecution(
				stopped,
				{ ...recovery, scope: { ...recovery.scope, taskId: "unrelated" } },
				pair.parent,
			),
		),
	)
	assert(
		refused(() =>
			recoverTaskExecution(
				stopped,
				{ ...recovery, scope: { ...recovery.scope, action: expected.finish } },
				pair.parent,
			),
		),
	)
	landmarks.push("recovery-full-parent-task-action-scope-refusal")
	return landmarks
}

export async function checkExecutionProtocol(): Promise<void> {
	const results = []
	for (const seed of recoverySeeds()) results.push(await explore(recoveryDomain(seed.name, seed.initial)))
	results.push(await explore(completionDomain()))
	const actions = new Set(results.flatMap((result) => [...result.actions]))
	const landmarks = new Set(results.flatMap((result) => [...result.landmarks]))
	for (const name of [
		"observer-live-refused",
		"observer-unknown-refused",
		"host-death",
		"repair-known-dead",
		"interrupt",
		"cleanup-unconfirmed-refused",
		"settle-cleanup",
		"transfer-settled",
		"repair-failed-result",
		"capture-explicit-recovery",
		"revoke-recovery-scope",
		"recovery-scope-refused",
		"explicit-recovery",
		"explicit-recovery-refused",
		"duplicate-recovery-refused",
		"scheduler-refused",
		"scheduler-authorized",
		"stale-callback-refused",
		"capture-finish-approval",
		"cancel-before-commit",
		"transfer-during-approval",
		"replace-finish-during-approval",
		"completion-scope-refused",
		"completion-authority-refused",
		"prepare-completion",
		"validate-completion-under-lock",
		"prefix-cancellation-refused",
		"crash-prefix",
		"live-peer-repair-refused",
		"unknown-peer-repair-refused",
		"repair-compatible-prefix",
		"write-api-result",
		"write-ui-result",
		"commit-child",
		"commit-parent",
		"duplicate-completion",
		"revoke-completion-scope",
	])
		assert(actions.has(name), `Unreachable execution protocol action: ${name}`)
	const requiredLandmarks = new Set([
		...Object.keys(recoveryDomain("coverage", recoverySeeds()[0]!.initial).landmarks),
		...Object.keys(completionDomain().landmarks),
	])
	for (const name of requiredLandmarks) assert(landmarks.has(name), `Unreachable execution landmark: ${name}`)
	const representatives = await representativeScenarios()
	console.log(
		`Execution protocol passed: ${results.reduce((sum, result) => sum + result.states, 0)} states, ` +
			`${results.reduce((sum, result) => sum + result.edges, 0)} edges, ${actions.size} actions, ` +
			`${recoveryInvariantNames.length + completionInvariantNames.length} invariants, ${landmarks.size} explored landmarks, ` +
			`${representatives.length} representative landmarks; depth <= ${MAX_DEPTH} (reached ${Math.max(...results.map((r) => r.depth))}), ` +
			`budget ${MAX_STATES}/seed; generations <= ${MAX_GENERATION}, revisions <= ${MAX_REVISION}`,
	)
	console.log(`  Explored landmarks: ${[...landmarks].sort().join(", ")}`)
	console.log(`  Representative landmarks: ${representatives.join(", ")}`)
}
