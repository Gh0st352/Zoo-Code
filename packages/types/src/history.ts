import { z } from "zod"

import { todoItemSchema } from "./todo.js"

/**
 * HistoryItem
 */

export const pendingTaskActionSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("create_subtask"),
		actionId: z.string(),
		approvalText: z.string(),
		mode: z.string(),
		message: z.string(),
		todos: z.array(todoItemSchema),
	}),
	z.object({
		kind: z.literal("finish_subtask"),
		actionId: z.string(),
		approvalText: z.string(),
		parentTaskId: z.string(),
		result: z.string(),
	}),
])

export type PendingTaskAction = z.infer<typeof pendingTaskActionSchema>

/** Identity, not a timeout lease. Only a locally proven machine permits a PID probe. */
export const executionOwnerSchema = z
	.object({
		hostSessionId: z.string().min(1),
		providerId: z.string().min(1),
		runtimeId: z.string().min(1),
		processId: z.number().int().positive(),
		machineId: z.string().min(1),
		machineProof: z.enum(["local", "unknown"]),
	})
	.strict()
export type ExecutionOwner = z.infer<typeof executionOwnerSchema>

export const executionTokenSchema = z
	.object({
		taskId: z.string().min(1),
		generation: z.number().int().nonnegative().safe(),
		owner: executionOwnerSchema,
	})
	.strict()
export type ExecutionToken = z.infer<typeof executionTokenSchema>

export const executionClaimSchema = z
	.object({
		version: z.literal(1),
		owner: executionOwnerSchema,
		generation: z.number().int().nonnegative().safe(),
		phase: z.enum(["active", "suspended", "settled"]),
		cleanupPending: z.boolean(),
		settlement: z.enum(["cleanup", "owner_dead", "completion"]).optional(),
	})
	.strict()
export type ExecutionClaim = z.infer<typeof executionClaimSchema>

export const delegationActionSchema = z
	.object({
		actionId: z.string(),
		operationId: z.string(),
		childId: z.string(),
		ownerToken: z.string(),
		executionToken: executionTokenSchema.optional(),
		generation: z.number().int().nonnegative(),
		intent: pendingTaskActionSchema,
		phase: z.enum(["prepared", "committed", "failed", "uncertain", "denied"]),
		attempts: z.number().int().min(0).max(1),
		revision: z.number().int().nonnegative(),
		resultTs: z.number(),
		reason: z.string().optional(),
		resultWritten: z.boolean().optional(),
	})
	.strict()
export type DelegationAction = z.infer<typeof delegationActionSchema>

export const delegationStateSchema = z
	.object({
		version: z.literal(1),
		actions: z.array(delegationActionSchema),
		blocked: z
			.object({ actionId: z.string(), generation: z.number().int().nonnegative(), reason: z.string() })
			.optional(),
	})
	.strict()
export type DelegationState = z.infer<typeof delegationStateSchema>

/** Parent-owned write-ahead receipt. A prepared receipt blocks BOTH participants. */
export const delegatedCompletionReceiptSchema = z
	.object({
		operationId: z.string().min(1),
		phase: z.enum(["prepared", "committed"]),
		parentToken: executionTokenSchema,
		childToken: executionTokenSchema,
		parentRevision: z.number().int().nonnegative().safe(),
		childRevision: z.number().int().nonnegative().safe(),
		creating: delegationActionSchema,
		finish: pendingTaskActionSchema,
		resultTs: z.number().finite(),
	})
	.strict()
export type DelegatedCompletionReceipt = z.infer<typeof delegatedCompletionReceiptSchema>
export const delegatedCompletionStateSchema = z
	.object({
		version: z.literal(1),
		receipts: z.array(delegatedCompletionReceiptSchema),
	})
	.strict()
export type DelegatedCompletionState = z.infer<typeof delegatedCompletionStateSchema>

export const taskRecoveryChoices = ["resume_linked", "resume_independent", "retain_delegation"] as const
export type TaskRecoveryChoice = (typeof taskRecoveryChoices)[number]

export type ExecutionRefusalReason =
	| "metadata_missing"
	| "metadata_unknown"
	| "owner_live"
	| "owner_unknown"
	| "owner_mismatch"
	| "stale_generation"
	| "stale_revision"
	| "stale_scope"
	| "wrong_intent"
	| "cleanup_pending"
	| "completed"
	| "not_active"
	| "descendant_owned"
	| "parent_mismatch"
	| "receipt_mismatch"
	| "action_mismatch"
	| "recovery_required"
	| "result_repair_required"
	| "completion_pending"
	| "transcript_conflict"
	| "history_missing"
	| "history_invalid"
	| "history_io_error"

/** Full equality, including the pending intent, prevents reuse after a same-ID replacement. */
export interface TaskRecoveryScope {
	taskId: string
	revision: number
	generation: number
	claim: ExecutionClaim | null
	action: PendingTaskAction | null
	blockedActionId: string | null
	parent: {
		id: string
		revision: number
		generation: number
		claim: ExecutionClaim | null
		status: NonNullable<HistoryItem["status"]> | null
		awaitingChildId: string | null
		delegatedToId: string | null
		creating: DelegationAction | null
	} | null
	parentId: string | null
}

export interface TaskRecoveryRequest {
	scope: TaskRecoveryScope
	intent: "explicit_user_resume"
	choice: TaskRecoveryChoice
	owner: ExecutionOwner
}

export interface TaskRecoveryPreview {
	history: HistoryItem
	parent?: HistoryItem
	scope: TaskRecoveryScope
	choices: TaskRecoveryChoice[]
	reason?: ExecutionRefusalReason
}

export type ExecutionCommandResult =
	| { kind: "applied"; history: HistoryItem; token: ExecutionToken }
	| { kind: "refused"; reason: ExecutionRefusalReason; history?: HistoryItem }

export type ExecutionGuardResult =
	| { kind: "allowed"; history: HistoryItem }
	| { kind: "refused"; reason: ExecutionRefusalReason; history?: HistoryItem }

export interface DelegatedCompletionRequest {
	operationId: string
	parentToken: ExecutionToken
	childToken: ExecutionToken
	parentRevision: number
	childRevision: number
	creating: DelegationAction
	finish: Extract<PendingTaskAction, { kind: "finish_subtask" }>
	resultTs: number
}

export type DelegatedCompletionResult =
	| { kind: "completed" | "duplicate"; parent: HistoryItem; child: HistoryItem; receipt: DelegatedCompletionReceipt }
	| { kind: "refused"; reason: ExecutionRefusalReason; parent?: HistoryItem; child?: HistoryItem }

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	status: z.enum(["active", "completed", "delegated", "interrupted"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	pendingAction: pendingTaskActionSchema.optional(),
	lifecycleRevision: z.number().int().nonnegative().optional(),
	executionGeneration: z.number().int().nonnegative().optional(),
	delegationOrigin: z.object({ parentId: z.string(), operationId: z.string() }).optional(),
	execution: z.union([executionClaimSchema, z.record(z.unknown())]).optional(),
	delegatedCompletion: z.union([delegatedCompletionStateSchema, z.record(z.unknown())]).optional(),
	lineageProvenance: z.object({ parentTaskId: z.string().optional(), rootTaskId: z.string().optional() }).optional(),
	// Preserve unknown versions for read-only display, never silently strip a gate.
	delegation: z.union([delegationStateSchema, z.record(z.unknown())]).optional(),
})

export type HistoryItem = z.infer<typeof historyItemSchema>
