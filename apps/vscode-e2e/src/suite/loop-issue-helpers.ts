import * as assert from "assert"
import { RooCodeEventName, type RooCodeAPI, type TaskRecoveryDecision } from "@roo-code/types"
import type { LoopIssueTestApi } from "../loopIssueContract"
import { waitFor } from "./utils"

export function loopIssueHooks(api: RooCodeAPI): LoopIssueTestApi {
	assert.ok(
		"getLoopIssueTestApi" in api && typeof api.getLoopIssueTestApi === "function",
		"Rebuild the extension with LoopIssue test hooks",
	)
	return api.getLoopIssueTestApi() as LoopIssueTestApi
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

/** Hold a real aimock response at the SDK's first body read, not a wall-clock delay. */
export function gateModelResponses(marker: string) {
	assert.ok(process.env.AIMOCK_URL && process.env.AIMOCK_RECORD !== "true", "LoopIssue requires mock-only mode")
	const original = globalThis.fetch
	const gates = new Map<
		number,
		{
			entered: ReturnType<typeof deferred>
			release: ReturnType<typeof deferred>
		}
	>()
	const gate = (index: number) => {
		let value = gates.get(index)
		if (!value) {
			value = { entered: deferred(), release: deferred() }
			gates.set(index, value)
		}
		return value
	}
	let requests = 0
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const body = typeof init?.body === "string" ? init.body : ""
		if (!url.startsWith(`${process.env.AIMOCK_URL}/`) || !url.endsWith("/chat/completions")) {
			return original(input, init)
		}
		const parsed = JSON.parse(body) as { messages?: { role: string; content?: unknown }[] }
		if (
			!parsed.messages?.some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes(marker),
			)
		) {
			return original(input, init)
		}
		const current = gate(++requests)
		const response = await original(input, init)
		assert.ok(response.ok && response.body, `Mock returned ${response.status}`)
		const reader = response.body.getReader()
		let closed = false
		const stream = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					try {
						const chunk = await reader.read()
						// A real SDK read is pending with an actual buffered provider chunk.
						current.entered.resolve()
						await current.release.promise
						if (closed) return
						if (chunk.done) {
							closed = true
							controller.close()
						} else controller.enqueue(chunk.value)
					} catch (error) {
						closed = true
						controller.error(error)
					}
				},
				async cancel() {
					closed = true
					await reader.cancel()
				},
			},
			{ highWaterMark: 0 },
		)
		return new Response(stream, { status: response.status, headers: response.headers })
	}
	return {
		get requests() {
			return requests
		},
		async entered(index = 1) {
			// Poll a readiness predicate with a bounded timeout; never sleep to make a race likely.
			let entered = false
			void gate(index).entered.promise.then(() => {
				entered = true
			})
			await waitFor(() => entered)
		},
		release(index = 1) {
			gate(index).release.resolve()
		},
		async dispose() {
			globalThis.fetch = original
			for (const value of gates.values()) value.release.resolve()
			// Tests await provider cancellation separately: it owns actual SDK/stream cleanup.
		},
	}
}

export function completionEvents(api: RooCodeAPI) {
	const completed: string[] = []
	const listener = (taskId: string) => {
		completed.push(taskId)
	}
	api.on(RooCodeEventName.TaskCompleted, listener)
	return {
		completed,
		wait: (taskId: string) => waitFor(() => completed.includes(taskId)),
		dispose: () => {
			api.off(RooCodeEventName.TaskCompleted, listener)
		},
	}
}

export async function recoverIndependently(hooks: LoopIssueTestApi, taskId: string) {
	const preview = await hooks.dispatch({ type: "previewTaskRecovery", taskId, requestId: `preview-${taskId}` })
	const prompt = preview.find(
		(message) => message.type === "taskRecovery" && message.taskRecovery?.taskId === taskId,
	)?.taskRecovery
	assert.ok(prompt, "The host message handler must publish a scoped preview")
	assert.deepStrictEqual(prompt.choices, ["resume_independent"])
	const decision: TaskRecoveryDecision = {
		taskId,
		promptId: prompt.promptId,
		choice: "resume_independent",
		intent: "explicit_user_resume",
	}
	const replies = await hooks.dispatch({
		type: "recoverTask",
		taskRecoveryDecision: decision,
		requestId: `recover-${taskId}`,
	})
	const result = replies.find((message) => message.type === "taskRecoveryResult")?.taskRecoveryResult
	assert.deepStrictEqual(result, { kind: "applied", taskId, promptId: prompt.promptId })
	return decision
}

export const loopConfiguration = {
	mode: "ask",
	autoApprovalEnabled: true,
	alwaysAllowSubtasks: true,
	alwaysAllowModeSwitch: true,
	enableCheckpoints: false,
} as const
