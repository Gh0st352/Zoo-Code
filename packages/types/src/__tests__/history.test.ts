import { historyItemSchema, pendingTaskActionSchema } from "../history.js"

describe("pendingTaskActionSchema", () => {
	it("accepts create and finish subtask actions", () => {
		expect(
			pendingTaskActionSchema.parse({
				kind: "create_subtask",
				actionId: "create-1",
				approvalText: "{}",
				mode: "ask",
				message: "Child",
				todos: [],
			}),
		).toMatchObject({ kind: "create_subtask", actionId: "create-1" })
		expect(
			pendingTaskActionSchema.parse({
				kind: "finish_subtask",
				actionId: "finish-1",
				approvalText: "{}",
				parentTaskId: "parent-1",
				result: "Done",
			}),
		).toMatchObject({ kind: "finish_subtask", actionId: "finish-1" })
	})

	it("round-trips pending actions on history items", () => {
		const parsed = historyItemSchema.parse({
			id: "task-1",
			number: 1,
			ts: 1,
			task: "Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			pendingAction: {
				kind: "finish_subtask",
				actionId: "finish-1",
				approvalText: "{}",
				parentTaskId: "parent-1",
				result: "Done",
			},
		})

		expect(parsed.pendingAction?.actionId).toBe("finish-1")
	})

	it("preserves versioned and unknown delegation gates while legacy histories need no migration", () => {
		const base = { id: "task", number: 1, ts: 1, task: "Task", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		expect(historyItemSchema.parse(base).delegation).toBeUndefined()
		const delegation = { version: 1, actions: [], blocked: { actionId: "call", generation: 0, reason: "stop" } }
		expect(historyItemSchema.parse({ ...base, delegation }).delegation).toEqual(delegation)
		const future = { version: 2, blocked: { opaque: true } }
		expect(historyItemSchema.parse({ ...base, delegation: future }).delegation).toEqual(future)
	})

	it("round-trips execution ownership, provenance and unknown completion/owner versions without stripping gates", () => {
		const base = { id: "task", number: 1, ts: 1, task: "Task", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		const execution = {
			version: 1,
			generation: 4,
			phase: "suspended",
			cleanupPending: true,
			owner: {
				hostSessionId: "host",
				providerId: "provider",
				runtimeId: "runtime",
				processId: 1,
				machineId: "machine",
				machineProof: "local",
			},
		}
		const saved = {
			...base,
			executionGeneration: 4,
			lifecycleRevision: 9,
			execution,
			lineageProvenance: { parentTaskId: "parent", rootTaskId: "root" },
			delegatedCompletion: { version: 1, receipts: [] },
		}
		expect(historyItemSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
		const future = {
			...saved,
			execution: { version: 7, unknown: "preserved" },
			delegatedCompletion: { version: 7, prefix: { unresolved: true } },
		}
		expect(historyItemSchema.parse(future)).toEqual(future)
	})
})
