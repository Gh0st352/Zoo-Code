import deepEqual from "fast-deep-equal"
import type { HistoryItem } from "@roo-code/types"

import { type HistoryItemStatus, VALID_TASK_STATUS_TRANSITIONS } from "./taskLifecycle"

export class DeltaRejectedError extends Error {
	constructor(
		public readonly taskId: string,
		public readonly diskStatus: HistoryItemStatus,
		public readonly attemptedStatus: HistoryItemStatus,
	) {
		super(`Delta rejected for task ${taskId}: disk status ${diskStatus} rejects transition to ${attemptedStatus}`)
		this.name = "DeltaRejectedError"
	}
}

export function computeHistoryDelta(cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
	return Object.fromEntries(
		Object.entries(incoming).filter(([key, value]) => !deepEqual(value, (cached as Record<string, unknown>)[key])),
	) as Partial<HistoryItem>
}

export function mergeTaskMessageMetadata(current: HistoryItem, item: HistoryItem): HistoryItem {
	const {
		status: _status,
		parentTaskId: _parent,
		rootTaskId: _root,
		awaitingChildId: _awaiting,
		delegatedToId: _delegated,
		childIds: _children,
		pendingAction: _pending,
		delegation: _action,
		lifecycleRevision: _revision,
		executionGeneration: _generation,
		delegationOrigin: _origin,
		execution: _execution,
		delegatedCompletion: _completion,
		lineageProvenance: _provenance,
		completedByChildId: _completedBy,
		completionResultSummary: _summary,
		...metadata
	} = item
	return { ...current, ...metadata }
}

export function mergeHistoryDelta(existing: unknown, incoming: HistoryItem, delta: Partial<HistoryItem>): HistoryItem {
	if (!existing || typeof existing !== "object" || !("id" in existing)) {
		// First message-derived insert may describe a task, never grant execution authority.
		const {
			execution: _execution,
			delegatedCompletion: _completion,
			delegation: _delegation,
			executionGeneration: _generation,
			lifecycleRevision: _revision,
			...metadata
		} = incoming
		return metadata
	}
	const disk = existing as HistoryItem
	const normalizedDelta = { ...delta }
	// Action receipts and execution authority are command-owned, never ordinary
	// metadata deltas. Unknown future versions must survive old runtime snapshots.
	for (const key of [
		"delegation",
		"executionGeneration",
		"lifecycleRevision",
		"delegationOrigin",
		"execution",
		"delegatedCompletion",
		"lineageProvenance",
	] as const) {
		delete normalizedDelta[key]
	}
	// Claimed records require authoritative commands for ALL lifecycle/action changes.
	if (disk.execution !== undefined || disk.delegatedCompletion !== undefined) {
		return mergeTaskMessageMetadata(disk, { ...disk, ...normalizedDelta })
	}
	if ("status" in delta) {
		const diskStatus: HistoryItemStatus = disk.status ?? "active"
		const attemptedStatus: HistoryItemStatus = delta.status ?? "active"
		if (attemptedStatus !== diskStatus) {
			const validTargets = VALID_TASK_STATUS_TRANSITIONS[diskStatus]
			if (!validTargets.includes(attemptedStatus)) {
				throw new DeltaRejectedError(disk.id, diskStatus, attemptedStatus)
			}
		}
		normalizedDelta.status = attemptedStatus
	}
	const merged = { ...disk, ...normalizedDelta }
	if (
		disk.delegation &&
		["status", "parentTaskId", "rootTaskId", "awaitingChildId", "delegatedToId"].some(
			(key) =>
				key in normalizedDelta &&
				!deepEqual(normalizedDelta[key as keyof HistoryItem], disk[key as keyof HistoryItem]),
		)
	) {
		merged.lifecycleRevision = (disk.lifecycleRevision ?? 0) + 1
	}
	if (normalizedDelta.childIds && disk.childIds) {
		merged.childIds = [...new Set([...disk.childIds, ...normalizedDelta.childIds])]
	}
	return merged
}
