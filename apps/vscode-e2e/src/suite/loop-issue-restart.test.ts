import * as assert from "assert"
import { LOOP_RESTART } from "../fixtures/loop-issue"
import { PHASE_RESULT_VERSION, readPhaseResult, serializePhaseError, writePhaseResult } from "../restart/phaseProtocol"
import { gateModelResponses, loopConfiguration, loopIssueHooks } from "./loop-issue-helpers"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("LoopIssue fresh host", function () {
	setDefaultSuiteTimeout(this)

	test("restart preserves readable history and default unknown ownership without launching work", async () => {
		const api = globalThis.api
		const hooks = loopIssueHooks(api)
		const phase = process.env.E2E_PHASE
		const results = process.env.E2E_RESULTS_DIR
		assert.ok(results && process.env.E2E_SCENARIO === "loop-issue-restart", "Use the isolated two-host runner")
		assert.ok(phase === "create" || phase === "verify")
		assert.strictEqual(hooks.host.machineProof, "unknown", "Never inject positive death evidence in this smoke")
		const stream = gateModelResponses(LOOP_RESTART)
		try {
			if (phase === "create") {
				const taskId = await api.startNewTask({ configuration: loopConfiguration, text: LOOP_RESTART })
				await stream.entered()
				const before = await hooks.snapshot(taskId)
				assert.strictEqual(before.history.status, "active")
				assert.ok(before.runtime?.token)
				await writePhaseResult(results, {
					version: PHASE_RESULT_VERSION,
					phase,
					status: "passed",
					values: {
						taskId,
						pid: String(process.pid),
						session: hooks.host.hostSessionId,
						termination: "extension-host-exit",
						history: JSON.stringify(before.history),
						apiHistory: before.apiHistory,
						uiHistory: before.uiHistory,
					},
				})
				// ONLY this disposable test process exits. Do not run graceful provider cleanup:
				// the next fresh process must see an unsettled prior-host claim on disk.
				process.exit(0)
			}

			const created = await readPhaseResult(results, "create")
			const values = created.values
			assert.ok(values?.taskId)
			assert.ok(values.history && values.pid && values.session, "Create receipt must contain ownership evidence")
			assert.notStrictEqual(String(process.pid), values.pid, "Must be a distinct extension-host process")
			assert.notStrictEqual(hooks.host.hostSessionId, values.session, "Must not reuse the loaded host nonce")
			const taskId = values.taskId
			assert.strictEqual(await api.isTaskInHistory(taskId), true)
			const before = await hooks.snapshot(taskId)
			assert.deepStrictEqual(before.history, JSON.parse(values.history))
			assert.strictEqual(before.apiHistory, values.apiHistory)
			assert.strictEqual(before.uiHistory, values.uiHistory)
			assert.strictEqual(before.runtime, undefined)

			await api.resumeTask(taskId)
			const observed = await hooks.snapshot(taskId)
			assert.strictEqual(observed.runtime?.token, undefined)
			assert.strictEqual(observed.runtime?.blocked, true)
			assert.deepStrictEqual(observed.history, before.history)
			assert.strictEqual(observed.apiHistory, before.apiHistory)
			assert.strictEqual(observed.uiHistory, before.uiHistory)
			const preview = await hooks.dispatch({ type: "previewTaskRecovery", taskId, requestId: "restart-preview" })
			const prompt = preview.find(
				(message) => message.type === "taskRecovery" && message.taskRecovery?.taskId === taskId,
			)?.taskRecovery
			assert.ok(prompt)
			assert.deepStrictEqual(prompt.choices, [])
			assert.strictEqual(prompt.reason, "owner_unknown")
			await hooks.dispatch({ type: "askResponse", askResponse: "yesButtonClicked" })
			const replies = await hooks.dispatch({
				type: "recoverTask",
				requestId: "restart-refusal",
				taskRecoveryDecision: {
					taskId,
					promptId: prompt.promptId,
					choice: "resume_independent",
					intent: "explicit_user_resume",
				},
			})
			assert.deepStrictEqual(
				replies.find((message) => message.type === "taskRecoveryResult")?.taskRecoveryResult,
				{
					kind: "refused",
					taskId,
					promptId: prompt.promptId,
					reason: "owner_unknown",
				},
			)
			assert.deepStrictEqual(await hooks.snapshot(taskId), observed)
			await api.clearCurrentTask()
			assert.deepStrictEqual(
				await hooks.snapshot(taskId),
				before,
				"Observer disposal cannot settle the prior host",
			)
			assert.strictEqual(stream.requests, 0)
			await writePhaseResult(results, {
				version: PHASE_RESULT_VERSION,
				phase,
				status: "passed",
				values: {
					taskId,
					pid: String(process.pid),
					session: hooks.host.hostSessionId,
					termination: "test-runner",
				},
			})
		} catch (error) {
			await writePhaseResult(results, {
				version: PHASE_RESULT_VERSION,
				phase,
				status: "failed",
				error: serializePhaseError(error),
			})
			throw error
		} finally {
			await stream.dispose()
			await api.clearCurrentTask()
		}
	})
})
