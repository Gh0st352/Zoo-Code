import type { ExecutionOwner, ExecutionToken, ExtensionMessage, HistoryItem, WebviewMessage } from "@roo-code/types"

/** Test-only, in-process contract; deliberately not part of the public extension API. */
export interface LoopIssueSnapshot {
	history: HistoryItem
	apiHistory: string
	uiHistory: string
	runtime?: {
		taskId: string
		instanceId: string
		token?: ExecutionToken
		blocked: boolean
		aborted: boolean
	}
}

export interface LoopIssueTestApi {
	host: Omit<ExecutionOwner, "providerId" | "runtimeId">
	snapshot(taskId: string): Promise<LoopIssueSnapshot>
	dispatch(message: WebviewMessage): Promise<ExtensionMessage[]>
	openObserver(taskId: string): Promise<{
		snapshot(): Promise<LoopIssueSnapshot>
		close(): Promise<void>
	}>
	captureCompletion(): { taskId: string; instanceId: string; deliver(result: string): Promise<boolean> }
}
