import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ChatInput, ExtensionMessage } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"

/** Keep the draft until a correlated host receipt; never retry with a new identity. */
export function useChatSubmission({
	taskId,
	instanceId,
	text,
	images,
	clearDraft,
}: {
	taskId?: string | null
	instanceId?: string | null
	text: string
	images: string[]
	clearDraft: () => void
}) {
	const pending = useRef<{ input: ChatInput; draft: string; images: string[] }>()
	const latest = useRef({ taskId, instanceId, text, images, clearDraft })
	const [status, setStatus] = useState<"pending" | "unknown" | "refused" | undefined>()
	useLayoutEffect(() => {
		latest.current = { taskId, instanceId, text, images, clearDraft }
		const scope = pending.current?.input.scope
		if (scope && (scope.taskId !== taskId || scope.instanceId !== instanceId)) {
			pending.current = undefined
			setStatus(undefined)
		}
	}, [taskId, instanceId, text, images, clearDraft])
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			const result = event.data.type === "chatInputResult" ? event.data.chatInputResult : undefined
			const request = pending.current
			if (!result || !request || result.requestId !== request.input.requestId) return
			pending.current = undefined
			const current = latest.current
			if (
				request.input.scope === null &&
				current.taskId &&
				(result.kind !== "accepted" || current.taskId !== result.taskId)
			) {
				setStatus(undefined)
				return
			}
			setStatus(result.kind === "refused" ? "refused" : undefined)
			if (
				result.kind === "accepted" &&
				request.input.text === request.draft.trim() &&
				request.input.images.length === request.images.length &&
				request.input.images.every((image, index) => image === request.images[index]) &&
				current.text === request.draft &&
				current.images.length === request.images.length &&
				current.images.every((image, index) => image === request.images[index])
			) {
				current.clearDraft()
			}
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [])
	useEffect(() => {
		if (status !== "pending") return
		const timer = setTimeout(() => setStatus("unknown"), 15000)
		return () => clearTimeout(timer)
	}, [status])
	const submit = useCallback((input: ChatInput) => {
		if (pending.current) return false
		pending.current = { input, draft: latest.current.text, images: [...latest.current.images] }
		setStatus("pending")
		try {
			vscode.postMessage({ type: "submitChatMessage", chatInput: input })
		} catch {
			pending.current = undefined
			setStatus("refused")
			return false
		}
		return true
	}, [])
	const retryReceipt = useCallback(() => {
		if (pending.current) {
			setStatus("pending")
			try {
				vscode.postMessage({ type: "submitChatMessage", chatInput: pending.current.input })
			} catch {
				setStatus("unknown")
			}
		}
	}, [])
	return { submit, status, retryReceipt }
}
