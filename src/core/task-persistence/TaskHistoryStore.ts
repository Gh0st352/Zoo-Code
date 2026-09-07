import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import crypto from "crypto"
import * as lockfile from "proper-lockfile"

import deepEqual from "fast-deep-equal"
import {
	historyItemSchema,
	type DelegationAction,
	type HistoryItem,
	type ClineMessage,
	type ExecutionOwner,
	type ExecutionToken,
	type ExecutionCommandResult,
	type ExecutionGuardResult,
	type TaskRecoveryRequest,
	type TaskRecoveryPreview,
	type DelegatedCompletionRequest,
	type DelegatedCompletionResult,
	type DelegatedCompletionReceipt,
	type ExecutionRefusalReason,
} from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { LOCK_STALE_MS, safeWriteJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"
import {
	assertValidTransition,
	delegationState,
	reconcileDelegationResult,
	LifecycleTransitionError,
	type HistoryItemStatus,
	ExecutionAuthorityError,
	executionClaim,
	executionToken,
	assertExecutionToken,
	assertExecutionAllowed,
	assertNoCompletionPrefix,
	claimNewExecution,
	interruptExecution,
	settleExecution,
	transferExecution,
	repairDeadExecution,
	previewTaskRecovery,
	recoverTaskExecution,
	completeStandaloneExecution,
	completionState,
	validateDelegatedCompletion,
	prepareDelegatedCompletion,
	validateCompletionPrefix,
	commitDelegatedCompletion,
	abandonExecutionDelegation,
} from "./taskLifecycle"
import { createExecutionHost, probeExecutionOwner, type ExecutionHost } from "./executionHost"
import {
	computeHistoryDelta,
	DeltaRejectedError,
	mergeHistoryDelta,
	mergeTaskMessageMetadata,
} from "./taskStoreConcurrency"
import {
	type ApiMessage,
	ApiMessagesReadError,
	saveApiMessages,
	saveDelegationFailureResult,
	readApiMessagesForCompletion,
	withDelegationCompletion,
	saveDelegationCompletionResult,
} from "./apiMessages"
import { TaskMessagesReadError, readTaskMessages, saveTaskMessages } from "./taskMessages"

export { assertValidTransition, type HistoryItemStatus } from "./taskLifecycle"
export { DeltaRejectedError } from "./taskStoreConcurrency"

export class HistoryReadError extends Error {
	constructor(
		public readonly kind: "missing" | "invalid" | "io_error",
		public readonly taskId: string,
		options?: ErrorOptions,
	) {
		super(`Authoritative history ${kind}: ${taskId}`, options)
	}
}

export class LifecycleWriteError extends Error {
	constructor(
		public readonly certainty: "not_committed" | "uncertain",
		options: ErrorOptions,
	) {
		super(`Lifecycle write ${certainty}`, options)
	}
}

function persistedHistoryEqual(left: HistoryItem, right: HistoryItem): boolean {
	// Optional properties disappear on disk. Compare the persisted representation,
	// not in-memory undefined keys, when proving a failed write actually committed.
	return deepEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))
}

/**
 * Build a `safeWriteJson` merge callback that applies only `delta` to the
 * current disk state, preserving fields written by another process.
 */
function mergeWithDisk(delta: Partial<HistoryItem>): (existing: unknown, incoming: unknown) => unknown {
	return (existing, incoming) => mergeHistoryDelta(existing, incoming as HistoryItem, delta)
}

/**
 * TaskHistoryStore encapsulates all task history persistence logic.
 *
 * Each task's HistoryItem is stored as an individual JSON file in its
 * existing task directory (`globalStorage/tasks/<taskId>/history_item.json`).
 * There is no shared index file. Reads scan the task directories.
 *
 * Cross-process safety for per-task files comes from `safeWriteJson`'s
 * `proper-lockfile` with a `merge` callback: each write reads the
 * current file under the advisory lock and merges incoming fields, so
 * a concurrent writer's changes are preserved rather than silently
 * dropped. Within a single extension host process, an in-process write
 * lock serializes mutations.
 */
/**
 * Options for TaskHistoryStore constructor.
 */
export interface TaskHistoryStoreOptions {
	executionHost?: ExecutionHost
	providerId?: string
	/**
	 * Optional callback invoked inside the write lock after each mutation
	 * (upsert, delete, deleteMany). Used for serialized write-through to
	 * globalState during the transition period.
	 */
	onWrite?: (items: HistoryItem[]) => Promise<void>
}

export class TaskHistoryStore {
	private readonly executionHost: ExecutionHost
	private readonly providerId: string
	private readonly globalStoragePath: string
	private readonly onWrite?: (items: HistoryItem[]) => Promise<void>
	private cache: Map<string, HistoryItem> = new Map()
	private taskFileMtimes: Map<string, number> = new Map()
	private writeLock: Promise<void> = Promise.resolve()
	private fsWatcher: fsSync.FSWatcher | null = null
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false

	/**
	 * Promise that resolves when initialization is complete.
	 * Callers can await this to ensure the store is ready before reading.
	 */
	public readonly initialized: Promise<void>
	private resolveInitialized!: () => void

	/** Periodic reconciliation interval in milliseconds. */
	private static readonly RECONCILE_INTERVAL_MS = 5 * 60 * 1000

	constructor(globalStoragePath: string, options?: TaskHistoryStoreOptions) {
		this.globalStoragePath = globalStoragePath
		this.executionHost = options?.executionHost ?? createExecutionHost()
		this.providerId = options?.providerId ?? crypto.randomUUID()
		this.onWrite = options?.onWrite
		this.initialized = new Promise<void>((resolve) => {
			this.resolveInitialized = resolve
		})
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	/**
	 * Scan task files, reconcile delegation state, start watchers.
	 */
	async initialize(): Promise<void> {
		try {
			const tasksDir = await this.getTasksDir()
			await fs.mkdir(tasksDir, { recursive: true })

			// 1. Scan task directories to populate the cache
			await this.reconcile({ forceRefresh: true })
			// Additional providers are observers. Legacy journals contain no owner proof.
			await this.quarantineLegacyRepair()
			await this.repairConfirmedDeadOwners()

			// 4. Start fs.watch for cross-instance reactivity
			this.startWatcher()

			// 5. Start periodic reconciliation as a defensive fallback
			this.startPeriodicReconciliation()
		} finally {
			// Mark initialization as complete so callers awaiting `initialized` can proceed
			this.resolveInitialized()
		}
	}

	/**
	 * Flush pending writes, clear watchers, release resources.
	 */
	dispose(): void {
		this.disposed = true

		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer)
			this.reconcileTimer = null
		}

		if (this.fsWatcher) {
			this.fsWatcher.close()
			this.fsWatcher = null
		}
	}

	// ────────────────────────────── Reads ──────────────────────────────

	public ownerForRuntime(runtimeId: string): ExecutionOwner {
		return { ...this.executionHost.identity, providerId: this.providerId, runtimeId }
	}

	private assertLocalOwner(owner: ExecutionOwner): void {
		if (!deepEqual(owner, this.ownerForRuntime(owner.runtimeId)))
			throw new ExecutionAuthorityError("owner_mismatch")
	}

	/** Caller cleanup assertions authorize only local runtimes; peers need durable settlement. */
	private async assertLocalOrSettledOwner(history: HistoryItem): Promise<void> {
		const claim = executionClaim(history)
		if (deepEqual(claim.owner, this.ownerForRuntime(claim.owner.runtimeId))) return
		if (claim.phase === "settled" && !claim.cleanupPending) return
		const liveness = await probeExecutionOwner(claim, this.executionHost)
		// Even positive death must first pass through the separate repair/settlement command.
		throw new ExecutionAuthorityError(liveness === "live" ? "owner_live" : "owner_unknown")
	}

	private refusalReason(error: unknown): ExecutionRefusalReason | undefined {
		if (error instanceof ExecutionAuthorityError) return error.reason
		if (error instanceof HistoryReadError)
			return error.kind === "missing"
				? "history_missing"
				: error.kind === "invalid"
					? "history_invalid"
					: "history_io_error"
		if (error instanceof TaskMessagesReadError)
			return error.kind === "not_found"
				? "history_missing"
				: error.kind === "invalid"
					? "history_invalid"
					: "history_io_error"
		if (error instanceof ApiMessagesReadError)
			return error.kind === "invalid" ? "history_invalid" : "history_io_error"
		return undefined
	}

	private async readOptionalHistory(id?: string): Promise<HistoryItem | undefined> {
		if (!id) return undefined
		try {
			return await this.readAuthoritative(id)
		} catch (error) {
			if (error instanceof HistoryReadError && error.kind === "missing") return undefined
			throw error
		}
	}

	/** Must be called inside withLock. Read-back resolves write-after-rename failures. */
	private async persistLifecycle(
		current: HistoryItem,
		updated: HistoryItem,
		isCurrent: () => boolean = () => true,
	): Promise<HistoryItem> {
		if (!isCurrent()) throw new ExecutionAuthorityError("stale_scope")
		if (persistedHistoryEqual(current, updated)) return current
		try {
			await safeWriteJson(await this.getTaskFilePath(current.id), updated, {
				merge: (disk) => {
					// Synchronous scope check after path resolution, file-lock acquisition and disk read.
					// No provider callback may re-enter a store command from this predicate.
					if (!isCurrent()) throw new ExecutionAuthorityError("stale_scope")
					if (!deepEqual(disk, current)) throw new ExecutionAuthorityError("stale_revision")
					return updated
				},
			})
		} catch (cause) {
			// A rejected merge has not started a write. Never reinterpret lost scope as a commit.
			if (cause instanceof ExecutionAuthorityError && cause.reason === "stale_scope") throw cause
			let disk: HistoryItem
			try {
				disk = await this.readAuthoritative(current.id)
			} catch {
				throw new LifecycleWriteError("uncertain", { cause })
			}
			if (!persistedHistoryEqual(disk, updated)) {
				if (cause instanceof ExecutionAuthorityError) throw cause
				throw new LifecycleWriteError(persistedHistoryEqual(disk, current) ? "not_committed" : "uncertain", {
					cause,
				})
			}
		}
		this.cache.set(updated.id, updated)
		return updated
	}

	private async notifyLifecycle(): Promise<void> {
		try {
			await this.onWrite?.(this.getAll())
		} catch (error) {
			console.error("[TaskHistoryStore] Lifecycle notification failed after commit", error)
		}
	}

	/** Creates the history AND its first claim; existing task histories cannot be adopted here. */
	public claimNewTask(item: HistoryItem, owner: ExecutionOwner): Promise<ExecutionCommandResult> {
		return this.withLock(async () => {
			try {
				this.assertLocalOwner(owner)
				if (!this.isSafeTaskId(item.id)) throw new ExecutionAuthorityError("history_invalid")
				const existing = await this.readOptionalHistory(item.id)
				if (existing) return { kind: "refused", reason: "recovery_required", history: existing }
				if (item.parentTaskId) throw new ExecutionAuthorityError("parent_mismatch")
				const updated = claimNewExecution(item, owner)
				// A directory left by an uncertain earlier creation is never silently adopted.
				await fs.mkdir(await this.getTasksDir(), { recursive: true })
				await fs.mkdir(path.dirname(await this.getTaskFilePath(item.id)))
				await safeWriteJson(await this.getTaskFilePath(item.id), updated, {
					merge: (disk) => {
						if (disk !== null) throw new ExecutionAuthorityError("owner_mismatch")
						return updated
					},
				})
				this.cache.set(item.id, updated)
				await this.notifyLifecycle()
				return { kind: "applied", history: updated, token: executionToken(updated) }
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason }
				throw error
			}
		})
	}

	private executionCommand(
		token: ExecutionToken,
		reduce: (item: HistoryItem, parent?: HistoryItem) => HistoryItem,
		isCurrent: () => boolean = () => true,
	): Promise<ExecutionCommandResult> {
		return this.withLock(async () => {
			let current: HistoryItem | undefined
			try {
				this.assertLocalOwner(token.owner)
				current = await this.readAuthoritative(token.taskId)
				const parent = await this.readOptionalHistory(current.parentTaskId)
				assertNoCompletionPrefix(current, parent)
				const history = await this.persistLifecycle(current, reduce(current, parent), isCurrent)
				await this.notifyLifecycle()
				return { kind: "applied", history, token: executionToken(history) }
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason, history: current }
				throw error
			}
		})
	}

	public guardExecution(token: ExecutionToken): Promise<ExecutionGuardResult> {
		return this.withLock(async () => {
			let history: HistoryItem | undefined
			try {
				this.assertLocalOwner(token.owner)
				history = await this.readAuthoritative(token.taskId)
				assertExecutionAllowed(
					history,
					token,
					await this.readOptionalHistory(history.parentTaskId),
					await this.readOptionalHistory(history.awaitingChildId),
				)
				return { kind: "allowed", history }
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason, history }
				throw error
			}
		})
	}

	/**
	 * Captures inputs before queueing; authority and every write share one storage lock.
	 * Cleanup is provider-only: supply the exact fenced token with a pre-fence snapshot,
	 * or flush the still-active parent before delegation. This never settles/replaces a claim.
	 */
	public async saveExecutionSnapshot(
		token: ExecutionToken,
		snapshot: {
			apiMessages?: ApiMessage[]
			clineMessages?: ClineMessage[]
			metadata?: HistoryItem
			merge?: boolean
		},
		cleanup = false,
	): Promise<void> {
		const expected = structuredClone(token)
		const captured = structuredClone(snapshot)
		await this.withLock(async () => {
			this.assertLocalOwner(expected.owner)
			const current = await this.readAuthoritative(expected.taskId)
			const claim = assertExecutionToken(current, expected)
			const parent = await this.readOptionalHistory(current.parentTaskId)
			assertNoCompletionPrefix(current, parent)
			if (captured.metadata && captured.metadata.id !== current.id)
				throw new ExecutionAuthorityError("owner_mismatch")
			if (claim.phase === "settled") throw new ExecutionAuthorityError("not_active")
			// Only provider-captured final data may flush a fenced completed/failed task.
			if (!(cleanup && claim.phase === "suspended" && claim.cleanupPending)) {
				const state = delegationState(current)
				const prepared = state.actions.filter((receipt) => receipt.phase === "prepared")
				if (
					prepared.length > 1 ||
					prepared.some(
						(receipt) =>
							!deepEqual(receipt.executionToken, expected) ||
							receipt.generation !== expected.generation ||
							receipt.ownerToken !== expected.owner.runtimeId ||
							current.lifecycleRevision !== receipt.revision + 1 ||
							!deepEqual(current.pendingAction, receipt.intent),
					) ||
					state.actions.some(
						(receipt) =>
							receipt.generation === expected.generation &&
							(receipt.phase === "failed" || receipt.phase === "denied"),
					)
				)
					throw new ExecutionAuthorityError("recovery_required")
				// A reservation gates execution, but its original active owner must still flush.
				assertExecutionAllowed(
					{
						...current,
						delegation: { ...state, actions: state.actions.filter((r) => r.phase !== "prepared") },
					},
					expected,
					parent,
					await this.readOptionalHistory(current.awaitingChildId),
				)
			}
			if (captured.apiMessages) {
				await saveApiMessages({
					taskId: current.id,
					globalStoragePath: this.globalStoragePath,
					messages: captured.apiMessages,
					merge: captured.merge,
				})
			}
			if (captured.clineMessages) {
				await saveTaskMessages({
					taskId: current.id,
					globalStoragePath: this.globalStoragePath,
					messages: captured.clineMessages,
					merge: captured.merge,
				})
			}
			if (captured.metadata) {
				this.cache.set(current.id, current)
				await this.upsertCore(mergeTaskMessageMetadata(current, captured.metadata))
			}
		})
	}

	/** Return the new fenced token; retain it to settle the outgoing runtime after abort completes. */
	public interruptTask(token: ExecutionToken): Promise<ExecutionCommandResult> {
		return this.executionCommand(token, (item, parent) => interruptExecution(item, token, parent))
	}

	public settleTaskExecution(token: ExecutionToken, cleanupSettled: boolean): Promise<ExecutionCommandResult> {
		return this.executionCommand(token, (item) => settleExecution(item, token, cleanupSettled))
	}

	public transferTaskExecution(
		outgoing: ExecutionToken,
		owner: ExecutionOwner,
		cleanupSettled: boolean,
		isCurrent: () => boolean = () => true,
	): Promise<ExecutionCommandResult> {
		return this.withLock(async () => {
			let history: HistoryItem | undefined
			try {
				this.assertLocalOwner(owner)
				history = await this.readAuthoritative(outgoing.taskId)
				assertExecutionToken(history, outgoing)
				if (!cleanupSettled) throw new ExecutionAuthorityError("cleanup_pending")
				await this.assertLocalOrSettledOwner(history)
				assertNoCompletionPrefix(history, await this.readOptionalHistory(history.parentTaskId))
				history = await this.persistLifecycle(
					history,
					transferExecution(history, outgoing, owner, cleanupSettled),
					isCurrent,
				)
				await this.notifyLifecycle()
				return { kind: "applied", history, token: executionToken(history) }
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason, history }
				throw error
			}
		})
	}

	/** Disposal is NOT settlement. Only these exact locally owned tokens may be released. */
	public async releaseProviderClaims(
		tokens: readonly ExecutionToken[],
		cleanupSettled: boolean,
	): Promise<ExecutionCommandResult[]> {
		const results: ExecutionCommandResult[] = []
		for (const token of tokens) results.push(await this.settleTaskExecution(token, cleanupSettled))
		return results
	}

	public previewRecovery(taskId: string): Promise<TaskRecoveryPreview> {
		return this.withLock(async () => {
			const item = await this.readAuthoritative(taskId)
			const parent = await this.readOptionalHistory(item.parentTaskId)
			const preview = previewTaskRecovery(item, parent, await this.readOptionalHistory(item.awaitingChildId))
			if (preview.reason === "owner_live") {
				const liveness = await probeExecutionOwner(executionClaim(item), this.executionHost)
				if (liveness === "unknown") return { ...preview, reason: "owner_unknown" }
			}
			return preview
		})
	}

	public recoverTask(
		request: TaskRecoveryRequest,
		isCurrent: () => boolean = () => true,
	): Promise<ExecutionCommandResult> {
		const expected = structuredClone(request)
		return this.withLock(async () => {
			let current: HistoryItem | undefined
			try {
				this.assertLocalOwner(expected.owner)
				current = await this.readAuthoritative(expected.scope.taskId)
				const parent = await this.readOptionalHistory(current.parentTaskId)
				const child = await this.readOptionalHistory(current.awaitingChildId)
				const updated = recoverTaskExecution(current, expected, parent, child)
				const history = await this.persistLifecycle(current, updated, isCurrent)
				await this.notifyLifecycle()
				return { kind: "applied", history, token: executionToken(history) }
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason, history: current }
				throw error
			}
		})
	}

	public completeStandaloneTask(
		token: ExecutionToken,
		result: string,
		isCurrent: () => boolean = () => true,
	): Promise<ExecutionCommandResult> {
		const expected = structuredClone(token)
		return this.executionCommand(expected, (item) => completeStandaloneExecution(item, expected, result), isCurrent)
	}

	/** Lock held from fresh authority checks through transcripts, child commit, and parent commit. */
	public completeDelegatedTask(
		request: DelegatedCompletionRequest,
		isCurrent: () => boolean = () => true,
	): Promise<DelegatedCompletionResult> {
		const expected = structuredClone(request)
		return this.withLock(async () => {
			let parent: HistoryItem | undefined
			let child: HistoryItem | undefined
			try {
				this.assertLocalOwner(expected.childToken.owner)
				parent = await this.readAuthoritative(expected.parentToken.taskId)
				child = await this.readAuthoritative(expected.childToken.taskId)
				const upstream = await this.readOptionalHistory(parent.parentTaskId)
				const prior = validateDelegatedCompletion(parent, child, expected, upstream)
				if (prior?.phase === "committed") return { kind: "duplicate", parent, child, receipt: prior }
				if (prior) return { kind: "refused", reason: "completion_pending", parent, child }
				await this.assertLocalOrSettledOwner(parent)
				const receipt: DelegatedCompletionReceipt = { ...expected, phase: "prepared" }
				// Preflight BOTH histories without writing/migrating either of them.
				withDelegationCompletion(await readApiMessagesForCompletion(parent.id, this.globalStoragePath), receipt)
				await readTaskMessages({ taskId: parent.id, globalStoragePath: this.globalStoragePath })
				parent = await this.persistLifecycle(
					parent,
					prepareDelegatedCompletion(parent, child, expected, upstream),
					isCurrent,
				)
				// Once prepared, finish this exact prefix even if focus changes; cancellation queues behind it.
				return await this.finishCompletionPrefix(parent, child, receipt)
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason, parent, child }
				throw error
			}
		})
	}

	/**
	 * No activation or implicit retry: parent ownership is cleared before child detachment.
	 * A second-write failure throws and leaves a nonexecuting parent plus a settled child
	 * with old lineage. Independent recovery can detach that child; stale retries cannot.
	 */
	public abandonTaskDelegation(
		parentToken: ExecutionToken,
		childToken: ExecutionToken,
	): Promise<
		| { kind: "applied"; parent: HistoryItem; child: HistoryItem }
		| { kind: "refused"; reason: ExecutionRefusalReason }
	> {
		const expectedParent = structuredClone(parentToken)
		const expectedChild = structuredClone(childToken)
		return this.withLock(async () => {
			let parent: HistoryItem
			let child: HistoryItem
			let updated: { parent: HistoryItem; child: HistoryItem }
			try {
				this.assertLocalOwner(expectedParent.owner)
				parent = await this.readAuthoritative(expectedParent.taskId)
				child = await this.readAuthoritative(expectedChild.taskId)
				updated = abandonExecutionDelegation(
					parent,
					child,
					expectedParent,
					expectedChild,
					await this.readOptionalHistory(parent.parentTaskId),
				)
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason }
				throw error
			}
			// Do not translate any partial persistence failure into a side-effect-free refusal.
			const savedParent = await this.persistLifecycle(parent, updated.parent)
			const savedChild = await this.persistLifecycle(child, updated.child)
			await this.notifyLifecycle()
			return { kind: "applied", parent: savedParent, child: savedChild }
		})
	}

	/** No launch/activation. Safe repair may finish only this exact durable prefix. */
	public repairDelegatedCompletion(parentId: string, operationId: string): Promise<DelegatedCompletionResult> {
		return this.withLock(async () => {
			let parent: HistoryItem | undefined
			let child: HistoryItem | undefined
			try {
				parent = await this.readAuthoritative(parentId)
				const receipt = completionState(parent).receipts.find((entry) => entry.operationId === operationId)
				if (!receipt) return { kind: "refused", reason: "receipt_mismatch", parent }
				child = await this.readAuthoritative(receipt.childToken.taskId)
				if (receipt.phase === "committed") return { kind: "duplicate", parent, child, receipt }
				validateCompletionPrefix(parent, child, receipt, await this.readOptionalHistory(parent.parentTaskId))
				// Live peer commands repair their own prefix; observers require positive death/settlement.
				for (const item of [parent, child]) {
					const claim = executionClaim(item)
					if (!deepEqual(claim.owner, this.ownerForRuntime(claim.owner.runtimeId))) {
						const liveness = await probeExecutionOwner(claim, this.executionHost)
						if (liveness !== "dead" && liveness !== "settled")
							throw new ExecutionAuthorityError(liveness === "live" ? "owner_live" : "owner_unknown")
					}
				}
				return await this.finishCompletionPrefix(parent, child, receipt)
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason, parent, child }
				throw error
			}
		})
	}

	private async finishCompletionPrefix(
		parent: HistoryItem,
		child: HistoryItem,
		receipt: DelegatedCompletionReceipt,
	): Promise<DelegatedCompletionResult> {
		const upstream = await this.readOptionalHistory(parent.parentTaskId)
		validateCompletionPrefix(parent, child, receipt, upstream)
		if (receipt.finish.kind !== "finish_subtask") throw new ExecutionAuthorityError("action_mismatch")
		const messages = await readTaskMessages({ taskId: parent.id, globalStoragePath: this.globalStoragePath })
		const messageId = `completion:${receipt.operationId}:ui`
		const existing = messages.filter((message) => message.messageId === messageId)
		if (existing.length > 1 || (existing[0] && existing[0].text !== receipt.finish.result))
			throw new ExecutionAuthorityError("transcript_conflict")
		await saveDelegationCompletionResult(parent.id, this.globalStoragePath, receipt)
		if (!existing.length) {
			messages.push({
				messageId,
				ts: receipt.resultTs,
				type: "say",
				say: "subtask_result",
				text: receipt.finish.result,
			})
			await saveTaskMessages({
				taskId: parent.id,
				globalStoragePath: this.globalStoragePath,
				messages,
				merge: true,
			})
		}
		const updated = commitDelegatedCompletion(parent, child, receipt, upstream)
		await this.persistLifecycle(child, updated.child)
		await this.persistLifecycle(parent, updated.parent)
		await this.notifyLifecycle()
		return { kind: "completed", ...updated, receipt: { ...receipt, phase: "committed" } }
	}

	private async quarantineLegacyRepair(): Promise<void> {
		await this.withLock(async () => {
			const file = await this.getDelegationRepairIntentPath()
			try {
				await fs.rename(file, `${file}.quarantine-${crypto.randomUUID()}`)
			} catch (error) {
				if (!this.isFileNotFoundError(error)) throw error
			}
		})
	}

	/** No timestamp/heartbeat takeover; no graph repair, activation, deletion or receipt reinterpretation. */
	public repairConfirmedDeadOwners(): Promise<void> {
		return this.withLock(async () => {
			let changed = false
			for (const id of this.cache.keys()) {
				try {
					const current = await this.readAuthoritative(id)
					const parent = await this.readOptionalHistory(current.parentTaskId)
					assertNoCompletionPrefix(current, parent)
					const claim = executionClaim(current)
					if ((await probeExecutionOwner(claim, this.executionHost)) !== "dead") continue
					await this.persistLifecycle(current, repairDeadExecution(current, executionToken(current)))
					changed = true
				} catch (error) {
					if (!this.refusalReason(error)) throw error
				}
			}
			if (changed) await this.notifyLifecycle()
		})
	}

	/**
	 * Get a single history item by task ID.
	 */
	get(taskId: string): HistoryItem | undefined {
		return this.cache.get(taskId)
	}

	/** Strict read: missing/corrupt/unreadable metadata is never execution authority. */
	public async readAuthoritative(taskId: string): Promise<HistoryItem> {
		if (!this.isSafeTaskId(taskId)) throw new HistoryReadError("invalid", taskId)
		let raw: unknown
		try {
			raw = JSON.parse(await fs.readFile(await this.getTaskFilePath(taskId), "utf8"))
		} catch (cause) {
			throw new HistoryReadError(
				this.isFileNotFoundError(cause) ? "missing" : cause instanceof SyntaxError ? "invalid" : "io_error",
				taskId,
				{ cause },
			)
		}
		const parsed = historyItemSchema.passthrough().safeParse(raw)
		if (!parsed.success || parsed.data.id !== taskId) throw new HistoryReadError("invalid", taskId)
		return parsed.data
	}

	/**
	 * Short authoritative command. All participating store writers share the storage
	 * advisory lock; the parent is revalidated again under safeWriteJson's file lock.
	 * Preparation stays outside this command. A receipt in the parent records any
	 * uncommitted child prefix, so reload can block without replaying preparation.
	 */
	public lifecycleCommand(
		taskId: string,
		update: (current: HistoryItem, related: ReadonlyMap<string, HistoryItem>) => HistoryItem,
		relatedIds: readonly string[] = [],
		readLineage = true,
		authority?: ExecutionToken,
		isCurrent: () => boolean = () => true,
	): Promise<HistoryItem> {
		return this.withLock(async () => {
			const current = await this.readAuthoritative(taskId)
			if (!isCurrent()) throw new ExecutionAuthorityError("stale_scope")
			const related = new Map<string, HistoryItem>()
			for (const id of new Set(
				[...(readLineage ? [current.parentTaskId, current.awaitingChildId] : []), ...relatedIds].filter(
					(id): id is string => !!id,
				),
			)) {
				related.set(id, await this.readAuthoritative(id))
				if (!isCurrent()) throw new ExecutionAuthorityError("stale_scope")
			}
			let updated = update(structuredClone(current), related)
			if (updated.id !== taskId) throw new LifecycleTransitionError("Lifecycle command changed task identity")
			if ((updated.status ?? "active") !== (current.status ?? "active"))
				assertValidTransition(current.status, updated.status ?? "active")
			assertNoCompletionPrefix(
				current,
				related.get(current.parentTaskId ?? "") ?? (await this.readOptionalHistory(current.parentTaskId)),
			)
			if (!isCurrent()) throw new ExecutionAuthorityError("stale_scope")
			if (current.execution !== undefined) {
				if (!authority) throw new ExecutionAuthorityError("metadata_missing")
				this.assertLocalOwner(authority.owner)
				const claim = assertExecutionToken(current, authority)
				if (claim.phase === "settled" || claim.cleanupPending)
					throw new ExecutionAuthorityError("cleanup_pending")
				// Generic commands can save pending intent/reserve/commit, not replace execution authority.
				const nextClaim = executionClaim(updated)
				if (
					!deepEqual({ ...claim, phase: nextClaim.phase }, nextClaim) ||
					(nextClaim.phase !== claim.phase &&
						!(
							claim.phase === "active" &&
							nextClaim.phase === "suspended" &&
							updated.status === "delegated"
						)) ||
					(current.status !== "active" && updated.status === "active")
				)
					throw new ExecutionAuthorityError("owner_mismatch")
				if (updated.status !== current.status && updated.status !== "delegated")
					throw new ExecutionAuthorityError("owner_mismatch")
				if (
					!deepEqual(current.delegatedCompletion, updated.delegatedCompletion) ||
					!deepEqual(current.delegationOrigin, updated.delegationOrigin) ||
					current.parentTaskId !== updated.parentTaskId ||
					current.rootTaskId !== updated.rootTaskId
				)
					throw new ExecutionAuthorityError("owner_mismatch")
				const before = delegationState(current)
				const after = delegationState(updated)
				if (before.blocked && !deepEqual(before.blocked, after.blocked))
					throw new ExecutionAuthorityError("recovery_required")
				for (const receipt of before.actions.filter((entry) => entry.phase !== "prepared")) {
					if (
						!deepEqual(
							receipt,
							after.actions.find((entry) => entry.operationId === receipt.operationId),
						)
					)
						throw new ExecutionAuthorityError("receipt_mismatch")
				}
				for (const receipt of before.actions.filter((entry) => entry.phase === "prepared")) {
					const next = after.actions.find((entry) => entry.operationId === receipt.operationId)
					if (!next) throw new ExecutionAuthorityError("receipt_mismatch")
					const { phase: _oldPhase, reason: _oldReason, ...oldIdentity } = receipt
					const { phase: _newPhase, reason: _newReason, ...newIdentity } = next
					if (!deepEqual(oldIdentity, newIdentity)) throw new ExecutionAuthorityError("receipt_mismatch")
				}
				if (!deepEqual(current, updated)) {
					const revision = Math.max((current.lifecycleRevision ?? 0) + 1, updated.lifecycleRevision ?? 0)
					if (!Number.isSafeInteger(revision)) throw new ExecutionAuthorityError("metadata_unknown")
					updated = { ...updated, lifecycleRevision: revision }
				}
			} else if (updated.execution !== undefined) throw new ExecutionAuthorityError("metadata_missing")
			// Admission-only/no-op commands must also validate their final scope.
			if (!isCurrent()) throw new ExecutionAuthorityError("stale_scope")
			if (deepEqual(current, updated)) return current
			try {
				await safeWriteJson(await this.getTaskFilePath(taskId), updated, {
					merge: (disk) => {
						// Recheck after path resolution, file-lock acquisition and disk read.
						if (!isCurrent()) throw new ExecutionAuthorityError("stale_scope")
						if (!deepEqual(disk, current))
							throw new LifecycleTransitionError(`Authoritative history changed for ${taskId}`)
						return updated
					},
				})
			} catch (cause) {
				// A stale-scope merge rejection never started a write.
				if (cause instanceof ExecutionAuthorityError && cause.reason === "stale_scope") throw cause
				// Never infer absence of commit from an exception or a cache snapshot.
				let disk: HistoryItem
				try {
					disk = await this.readAuthoritative(taskId)
				} catch {
					throw new LifecycleWriteError("uncertain", { cause })
				}
				if (!persistedHistoryEqual(disk, updated)) {
					if (cause instanceof LifecycleTransitionError) throw cause
					throw new LifecycleWriteError(
						persistedHistoryEqual(disk, current) ? "not_committed" : "uncertain",
						{ cause },
					)
				}
			}
			this.cache.set(taskId, updated)
			// Notification failure is post-commit, not a failed operation.
			try {
				await this.onWrite?.(this.getAll())
			} catch (error) {
				console.error("[TaskHistoryStore] Lifecycle write-through failed after commit", error)
			}
			return updated
		})
	}

	/** Message-derived metadata cannot alter lifecycle, lineage, action or recovery state. */
	public updateMessageMetadata(item: HistoryItem): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			let current: HistoryItem | undefined
			try {
				current = await this.readAuthoritative(item.id)
			} catch (error) {
				if (!(error instanceof HistoryReadError) || error.kind !== "missing") throw error
			}
			if (!current) return this.upsertCore(item)
			this.cache.set(item.id, current)
			return this.upsertCore(mergeTaskMessageMetadata(current, item))
		})
	}

	public async repairDelegationFailure(taskId: string, receipt: DelegationAction): Promise<void> {
		// Protect metadata/result ordering from participating cancellation/replacement
		// writers. No Task callback is used: its runtime may already be disposed.
		await this.withLock(async () => {
			const current = await this.readAuthoritative(taskId)
			assertNoCompletionPrefix(current, await this.readOptionalHistory(current.parentTaskId))
			const action = delegationState(current).actions.find((entry) => entry.operationId === receipt.operationId)
			if (
				!action ||
				action.phase === "committed" ||
				action.phase === "prepared" ||
				action.phase === "uncertain" ||
				action.resultWritten
			)
				return
			if (!deepEqual(action, receipt)) throw new ExecutionAuthorityError("receipt_mismatch")
			await saveDelegationFailureResult(taskId, this.globalStoragePath, action)
			const messages = await readTaskMessages({ taskId, globalStoragePath: this.globalStoragePath })
			const messageId = `delegation:${action.operationId}:error`
			if (!messages.some((message) => message.messageId === messageId)) {
				messages.push({ ts: action.resultTs, messageId, type: "say", say: "error", text: action.reason })
			}
			await saveTaskMessages({ taskId, globalStoragePath: this.globalStoragePath, messages, merge: true })
			const updated = reconcileDelegationResult(current, action)
			await safeWriteJson(await this.getTaskFilePath(taskId), updated, {
				merge: (disk) => {
					if (!deepEqual(disk, current))
						throw new LifecycleTransitionError(`History changed during result repair for ${taskId}`)
					return updated
				},
			})
			this.cache.set(taskId, updated)
		})
	}

	public createDelegationChild(item: HistoryItem): Promise<void> {
		return this.withLock(async () => {
			if (item.execution !== undefined) throw new ExecutionAuthorityError("metadata_missing")
			// The directory reservation happens before Task construction. An existing
			// directory is never reused or removed, even if its metadata is missing.
			const directory = path.dirname(await this.getTaskFilePath(item.id))
			await fs.mkdir(directory)
			await safeWriteJson(await this.getTaskFilePath(item.id), item)
			await saveTaskMessages({
				taskId: item.id,
				globalStoragePath: this.globalStoragePath,
				messages: [{ ts: item.ts, type: "say", say: "text", text: item.task }],
			})
			await saveApiMessages({
				taskId: item.id,
				globalStoragePath: this.globalStoragePath,
				messages: [{ ts: item.ts, role: "user", content: item.task }],
			})
			this.cache.set(item.id, item)
		})
	}

	/** Paused child allocation under the exact durable reservation; guardExecution stays blocked until parent commit. */
	public claimDelegationChild(
		item: HistoryItem,
		owner: ExecutionOwner,
		parentToken: ExecutionToken,
		receipt: DelegationAction,
	): Promise<ExecutionCommandResult> {
		return this.withLock(async () => {
			try {
				this.assertLocalOwner(owner)
				this.assertLocalOwner(parentToken.owner)
				const parent = await this.readAuthoritative(parentToken.taskId)
				const claim = assertExecutionToken(parent, parentToken)
				assertNoCompletionPrefix(parent)
				if (claim.phase === "settled" || claim.cleanupPending)
					throw new ExecutionAuthorityError("cleanup_pending")
				if (
					receipt.phase !== "prepared" ||
					!deepEqual(receipt.executionToken, parentToken) ||
					!deepEqual(
						delegationState(parent).actions.find((entry) => entry.operationId === receipt.operationId),
						receipt,
					) ||
					!deepEqual(parent.pendingAction, receipt.intent) ||
					parent.lifecycleRevision !== receipt.revision + 1 ||
					receipt.childId !== item.id ||
					item.parentTaskId !== parent.id ||
					item.delegationOrigin?.operationId !== receipt.operationId ||
					item.delegationOrigin.parentId !== parent.id
				)
					throw new ExecutionAuthorityError("receipt_mismatch")
				if (!this.isSafeTaskId(item.id)) throw new ExecutionAuthorityError("history_invalid")
				const updated = claimNewExecution(item, owner)
				// Exclusive reservation, not redundant mkdir before safeWriteJson.
				await fs.mkdir(path.dirname(await this.getTaskFilePath(item.id)))
				await safeWriteJson(await this.getTaskFilePath(item.id), updated)
				await saveTaskMessages({
					taskId: item.id,
					globalStoragePath: this.globalStoragePath,
					messages: [{ ts: item.ts, type: "say", say: "text", text: item.task }],
				})
				await saveApiMessages({
					taskId: item.id,
					globalStoragePath: this.globalStoragePath,
					messages: [{ ts: item.ts, role: "user", content: item.task }],
				})
				this.cache.set(item.id, updated)
				return { kind: "applied", history: updated, token: executionToken(updated) }
			} catch (error) {
				const reason = this.refusalReason(error)
				if (reason) return { kind: "refused", reason }
				throw error
			}
		})
	}

	public deleteUncommittedDelegationChild(parentId: string, receipt: DelegationAction): Promise<void> {
		return this.withLock(async () => {
			const parent = await this.readAuthoritative(parentId)
			const action = delegationState(parent).actions.find((entry) => entry.operationId === receipt.operationId)
			if (!action || action.phase !== "failed" || parent.awaitingChildId === receipt.childId) return
			const child = await this.readAuthoritative(receipt.childId)
			if (
				child.delegationOrigin?.operationId !== receipt.operationId ||
				child.delegationOrigin.parentId !== parentId ||
				child.childIds?.length ||
				child.execution !== undefined
			)
				return
			await fs.rm(path.dirname(await this.getTaskFilePath(child.id)), { recursive: true })
			this.cache.delete(child.id)
		})
	}

	/**
	 * Get all history items, sorted by timestamp descending (newest first).
	 */
	getAll(): HistoryItem[] {
		return Array.from(this.cache.values()).sort((a, b) => b.ts - a.ts)
	}

	/**
	 * Get history items filtered by workspace path.
	 */
	getByWorkspace(workspace: string): HistoryItem[] {
		return this.getAll().filter((item) => item.workspace === workspace)
	}

	// ────────────────────────────── Mutations ──────────────────────────────

	/**
	 * Insert or update a history item.
	 *
	 * Writes the per-task file immediately (source of truth)
	 * and updates the in-memory cache.
	 */
	async upsert(item: HistoryItem): Promise<HistoryItem[]> {
		return this.withLock(() => this.upsertCore(item))
	}

	/**
	 * Core upsert logic — must only be called from within `withLock`.
	 *
	 * Enforces state-machine transition rules when `item.status` changes.
	 */
	private async upsertCore(item: HistoryItem): Promise<HistoryItem[]> {
		let existing = this.cache.get(item.id)
		const disk = await this.readOptionalHistory(item.id)
		if (!disk && (item.execution !== undefined || item.delegatedCompletion !== undefined))
			throw new ExecutionAuthorityError("metadata_missing")
		if (disk?.execution !== undefined || disk?.delegatedCompletion !== undefined) {
			this.cache.set(item.id, disk)
			existing = disk
			item = mergeTaskMessageMetadata(disk, item)
		}

		// Enforce transition validity at the write boundary so that any caller
		// (including fire-and-forget saves) cannot silently stomp a terminal status.
		// Skip when there is no existing record — first insert has no prior state to transition from.
		// Normalize existing.status (undefined = legacy "active") before comparing so that writing
		// status: "active" onto a legacy item without a status field is not treated as a transition.
		if (existing && item.status !== undefined) {
			const normalizedExisting: HistoryItemStatus = existing.status ?? "active"
			if (item.status !== normalizedExisting) {
				try {
					assertValidTransition(existing.status, item.status)
				} catch (cacheError) {
					// Cache may be stale from a peer write. Re-read disk
					// under the store lock before rejecting the transition.
					const diskItem = await this.readTaskFile(item.id)
					if (!diskItem) {
						throw cacheError
					}
					assertValidTransition(diskItem.status, item.status)
				}
			}
		}

		// Merge: preserve existing metadata unless explicitly overwritten
		const merged = existing ? { ...existing, ...item } : item

		const delta = existing ? this.buildDelta(item.id, existing, item) : { ...item }
		let written: HistoryItem
		try {
			written = await this.writeTaskFile(merged, delta)
		} catch (error) {
			if (error instanceof DeltaRejectedError) {
				const diskItem = await this.readTaskFile(item.id)
				if (diskItem) {
					this.cache.set(item.id, diskItem)
				}
				throw error
			}
			throw error
		}

		// Update in-memory cache with what was actually persisted
		this.cache.set(written.id, written)

		const all = this.getAll()

		// Call onWrite callback inside the lock for serialized write-through
		if (this.onWrite) {
			await this.onWrite(all)
		}

		return all
	}

	/**
	 * Delete a single task's history item.
	 */
	async delete(taskId: string): Promise<void> {
		return this.withLock(async () => {
			await this.assertDeletionAllowed(taskId)
			this.cache.delete(taskId)
			this.taskFileMtimes.delete(taskId)

			// Remove per-task file (best-effort)
			try {
				const filePath = await this.getTaskFilePath(taskId)
				await fs.unlink(filePath)
			} catch {
				// File may already be deleted
			}

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	/**
	 * Delete multiple tasks' history items in a batch.
	 */
	async deleteMany(taskIds: string[]): Promise<void> {
		return this.withLock(async () => {
			for (const taskId of taskIds) await this.assertDeletionAllowed(taskId)
			for (const taskId of taskIds) {
				this.cache.delete(taskId)
				this.taskFileMtimes.delete(taskId)

				try {
					const filePath = await this.getTaskFilePath(taskId)
					await fs.unlink(filePath)
				} catch {
					// File may already be deleted
				}
			}

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	private async assertDeletionAllowed(taskId: string): Promise<void> {
		const current = await this.readOptionalHistory(taskId)
		if (!current) return
		assertNoCompletionPrefix(current, await this.readOptionalHistory(current.parentTaskId))
		if (current.execution !== undefined && executionClaim(current).phase !== "settled")
			throw new ExecutionAuthorityError("cleanup_pending")
	}

	// ────────────────────────────── Reconciliation ──────────────────────────────

	/**
	 * Scan task directories and fix any drift between disk and cache.
	 *
	 * - Tasks on disk but missing from cache: read and add
	 * - Tasks in cache but missing from disk: remove
	 */
	async reconcile(options: { forceRefresh?: boolean } = {}): Promise<void> {
		// Run through the write lock to prevent interleaving with upsert/delete
		return this.withLock(async () => {
			const tasksDir = await this.getTasksDir()

			let dirEntries: string[]
			try {
				dirEntries = await fs.readdir(tasksDir)
			} catch {
				return // tasks dir doesn't exist yet
			}

			// Filter out hidden and reserved names
			const taskDirNames = dirEntries.filter((name) => !name.startsWith("_") && !name.startsWith("."))

			const onDiskIds = new Set(taskDirNames)
			const cacheIds = new Set(this.cache.keys())
			const liveIds = new Set<string>()

			for (const taskId of onDiskIds) {
				try {
					const taskFilePath = await this.getTaskFilePath(taskId)
					const { mtimeMs } = await fs.stat(taskFilePath)
					liveIds.add(taskId)
					if (
						!options.forceRefresh &&
						this.cache.has(taskId) &&
						this.taskFileMtimes.get(taskId) === mtimeMs
					) {
						continue
					}

					const item = await this.readTaskFile(taskId)
					if (item?.id === taskId) {
						const previous = this.cache.get(taskId)
						this.taskFileMtimes.set(taskId, mtimeMs)
						if (!deepEqual(previous, item)) {
							this.cache.set(taskId, item)
						}
					}
				} catch {
					// File may be temporarily absent during a peer's atomic
					// rename window in safeWriteJson. The advisory lock is
					// held for the entire write, so its presence means a
					// write is in progress — keep the task live.
					try {
						const lockPath = (await this.getTaskFilePath(taskId)) + ".lock"
						const lockStat = await fs.stat(lockPath)
						if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) {
							liveIds.add(taskId)
						}
					} catch {
						// No lock file — file is genuinely absent
					}
				}
			}

			// Evict tasks whose history_item.json no longer exists
			for (const taskId of cacheIds) {
				if (!liveIds.has(taskId)) {
					this.cache.delete(taskId)
					this.taskFileMtimes.delete(taskId)
				}
			}
		})
	}

	private isSafeTaskId(value: unknown): value is string {
		return (
			typeof value === "string" &&
			value.length > 0 &&
			value !== "." &&
			value !== ".." &&
			!value.includes("/") &&
			!value.includes("\\")
		)
	}

	private isFileNotFoundError(error: unknown): boolean {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
	}

	private async getDelegationRepairIntentPath(): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
	}

	// ────────────────────────────── Cache invalidation ──────────────────────────────

	/**
	 * Invalidate a single task's cache entry (re-read from disk on next access).
	 */
	async invalidate(taskId: string): Promise<void> {
		return this.withLock(async () => {
			try {
				const item = await this.readTaskFile(taskId)
				if (item) {
					this.cache.set(taskId, item)
				} else {
					this.cache.delete(taskId)
				}
				this.taskFileMtimes.delete(taskId)
			} catch {
				this.cache.delete(taskId)
			}
		})
	}

	/**
	 * Clear all in-memory cache entries; a subsequent `reconcile()` repopulates them from task files.
	 */
	async invalidateAll(): Promise<void> {
		return this.withLock(async () => {
			this.cache.clear()
		})
	}

	// ────────────────────────────── Migration ──────────────────────────────

	/**
	 * Migrate from globalState taskHistory array to per-task files.
	 *
	 * For each entry in the globalState array, writes a `history_item.json`
	 * file if one doesn't already exist. This is idempotent and safe to re-run.
	 */
	async migrateFromGlobalState(taskHistoryEntries: HistoryItem[]): Promise<void> {
		if (!taskHistoryEntries || taskHistoryEntries.length === 0) {
			return
		}

		await this.withLock(async () => {
			const tasksDir = await this.getTasksDir()

			for (const item of taskHistoryEntries) {
				if (!item.id) {
					continue
				}

				// Check if task directory exists on disk
				const taskDir = path.join(tasksDir, item.id)

				try {
					await fs.access(taskDir)
				} catch {
					// Task directory doesn't exist; skip this entry as it's orphaned in globalState
					continue
				}

				// Write history_item.json if it doesn't exist yet
				const filePath = path.join(taskDir, GlobalFileNames.historyItem)
				try {
					await fs.access(filePath)
					// File already exists, skip (don't overwrite existing per-task files)
				} catch {
					// File doesn't exist, write it
					await safeWriteJson(filePath, item)
					this.cache.set(item.id, item)
				}
			}
		})
	}

	// ────────────────────────────── Private: Per-task file I/O ──────────────────────────────

	/**
	 * Return only the fields in `incoming` that differ from `cached`.
	 */
	private computeDelta(cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
		return computeHistoryDelta(cached, incoming)
	}

	private buildDelta(id: string, cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
		return { id, ...this.computeDelta(cached, incoming) }
	}

	/**
	 * Write a HistoryItem to its per-task `history_item.json` file.
	 *
	 * When `delta` is provided, the merge callback applies only the
	 * delta to the current disk state, so fields written by another
	 * process are preserved. Without a delta the full item is written
	 * as-is (used by administrative repair paths that are authoritative).
	 */
	private async writeTaskFile(item: HistoryItem, delta?: Partial<HistoryItem>): Promise<HistoryItem> {
		const filePath = await this.getTaskFilePath(item.id)
		if (delta) {
			let written: HistoryItem = item
			const mergeFn = mergeWithDisk(delta)
			await safeWriteJson(filePath, item, {
				merge: (existing, incoming) => {
					const result = mergeFn(existing, incoming)
					written = result as HistoryItem
					return result
				},
			})
			return written
		} else {
			await safeWriteJson(filePath, item)
			return item
		}
	}

	/**
	 * Read a HistoryItem from its per-task `history_item.json` file.
	 */
	private async readTaskFile(taskId: string): Promise<HistoryItem | null> {
		const filePath = await this.getTaskFilePath(taskId)

		try {
			const raw = await fs.readFile(filePath, "utf8")
			const item: HistoryItem = JSON.parse(raw)
			return item.id ? item : null
		} catch {
			return null
		}
	}

	// ────────────────────────────── Private: fs.watch ──────────────────────────────

	/**
	 * Watch the tasks directory for changes from other instances.
	 */
	private startWatcher(): void {
		if (this.disposed) {
			return
		}

		// Use a debounced handler to avoid excessive reconciliation
		let watchDebounce: ReturnType<typeof setTimeout> | null = null

		this.getTasksDir()
			.then((tasksDir) => {
				if (this.disposed) {
					return
				}

				try {
					this.fsWatcher = fsSync.watch(tasksDir, { recursive: false }, (_eventType, _filename) => {
						if (this.disposed) {
							return
						}

						// Debounce the reconciliation triggered by fs.watch
						if (watchDebounce) {
							clearTimeout(watchDebounce)
						}
						watchDebounce = setTimeout(() => {
							this.reconcile().catch((err) => {
								console.error("[TaskHistoryStore] Reconciliation after fs.watch failed:", err)
							})
						}, 500)
					})

					this.fsWatcher.on("error", (err) => {
						console.error("[TaskHistoryStore] fs.watch error:", err)
						// fs.watch is unreliable on some platforms; periodic reconciliation
						// serves as the fallback.
					})
				} catch (err) {
					console.error("[TaskHistoryStore] Failed to start fs.watch:", err)
				}
			})
			.catch((err) => {
				console.error("[TaskHistoryStore] Failed to get tasks dir for watcher:", err)
			})
	}

	/**
	 * Start periodic reconciliation as a defensive fallback for platforms
	 * where fs.watch is unreliable.
	 */
	private startPeriodicReconciliation(): void {
		if (this.disposed) {
			return
		}

		this.reconcileTimer = setTimeout(async () => {
			if (this.disposed) {
				return
			}
			try {
				await this.reconcile()
			} catch (err) {
				console.error("[TaskHistoryStore] Periodic reconciliation failed:", err)
			}
			this.startPeriodicReconciliation()
		}, TaskHistoryStore.RECONCILE_INTERVAL_MS)
	}

	// ────────────────────────────── Atomic read-modify-write ──────────────────────────────

	/**
	 * Read a HistoryItem from the in-memory cache and write back an updated version,
	 * all within a single lock acquisition so no concurrent writer can interleave
	 * between the read and the write.
	 *
	 * The `updater` receives the current cached item and must return the new item
	 * synchronously. It must not perform I/O or acquire any other lock.
	 *
	 * @throws If the task ID is not present in the cache.
	 */
	public atomicReadAndUpdate(taskId: string, updater: (current: HistoryItem) => HistoryItem): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			const current = this.cache.get(taskId)
			if (!current) {
				throw new Error(`[TaskHistoryStore] atomicReadAndUpdate: task ${taskId} not found in cache`)
			}
			// Deep-copy so a mutating updater cannot alter cached state before persistence.
			const snapshot = structuredClone(current)
			const updated = updater(snapshot)
			if (updated.id !== taskId) {
				throw new Error(
					`[TaskHistoryStore] atomicReadAndUpdate: updater changed task id from ${taskId} to ${updated.id}`,
				)
			}
			return this.upsertCore(updated)
		})
	}

	/**
	 * Update two related HistoryItems within a single in-process lock acquisition.
	 * Both updaters run synchronously (no I/O, no lock re-entry). Both writes
	 * complete before the lock releases, so no in-process reader can observe an
	 * intermediate state. Cross-process atomicity is NOT guaranteed — each
	 * writeTaskFile call acquires and releases its own advisory file lock.
	 *
	 * @throws If either task ID is not present in the cache.
	 */
	public atomicUpdatePair(
		firstId: string,
		secondId: string,
		firstUpdater: (current: HistoryItem) => HistoryItem,
		secondUpdater: (current: HistoryItem) => HistoryItem,
	): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			const first = this.cache.get(firstId)
			if (!first) throw new Error(`[TaskHistoryStore] atomicUpdatePair: ${firstId} not found`)
			const second = this.cache.get(secondId)
			if (!second) throw new Error(`[TaskHistoryStore] atomicUpdatePair: ${secondId} not found`)

			const updatedFirst = firstUpdater(structuredClone(first))
			const updatedSecond = secondUpdater(structuredClone(second))

			if (updatedFirst.id !== firstId) {
				throw new Error(
					`[TaskHistoryStore] atomicUpdatePair: first updater changed id from ${firstId} to ${updatedFirst.id}`,
				)
			}
			if (updatedSecond.id !== secondId) {
				throw new Error(
					`[TaskHistoryStore] atomicUpdatePair: second updater changed id from ${secondId} to ${updatedSecond.id}`,
				)
			}

			// Validate status transitions before any disk write — mirrors upsertCore guard.
			for (const [existing, updated] of [
				[first, updatedFirst],
				[second, updatedSecond],
			] as const) {
				if (updated.status !== undefined) {
					const normalizedExisting: HistoryItemStatus = existing.status ?? "active"
					if (updated.status !== normalizedExisting) {
						assertValidTransition(existing.status, updated.status)
					}
				}
			}

			// Merge with existing cache entries before writing, mirroring upsertCore.
			const mergedFirst = { ...first, ...updatedFirst }
			const mergedSecond = { ...second, ...updatedSecond }

			const writtenFirst = await this.writeTaskFile(mergedFirst, this.buildDelta(firstId, first, updatedFirst))
			let writtenSecond: HistoryItem
			try {
				writtenSecond = await this.writeTaskFile(mergedSecond, this.buildDelta(secondId, second, updatedSecond))
			} catch (error) {
				// First record is committed on disk. Update cache so it
				// reflects disk state before propagating the error.
				this.cache.set(firstId, writtenFirst)
				throw error
			}

			// Both disk writes succeeded — now update the cache.
			this.cache.set(firstId, writtenFirst)
			this.cache.set(secondId, writtenSecond)

			const all = this.getAll()
			if (this.onWrite) {
				await this.onWrite(all)
			}
			return all
		})
	}

	// ────────────────────────────── Private: Write lock ──────────────────────────────

	/**
	 * Serializes all read-modify-write operations within a single extension
	 * host process to prevent concurrent interleaving.
	 */
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const coordinated = async () => {
			// Lock order: local queue turn -> storage lifecycle lock -> per-file lock.
			// No caller may invoke another store method from a locked callback.
			const storage = await getStorageBasePath(this.globalStoragePath)
			await fs.mkdir(storage, { recursive: true })
			const base = await fs.realpath(storage)
			const release = await lockfile.lock(path.join(base, ".task-lifecycle"), {
				realpath: false,
				stale: LOCK_STALE_MS,
				retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
			})
			try {
				return await fn()
			} finally {
				await release()
			}
		}
		const result = this.writeLock.then(coordinated, coordinated)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	// ────────────────────────────── Private: Path helpers ──────────────────────────────

	/**
	 * Get the tasks base directory path, resolving custom storage paths.
	 */
	private async getTasksDir(): Promise<string> {
		const basePath = await getStorageBasePath(this.globalStoragePath)
		return path.join(basePath, "tasks")
	}

	/**
	 * Get the path to a task's `history_item.json` file.
	 */
	private async getTaskFilePath(taskId: string): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, taskId, GlobalFileNames.historyItem)
	}
}
