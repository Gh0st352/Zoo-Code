import * as assert from "assert"
import {
	LOOP_CANCEL,
	LOOP_DELAYED,
	LOOP_MULTI_CHILD,
	LOOP_MULTI_PARENT,
	LOOP_RESULT,
	LOOP_SEND,
	LOOP_SEND_REPLY,
	LOOP_SEND_FEEDBACK,
} from "../fixtures/loop-issue"
import type { ChatInput, ClineMessage } from "@roo-code/types"
import {
	completionEvents,
	gateModelResponses,
	loopConfiguration,
	loopIssueHooks,
	recoverIndependently,
} from "./loop-issue-helpers"
import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"
import { suspendCompletionAutoApproval } from "./index"

suite("LoopIssue host boundaries", function () {
	setDefaultSuiteTimeout(this)

	test("correlated chat sends reach real provider requests once, including live completion feedback", async () => {
		const api = globalThis.api
		const hooks = loopIssueHooks(api)
		const stream = gateModelResponses(LOOP_SEND)
		const restoreApproval = suspendCompletionAutoApproval()
		try {
			await api.clearCurrentTask()
			await api.setConfiguration({ ...loopConfiguration, autoApprovalEnabled: false })
			const input: ChatInput = { kind: "new", requestId: "host-fresh", scope: null, text: LOOP_SEND, images: [] }
			const replies = await hooks.dispatch({ type: "submitChatMessage", chatInput: input })
			const receipt = replies.find((message) => message.type === "chatInputResult")?.chatInputResult
			assert.ok(receipt?.kind === "accepted")
			const taskId = receipt.taskId
			await stream.entered()
			await hooks.dispatch({ type: "submitChatMessage", chatInput: input })
			assert.strictEqual(stream.requests, 1)
			stream.release()
			const waitForAsk = async (ask: ClineMessage["ask"]) => {
				let message: ClineMessage | undefined
				await waitFor(async () => {
					const snapshot = await hooks.snapshot(taskId)
					const messages: ClineMessage[] = JSON.parse(snapshot.uiHistory)
					message = messages.at(-1)
					return !!message && message.ask === ask && message.partial !== true
				})
				assert.ok(message)
				return message
			}
			for (const [index, ask, text] of [
				[2, "followup", LOOP_SEND_REPLY],
				[3, "completion_result", LOOP_SEND_FEEDBACK],
			] as const) {
				const message = await waitForAsk(ask)
				const before = await hooks.snapshot(taskId)
				assert.ok(before.runtime)
				const reply: ChatInput = {
					kind: "response",
					requestId: `reply-${index}`,
					text,
					images: [],
					scope: { taskId, instanceId: before.runtime.instanceId },
					askTs: message.ts,
				}
				const result = await hooks.dispatch({ type: "submitChatMessage", chatInput: reply })
				assert.strictEqual(
					result.find((item) => item.type === "chatInputResult")?.chatInputResult?.kind,
					"accepted",
				)
				await stream.entered(index)
				await hooks.dispatch({ type: "submitChatMessage", chatInput: reply })
				assert.strictEqual(stream.requests, index)
				stream.release(index)
			}
			await waitForAsk("completion_result")
			assert.ok((await hooks.snapshot(taskId)).apiHistory.includes(LOOP_SEND_FEEDBACK))
		} finally {
			restoreApproval()
			await stream.dispose()
			await api.clearCurrentTask()
			await api.setConfiguration(loopConfiguration)
		}
	})

	test("second real view initializes and disposes without changing the continuing live owner", async () => {
		const api = globalThis.api
		const hooks = loopIssueHooks(api)
		const stream = gateModelResponses(LOOP_MULTI_CHILD)
		const events = completionEvents(api)
		let observer: Awaited<ReturnType<typeof hooks.openObserver>> | undefined
		try {
			const parentId = await api.startNewTask({ configuration: loopConfiguration, text: LOOP_MULTI_PARENT })
			await stream.entered()
			const childId = api.getCurrentTaskStack().at(-1)!
			assert.notStrictEqual(childId, parentId)
			const parent = await hooks.snapshot(parentId)
			const child = await hooks.snapshot(childId)
			assert.strictEqual(parent.history.status, "delegated")
			assert.strictEqual(parent.history.awaitingChildId, childId)
			assert.strictEqual(child.history.parentTaskId, parentId)
			assert.ok(child.runtime?.token)

			observer = await hooks.openObserver(childId)
			const observed = await observer.snapshot()
			assert.strictEqual(observed.runtime?.token, undefined)
			assert.strictEqual(observed.runtime?.blocked, true)
			assert.deepStrictEqual(observed.history, child.history)
			await observer.close()
			observer = undefined
			assert.deepStrictEqual(await hooks.snapshot(parentId), parent)
			assert.deepStrictEqual(await hooks.snapshot(childId), child)
			assert.strictEqual(stream.requests, 1)

			stream.release()
			await events.wait(parentId)
			assert.strictEqual(events.completed.filter((id) => id === childId).length, 1)
			assert.strictEqual(events.completed.filter((id) => id === parentId).length, 1)
			assert.strictEqual((await hooks.snapshot(parentId)).history.status, "completed")
		} finally {
			await stream.dispose()
			await observer?.close()
			await api.clearCurrentTask()
			events.dispose()
		}
	})

	test("cancelled task resumes only through an explicit scoped host message decision", async () => {
		const api = globalThis.api
		const hooks = loopIssueHooks(api)
		const stream = gateModelResponses(LOOP_CANCEL)
		const events = completionEvents(api)
		try {
			const taskId = await api.startNewTask({ configuration: loopConfiguration, text: LOOP_CANCEL })
			await stream.entered()
			const cancellation = api.cancelCurrentTask()
			await waitFor(async () => (await hooks.snapshot(taskId)).history.status === "interrupted")
			stream.release()
			await cancellation
			const stopped = await hooks.snapshot(taskId)
			assert.strictEqual(stopped.runtime?.token, undefined)
			assert.strictEqual(stopped.runtime?.blocked, true)
			await hooks.dispatch({ type: "askResponse", askResponse: "yesButtonClicked" })
			assert.deepStrictEqual(await hooks.snapshot(taskId), stopped)
			assert.strictEqual(stream.requests, 1, "Generic approval must not launch recovery")

			const decision = await recoverIndependently(hooks, taskId)
			await stream.entered(2)
			const recovered = await hooks.snapshot(taskId)
			assert.strictEqual(recovered.history.status, "active")
			assert.ok(recovered.runtime?.token)
			const duplicate = await hooks.dispatch({
				type: "recoverTask",
				taskRecoveryDecision: decision,
				requestId: "duplicate",
			})
			assert.deepStrictEqual(
				duplicate.find((message) => message.type === "taskRecoveryResult")?.taskRecoveryResult,
				{
					kind: "refused",
					taskId,
					promptId: decision.promptId,
					reason: "stale_scope",
				},
			)
			assert.deepStrictEqual(await hooks.snapshot(taskId), recovered)
			assert.strictEqual(stream.requests, 2)
			stream.release(2)
			await events.wait(taskId)
			assert.strictEqual(events.completed.filter((id) => id === taskId).length, 1)
			assert.ok((await hooks.snapshot(taskId)).uiHistory.includes(LOOP_RESULT))
		} finally {
			await stream.dispose()
			await api.clearCurrentTask()
			events.dispose()
		}
	})

	test("delayed stream and old completion callback cannot mutate a cancelled or replaced same-ID owner", async () => {
		const api = globalThis.api
		const hooks = loopIssueHooks(api)
		const stream = gateModelResponses(LOOP_DELAYED)
		const events = completionEvents(api)
		try {
			const taskId = await api.startNewTask({ configuration: loopConfiguration, text: LOOP_DELAYED })
			await stream.entered()
			const old = hooks.captureCompletion()
			const oldToken = (await hooks.snapshot(taskId)).runtime?.token
			assert.ok(oldToken)
			const cancellation = api.cancelCurrentTask()
			await waitFor(async () => (await hooks.snapshot(taskId)).history.status === "interrupted")
			// This delivery occurs AFTER the durable fence, not merely after calling cancel.
			stream.release()
			await cancellation
			const stopped = await hooks.snapshot(taskId)
			assert.strictEqual(await old.deliver("STALE_CANCELLED_RESULT"), false)
			assert.deepStrictEqual(await hooks.snapshot(taskId), stopped)
			assert.strictEqual(events.completed.length, 0)

			await recoverIndependently(hooks, taskId)
			await stream.entered(2)
			const replacement = await hooks.snapshot(taskId)
			assert.strictEqual(replacement.runtime?.taskId, old.taskId)
			assert.notStrictEqual(replacement.runtime?.instanceId, old.instanceId)
			assert.ok(replacement.runtime?.token && replacement.runtime.token.generation > oldToken.generation)
			assert.strictEqual(await old.deliver("STALE_REPLACED_RESULT"), false)
			assert.deepStrictEqual(await hooks.snapshot(taskId), replacement)
			assert.strictEqual(events.completed.length, 0)
			stream.release(2)
			await events.wait(taskId)
			assert.strictEqual(events.completed.length, 1)
			const final = await hooks.snapshot(taskId)
			assert.ok(!final.apiHistory.includes("STALE_") && !final.uiHistory.includes("STALE_"))
		} finally {
			await stream.dispose()
			await api.clearCurrentTask()
			events.dispose()
		}
	})
})
