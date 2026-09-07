import fs from "fs/promises"
import * as vscode from "vscode"
import type { ExtensionMessage } from "@roo-code/types"
import pWaitFor from "p-wait-for"

import type { LoopIssueSnapshot, LoopIssueTestApi } from "../../apps/vscode-e2e/src/loopIssueContract"
import { openClineInNewTab } from "../activate/registerCommands"
import { createExecutionHost } from "../core/task-persistence/executionHost"
import type { ClineProvider } from "../core/webview/ClineProvider"
import { webviewMessageHandler } from "../core/webview/webviewMessageHandler"

/** No authority injection: all operations still cross the production provider/store guards. */
export function createLoopIssueTestApi(provider: ClineProvider, outputChannel: vscode.OutputChannel): LoopIssueTestApi {
	if (provider.context.extensionMode !== vscode.ExtensionMode.Test) {
		throw new Error("LoopIssue test API requires an isolated extension test host")
	}

	const snapshot = async (source: ClineProvider, taskId: string): Promise<LoopIssueSnapshot> => {
		await source.taskHistoryStore.initialized
		const history = await source.taskHistoryStore.readAuthoritative(taskId)
		const paths = await source.getTaskWithId(taskId)
		const [apiHistory, uiHistory] = await Promise.all([
			fs.readFile(paths.apiConversationHistoryFilePath, "utf8"),
			fs.readFile(paths.uiMessagesFilePath, "utf8"),
		])
		const task = source.getCurrentTask()
		return {
			history: structuredClone(history),
			apiHistory,
			uiHistory,
			runtime: task && {
				taskId: task.taskId,
				instanceId: task.instanceId,
				token: task.executionToken && structuredClone(task.executionToken),
				blocked: task.executionBlocked,
				aborted: task.abort,
			},
		}
	}

	let dispatching = false
	return {
		host: createExecutionHost().identity,
		snapshot: (taskId) => snapshot(provider, taskId),
		async dispatch(message) {
			if (dispatching) throw new Error("Test message dispatch must be sequential")
			dispatching = true
			const messages: ExtensionMessage[] = []
			const original = provider.postMessageToWebview
			provider.postMessageToWebview = async (response) => {
				// Keep the real publication path, including its asynchronous boundary.
				messages.push(structuredClone(response))
				await original.call(provider, response)
			}
			try {
				await webviewMessageHandler(provider, message)
				return messages
			} finally {
				provider.postMessageToWebview = original
				dispatching = false
			}
		},
		async openObserver(taskId) {
			const observer = await openClineInNewTab({ context: provider.context, outputChannel })
			try {
				await observer.taskHistoryStore.initialized
				await pWaitFor(() => observer.viewLaunched, { timeout: 30_000, interval: 50 })
				await observer.showTaskWithId(taskId)
				let closing: Promise<void> | undefined
				const close = async () => {
					const panel = observer["view"]
					if (!panel || !("dispose" in panel)) throw new Error("Expected a real editor webview panel")
					const original = observer.dispose.bind(observer)
					let disposal: Promise<void> | undefined
					// VS Code's disposal event doesn't await listeners. Expose its actual settlement.
					observer.dispose = () => (disposal ??= original())
					panel.dispose()
					if (!disposal) throw new Error("Panel disposal did not invoke provider disposal")
					await disposal
				}
				return {
					snapshot: () => snapshot(observer, taskId),
					close: () => (closing ??= close()),
				}
			} catch (error) {
				await observer.dispose()
				throw error
			}
		},
		captureCompletion() {
			const task = provider.getCurrentTask()
			if (!task?.executionToken) throw new Error("Expected an executing task to capture")
			return {
				taskId: task.taskId,
				instanceId: task.instanceId,
				// Retain the OLD object, not a lookup of the current same-ID incarnation.
				deliver: (result) => provider.completeTask(task, result),
			}
		},
	}
}
