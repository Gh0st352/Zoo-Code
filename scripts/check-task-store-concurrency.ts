import assert from "node:assert/strict"
import type { DelegatedCompletionReceipt, DelegatedCompletionRequest, HistoryItem } from "../packages/types/src/history"

import {
	abandonDelegatedChild,
	interruptDelegatedChild,
	assertExecutionAllowed,
	hasExactDelegation,
	commitDelegatedCompletion,
	completionState,
	executionToken,
	LifecycleTransitionError,
	prepareDelegatedCompletion,
	previewTaskRecovery,
	recoverTaskExecution,
	settleExecution,
	validateCompletionPrefix,
	validateDelegatedCompletion,
} from "../src/core/task-persistence/taskLifecycle"
import { completionRequest, delegate, finishChild, ownedTask } from "./check-task-execution-protocol"
import {
	computeHistoryDelta,
	DeltaRejectedError,
	mergeHistoryDelta,
	mergeTaskMessageMetadata,
} from "../src/core/task-persistence/taskStoreConcurrency"

const hosts = ["A", "B"] as const
type Host = (typeof hosts)[number]
type TaskId = "parent" | "child-a" | "child-b"
type OperationId =
	| "metadata-a"
	| "metadata-b"
	| "distinct-a"
	| "distinct-b"
	| "complete-a"
	| "redelegate-b"
	| "stale-save-a"
	| "abandon-b"
	| "reject-a"
type RecordMap = Partial<Record<TaskId, HistoryItem>>

interface PreparedWrite {
	taskId: TaskId
	incoming: HistoryItem
	delta: Partial<HistoryItem>
	expected?: HistoryItem
}

interface OperationState {
	phase: "idle" | "read" | "prepared" | "revalidated" | "done" | "rejected" | "failed"
	snapshot?: RecordMap
	writes?: PreparedWrite[]
	writeIndex: number
	candidate?: HistoryItem
	request?: DelegatedCompletionRequest
	receipt?: DelegatedCompletionReceipt
}

interface CommitEntry {
	operationId: OperationId
	taskId: TaskId
	previous?: HistoryItem
	delta: Partial<HistoryItem>
	next: HistoryItem
}

interface ModelState {
	disk: RecordMap
	caches: Record<Host, RecordMap>
	hostMutexes: Partial<Record<Host, OperationId>>
	storageMutex?: OperationId
	locks: Partial<Record<TaskId, OperationId>>
	operations: Partial<Record<OperationId, OperationState>>
	commits: CommitEntry[]
	transcripts: Array<{ parentId: string; childId: string; actionId: string; result: string }>
}

interface OperationSpec {
	id: OperationId
	host: Host
	externalSnapshot?: boolean
	allowRefreshAfterRead?: boolean
	publishCacheAtEnd?: boolean
	authoritative?: boolean
	isEnabled?(snapshot: RecordMap): boolean
	buildWrites(snapshot: RecordMap): HistoryItem[]
}

interface Scenario {
	name: string
	operations: OperationSpec[]
	check(state: ModelState): string[]
}

interface TraceStep {
	action: string
	state: ModelState
}

const MAX_DEPTH = 32
const MAX_STATES = 100_000
const commonInvariantNames = [
	"host mutex ownership",
	"storage command mutex ownership",
	"message metadata cannot restore detached lineage (#1021)",
	"file lock ownership",
	"disk field preservation",
	"childIds union",
	"pair write order",
	"whole-delta rejection",
	"old completion cannot clear newer handoff or orphan its live child (#1469)",
	"completion authority before transcript effect; refused completion has no effects",
	"durable completion prefix before transcript and child-before-parent commit",
	"claimed live links require exact ownership or a nonexecuting allocation prefix",
] as const
const expectedPhases = ["read", "prepare", "revalidate", "commit", "refresh", "reject", "fail", "transcript"] as const
const semanticLandmarks = {
	"stale-cache-newer-disk": (state: ModelState) =>
		state.commits.length > 0 &&
		hosts.some((host) =>
			(Object.keys(state.disk) as TaskId[]).some(
				(taskId) => canonical(state.caches[host][taskId]) !== canonical(state.disk[taskId]),
			),
		),
	"pair-first-commit-second-pending": (state: ModelState) =>
		(["complete-a", "abandon-b"] as OperationId[]).some((operationId) => {
			const operation = state.operations[operationId]
			return (
				operation?.writeIndex === (operationId === "complete-a" ? 2 : 1) &&
				(operation.phase === "prepared" || operation.phase === "revalidated") &&
				state.commits.filter((entry) => entry.operationId === operationId).length === operation.writeIndex
			)
		}),
	"pair-first-commit-second-failed": (state: ModelState) =>
		state.operations["complete-a"]?.phase === "failed" &&
		state.commits.filter((entry) => entry.operationId === "complete-a").length === 2 &&
		state.caches.A["child-a"]?.status === "completed" &&
		state.caches.A.parent?.status === "delegated",
	"old-causal-schedule-refused-without-transcript": (state: ModelState) =>
		state.operations["complete-a"]?.phase === "rejected" &&
		state.operations["complete-a"].snapshot?.parent?.awaitingChildId === "child-a" &&
		state.operations["redelegate-b"]?.phase === "done" &&
		state.disk.parent?.awaitingChildId === "child-b" &&
		state.transcripts.length === 0 &&
		!state.commits.some((entry) => entry.operationId === "complete-a"),
} satisfies Record<string, (state: ModelState) => boolean>

function item(id: TaskId, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id,
		number: id === "parent" ? 0 : id === "child-a" ? 1 : 2,
		ts: id === "parent" ? 0 : id === "child-a" ? 1 : 2,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		childIds: [],
		...overrides,
	}
}

function baseRecords(): RecordMap {
	return {
		parent: item("parent", {
			status: "delegated",
			awaitingChildId: "child-a",
			delegatedToId: "child-a",
			childIds: ["child-a"],
		}),
		"child-a": item("child-a", { parentTaskId: "parent", rootTaskId: "parent" }),
	}
}

function claimedRecords(): RecordMap {
	const graph = delegate(ownedTask("parent"), "child-a")
	return { parent: graph.parent, "child-a": finishChild(graph.child) }
}

function clone<T>(value: T): T {
	return structuredClone(value)
}

function initialState(operationIds: OperationId[], disk = baseRecords()): ModelState {
	return {
		disk: clone(disk),
		caches: { A: clone(disk), B: clone(disk) },
		hostMutexes: {},
		locks: {},
		operations: Object.fromEntries(
			operationIds.map((id) => [id, { phase: "idle", writeIndex: 0 } satisfies OperationState]),
		),
		commits: [],
		transcripts: [],
	}
}

function getRequired(records: RecordMap, taskId: TaskId): HistoryItem {
	const record = records[taskId]
	if (!record) throw new Error(`Model setup is missing ${taskId}`)
	return record
}

const operationSpecs: Record<OperationId, OperationSpec> = {
	"metadata-a": {
		id: "metadata-a",
		host: "A",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), mode: "architect" }],
	},
	"metadata-b": {
		id: "metadata-b",
		host: "B",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), totalCost: 42 }],
	},
	"distinct-a": {
		id: "distinct-a",
		host: "A",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), mode: "architect" }],
	},
	"distinct-b": {
		id: "distinct-b",
		host: "B",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "child-a"), totalCost: 42 }],
	},
	"complete-a": {
		id: "complete-a",
		host: "A",
		externalSnapshot: true,
		authoritative: true,
		isEnabled: (snapshot) => {
			const parent = snapshot.parent
			const child = snapshot["child-a"]
			return (
				(parent?.status === "delegated" || parent?.status === "active") &&
				parent.awaitingChildId === "child-a" &&
				(child?.status === "active" || child?.status === "interrupted")
			)
		},
		// Completion uses its captured immutable request, not a freshly invented approval.
		buildWrites: () => {
			throw new Error("Completion must use the authoritative receipt path")
		},
	},
	"redelegate-b": {
		id: "redelegate-b",
		host: "B",
		authoritative: true,
		isEnabled: (snapshot) =>
			snapshot.parent?.status === "delegated" &&
			snapshot.parent.awaitingChildId === "child-a" &&
			snapshot["child-a"]?.status === "active",
		buildWrites: (snapshot) => {
			const parent = getRequired(snapshot, "parent")
			const child = getRequired(snapshot, "child-a")
			// Composite competitor: cleanup/settlement, explicit retain-delegation recovery,
			// then reserve/claim/commit. These are reducer endpoints, not a physical transaction.
			const interrupted = settleExecution(child, executionToken(child), true)
			const settled = settleExecution(parent, executionToken(parent), true)
			const preview = previewTaskRecovery(settled, undefined, interrupted)
			const resumed = recoverTaskExecution(
				settled,
				{
					scope: preview.scope,
					intent: "explicit_user_resume",
					choice: "retain_delegation",
					owner: executionToken(parent).owner,
				},
				undefined,
				interrupted,
			)
			const replacement = delegate(resumed, "child-b", undefined, interrupted)
			return [interrupted, replacement.child, replacement.parent]
		},
	},
	"stale-save-a": {
		id: "stale-save-a",
		host: "A",
		externalSnapshot: true,
		allowRefreshAfterRead: true,
		buildWrites: (snapshot) => {
			const stale = getRequired(snapshot, "child-a")
			return [{ ...stale, tokensOut: stale.tokensOut + 1 }]
		},
	},
	"abandon-b": {
		id: "abandon-b",
		host: "B",
		publishCacheAtEnd: true,
		isEnabled: (snapshot) =>
			snapshot.parent?.status === "delegated" &&
			snapshot.parent.awaitingChildId === "child-a" &&
			snapshot["child-a"]?.status === "active",
		buildWrites: (snapshot) => {
			const parent = getRequired(snapshot, "parent")
			const interrupted = interruptDelegatedChild(parent, getRequired(snapshot, "child-a"))
			const abandoned = abandonDelegatedChild(parent, interrupted)
			return [abandoned.child, abandoned.parent]
		},
	},
	"reject-a": {
		id: "reject-a",
		host: "A",
		buildWrites: (snapshot) => [
			{ ...getRequired(snapshot, "parent"), status: "interrupted", mode: "must-not-commit" },
		],
	},
}

function prepareWrites(state: ModelState, spec: OperationSpec, operation: OperationState): PreparedWrite[] {
	let records: HistoryItem[]
	if (spec.id === "complete-a") {
		const parent = getRequired(state.disk, "parent")
		const child = getRequired(state.disk, "child-a")
		assert(operation.request)
		assert.equal(validateDelegatedCompletion(parent, child, operation.request), undefined)
		const prepared = prepareDelegatedCompletion(parent, child, operation.request)
		operation.receipt = completionState(prepared).receipts[0]!
		const completed = commitDelegatedCompletion(prepared, child, operation.receipt)
		records = [prepared, completed.child, completed.parent]
	} else records = spec.buildWrites(spec.authoritative ? state.disk : operation.snapshot!)
	const expected = clone(state.disk)
	return records.map((built) => {
		const taskId = built.id as TaskId
		const cached = spec.authoritative
			? expected[taskId]
			: spec.id === "stale-save-a"
				? state.disk[taskId]
				: state.caches[spec.host][taskId]
		// updateMessageMetadata uses fresh disk authority, discarding ALL protected
		// lifecycle/lineage fields in the captured stale live-task metadata.
		const incoming = spec.id === "stale-save-a" && cached ? mergeTaskMessageMetadata(cached, built) : built
		const write = {
			taskId,
			incoming,
			delta: cached ? { id: taskId, ...computeHistoryDelta(cached, incoming) } : { ...incoming },
			...(spec.authoritative ? { expected: cached } : {}),
		}
		expected[taskId] = incoming
		return write
	})
}

function transition(state: ModelState, action: string, mutate: (next: ModelState) => void): TraceStep {
	const next = clone(state)
	mutate(next)
	return { action, state: next }
}

function nextSteps(state: ModelState, scenario: Scenario): TraceStep[] {
	const result: TraceStep[] = []
	for (const spec of scenario.operations) {
		const operation = state.operations[spec.id]!
		if (
			operation.phase === "idle" &&
			!state.hostMutexes[spec.host] &&
			(spec.externalSnapshot || !state.storageMutex) &&
			(spec.isEnabled?.(state.caches[spec.host]) ?? true)
		) {
			result.push(
				transition(state, `${spec.id}.read`, (next) => {
					const target = next.operations[spec.id]!
					if (!spec.externalSnapshot) {
						next.hostMutexes[spec.host] = spec.id
						next.storageMutex = spec.id
					}
					target.phase = "read"
					target.snapshot = clone(next.caches[spec.host])
					if (spec.id === "complete-a")
						target.request = completionRequest(
							getRequired(target.snapshot, "parent"),
							getRequired(target.snapshot, "child-a"),
						)
				}),
			)
		} else if (
			operation.phase === "read" &&
			(!state.storageMutex || state.storageMutex === spec.id) &&
			(spec.externalSnapshot ? !state.hostMutexes[spec.host] : state.hostMutexes[spec.host] === spec.id)
		) {
			result.push(
				transition(state, `${spec.id}.prepare`, (next) => {
					const target = next.operations[spec.id]!
					if (spec.externalSnapshot) {
						next.hostMutexes[spec.host] = spec.id
						next.storageMutex = spec.id
					}
					try {
						target.writes = prepareWrites(next, spec, target)
						target.phase = "prepared"
					} catch (error) {
						if (!(error instanceof LifecycleTransitionError)) throw error
						target.phase = "rejected"
						delete next.hostMutexes[spec.host]
						delete next.storageMutex
					}
				}),
			)
		} else if (operation.phase === "prepared") {
			if (spec.id === "complete-a" && operation.writeIndex === 1 && !state.transcripts.length) {
				result.push(
					transition(state, `${spec.id}.transcript`, (next) => {
						assert.equal(next.storageMutex, spec.id)
						const receipt = next.operations[spec.id]!.receipt!
						validateCompletionPrefix(
							getRequired(next.disk, "parent"),
							getRequired(next.disk, "child-a"),
							receipt,
						)
						assert.equal(receipt.finish.kind, "finish_subtask")
						if (receipt.finish.kind !== "finish_subtask") throw new Error("Invalid finish intent")
						next.transcripts.push({
							parentId: receipt.parentToken.taskId,
							childId: receipt.childToken.taskId,
							actionId: receipt.creating.actionId,
							result: receipt.finish.result,
						})
					}),
				)
				continue
			}
			const write = operation.writes![operation.writeIndex]!
			if (!state.locks[write.taskId]) {
				result.push(
					transition(state, `${spec.id}.revalidate(${write.taskId})`, (next) => {
						const target = next.operations[spec.id]!
						const targetWrite = target.writes![target.writeIndex]!
						next.locks[targetWrite.taskId] = spec.id
						try {
							if (spec.authoritative) {
								assert.deepEqual(
									next.disk[targetWrite.taskId],
									targetWrite.expected,
									"Lifecycle CAS changed under storage lock",
								)
								target.candidate = targetWrite.incoming
							} else
								target.candidate = mergeHistoryDelta(
									next.disk[targetWrite.taskId],
									targetWrite.incoming,
									targetWrite.delta,
								)
							target.phase = "revalidated"
						} catch (error) {
							if (!(error instanceof DeltaRejectedError)) throw error
							target.phase = "rejected"
							delete next.locks[targetWrite.taskId]
							delete next.hostMutexes[spec.host]
							delete next.storageMutex
						}
					}),
				)
			}
		} else if (operation.phase === "revalidated") {
			const write = operation.writes![operation.writeIndex]!
			result.push(
				transition(state, `${spec.id}.commit(${write.taskId})`, (next) => {
					const target = next.operations[spec.id]!
					const targetWrite = target.writes![target.writeIndex]!
					if (next.locks[targetWrite.taskId] !== spec.id || !target.candidate) {
						throw new Error(`${spec.id} committed without owning ${targetWrite.taskId}`)
					}
					const previous = next.disk[targetWrite.taskId]
					next.disk[targetWrite.taskId] = target.candidate
					if (!spec.publishCacheAtEnd) next.caches[spec.host][targetWrite.taskId] = target.candidate
					next.commits.push({
						operationId: spec.id,
						taskId: targetWrite.taskId,
						previous,
						delta: targetWrite.delta,
						next: target.candidate,
					})
					delete next.locks[targetWrite.taskId]
					target.candidate = undefined
					target.writeIndex++
					target.phase = target.writeIndex === target.writes!.length ? "done" : "prepared"
					if (target.phase === "done") {
						if (spec.publishCacheAtEnd) {
							for (const commit of next.commits.filter((entry) => entry.operationId === spec.id)) {
								next.caches[spec.host][commit.taskId] = commit.next
							}
						}
						delete next.hostMutexes[spec.host]
						delete next.storageMutex
					}
				}),
			)
			if (
				(spec.publishCacheAtEnd && operation.writeIndex > 0) ||
				(spec.id === "complete-a" && operation.writeIndex === 2)
			) {
				result.push(
					transition(state, `${spec.id}.fail(${write.taskId})`, (next) => {
						const target = next.operations[spec.id]!
						const targetWrite = target.writes![target.writeIndex]!
						if (next.locks[targetWrite.taskId] !== spec.id) {
							throw new Error(`${spec.id} failed without owning ${targetWrite.taskId}`)
						}
						for (const commit of next.commits.filter((entry) => entry.operationId === spec.id)) {
							next.caches[spec.host][commit.taskId] = commit.next
						}
						target.candidate = undefined
						target.phase = "failed"
						delete next.locks[targetWrite.taskId]
						delete next.hostMutexes[spec.host]
						delete next.storageMutex
					}),
				)
			}
		}
	}

	for (const host of hosts) {
		const hostHasPreparedWork =
			Boolean(state.hostMutexes[host]) ||
			scenario.operations.some((spec) => {
				const operation = state.operations[spec.id]!
				return (
					spec.host === host &&
					(["prepared", "revalidated"].includes(operation.phase) ||
						(operation.phase === "read" && !spec.allowRefreshAfterRead))
				)
			})
		if (!state.storageMutex && !hostHasPreparedWork && canonical(state.caches[host]) !== canonical(state.disk)) {
			result.push(
				transition(state, `${host}.refresh`, (next) => {
					next.caches[host] = clone(next.disk)
				}),
			)
		}
	}
	return result
}

function commonViolations(state: ModelState, scenario: Scenario): string[] {
	const violations: string[] = []
	const replacement = state.commits.find((entry) => entry.operationId === "redelegate-b" && entry.taskId === "parent")
	if (
		replacement &&
		state.disk["child-b"]?.status === "active" &&
		state.disk["child-b"]?.parentTaskId === "parent" &&
		(state.disk.parent?.status !== "delegated" || state.disk.parent.awaitingChildId !== "child-b")
	)
		violations.push("#1469 stale child completion cleared a newer parent handoff / live linked orphan")
	const completion = state.operations["complete-a"]
	for (const child of Object.values(state.disk)) {
		if (!child?.execution || !child.parentTaskId || !["active", "delegated"].includes(child.status!)) continue
		const parent = state.disk[child.parentTaskId as TaskId]
		if (hasExactDelegation(parent, child)) continue
		// Exclusive paused allocation is not a live linked orphan: parent commit still
		// holds the command lock, and the production execution guard must reject it.
		const allocation =
			child.id === "child-b" &&
			state.storageMutex === "redelegate-b" &&
			state.operations["redelegate-b"]?.phase !== "done"
		if (!allocation) violations.push(`Claimed live linked orphan: ${child.id}`)
		else assert.throws(() => assertExecutionAllowed(child, executionToken(child), parent), LifecycleTransitionError)
	}
	if (
		completion?.phase === "rejected" &&
		(state.transcripts.length || state.commits.some((entry) => entry.operationId === "complete-a"))
	)
		violations.push("Refused completion mutated transcript or lifecycle")
	if (state.transcripts.length > 1) violations.push("Duplicate completion result")
	for (const effect of state.transcripts) {
		const prefix = state.commits.find((entry) => entry.operationId === "complete-a" && entry.taskId === "parent")
		if (
			!prefix ||
			prefix.previous?.awaitingChildId !== effect.childId ||
			effect.parentId !== prefix.previous.id ||
			completion?.receipt?.creating.actionId !== effect.actionId
		)
			violations.push("Completion result entered an unowned parent or preceded the prepared receipt")
		if (replacement) violations.push("Old completion result entered a replacement handoff")
	}
	if (completion && completion.writeIndex >= 2 && state.transcripts.length !== 1)
		violations.push("Completion child commit preceded transcript durability")
	if (completion?.receipt && completion.writeIndex > 0 && completion.phase !== "done") {
		validateCompletionPrefix(
			getRequired(state.disk, "parent"),
			getRequired(state.disk, "child-a"),
			completion.receipt,
		)
	}
	if (Object.values(state.hostMutexes).some((owner) => owner !== state.storageMutex))
		violations.push("Host writer lacks storage command mutex")
	for (const [host, owner] of Object.entries(state.hostMutexes) as Array<[Host, OperationId]>) {
		const operation = state.operations[owner]
		if (!operation || !["read", "prepared", "revalidated"].includes(operation.phase)) {
			violations.push(`${owner} holds host ${host} mutex outside its write phase`)
		}
	}
	for (const [taskId, owner] of Object.entries(state.locks) as Array<[TaskId, OperationId]>) {
		const operation = state.operations[owner]
		if (operation?.phase !== "revalidated" || operation.writes?.[operation.writeIndex]?.taskId !== taskId) {
			violations.push(`${owner} holds ${taskId} without a revalidated write`)
		}
	}
	for (const commit of state.commits) {
		if (
			commit.operationId === "stale-save-a" &&
			commit.previous &&
			(commit.next.parentTaskId !== commit.previous.parentTaskId ||
				commit.next.rootTaskId !== commit.previous.rootTaskId)
		) {
			violations.push("#1021 metadata save changed authoritative lineage")
		}
		if (commit.previous) {
			for (const [key, value] of Object.entries(commit.previous)) {
				if (!(key in commit.delta) && !deepEqual(value, commit.next[key as keyof HistoryItem])) {
					violations.push(`${commit.operationId} lost disk field ${key} absent from its delta`)
				}
			}
			if (commit.delta.childIds && commit.previous.childIds) {
				const expected = new Set([...commit.previous.childIds, ...commit.delta.childIds])
				if ([...expected].some((id) => !commit.next.childIds?.includes(id))) {
					violations.push(`${commit.operationId} lost a concurrent childIds entry`)
				}
			}
		}
	}
	for (const spec of scenario.operations) {
		const operation = state.operations[spec.id]!
		const committed = state.commits.filter((entry) => entry.operationId === spec.id)
		const expectedOrder = operation.writes?.slice(0, committed.length).map((write) => write.taskId) ?? []
		if (committed.some((entry, index) => entry.taskId !== expectedOrder[index])) {
			violations.push(`${spec.id} committed pair records out of production order`)
		}
		if (operation.phase === "rejected" && committed.length > operation.writeIndex) {
			violations.push(`${spec.id} committed a rejected file delta`)
		}
	}
	return violations
}

function deepEqual(left: unknown, right: unknown): boolean {
	return canonical(left) === canonical(right)
}

function canonical(value: unknown): string {
	return JSON.stringify(value)
}

function phaseName(action: string): string {
	if (action.endsWith(".read")) return "read"
	if (action.endsWith(".prepare")) return "prepare"
	if (action.includes(".revalidate(")) return "revalidate"
	if (action.includes(".commit(")) return "commit"
	if (action.includes(".fail(")) return "fail"
	if (action.endsWith(".refresh")) return "refresh"
	if (action.endsWith(".transcript")) return "transcript"
	return "reject"
}

function formatTrace(scenario: Scenario, message: string, trace: TraceStep[]): string {
	return [
		`Shared-store model violation in ${scenario.name}: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)}`),
	].join("\n")
}

function runScenario(scenario: Scenario): {
	states: number
	phases: Set<string>
	landmarks: Set<string>
	actions: Set<string>
	depth: number
} {
	const startDisk =
		scenario.name === "status rejection"
			? { parent: item("parent", { status: "completed", mode: "stable" }) }
			: scenario.operations.some((spec) => spec.authoritative)
				? claimedRecords()
				: baseRecords()
	const start = initialState(
		scenario.operations.map((operation) => operation.id),
		startDisk,
	)
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Set([canonical(start)])
	const frontier: ModelState[] = []
	const phases = new Set<string>()
	const landmarks = new Set<string>()
	const actions = new Set<string>()
	let depth = 0

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(semanticLandmarks)) {
			if (predicate(node.state)) landmarks.add(name)
		}
		const violations = [...commonViolations(node.state, scenario), ...scenario.check(node.state)]
		if (violations.length) throw new Error(formatTrace(scenario, violations.join("; "), node.trace))
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}

		for (const step of nextSteps(node.state, scenario)) {
			actions.add(step.action)
			phases.add(phaseName(step.action))
			if (step.state.operations["reject-a"]?.phase === "rejected") phases.add("reject")
			const key = canonical(step.state)
			if (visited.has(key)) continue
			visited.add(key)
			depth = Math.max(depth, node.trace.length)
			queue.push({ state: step.state, trace: [...node.trace, step] })
			if (visited.size > MAX_STATES) throw new Error(`${scenario.name} exceeded ${MAX_STATES} states`)
		}
	}

	const unseen = frontier
		.flatMap((state) => nextSteps(state, scenario))
		.find((step) => !visited.has(canonical(step.state)))
	if (unseen) throw new Error(`${scenario.name} truncated before unseen action ${unseen.action}`)
	return { states: visited.size, phases, landmarks, actions, depth }
}

const scenarios: Scenario[] = [
	{
		name: "peer field merge",
		operations: [operationSpecs["metadata-a"], operationSpecs["metadata-b"]],
		check: (state) => {
			if (state.operations["metadata-a"]?.phase !== "done" || state.operations["metadata-b"]?.phase !== "done") {
				return []
			}
			return state.disk.parent?.mode === "architect" && state.disk.parent.totalCost === 42
				? []
				: ["concurrent writes to different fields lost an update"]
		},
	},
	{
		name: "status rejection",
		operations: [operationSpecs["reject-a"]],
		check: (state) => {
			if (state.operations["reject-a"]?.phase !== "rejected") return []
			return state.disk.parent?.status === "completed" && state.disk.parent.mode === "stable"
				? []
				: ["rejected status delta applied companion fields"]
		},
	},
	{
		name: "pair second-write failure",
		operations: [operationSpecs["complete-a"]],
		check: (state) => {
			if (state.operations["complete-a"]?.phase !== "failed") return []
			return state.disk["child-a"]?.status === "completed" &&
				state.disk.parent?.status === "delegated" &&
				state.caches.A["child-a"]?.status === "completed" &&
				state.caches.A.parent?.status === "delegated"
				? []
				: ["pair failure cache did not reflect the committed first-record prefix"]
		},
	},
	{
		name: "distinct task writes (#920)",
		operations: [operationSpecs["distinct-a"], operationSpecs["distinct-b"]],
		check: (state) => {
			if (state.operations["distinct-a"]?.phase !== "done" || state.operations["distinct-b"]?.phase !== "done") {
				return []
			}
			return state.disk.parent?.mode === "architect" && state.disk["child-a"]?.totalCost === 42
				? []
				: ["#920 distinct task writes lost an entry"]
		},
	},
	{
		name: "stale completion ownership",
		operations: [operationSpecs["complete-a"], operationSpecs["redelegate-b"]],
		check: () => [],
	},
	{
		name: "stale save detachment",
		operations: [operationSpecs["stale-save-a"], operationSpecs["abandon-b"]],
		check: () => [],
	},
]

let totalStates = 0
const reachedPhases = new Set<string>()
const reachedLandmarks = new Set<string>()
const reachedActions = new Set<string>()
let reachedDepth = 0
for (const scenario of scenarios) {
	const result = runScenario(scenario)
	totalStates += result.states
	for (const phase of result.phases) reachedPhases.add(phase)
	for (const landmark of result.landmarks) reachedLandmarks.add(landmark)
	for (const action of result.actions) reachedActions.add(action)
	reachedDepth = Math.max(reachedDepth, result.depth)
	for (const operation of scenario.operations)
		assert(result.actions.has(`${operation.id}.prepare`), `Unreachable operation ${operation.id}`)
	console.log(
		`  ${scenario.name}: ${result.states} states, ${result.actions.size} actions, reached depth ${result.depth}`,
	)
}

// Retain the reviewed stage-1 causal schedule, not merely an arbitrary rejection.
// The old unsafe suffix (child commit, then clearing the parent) is now disabled.
const causalScenario = scenarios.find((scenario) => scenario.name === "stale completion ownership")!
let causal = initialState(["complete-a", "redelegate-b"], claimedRecords())
const causalActions = [
	"complete-a.read",
	"redelegate-b.read",
	"redelegate-b.prepare",
	"redelegate-b.revalidate(child-a)",
	"redelegate-b.commit(child-a)",
	"redelegate-b.revalidate(child-b)",
	"redelegate-b.commit(child-b)",
	"redelegate-b.revalidate(parent)",
	"redelegate-b.commit(parent)",
	"complete-a.prepare",
]
for (const action of causalActions) {
	const step = nextSteps(causal, causalScenario).find((entry) => entry.action === action)
	assert(step, `Reviewed #1469 causal action disappeared: ${action}`)
	causal = step.state
	assert.deepEqual(commonViolations(causal, causalScenario), [])
}
assert(semanticLandmarks["old-causal-schedule-refused-without-transcript"](causal))
assert(!nextSteps(causal, causalScenario).some((step) => step.action.startsWith("complete-a.")))
console.log(
	`Promoted #1469 / retained causal refusal (zero transcript/lifecycle writes): ${causalActions.join(" -> ")}`,
)

const missingPhases = expectedPhases.filter((phase) => !reachedPhases.has(phase))
if (missingPhases.length) throw new Error(`Shared-store model has unreachable phases: ${missingPhases.join(", ")}`)
const missingLandmarks = Object.keys(semanticLandmarks).filter((name) => !reachedLandmarks.has(name))
if (missingLandmarks.length) {
	throw new Error(`Shared-store model has unreachable semantic landmarks: ${missingLandmarks.join(", ")}`)
}

console.log(
	`Shared-store model check passed: ${totalStates} states, ${scenarios.length} scenarios, ${reachedActions.size} actions, ${commonInvariantNames.length} invariants, ${expectedPhases.length}/${expectedPhases.length} phases reachable, ${Object.keys(semanticLandmarks).length}/${Object.keys(semanticLandmarks).length} landmarks reached; depth <= ${MAX_DEPTH} (reached ${reachedDepth}), budget ${MAX_STATES}/scenario; no retained unsafe witnesses`,
)
