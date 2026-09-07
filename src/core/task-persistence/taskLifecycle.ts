import {
	delegationStateSchema,
	executionClaimSchema,
	executionOwnerSchema,
	delegatedCompletionStateSchema,
	type DelegationAction,
	type DelegationState,
	type ExecutionClaim,
	type ExecutionOwner,
	type ExecutionToken,
	type ExecutionRefusalReason,
	type TaskRecoveryScope,
	type TaskRecoveryRequest,
	type TaskRecoveryPreview,
	type DelegatedCompletionRequest,
	type DelegatedCompletionReceipt,
	type HistoryItem,
	type PendingTaskAction,
} from "@roo-code/types"
import deepEqual from "fast-deep-equal"

/** Valid status values for a task's HistoryItem. */
export type HistoryItemStatus = NonNullable<HistoryItem["status"]>

export const VALID_TASK_STATUS_TRANSITIONS: Readonly<Record<HistoryItemStatus, readonly HistoryItemStatus[]>> = {
	active: ["delegated", "completed", "interrupted"],
	delegated: ["active"],
	interrupted: ["completed"],
	completed: [],
}

export class LifecycleTransitionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LifecycleTransitionError"
	}
}

export class StaleDelegationActionError extends LifecycleTransitionError {}

export function assertValidTransition(from: HistoryItemStatus | undefined, to: HistoryItemStatus): void {
	const fromStatus: HistoryItemStatus = from ?? "active"
	if (!VALID_TASK_STATUS_TRANSITIONS[fromStatus].includes(to)) {
		throw new LifecycleTransitionError(`Invalid task status transition: ${fromStatus} → ${to}`)
	}
}

export function delegateTaskToChild(
	parent: HistoryItem,
	childId: string,
	awaitedChildStatus?: HistoryItemStatus,
): HistoryItem {
	let base = parent
	if (parent.status === "delegated") {
		if (awaitedChildStatus !== "interrupted") {
			throw new LifecycleTransitionError(
				`Cannot re-delegate task ${parent.id}: existing child ${parent.awaitingChildId} is ${awaitedChildStatus}, not interrupted`,
			)
		}
		base = {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		}
	}

	assertValidTransition(base.status, "delegated")
	return {
		...base,
		status: "delegated",
		delegatedToId: childId,
		awaitingChildId: childId,
		childIds: Array.from(new Set([...(base.childIds ?? []), childId])),
	}
}

export function interruptDelegatedChild(parent: HistoryItem, child: HistoryItem): HistoryItem {
	if (parent.status !== "delegated" || parent.awaitingChildId !== child.id) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	assertValidTransition(child.status, "interrupted")
	return { ...child, status: "interrupted" }
}

export function completeDelegatedChild(
	parent: HistoryItem,
	child: HistoryItem,
	completionResultSummary: string,
): { parent: HistoryItem; child: HistoryItem } {
	if ((parent.status !== "delegated" && parent.status !== "active") || parent.awaitingChildId !== child.id) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	assertValidTransition(child.status, "completed")
	if (parent.status !== "active") assertValidTransition(parent.status, "active")

	return {
		child: {
			...child,
			status: "completed",
			completionResultSummary,
		},
		parent: {
			...parent,
			status: "active",
			completedByChildId: child.id,
			completionResultSummary,
			awaitingChildId: undefined,
			delegatedToId: undefined,
			childIds: Array.from(new Set([...(parent.childIds ?? []), child.id])),
		},
	}
}

export function abandonDelegatedChild(
	parent: HistoryItem,
	child: HistoryItem,
): { parent: HistoryItem; child: HistoryItem } {
	if (parent.status !== "delegated" || parent.awaitingChildId !== child.id) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	if (child.status !== "interrupted") {
		throw new LifecycleTransitionError(`Cannot abandon child ${child.id} with status ${child.status}`)
	}
	assertValidTransition(parent.status, "active")

	return {
		child: { ...child, parentTaskId: undefined, rootTaskId: undefined },
		parent: {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		},
	}
}

/** Missing metadata is legacy intent, not proof of admission or approval. */
export function delegationState(item: HistoryItem): DelegationState {
	if (item.delegation === undefined) return { version: 1, actions: [] }
	const parsed = delegationStateSchema.safeParse(item.delegation)
	if (!parsed.success) throw new ExecutionAuthorityError("metadata_unknown")
	return parsed.data
}

export function delegationBlocked(item: HistoryItem): boolean {
	try {
		const state = delegationState(item)
		return (
			!!state.blocked ||
			state.actions.some((action) => action.phase === "prepared" || action.phase === "uncertain")
		)
	} catch {
		return true
	}
}

export function assertDelegationAdmission(
	parent: HistoryItem,
	action: PendingTaskAction,
	upstream?: HistoryItem,
	awaited?: HistoryItem,
): void {
	const state = delegationState(parent)
	if (parent.execution !== undefined) {
		const claim = executionClaim(parent)
		assertNoCompletionPrefix(parent, upstream)
		if (claim.phase !== "active" || claim.cleanupPending) refuse("not_active")
		assertUpstreamOwnership(parent, upstream)
		if (parent.awaitingChildId && (!awaited || executionClaim(awaited).phase !== "settled"))
			refuse("cleanup_pending")
	}
	if (state.blocked || state.actions.some((receipt) => receipt.actionId === action.actionId)) {
		throw new LifecycleTransitionError(`Delegation action ${action.actionId} requires explicit recovery`)
	}
	if (action.kind !== "create_subtask" || !deepEqual(parent.pendingAction, action)) {
		throw new LifecycleTransitionError(`Pending action mismatch for parent ${parent.id}`)
	}
	if (state.actions.some((receipt) => receipt.phase === "prepared" || receipt.phase === "uncertain")) {
		throw new LifecycleTransitionError(`Unresolved delegation for ${parent.id}`)
	}
	if (
		parent.parentTaskId &&
		(!upstream ||
			upstream.id !== parent.parentTaskId ||
			upstream.status !== "delegated" ||
			upstream.awaitingChildId !== parent.id)
	) {
		throw new LifecycleTransitionError(`Parent ownership mismatch for ${parent.id}`)
	}
	if (
		parent.awaitingChildId &&
		(parent.status !== "delegated" || awaited?.id !== parent.awaitingChildId || awaited.parentTaskId !== parent.id)
	) {
		throw new LifecycleTransitionError(`Awaited child ownership mismatch for ${parent.id}`)
	}
	// Preview the exact same ordinary transition used at commit. Never activate an interrupted parent.
	delegateTaskToChild(parent, "admission-only", awaited?.status)
}

export function reserveDelegation(
	parent: HistoryItem,
	receipt: DelegationAction,
	upstream?: HistoryItem,
	awaited?: HistoryItem,
): HistoryItem {
	assertDelegationAdmission(parent, receipt.intent, upstream, awaited)
	if (parent.execution !== undefined) {
		if (!receipt.executionToken) refuse("metadata_missing")
		assertExecutionToken(parent, receipt.executionToken)
		if (receipt.ownerToken !== receipt.executionToken.owner.runtimeId) refuse("owner_mismatch")
	}
	if (
		receipt.generation !== (parent.executionGeneration ?? 0) ||
		receipt.revision !== (parent.lifecycleRevision ?? 0)
	)
		throw new LifecycleTransitionError("Stale execution generation or revision")
	return {
		...parent,
		lifecycleRevision: (parent.lifecycleRevision ?? 0) + 1,
		delegation: { ...delegationState(parent), actions: [...delegationState(parent).actions, receipt] },
	}
}

export function commitDelegation(
	parent: HistoryItem,
	receipt: DelegationAction,
	upstream?: HistoryItem,
	awaited?: HistoryItem,
): HistoryItem {
	const state = delegationState(parent)
	const current = state.actions.find((entry) => entry.actionId === receipt.actionId)
	if (
		!deepEqual(current, receipt) ||
		current?.phase !== "prepared" ||
		(parent.lifecycleRevision ?? 0) !== receipt.revision + 1 ||
		(parent.executionGeneration ?? 0) !== receipt.generation
	) {
		throw new LifecycleTransitionError(`Stale delegation operation ${receipt.operationId}`)
	}
	if (parent.execution !== undefined) {
		if (!receipt.executionToken) refuse("metadata_missing")
		assertExecutionToken(parent, receipt.executionToken)
	}
	assertDelegationAdmission(
		{ ...parent, delegation: { ...state, actions: state.actions.filter((entry) => entry !== current) } },
		receipt.intent,
		upstream,
		awaited,
	)
	return {
		...delegateTaskToChild(parent, receipt.childId, awaited?.status),
		...(parent.execution === undefined
			? {}
			: {
					execution: { ...executionClaim(parent), phase: "suspended" as const, cleanupPending: false },
				}),
		pendingAction: undefined,
		lifecycleRevision: (parent.lifecycleRevision ?? 0) + 1,
		delegation: {
			...state,
			actions: state.actions.map((entry) => (entry === current ? { ...entry, phase: "committed" } : entry)),
		},
	}
}

/** A stale callback may neither consume a replacement nor install its recovery gate. */
export function failDelegation(
	parent: HistoryItem,
	receipt: DelegationAction,
	phase: "failed" | "uncertain" | "denied",
	reason: string,
): HistoryItem {
	const state = delegationState(parent)
	const current = state.actions.find((entry) => entry.actionId === receipt.actionId)
	if (
		(parent.executionGeneration ?? 0) !== receipt.generation ||
		!deepEqual(parent.pendingAction, receipt.intent) ||
		(current &&
			(current.operationId !== receipt.operationId ||
				current.ownerToken !== receipt.ownerToken ||
				current.phase !== "prepared"))
	)
		return parent
	const failed = { ...receipt, phase, reason }
	return {
		...parent,
		lifecycleRevision: (parent.lifecycleRevision ?? 0) + 1,
		delegation: {
			version: 1,
			actions: [...state.actions.filter((entry) => entry.actionId !== receipt.actionId), failed],
			blocked: { actionId: receipt.actionId, generation: receipt.generation, reason },
		},
	}
}

export function reconcileDelegationResult(parent: HistoryItem, receipt: DelegationAction): HistoryItem {
	const state = delegationState(parent)
	const current = state.actions.find((entry) => entry.operationId === receipt.operationId)
	if (!current || current.phase === "committed" || current.phase === "prepared" || current.phase === "uncertain")
		return parent
	if (!deepEqual(current, receipt) || current.resultWritten) return parent
	return {
		...parent,
		lifecycleRevision: (parent.lifecycleRevision ?? 0) + 1,
		pendingAction: deepEqual(parent.pendingAction, receipt.intent) ? undefined : parent.pendingAction,
		delegation: {
			...state,
			actions: state.actions.map((entry) => (entry === current ? { ...entry, resultWritten: true } : entry)),
		},
	}
}

/** Stable backend refusal vocabulary; adapters own presentation strings. */
export class ExecutionAuthorityError extends LifecycleTransitionError {
	constructor(public readonly reason: ExecutionRefusalReason) {
		super(reason)
	}
}

function refuse(reason: ExecutionRefusalReason): never {
	throw new ExecutionAuthorityError(reason)
}

function advance(value: number | undefined): number {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) refuse("metadata_unknown")
	if (value === Number.MAX_SAFE_INTEGER) refuse("metadata_unknown")
	return (value ?? 0) + 1
}

export function executionClaim(item: HistoryItem): ExecutionClaim {
	if (item.execution === undefined) refuse("metadata_missing")
	const claim = executionClaimSchema.safeParse(item.execution)
	if (!claim.success || claim.data.generation !== item.executionGeneration || item.lifecycleRevision === undefined)
		refuse("metadata_unknown")
	if (
		(claim.data.phase === "settled") !== !!claim.data.settlement ||
		(claim.data.phase === "settled" && claim.data.cleanupPending)
	)
		refuse("metadata_unknown")
	return claim.data
}

export function executionToken(item: HistoryItem): ExecutionToken {
	const claim = executionClaim(item)
	return { taskId: item.id, generation: claim.generation, owner: claim.owner }
}

export function assertExecutionToken(item: HistoryItem, token: ExecutionToken): ExecutionClaim {
	const claim = executionClaim(item)
	if (token.taskId !== item.id || !deepEqual(claim.owner, token.owner)) refuse("owner_mismatch")
	if (claim.generation !== token.generation) refuse("stale_generation")
	return claim
}

export function completionState(item: HistoryItem) {
	if (item.delegatedCompletion === undefined) return { version: 1 as const, receipts: [] }
	const parsed = delegatedCompletionStateSchema.safeParse(item.delegatedCompletion)
	if (!parsed.success) refuse("metadata_unknown")
	return parsed.data
}

export function assertNoCompletionPrefix(item: HistoryItem, parent?: HistoryItem): void {
	if (
		completionState(item).receipts.some((receipt) => receipt.phase === "prepared") ||
		(parent &&
			completionState(parent).receipts.some(
				(receipt) => receipt.phase === "prepared" && receipt.childToken.taskId === item.id,
			))
	)
		refuse("completion_pending")
}

/** Guard immediately before scheduling/requests/tools; a metadata read alone is not authority. */
export function assertExecutionAllowed(
	item: HistoryItem,
	token: ExecutionToken,
	parent?: HistoryItem,
	child?: HistoryItem,
): void {
	const claim = assertExecutionToken(item, token)
	assertNoCompletionPrefix(item, parent)
	if (claim.cleanupPending) refuse("cleanup_pending")
	if (item.status === "completed") refuse("completed")
	if (claim.phase !== "active") refuse("not_active")
	if (item.status === "delegated") {
		if (
			!child ||
			child.status !== "interrupted" ||
			!hasExactDelegation(item, child) ||
			executionClaim(child).phase !== "settled"
		)
			refuse("descendant_owned")
	} else if (item.status !== "active") refuse("not_active")
	if (delegationBlocked(item)) refuse("recovery_required")
	assertUpstreamOwnership(item, parent)
}

export function assertUpstreamOwnership(item: HistoryItem, parent?: HistoryItem): void {
	if (!item.parentTaskId) return
	if (!parent || !hasExactDelegation(parent, item)) refuse("parent_mismatch")
	if (executionClaim(parent).phase === "active") refuse("owner_live")
}

/** Only for an exclusively reserved NEW task; never use this to adopt a history. */
export function claimNewExecution(item: HistoryItem, owner: ExecutionOwner): HistoryItem {
	if (!executionOwnerSchema.safeParse(owner).success) refuse("metadata_unknown")
	if (
		item.execution !== undefined ||
		item.executionGeneration !== undefined ||
		item.lifecycleRevision !== undefined ||
		item.pendingAction ||
		item.delegation ||
		item.delegatedCompletion ||
		item.awaitingChildId ||
		(item.status !== undefined && item.status !== "active")
	)
		refuse("recovery_required")
	return {
		...item,
		status: "active",
		executionGeneration: 1,
		lifecycleRevision: 1,
		execution: { version: 1, generation: 1, owner, phase: "active", cleanupPending: false },
	}
}

/** Fences callbacks immediately, but retains the owner's claim until cleanup actually settles. */
export function interruptExecution(item: HistoryItem, token: ExecutionToken, parent?: HistoryItem): HistoryItem {
	const claim = assertExecutionToken(item, token)
	assertNoCompletionPrefix(item, parent)
	if (item.status === "completed") refuse("completed")
	if (claim.phase === "settled") refuse("not_active")
	const generation = advance(item.executionGeneration)
	return {
		...item,
		status: item.status === "delegated" ? "delegated" : "interrupted",
		lifecycleRevision: advance(item.lifecycleRevision),
		executionGeneration: generation,
		execution: { ...claim, generation, phase: "suspended", cleanupPending: true, settlement: undefined },
	}
}

export function settleExecution(item: HistoryItem, token: ExecutionToken, cleanupSettled: boolean): HistoryItem {
	const claim = assertExecutionToken(item, token)
	if (!cleanupSettled) refuse("cleanup_pending")
	if (claim.phase === "settled") return item
	// Suspension alone is not revocation. Always fence before releasing a claim.
	const generation = advance(item.executionGeneration)
	return {
		...item,
		status: item.status === "active" ? "interrupted" : item.status,
		executionGeneration: generation,
		lifecycleRevision: advance(item.lifecycleRevision),
		execution: { ...claim, generation, phase: "settled", cleanupPending: false, settlement: "cleanup" },
	}
}

/** Atomic runtime replacement after the caller has awaited the outgoing runtime's final writes. */
export function transferExecution(
	item: HistoryItem,
	outgoing: ExecutionToken,
	owner: ExecutionOwner,
	cleanupSettled: boolean,
): HistoryItem {
	assertExecutionToken(item, outgoing)
	if (!cleanupSettled) refuse("cleanup_pending")
	if (!executionOwnerSchema.safeParse(owner).success) refuse("metadata_unknown")
	assertNoCompletionPrefix(item)
	if (item.status === "completed") refuse("completed")
	const generation = advance(item.executionGeneration)
	return {
		...item,
		executionGeneration: generation,
		lifecycleRevision: advance(item.lifecycleRevision),
		execution: {
			version: 1,
			generation,
			owner,
			cleanupPending: false,
			phase: item.status === "active" && !delegationBlocked(item) ? "active" : "suspended",
		},
	}
}

/** The store must obtain fresh positive owner-death proof under its storage lock. */
export function repairDeadExecution(item: HistoryItem, expected: ExecutionToken): HistoryItem {
	const claim = assertExecutionToken(item, expected)
	assertNoCompletionPrefix(item)
	if (claim.phase === "settled") return item
	const generation = advance(item.executionGeneration)
	return {
		...item,
		status: item.status === "active" ? "interrupted" : item.status,
		executionGeneration: generation,
		lifecycleRevision: advance(item.lifecycleRevision),
		execution: { ...claim, generation, phase: "settled", cleanupPending: false, settlement: "owner_dead" },
	}
}

function creatingReceipt(parent: HistoryItem | undefined, child: HistoryItem): DelegationAction | undefined {
	if (!parent || child.delegationOrigin?.parentId !== parent.id) return undefined
	const receipts = delegationState(parent).actions.filter(
		(receipt) =>
			receipt.operationId === child.delegationOrigin?.operationId &&
			receipt.childId === child.id &&
			receipt.phase === "committed" &&
			receipt.intent.kind === "create_subtask" &&
			receipt.intent.actionId === receipt.actionId,
	)
	return receipts.length === 1 ? receipts[0] : undefined
}

export function hasExactDelegation(parent: HistoryItem | undefined, child: HistoryItem): boolean {
	return (
		!!parent &&
		child.parentTaskId === parent.id &&
		parent.status === "delegated" &&
		parent.awaitingChildId === child.id &&
		parent.delegatedToId === child.id &&
		!!parent.childIds?.includes(child.id) &&
		!!creatingReceipt(parent, child)
	)
}

/** Detaches a cleaned child; the parent becomes resumable, never executing. */
export function abandonExecutionDelegation(
	parent: HistoryItem,
	child: HistoryItem,
	parentToken: ExecutionToken,
	childToken: ExecutionToken,
	upstream?: HistoryItem,
): { parent: HistoryItem; child: HistoryItem } {
	const parentClaim = assertExecutionToken(parent, parentToken)
	const childClaim = assertExecutionToken(child, childToken)
	assertNoCompletionPrefix(parent, upstream)
	assertNoCompletionPrefix(child, parent)
	assertUpstreamOwnership(parent, upstream)
	if (parent.id === child.id || !hasExactDelegation(parent, child)) refuse("parent_mismatch")
	if (parentClaim.cleanupPending || childClaim.cleanupPending || childClaim.phase !== "settled")
		refuse("cleanup_pending")
	if (parentClaim.phase !== "suspended") refuse(parentClaim.phase === "active" ? "owner_live" : "not_active")
	if (child.status !== "interrupted") refuse("not_active")
	if (child.awaitingChildId || child.delegatedToId) refuse("descendant_owned")
	const parentGeneration = advance(parent.executionGeneration)
	const childGeneration = advance(child.executionGeneration)
	return {
		parent: {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			executionGeneration: parentGeneration,
			lifecycleRevision: advance(parent.lifecycleRevision),
			execution: { ...parentClaim, generation: parentGeneration, phase: "suspended" },
		},
		child: {
			...child,
			parentTaskId: undefined,
			rootTaskId: undefined,
			lineageProvenance: child.lineageProvenance ?? {
				parentTaskId: child.parentTaskId,
				rootTaskId: child.rootTaskId,
			},
			executionGeneration: childGeneration,
			lifecycleRevision: advance(child.lifecycleRevision),
			execution: { ...childClaim, generation: childGeneration },
		},
	}
}

function optionalClaim(item?: HistoryItem): ExecutionClaim | null {
	return item?.execution === undefined ? null : executionClaim(item)
}

export function recoveryScope(item: HistoryItem, parent?: HistoryItem): TaskRecoveryScope {
	return {
		taskId: item.id,
		revision: item.lifecycleRevision ?? 0,
		generation: item.executionGeneration ?? 0,
		claim: optionalClaim(item),
		action: item.pendingAction ?? null,
		blockedActionId: delegationState(item).blocked?.actionId ?? null,
		parentId: item.parentTaskId ?? null,
		parent: parent
			? {
					id: parent.id,
					revision: parent.lifecycleRevision ?? 0,
					generation: parent.executionGeneration ?? 0,
					claim: optionalClaim(parent),
					status: parent.status ?? null,
					awaitingChildId: parent.awaitingChildId ?? null,
					delegatedToId: parent.delegatedToId ?? null,
					creating: creatingReceipt(parent, item) ?? null,
				}
			: null,
	}
}

function assertRecoveryEligible(item: HistoryItem, parent?: HistoryItem): void {
	const claim = executionClaim(item)
	if (item.status === "completed") refuse("completed")
	assertNoCompletionPrefix(item, parent)
	if (claim.cleanupPending) refuse("cleanup_pending")
	if (claim.phase !== "settled") refuse("owner_live")
	const state = delegationState(item)
	if (state.actions.some((receipt) => receipt.phase === "prepared" || receipt.phase === "uncertain"))
		refuse("recovery_required")
	if (
		state.actions.some(
			(receipt) => (receipt.phase === "failed" || receipt.phase === "denied") && !receipt.resultWritten,
		)
	)
		refuse("result_repair_required")
	if (
		state.blocked &&
		!state.actions.some(
			(receipt) =>
				receipt.actionId === state.blocked?.actionId &&
				(receipt.phase === "failed" || receipt.phase === "denied") &&
				receipt.resultWritten,
		)
	)
		refuse("recovery_required")
	// Unresolved legacy intent is not permission to replay, even following a user resume.
	if (item.pendingAction) refuse("action_mismatch")
}

export function previewTaskRecovery(item: HistoryItem, parent?: HistoryItem, child?: HistoryItem): TaskRecoveryPreview {
	// Unknown schemas can still be inspected, but cannot produce an executable scope.
	let scope: TaskRecoveryScope
	try {
		scope = recoveryScope(item, parent)
	} catch {
		return {
			history: item,
			parent,
			scope: {
				taskId: item.id,
				revision: item.lifecycleRevision ?? 0,
				generation: item.executionGeneration ?? 0,
				claim: null,
				action: item.pendingAction ?? null,
				blockedActionId: null,
				parentId: item.parentTaskId ?? null,
				parent: null,
			},
			choices: [],
			reason: "metadata_unknown",
		}
	}
	try {
		assertRecoveryEligible(item, parent)
		if (item.status === "delegated") {
			if (
				child?.status !== "interrupted" ||
				!hasExactDelegation(item, child) ||
				executionClaim(child).phase !== "settled"
			)
				refuse("descendant_owned")
			assertUpstreamOwnership(item, parent)
			return { history: item, parent, scope, choices: ["retain_delegation"] }
		}
		if (item.status !== "interrupted" || item.awaitingChildId || item.delegatedToId) refuse("not_active")
		if (!item.parentTaskId) return { history: item, parent, scope, choices: ["resume_independent"] }
		if (hasExactDelegation(parent, item)) {
			assertUpstreamOwnership(item, parent)
			return { history: item, parent, scope, choices: ["resume_linked"] }
		}
		// Even contradictory receipt metadata cannot authorize detachment from a parent still awaiting this child.
		if (parent?.awaitingChildId === item.id) refuse("parent_mismatch")
		return { history: item, parent, scope, choices: ["resume_independent"] }
	} catch (error) {
		return {
			history: item,
			parent,
			scope,
			choices: [],
			reason: error instanceof ExecutionAuthorityError ? error.reason : "metadata_unknown",
		}
	}
}

/** The ONLY interrupted -> active edge. Ordinary transition/delta rules remain unchanged. */
export function recoverTaskExecution(
	item: HistoryItem,
	request: TaskRecoveryRequest,
	parent?: HistoryItem,
	child?: HistoryItem,
): HistoryItem {
	if (request.intent !== "explicit_user_resume") refuse("wrong_intent")
	if (!executionOwnerSchema.safeParse(request.owner).success) refuse("metadata_unknown")
	if (request.scope.taskId !== item.id) refuse("stale_scope")
	if (request.scope.generation !== item.executionGeneration) refuse("stale_generation")
	if (request.scope.revision !== item.lifecycleRevision) refuse("stale_revision")
	if (!deepEqual(request.scope, recoveryScope(item, parent))) refuse("stale_scope")
	const preview = previewTaskRecovery(item, parent, child)
	if (!preview.choices.includes(request.choice)) refuse(preview.reason ?? "wrong_intent")
	const generation = advance(item.executionGeneration)
	const independent = request.choice === "resume_independent"
	return {
		...item,
		status: request.choice === "retain_delegation" ? "delegated" : "active",
		...(independent
			? {
					parentTaskId: undefined,
					rootTaskId: undefined,
					lineageProvenance: item.lineageProvenance ?? {
						parentTaskId: item.parentTaskId,
						rootTaskId: item.rootTaskId,
					},
				}
			: {}),
		executionGeneration: generation,
		lifecycleRevision: advance(item.lifecycleRevision),
		execution: { version: 1, generation, owner: request.owner, phase: "active", cleanupPending: false },
		delegation: { ...delegationState(item), blocked: undefined },
	}
}

export function completeStandaloneExecution(item: HistoryItem, token: ExecutionToken, result: string): HistoryItem {
	assertExecutionAllowed(item, token)
	if (item.parentTaskId || item.awaitingChildId) refuse("parent_mismatch")
	const claim = executionClaim(item)
	const generation = advance(item.executionGeneration)
	return {
		...item,
		status: "completed",
		completionResultSummary: result,
		executionGeneration: generation,
		lifecycleRevision: advance(item.lifecycleRevision),
		execution: { ...claim, generation, phase: "suspended", cleanupPending: true, settlement: undefined },
	}
}

/** Pure authority validation shared by production and the cross-store model (#1469). */
export function validateDelegatedCompletion(
	parent: HistoryItem,
	child: HistoryItem,
	request: DelegatedCompletionRequest,
	upstream?: HistoryItem,
): DelegatedCompletionReceipt | undefined {
	const prior = completionState(parent).receipts.find((receipt) => receipt.operationId === request.operationId)
	if (prior) {
		const { phase: _phase, ...identity } = prior
		if (!deepEqual(identity, request)) refuse("receipt_mismatch")
		if (prior.parentToken.taskId !== parent.id || prior.childToken.taskId !== child.id) refuse("parent_mismatch")
		if (
			prior.phase === "committed" &&
			(child.status !== "completed" ||
				(child.executionGeneration ?? 0) < prior.childToken.generation + 1 ||
				child.delegationOrigin?.operationId !== prior.creating.operationId)
		)
			refuse("receipt_mismatch")
		return prior
	}
	assertNoCompletionPrefix(parent)
	assertUpstreamOwnership(parent, upstream)
	if (parent.id === child.id) refuse("parent_mismatch")
	const parentClaim = assertExecutionToken(parent, request.parentToken)
	assertExecutionAllowed(child, request.childToken, parent)
	if (parentClaim.cleanupPending) refuse("cleanup_pending")
	if (parentClaim.phase === "active") refuse("owner_live")
	if (delegationBlocked(parent)) refuse("recovery_required")
	if (parent.lifecycleRevision !== request.parentRevision || child.lifecycleRevision !== request.childRevision)
		refuse("stale_revision")
	if (!hasExactDelegation(parent, child)) refuse("parent_mismatch")
	if (!deepEqual(creatingReceipt(parent, child), request.creating)) refuse("receipt_mismatch")
	if (
		request.finish.kind !== "finish_subtask" ||
		request.finish.parentTaskId !== parent.id ||
		!deepEqual(child.pendingAction, request.finish)
	)
		refuse("action_mismatch")
	if (!request.operationId || !Number.isFinite(request.resultTs)) refuse("metadata_unknown")
	advance(child.executionGeneration)
	advance(child.lifecycleRevision)
	advance(advance(parent.lifecycleRevision))
	return undefined
}

export function prepareDelegatedCompletion(
	parent: HistoryItem,
	child: HistoryItem,
	request: DelegatedCompletionRequest,
	upstream?: HistoryItem,
): HistoryItem {
	if (validateDelegatedCompletion(parent, child, request, upstream)) refuse("receipt_mismatch")
	return {
		...parent,
		lifecycleRevision: advance(parent.lifecycleRevision),
		delegatedCompletion: {
			version: 1,
			receipts: [...completionState(parent).receipts, { ...request, phase: "prepared" }],
		},
	}
}

/** Validate a compatible durable prefix before repairing ANY transcript or lifecycle record. */
export function validateCompletionPrefix(
	parent: HistoryItem,
	child: HistoryItem,
	receipt: DelegatedCompletionReceipt,
	upstream?: HistoryItem,
): void {
	assertUpstreamOwnership(parent, upstream)
	if (receipt.finish.kind !== "finish_subtask") refuse("action_mismatch")
	if (
		receipt.parentToken.taskId !== parent.id ||
		receipt.childToken.taskId !== child.id ||
		receipt.finish.parentTaskId !== parent.id ||
		receipt.creating.childId !== child.id
	)
		refuse("parent_mismatch")
	if (
		!deepEqual(
			completionState(parent).receipts.find((entry) => entry.operationId === receipt.operationId),
			receipt,
		)
	)
		refuse("receipt_mismatch")
	if (receipt.phase !== "prepared") refuse("receipt_mismatch")
	const parentClaim = assertExecutionToken(parent, receipt.parentToken)
	if (parentClaim.phase === "active" || parentClaim.cleanupPending) refuse("owner_live")
	if (
		parent.lifecycleRevision !== receipt.parentRevision + 1 ||
		!hasExactDelegation(parent, child) ||
		!deepEqual(creatingReceipt(parent, child), receipt.creating)
	)
		refuse("parent_mismatch")
	if (child.status === "completed") {
		const target = completedChildForReceipt(child, receipt)
		if (
			child.executionGeneration !== receipt.childToken.generation + 1 ||
			child.lifecycleRevision !== receipt.childRevision + 1 ||
			!deepEqual(child.execution, target.execution) ||
			child.pendingAction ||
			child.completionResultSummary !== receipt.finish.result
		)
			refuse("stale_generation")
	} else {
		const claim = assertExecutionToken(child, receipt.childToken)
		if (
			child.status !== "active" ||
			claim.phase !== "active" ||
			claim.cleanupPending ||
			child.lifecycleRevision !== receipt.childRevision ||
			!deepEqual(child.pendingAction, receipt.finish)
		)
			refuse("action_mismatch")
	}
}

function completedChildForReceipt(child: HistoryItem, receipt: DelegatedCompletionReceipt): HistoryItem {
	if (receipt.finish.kind !== "finish_subtask") refuse("action_mismatch")
	return {
		...child,
		status: "completed",
		pendingAction: undefined,
		completionResultSummary: receipt.finish.result,
		executionGeneration: advance(receipt.childToken.generation),
		lifecycleRevision: advance(receipt.childRevision),
		execution: {
			version: 1,
			generation: advance(receipt.childToken.generation),
			owner: receipt.childToken.owner,
			phase: "suspended",
			cleanupPending: true,
		},
	}
}

/** Histories must already be durable. Child first, parent last: the parent's receipt gates every prefix. */
export function commitDelegatedCompletion(
	parent: HistoryItem,
	child: HistoryItem,
	receipt: DelegatedCompletionReceipt,
	upstream?: HistoryItem,
): { parent: HistoryItem; child: HistoryItem } {
	validateCompletionPrefix(parent, child, receipt, upstream)
	if (receipt.finish.kind !== "finish_subtask") refuse("action_mismatch")
	return {
		child: completedChildForReceipt(child, receipt),
		parent: {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			completedByChildId: child.id,
			completionResultSummary: receipt.finish.result,
			lifecycleRevision: advance(parent.lifecycleRevision),
			delegatedCompletion: {
				version: 1,
				receipts: completionState(parent).receipts.map((entry) =>
					entry.operationId === receipt.operationId ? { ...entry, phase: "committed" } : entry,
				),
			},
		},
	}
}
