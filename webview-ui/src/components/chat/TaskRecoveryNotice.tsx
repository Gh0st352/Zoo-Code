import { useEffect, useRef, useState } from "react"
import type { ExtensionMessage, TaskRecoveryChoice } from "@roo-code/types"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

/** Recovery is a separate deliberate action; sending a draft never authorizes it. */
export function TaskRecoveryNotice() {
	const { currentTaskId, taskRecovery } = useExtensionState()
	const { t } = useAppTranslation()
	const pending = useRef<{ requestId: string; taskId: string; promptId: string }>()
	const [status, setStatus] = useState<"pending" | "refused" | "applied" | undefined>()
	const prompt = taskRecovery?.taskId === currentTaskId ? taskRecovery : undefined
	const promptId = prompt?.promptId
	useEffect(() => {
		pending.current = undefined
		setStatus(undefined)
	}, [currentTaskId])
	useEffect(() => {
		if (promptId && pending.current?.promptId !== promptId) setStatus(undefined)
	}, [promptId])
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			const request = pending.current
			const result = message.taskRecoveryResult
			if (
				message.type !== "taskRecoveryResult" ||
				!request ||
				message.requestId !== request.requestId ||
				!result ||
				result.taskId !== currentTaskId ||
				result.promptId !== request.promptId
			)
				return
			pending.current = undefined
			setStatus(result.kind)
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [currentTaskId])
	const recover = (choice: TaskRecoveryChoice) => {
		if (!prompt || pending.current || !prompt.choices.includes(choice)) return
		const request = { requestId: crypto.randomUUID(), taskId: prompt.taskId, promptId: prompt.promptId }
		pending.current = request
		setStatus("pending")
		vscode.postMessage({
			type: "recoverTask",
			requestId: request.requestId,
			taskRecoveryDecision: {
				taskId: request.taskId,
				promptId: request.promptId,
				choice,
				intent: "explicit_user_resume",
			},
		})
	}
	if (!prompt && !status) return null
	return (
		<div role="status" className="px-4 py-2 text-vscode-descriptionForeground">
			<p>{t(`chat:recovery.${status ?? (prompt?.reason === "completed" ? "completed" : "paused")}`)}</p>
			{!status &&
				prompt?.choices.map((choice) => (
					<Button key={choice} variant="secondary" onClick={() => recover(choice)}>
						{t(`chat:recovery.${choice}`)}
					</Button>
				))}
			{(!status || status === "refused") && (
				<Button variant="secondary" onClick={() => vscode.postMessage({ type: "clearTask" })}>
					{t("chat:startNewTask.title")}
				</Button>
			)}
		</div>
	)
}
