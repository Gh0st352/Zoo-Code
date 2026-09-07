import { chatInputSchema, type ChatInputResult } from "@roo-code/types"
import type { Task } from "../task/Task"
import type { ClineProvider } from "./ClineProvider"

// Retain only small receipts, not user content. Provider disposal releases the map.
// Install the promise before awaiting admission so duplicate bridge deliveries join it.
const receipts = new WeakMap<ClineProvider, Map<string, Promise<ChatInputResult>>>()

export async function submitChatInput(
	provider: ClineProvider,
	payload: unknown,
	resolveImages: (
		input: { text: string; images: string[] },
		task?: Task,
	) => Promise<{ text: string; images?: string[] }>,
): Promise<ChatInputResult | undefined> {
	const parsed = chatInputSchema.safeParse(payload)
	if (!parsed.success) {
		if (
			typeof payload !== "object" ||
			payload === null ||
			!("requestId" in payload) ||
			typeof payload.requestId !== "string"
		)
			return undefined
		return { requestId: payload.requestId, kind: "refused", reason: "invalid_input" }
	}
	const input = parsed.data
	let requests = receipts.get(provider)
	if (!requests) {
		requests = new Map()
		receipts.set(provider, requests)
	}
	const existing = requests.get(input.requestId)
	if (existing) return existing
	const task = provider.getCurrentTask()
	const refused = (reason: Extract<ChatInputResult, { kind: "refused" }>["reason"]): ChatInputResult => ({
		requestId: input.requestId,
		kind: "refused",
		reason,
	})
	const isCurrent = () =>
		provider.getCurrentTask() === task &&
		(input.scope === null
			? !task
			: !!task && task.taskId === input.scope.taskId && task.instanceId === input.scope.instanceId)
	const run = async (): Promise<ChatInputResult> => {
		try {
			if (!input.text.trim() && input.images.length === 0) return refused("invalid_input")
			if (!isCurrent()) return refused("stale_scope")
			if (task && !(await task.guardExecution())) return refused("execution_refused")
			if (!isCurrent()) return refused("stale_scope")
			const resolved = await resolveImages(input, task)
			if (!isCurrent()) return refused("stale_scope")
			if (input.kind === "new") {
				const created = await provider.createTask(resolved.text, resolved.images, undefined, {}, {}, isCurrent)
				return { requestId: input.requestId, kind: "accepted", taskId: created.taskId }
			}
			if (!task || !(await task.guardExecution())) return refused("execution_refused")
			if (!isCurrent()) return refused("stale_scope")
			if (input.kind === "response") {
				if (!task.acceptChatResponse(input.askTs, resolved.text, resolved.images)) return refused("stale_scope")
			} else {
				task.messageQueueService.addMessage(resolved.text, resolved.images)
			}
			return { requestId: input.requestId, kind: "accepted", taskId: task.taskId }
		} catch {
			// Do not echo user text, credentials, paths, or raw exceptions to the UI.
			return refused("input_failed")
		}
	}
	const pending = Promise.resolve().then(run)
	requests.set(input.requestId, pending)
	return pending
}
