import type {
	ClineMessage,
	ExtensionMessage,
	TaskProviderLike,
	TaskRecoveryDecision,
	TaskRecoveryPrompt,
	TaskRecoveryResponse,
	WebviewMessage,
} from "@roo-code/types"
import type { Task } from "../../task/Task"
import type { ClineProvider } from "../ClineProvider"

vi.mock("../ClineProvider", () => ({ ClineProvider: {} }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key, changeLanguage: vi.fn() }))
vi.mock("../../mentions/resolveImageMentions", () => ({ resolveImageMentions: vi.fn() }))
vi.mock("../../task-persistence", () => ({ saveTaskMessages: vi.fn() }))
vi.mock("../../tools/UpdateTodoListTool", () => ({ setPendingTodoList: vi.fn() }))
vi.mock("../checkpointRestoreHandler", () => ({ handleCheckpointRestoreOperation: vi.fn() }))
vi.mock("p-wait-for", () => ({ default: vi.fn() }))

import pWaitFor from "p-wait-for"
import { resolveImageMentions } from "../../mentions/resolveImageMentions"
import { saveTaskMessages } from "../../task-persistence"
import { setPendingTodoList } from "../../tools/UpdateTodoListTool"
import { handleCheckpointRestoreOperation } from "../checkpointRestoreHandler"
import { webviewMessageHandler } from "../webviewMessageHandler"

const decision: TaskRecoveryDecision = {
	taskId: "task",
	promptId: "prompt",
	choice: "resume_independent",
	intent: "explicit_user_resume",
}
const prompt: TaskRecoveryPrompt = { taskId: "task", promptId: "prompt", choices: ["resume_independent"] }
const applied: TaskRecoveryResponse = { kind: "applied", taskId: "task", promptId: "prompt" }
const imageResult = { text: "resolved", images: ["data:image/png;base64,resolved"] }
const imageSettings = { maxImageFileSize: 5, maxTotalImageSize: 20 }

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function makeTask(taskId = "task") {
	const clineMessages: ClineMessage[] = [{ ts: 10, type: "say", say: "user_feedback", text: "original" }]
	return {
		taskId,
		cwd: `/workspace/${taskId}`,
		rooIgnoreController: undefined,
		isInitialized: true,
		guardExecution: vi.fn<Task["guardExecution"]>().mockResolvedValue(true),
		handleWebviewAskResponse: vi.fn<Task["handleWebviewAskResponse"]>(),
		handleTerminalOperation: vi.fn<Task["handleTerminalOperation"]>().mockResolvedValue(undefined),
		cancelAutoApprovalTimeout: vi.fn<Task["cancelAutoApprovalTimeout"]>(),
		checkpointRestore: vi.fn<Task["checkpointRestore"]>().mockResolvedValue(undefined),
		overwriteClineMessages: vi.fn<Task["overwriteClineMessages"]>().mockResolvedValue(undefined),
		submitUserMessage: vi.fn<Task["submitUserMessage"]>().mockResolvedValue(undefined),
		clineMessages,
		apiConversationHistory: [],
		messageManager: {
			rewindToTimestamp: vi.fn<Task["messageManager"]["rewindToTimestamp"]>().mockResolvedValue(undefined),
		},
		messageQueueService: {
			addMessage: vi.fn<Task["messageQueueService"]["addMessage"]>(),
			removeMessage: vi.fn<Task["messageQueueService"]["removeMessage"]>(),
			updateMessage: vi.fn<Task["messageQueueService"]["updateMessage"]>(),
		},
	}
}

function harness() {
	const task = makeTask()
	let current: ReturnType<typeof makeTask> | undefined = task
	const provider = {
		getCurrentTask: vi.fn(() => current),
		log: vi.fn<ClineProvider["log"]>(),
		getState: vi.fn(async () => imageSettings),
		previewTaskRecovery: vi.fn<TaskProviderLike["previewTaskRecovery"]>().mockResolvedValue(prompt),
		recoverTask: vi.fn<TaskProviderLike["recoverTask"]>().mockResolvedValue(applied),
		postMessageToWebview: vi.fn<(message: ExtensionMessage) => Promise<void>>().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		createTask: vi.fn().mockResolvedValue(task),
		cancelTask: vi.fn().mockResolvedValue(undefined),
		showTaskWithId: vi.fn().mockResolvedValue(undefined),
		condenseTaskContext: vi.fn().mockResolvedValue(undefined),
		contextProxy: { setValue: vi.fn().mockResolvedValue(undefined), globalStorageUri: { fsPath: "/storage" } },
		cwd: "/provider-workspace",
	}
	return {
		task,
		provider,
		setCurrent: (next: typeof current) => {
			current = next
		},
		// This boundary intentionally omits provider services unrelated to these handler units;
		// constructing a real provider/task would exercise persistence and execution instead.
		dispatch: (message: WebviewMessage) => webviewMessageHandler(provider as unknown as ClineProvider, message),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(resolveImageMentions).mockReset().mockResolvedValue(imageResult)
	vi.mocked(saveTaskMessages).mockReset().mockResolvedValue([])
	vi.mocked(pWaitFor).mockReset().mockResolvedValue(undefined)
})

describe("recovery message dispatch", () => {
	it("routes preview by the supplied ID without duplicate publication or execution", async () => {
		const h = harness()
		h.setCurrent(makeTask("unrelated"))
		await h.dispatch({ type: "previewTaskRecovery", taskId: "task" })
		expect(h.provider.previewTaskRecovery).toHaveBeenCalledExactlyOnceWith("task")
		expect(h.provider.postMessageToWebview).not.toHaveBeenCalled()
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
		expect(h.provider.getCurrentTask).not.toHaveBeenCalled()
	})

	it.each([undefined, null, 1, ""])("does not infer a preview target from invalid ID %s", async (taskId) => {
		const h = harness()
		// Simulate an untrusted runtime message, bypassing the compile-time request contract.
		await h.dispatch({ type: "previewTaskRecovery", taskId } as WebviewMessage)
		expect(h.provider.previewTaskRecovery).not.toHaveBeenCalled()
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
	})

	it.each<TaskRecoveryResponse>([
		applied,
		{ kind: "refused", taskId: "task", promptId: "prompt", reason: "stale_scope" },
		{ kind: "refused", taskId: "task", reason: "owner_live" },
	])("publishes the provider's $kind response without adding authority", async (response) => {
		const h = harness()
		h.provider.recoverTask.mockResolvedValue(response)
		await h.dispatch({ type: "recoverTask", taskRecoveryDecision: decision })
		expect(h.provider.recoverTask).toHaveBeenCalledExactlyOnceWith(decision)
		expect(h.provider.recoverTask.mock.calls[0][0]).not.toBe(decision)
		expect(h.provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "taskRecoveryResult",
			taskRecoveryResult: response,
		})
	})

	it.each(["owner", "scope", "generation", "cleanup", "cleanupPending"])(
		"refuses forged %s before calling the provider",
		async (field) => {
			const h = harness()
			await h.dispatch({ type: "recoverTask", taskRecoveryDecision: { ...decision, [field]: {} } })
			expect(h.provider.recoverTask).not.toHaveBeenCalled()
			expect(h.provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "taskRecoveryResult",
				taskRecoveryResult: { kind: "refused", taskId: "task", promptId: "prompt", reason: "stale_scope" },
			})
		},
	)

	it.each([
		{ ...decision, intent: "automatic_approval" },
		{ ...decision, intent: "yesButtonClicked" },
		{ ...decision, intent: undefined },
	])("refuses implicit intent %# with a stable backend reason", async (input) => {
		const h = harness()
		await h.dispatch({ type: "recoverTask", taskRecoveryDecision: input as TaskRecoveryDecision })
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
		expect(h.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskRecoveryResult",
			taskRecoveryResult: { kind: "refused", taskId: "task", promptId: "prompt", reason: "wrong_intent" },
		})
	})

	it.each([undefined, null, {}, { taskId: 42 }])("ignores unscoped malformed decisions %#", async (input) => {
		const h = harness()
		// Simulate untyped bridge input; this intentionally violates the public message contract.
		const malformed: unknown = input
		await h.dispatch({ type: "recoverTask", taskRecoveryDecision: malformed as TaskRecoveryDecision })
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
		expect(h.provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("keeps late results scoped to the original decision", async () => {
		const h = harness()
		const result = deferred<TaskRecoveryResponse>()
		h.provider.recoverTask.mockReturnValue(result.promise)
		const handling = h.dispatch({ type: "recoverTask", taskRecoveryDecision: { ...decision } })
		h.setCurrent(makeTask("new-task"))
		result.resolve(applied)
		await handling
		expect(h.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskRecoveryResult",
			taskRecoveryResult: applied,
		})
	})

	it("does not retry recovery or misreport success after provider failure", async () => {
		const h = harness()
		h.provider.recoverTask.mockRejectedValue(new Error("storage failure"))
		await h.dispatch({ type: "recoverTask", taskRecoveryDecision: decision, requestId: "recovery-request" })
		expect(h.provider.recoverTask).toHaveBeenCalledTimes(1)
		expect(h.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskRecoveryResult",
			requestId: "recovery-request",
			taskRecoveryResult: {
				kind: "refused",
				taskId: decision.taskId,
				promptId: decision.promptId,
				reason: "history_io_error",
			},
		})
	})

	it("does not relabel committed recovery when publication fails", async () => {
		const h = harness()
		h.provider.recoverTask.mockResolvedValue(applied)
		h.provider.postMessageToWebview.mockRejectedValue(new Error("closed webview"))
		await expect(
			h.dispatch({ type: "recoverTask", taskRecoveryDecision: decision, requestId: "receipt" }),
		).rejects.toThrow("closed webview")
		expect(h.provider.recoverTask).toHaveBeenCalledTimes(1)
		expect(h.provider.postMessageToWebview).toHaveBeenCalledTimes(1)
		expect(h.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskRecoveryResult",
			taskRecoveryResult: applied,
			requestId: "receipt",
		})
	})
})

describe("user-input diagnostics", () => {
	it("traces new-task success and failure without recording the original input", async () => {
		const h = harness()
		await h.dispatch({ type: "newTask", text: "private-input" })
		expect(h.provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"stage":"created"'))
		h.provider.createTask.mockRejectedValue(new Error("task construction failed"))
		await h.dispatch({ type: "newTask", text: "private-input" })
		expect(h.provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"stage":"failed"'))
		for (const [line] of h.provider.log.mock.calls) expect(line).not.toContain("private-input")
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
	})

	it.each(["askResponse", "queueMessage"] as const)(
		"records a %s refusal without input or token contents",
		async (type) => {
			const h = harness()
			h.task.guardExecution.mockResolvedValue(false)
			Object.assign(h.task, {
				executionBlocked: true,
				executionRefusalReason: "owner_unknown",
				executionToken: { owner: { hostSessionId: "private-owner-secret" } },
			})
			await h.dispatch({
				type,
				askResponse: "messageResponse",
				text: "private-user-message",
				images: ["private-image-data"],
			})
			expect(h.provider.log).toHaveBeenCalledTimes(2)
			expect(h.provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"stage":"refused"'))
			expect(h.provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"reason":"execution_guard"'))
			expect(h.provider.log).toHaveBeenLastCalledWith(
				expect.stringContaining('"executionRefusalReason":"owner_unknown"'),
			)
			for (const [line] of h.provider.log.mock.calls) {
				expect(line).not.toContain("private-")
				expect(line).toContain('"hasText":true')
				expect(line).toContain('"imageCount":1')
			}
			expect(h.provider.recoverTask).not.toHaveBeenCalled()
		},
	)

	it.each(["askResponse", "queueMessage"] as const)(
		"records missing task and wrong-task %s separately",
		async (type) => {
			const h = harness()
			await h.dispatch({ type, askResponse: "messageResponse", taskId: "other" })
			expect(h.provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"reason":"not_current_task"'))
			expect(h.task.guardExecution).not.toHaveBeenCalled()
			h.setCurrent(undefined)
			await h.dispatch({ type, askResponse: "messageResponse" })
			expect(h.provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"reason":"no_current_task"'))
		},
	)

	it("records a missing response without dispatching or guarding execution", async () => {
		const h = harness()
		await h.dispatch({ type: "askResponse" })
		expect(h.provider.log).toHaveBeenLastCalledWith(expect.stringContaining('"reason":"missing_response"'))
		expect(h.task.guardExecution).not.toHaveBeenCalled()
		expect(h.task.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it.each(["askResponse", "queueMessage"] as const)(
		"traces eligible %s and tolerates a disposed logger",
		async (type) => {
			const h = harness()
			await h.dispatch({ type, askResponse: "messageResponse", text: "input" })
			expect(h.provider.log).toHaveBeenLastCalledWith(
				expect.stringContaining(`"stage":"${type === "askResponse" ? "delivered" : "queued"}"`),
			)
			h.provider.log.mockImplementation(() => {
				throw new Error("disposed output channel")
			})
			await expect(h.dispatch({ type, askResponse: "messageResponse", text: "input" })).resolves.toBeUndefined()
			const effect =
				type === "askResponse" ? h.task.handleWebviewAskResponse : h.task.messageQueueService.addMessage
			expect(effect).toHaveBeenCalledTimes(2)
			expect(h.provider.recoverTask).not.toHaveBeenCalled()
		},
	)
})

describe.each(["askResponse", "queueMessage", "editMessageConfirm"] as const)("%s task capture", (type) => {
	const message: WebviewMessage = { type, askResponse: "messageResponse", text: "input", messageTs: 10 }

	it("refuses observer/blocked execution before image processing or task effects", async () => {
		const h = harness()
		h.task.guardExecution.mockResolvedValue(false)
		await h.dispatch(message)
		expect(resolveImageMentions).not.toHaveBeenCalled()
		expect(h.task.handleWebviewAskResponse).not.toHaveBeenCalled()
		expect(h.task.messageQueueService.addMessage).not.toHaveBeenCalled()
		expect(h.task.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
	})

	it("rejects an explicit mismatched task ID", async () => {
		const h = harness()
		await h.dispatch({ ...message, taskId: "other" })
		expect(h.task.guardExecution).not.toHaveBeenCalled()
		expect(resolveImageMentions).not.toHaveBeenCalled()
	})

	it.each(["first guard", "state", "images", "last guard"])(
		"never delivers to a replacement runtime after awaiting %s",
		async (stage) => {
			const h = harness()
			const replacement = makeTask("task")
			const reached = deferred<void>()
			const release = deferred<void>()
			const pause = async <T>(value: T) => {
				reached.resolve()
				await release.promise
				return value
			}
			if (stage === "first guard") h.task.guardExecution.mockImplementationOnce(() => pause(true))
			if (stage === "state") h.provider.getState.mockImplementationOnce(() => pause(imageSettings))
			if (stage === "images") vi.mocked(resolveImageMentions).mockImplementationOnce(() => pause(imageResult))
			if (stage === "last guard")
				h.task.guardExecution.mockResolvedValueOnce(true).mockImplementationOnce(() => pause(true))
			const handling = h.dispatch(message)
			await reached.promise
			h.setCurrent(replacement)
			release.resolve()
			await handling
			for (const task of [h.task, replacement]) {
				expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
				expect(task.messageQueueService.addMessage).not.toHaveBeenCalled()
				expect(task.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
			}
			if (stage === "state")
				expect(resolveImageMentions).toHaveBeenCalledWith(expect.objectContaining({ cwd: h.task.cwd }))
		},
	)

	it("rechecks execution authority after image resolution even when focus is unchanged", async () => {
		const h = harness()
		h.task.guardExecution.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
		await h.dispatch(message)
		expect(h.task.guardExecution).toHaveBeenCalledTimes(2)
		expect(h.task.handleWebviewAskResponse).not.toHaveBeenCalled()
		expect(h.task.messageQueueService.addMessage).not.toHaveBeenCalled()
		expect(h.task.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
	})

	it("applies eligible input only to the captured task", async () => {
		const h = harness()
		await h.dispatch(message)
		if (type === "askResponse")
			expect(h.task.handleWebviewAskResponse).toHaveBeenCalledExactlyOnceWith(
				"messageResponse",
				imageResult.text,
				imageResult.images,
			)
		if (type === "queueMessage")
			expect(h.task.messageQueueService.addMessage).toHaveBeenCalledExactlyOnceWith(
				imageResult.text,
				imageResult.images,
			)
		if (type === "editMessageConfirm")
			expect(h.task.submitUserMessage).toHaveBeenCalledExactlyOnceWith(imageResult.text, imageResult.images)
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
	})
})

describe("other task-local effects", () => {
	it.each<WebviewMessage>([
		{ type: "terminalOperation", terminalOperation: "continue" },
		{ type: "removeQueuedMessage", text: "queued-id" },
		{ type: "editQueuedMessage", payload: { id: "queued-id", text: "edited", images: [] } },
		{ type: "updateTodoList", payload: { todos: [] } },
		{ type: "deleteMessageConfirm", messageTs: 10 },
		{ type: "condenseTaskContextRequest", text: "task" },
		{ type: "checkpointRestore", payload: { ts: 10, commitHash: "commit", mode: "restore" } },
	])("fences $type against blocked execution and replacement during its guard", async (message) => {
		for (const replacementDuringGuard of [false, true]) {
			const h = harness()
			h.task.guardExecution.mockImplementationOnce(async () => {
				if (replacementDuringGuard) h.setCurrent(makeTask("task"))
				return replacementDuringGuard
			})
			await h.dispatch(message)
			expect(h.task.handleTerminalOperation).not.toHaveBeenCalled()
			expect(h.task.messageQueueService.removeMessage).not.toHaveBeenCalled()
			expect(h.task.messageQueueService.updateMessage).not.toHaveBeenCalled()
			expect(h.task.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
			expect(h.provider.condenseTaskContext).not.toHaveBeenCalled()
			expect(h.provider.cancelTask).not.toHaveBeenCalled()
			expect(setPendingTodoList).not.toHaveBeenCalled()
		}
	})

	it("does not authorize a different condensation target using the focused task", async () => {
		const h = harness()
		await h.dispatch({ type: "condenseTaskContextRequest", text: "other" })
		expect(h.task.guardExecution).not.toHaveBeenCalled()
		expect(h.provider.condenseTaskContext).not.toHaveBeenCalled()
	})

	it("allows authorized queue edits, todo edits, terminal continuation and condensation", async () => {
		const h = harness()
		await h.dispatch({ type: "removeQueuedMessage", text: "queued-id" })
		await h.dispatch({ type: "editQueuedMessage", payload: { id: "queued-id", text: "edited", images: [] } })
		await h.dispatch({ type: "updateTodoList", payload: { todos: [] } })
		await h.dispatch({ type: "terminalOperation", terminalOperation: "continue" })
		await h.dispatch({ type: "condenseTaskContextRequest", text: "task" })
		expect(h.task.messageQueueService.removeMessage).toHaveBeenCalledWith("queued-id")
		expect(h.task.messageQueueService.updateMessage).toHaveBeenCalledWith("queued-id", "edited", [])
		expect(setPendingTodoList).toHaveBeenCalledWith([])
		expect(h.task.handleTerminalOperation).toHaveBeenCalledWith("continue")
		expect(h.provider.condenseTaskContext).toHaveBeenCalledWith("task")
	})

	it.each(["deleteMessageConfirm", "editMessageConfirm"] as const)(
		"does not persist or submit %s after focus changes during rewind",
		async (type) => {
			const h = harness()
			h.task.messageManager.rewindToTimestamp.mockImplementationOnce(async () => {
				h.setCurrent(makeTask("other"))
			})
			await h.dispatch({ type, messageTs: 10, text: "edit" })
			expect(saveTaskMessages).not.toHaveBeenCalled()
			expect(h.task.overwriteClineMessages).not.toHaveBeenCalled()
			expect(h.task.submitUserMessage).not.toHaveBeenCalled()
		},
	)

	it.each(["deleteMessageConfirm", "editMessageConfirm"] as const)(
		"does not publish or submit %s after focus changes during persistence",
		async (type) => {
			const h = harness()
			vi.mocked(saveTaskMessages).mockImplementationOnce(async () => {
				h.setCurrent(makeTask("task"))
				return []
			})
			await h.dispatch({ type, messageTs: 10, text: "edit" })
			expect(h.task.overwriteClineMessages).not.toHaveBeenCalled()
			expect(h.task.submitUserMessage).not.toHaveBeenCalled()
		},
	)

	it("does not submit an edit after authority is lost during transcript publication", async () => {
		const h = harness()
		h.task.overwriteClineMessages.mockImplementationOnce(async () => {
			h.task.guardExecution.mockResolvedValue(false)
		})
		await h.dispatch({ type: "editMessageConfirm", messageTs: 10, text: "edit" })
		expect(h.task.overwriteClineMessages).toHaveBeenCalledTimes(1)
		expect(h.task.submitUserMessage).not.toHaveBeenCalled()
	})

	it("refuses checkpoint edits before delegating to the checkpoint operation", async () => {
		const h = harness()
		h.task.guardExecution.mockResolvedValue(false)
		await h.dispatch({ type: "deleteMessageConfirm", messageTs: 10, restoreCheckpoint: true })
		await h.dispatch({ type: "editMessageConfirm", messageTs: 10, text: "edit", restoreCheckpoint: true })
		expect(handleCheckpointRestoreOperation).not.toHaveBeenCalled()
	})

	it.each(["different task", "blocked restored task", "same-ID replacement"])(
		"does not restore a checkpoint on %s",
		async (scenario) => {
			const h = harness()
			const restored = makeTask(scenario === "different task" ? "other" : "task")
			const replacement = makeTask("task")
			h.provider.cancelTask.mockImplementationOnce(async () => h.setCurrent(restored))
			if (scenario === "blocked restored task") restored.guardExecution.mockResolvedValue(false)
			if (scenario === "same-ID replacement")
				vi.mocked(pWaitFor).mockImplementationOnce(async () => h.setCurrent(replacement))
			await h.dispatch({ type: "checkpointRestore", payload: { ts: 10, commitHash: "commit", mode: "restore" } })
			expect(h.task.checkpointRestore).not.toHaveBeenCalled()
			expect(restored.checkpointRestore).not.toHaveBeenCalled()
			expect(replacement.checkpointRestore).not.toHaveBeenCalled()
		},
	)

	it.each(["checkpointRestore", "completionCheckpointRestore"] as const)(
		"applies %s only after guarding the captured restored runtime",
		async (type) => {
			const h = harness()
			h.task.clineMessages.push({ ts: 11, type: "say", say: "checkpoint_saved", text: "commit" })
			const restored = makeTask("task")
			h.provider.cancelTask.mockImplementationOnce(async () => h.setCurrent(restored))
			await h.dispatch({ type, payload: { ts: 11, commitHash: "commit", mode: "restore" } })
			expect(h.task.guardExecution).toHaveBeenCalledTimes(1)
			expect(restored.guardExecution).toHaveBeenCalledTimes(1)
			expect(restored.checkpointRestore).toHaveBeenCalledExactlyOnceWith({
				ts: 11,
				commitHash: "commit",
				mode: "restore",
			})
		},
	)

	it.each(["initial refusal", "different task", "blocked restored task", "same-ID replacement"])(
		"fences completion checkpoint restoration after %s",
		async (scenario) => {
			const h = harness()
			h.task.clineMessages.push({ ts: 11, type: "say", say: "checkpoint_saved", text: "commit" })
			const restored = makeTask(scenario === "different task" ? "other" : "task")
			const replacement = makeTask("task")
			h.provider.cancelTask.mockImplementationOnce(async () => h.setCurrent(restored))
			if (scenario === "initial refusal") h.task.guardExecution.mockResolvedValue(false)
			if (scenario === "blocked restored task") restored.guardExecution.mockResolvedValue(false)
			if (scenario === "same-ID replacement")
				vi.mocked(pWaitFor).mockImplementationOnce(async () => h.setCurrent(replacement))
			await h.dispatch({ type: "completionCheckpointRestore" })
			expect(h.task.checkpointRestore).not.toHaveBeenCalled()
			expect(restored.checkpointRestore).not.toHaveBeenCalled()
			expect(replacement.checkpointRestore).not.toHaveBeenCalled()
		},
	)

	it("does not gate navigation, cancellation, terminal abort or global settings on task execution", async () => {
		const h = harness()
		h.task.guardExecution.mockResolvedValue(false)
		await h.dispatch({ type: "showTaskWithId", text: "history" })
		await h.dispatch({ type: "cancelTask" })
		await h.dispatch({ type: "cancelAutoApproval" })
		await h.dispatch({ type: "terminalOperation", terminalOperation: "abort" })
		await h.dispatch({ type: "updateSettings", updatedSettings: { soundEnabled: false } })
		expect(h.task.guardExecution).not.toHaveBeenCalled()
		expect(h.provider.showTaskWithId).toHaveBeenCalledWith("history")
		expect(h.provider.cancelTask).toHaveBeenCalledTimes(1)
		expect(h.task.cancelAutoApprovalTimeout).toHaveBeenCalledTimes(1)
		expect(h.task.handleTerminalOperation).toHaveBeenCalledWith("abort")
		expect(h.provider.contextProxy.setValue).toHaveBeenCalledWith("soundEnabled", false)
		expect(h.provider.recoverTask).not.toHaveBeenCalled()
	})
})
