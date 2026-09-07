import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import EventEmitter from "events"
import {
	RooCodeEventName,
	type DelegatedCompletionRequest,
	type ExecutionCommandResult,
	type ExecutionToken,
	type HistoryItem,
	type PendingTaskAction,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { Task } from "../Task"
import { TaskScheduler } from "../TaskScheduler"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { ExecutionAuthorityError } from "../../task-persistence/taskLifecycle"
import { readApiMessages, saveApiMessages } from "../../task-persistence/apiMessages"
import { readTaskMessages, saveTaskMessages } from "../../task-persistence/taskMessages"
import { ClineProvider } from "../../webview/ClineProvider"
import { presentAssistantMessage } from "../../assistant-message/presentAssistantMessage"
import { newTaskTool } from "../../tools/NewTaskTool"
import { attemptCompletionTool } from "../../tools/AttemptCompletionTool"
import { writeToFileTool } from "../../tools/WriteToFileTool"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import * as ignoreController from "../../ignore/RooIgnoreController"
import * as nativeTools from "../build-tools"
import * as environment from "../../environment/getEnvironmentDetails"
import * as apiModule from "../../../api"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import * as storagePaths from "../../../utils/storage"
import type { RooTerminalProcess, RooTerminalProcessEvents } from "../../../integrations/terminal/types"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence"
import type { ClineMessage } from "@roo-code/types"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function applied(result: ExecutionCommandResult) {
	if (result.kind !== "applied") throw new Error(result.reason)
	return result
}

describe("Task immutable execution authority", () => {
	let storage: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	const tasks: Task[] = []
	const peers: TaskHistoryStore[] = []

	beforeEach(async () => {
		// Install explicit runtime doubles: the Windows runner can resolve hoisted
		// relative module mocks differently from Task's transitive imports.
		const ignorePrototype = ignoreController.RooIgnoreController.prototype
		vi.spyOn(ignoreController, "RooIgnoreController").mockImplementation(function () {
			return Object.assign(Object.create(ignorePrototype) as ignoreController.RooIgnoreController, {
				initialize: vi.fn(async () => {}),
				dispose: vi.fn(),
				validateAccess: vi.fn(() => true),
			})
		})
		vi.spyOn(nativeTools, "buildNativeToolsArrayWithRestrictions").mockResolvedValue({ tools: [] })
		vi.spyOn(environment, "getEnvironmentDetails").mockResolvedValue("")
		vi.spyOn(apiModule, "buildApiHandler").mockImplementation(() => ({
			getModel: () => ({
				id: "offline",
				info: { contextWindow: 10000, supportsImages: false, supportsPromptCache: false },
			}),
			ensureModelFetched: vi.fn(async () => {}),
			countTokens: vi.fn(async () => 1),
			createMessage: vi.fn(() => {
				throw new Error("Unexpected model request")
			}),
		}))
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-task-authority-"))
		store = new TaskHistoryStore(storage)
		await store.initialize()
		provider = makeProvider(store)
	})

	function makeProvider(historyStore: TaskHistoryStore): ClineProvider {
		// Keep Task/store real; shell services and unrelated provider startup are not
		// needed for these caller-contract tests. Each overridden API stays typed.
		return Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			context: makeExtensionContext({ globalStorageUri: makeUri(storage) }),
			taskHistoryStore: historyStore,
			getState: vi.fn(async () => ({ mode: "code", mcpEnabled: false, autoApprovalEnabled: false })),
			log: vi.fn(),
			postStateToWebviewThrottled: vi.fn(async () => {}),
			flushPostStateToWebviewThrottled: vi.fn(async () => {}),
			postClineMessagesSnapshot: vi.fn(async () => {}),
			postClineMessageAppended: vi.fn(async () => {}),
			postClineMessageUpdated: vi.fn(async () => {}),
			isClineMessagesPartialCoalescingActive: () => false,
		})
	}

	afterEach(async () => {
		for (const task of tasks.splice(0)) {
			await task.abortTask(true)
			await task.dispose()
		}
		for (const peer of peers.splice(0)) peer.dispose()
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(storage, { recursive: true, force: true })
	})

	function fromHistory(history: HistoryItem, token?: ExecutionToken, taskProvider = provider) {
		const task = new Task({
			provider: taskProvider,
			apiConfiguration: {},
			historyItem: history,
			executionToken: token,
			startTask: false,
			enableCheckpoints: false,
			workspacePath: storage,
		})
		tasks.push(task)
		return task
	}

	async function create(id = "task", observe = false) {
		const history: HistoryItem = { id, task: "Original", number: 1, ts: 1, tokensIn: 0, tokensOut: 0, totalCost: 0 }
		const claim = applied(await store.claimNewTask(history, store.ownerForRuntime(`runtime-${id}`)))
		return { task: fromHistory(claim.history, observe ? undefined : claim.token), ...claim }
	}

	async function sharedResources(taskId: string) {
		const outputDir = path.join(await storagePaths.getTaskDirectoryPath(storage, taskId), "command-output")
		await fs.mkdir(outputDir, { recursive: true })
		const artifact = path.join(outputDir, "cmd-live.txt")
		await fs.writeFile(artifact, "Live owner output")
		const terminal = await TerminalRegistry.getOrCreateTerminal(storage, taskId, "execa")
		return { artifact, terminal, outputDir }
	}

	it("closing a same-task peer observer preserves owner terminals, artifacts and both histories", async () => {
		const owner = await create()
		await owner.task.overwriteApiConversationHistory([{ role: "user", content: "Original", ts: 1 }])
		await owner.task.overwriteClineMessages([{ type: "say", say: "text", text: "Original", ts: 1 }])
		const peer = new TaskHistoryStore(storage)
		peers.push(peer)
		await peer.initialize()
		const observer = fromHistory(await peer.readAuthoritative(owner.task.taskId), undefined, makeProvider(peer))
		const { artifact, terminal } = await sharedResources(owner.task.taskId)
		const process: RooTerminalProcess = Object.assign(new EventEmitter<RooTerminalProcessEvents>(), {
			command: "live owner command",
			isHot: true,
			run: async () => {},
			continue: vi.fn(),
			abort: vi.fn(),
			hasUnretrievedOutput: () => true,
			getUnretrievedOutput: () => "Live owner output",
			trimRetrievedOutput: vi.fn(),
		})
		terminal.process = process
		terminal.busy = true
		owner.task.terminalProcess = process
		const history = await store.readAuthoritative(owner.task.taskId)
		const options = { taskId: owner.task.taskId, globalStoragePath: storage }
		const api = await readApiMessages(options)
		const messages = await readTaskMessages(options)
		await observer.hydrateForRecovery()
		expect(observer.clineMessages).toEqual(messages)
		expect(observer.apiConversationHistory).toEqual(api)
		const cleanup = vi.spyOn(OutputInterceptor, "cleanup")
		const release = vi.spyOn(TerminalRegistry, "releaseTerminalsForTask")
		const directory = vi.spyOn(storagePaths, "getTaskDirectoryPath")
		await observer.abortTask(true)
		expect(await observer.awaitExecutionCleanup()).toBe(true)
		expect(cleanup).not.toHaveBeenCalled()
		expect(release).not.toHaveBeenCalled()
		expect(directory).not.toHaveBeenCalled()
		expect(terminal.taskId).toBe(owner.task.taskId)
		expect(terminal.busy).toBe(true)
		expect(process.abort).not.toHaveBeenCalled()
		expect(await fs.readFile(artifact, "utf8")).toBe("Live owner output")
		expect(await readApiMessages(options)).toEqual(api)
		expect(await readTaskMessages(options)).toEqual(messages)
		expect(await store.readAuthoritative(owner.task.taskId)).toEqual(history)
		expect(await owner.task.guardExecution()).toBe(true)
		process.emit("shell_execution_complete", { exitCode: 0 })
		terminal.busy = false
		terminal.process = undefined
	})

	it.each(["active", "interrupted", "completed"] as const)(
		"cleans shared resources for the actual %s owner without reauthorizing execution",
		async (phase) => {
			const { task, token } = await create()
			const { artifact, terminal, outputDir } = await sharedResources(task.taskId)
			if (phase === "interrupted") applied(await store.interruptTask(token))
			if (phase === "completed") applied(await store.completeStandaloneTask(token, "Done"))
			const cleanup = vi.spyOn(OutputInterceptor, "cleanup")
			const release = vi.spyOn(TerminalRegistry, "releaseTerminalsForTask")
			await task.abortTask()
			expect(await task.awaitExecutionCleanup()).toBe(true)
			expect(cleanup).toHaveBeenCalledExactlyOnceWith(outputDir)
			expect(release).toHaveBeenCalledExactlyOnceWith(task.taskId)
			expect(terminal.taskId).toBeUndefined()
			await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" })
			expect(task.executionToken).toEqual(token)
			expect(await task.guardExecution()).toBe(false)
		},
	)

	it.each(["new runtime", "same runtime"])("stale disposal cannot clean a transferred %s", async (variant) => {
		const { task, token } = await create()
		// Exercise direct stale Task.dispose even if a caller incorrectly attests cleanup.
		const next = applied(
			await store.transferTaskExecution(
				token,
				variant === "same runtime" ? token.owner : store.ownerForRuntime("replacement"),
				true,
			),
		)
		fromHistory(next.history, next.token)
		const { artifact, terminal } = await sharedResources(task.taskId)
		const cleanup = vi.spyOn(OutputInterceptor, "cleanup")
		const release = vi.spyOn(TerminalRegistry, "releaseTerminalsForTask")
		await task.dispose()
		expect(cleanup).not.toHaveBeenCalled()
		expect(release).not.toHaveBeenCalled()
		expect(terminal.taskId).toBe(task.taskId)
		expect(await fs.readFile(artifact, "utf8")).toBe("Live owner output")
		expect(await store.guardExecution(next.token)).toMatchObject({ kind: "allowed" })
	})

	it("a copied peer token does not authorize shared cleanup", async () => {
		const owner = await create()
		const peer = new TaskHistoryStore(storage)
		peers.push(peer)
		await peer.initialize()
		const impostor = fromHistory(owner.history, owner.token, makeProvider(peer))
		const { artifact, terminal } = await sharedResources(owner.task.taskId)
		const cleanup = vi.spyOn(OutputInterceptor, "cleanup")
		const release = vi.spyOn(TerminalRegistry, "releaseTerminalsForTask")
		await impostor.dispose()
		expect(cleanup).not.toHaveBeenCalled()
		expect(release).not.toHaveBeenCalled()
		expect(terminal.taskId).toBe(owner.task.taskId)
		expect(await fs.readFile(artifact, "utf8")).toBe("Live owner output")
	})

	it.each(["completed", "ownerless"])("hydrates an ordinary %s observer without inventing an error", async (kind) => {
		const { task, token } = await create()
		await task.overwriteApiConversationHistory([{ role: "user", content: "Original", ts: 1 }])
		await task.overwriteClineMessages([{ type: "say", say: "text", text: "Original", ts: 1 }])
		if (kind === "completed") applied(await store.completeStandaloneTask(token, "Done"))
		const current = await store.readAuthoritative(task.taskId)
		const settled = applied(
			await store.settleTaskExecution({ ...token, generation: current.executionGeneration! }, true),
		)
		const observer = fromHistory(settled.history)
		const snapshot = vi.spyOn(store, "saveExecutionSnapshot")
		await observer.hydrateForRecovery()
		expect(observer.clineMessages).toEqual(task.clineMessages)
		expect(observer.clineMessages.some((message) => message.say === "error")).toBe(false)
		expect(snapshot).not.toHaveBeenCalled()
	})

	it("does not duplicate a durable delegation failure even when an explicit fallback is supplied", async () => {
		const { task } = await create("observer", true)
		const messages: ClineMessage[] = [
			{ type: "say", say: "error", text: "Original failure", ts: 1, messageId: "delegation:failed" },
		]
		await saveTaskMessages({ taskId: task.taskId, globalStoragePath: storage, messages })
		await saveApiMessages({ taskId: task.taskId, globalStoragePath: storage, messages: [] })
		await task.hydrateForRecovery("Explicit unexpected failure")
		expect(task.clineMessages).toEqual(messages)
	})

	it("adds only an explicitly supplied recovery failure in memory, never to either history", async () => {
		const { task } = await create("observer", true)
		const options = { taskId: task.taskId, globalStoragePath: storage }
		await saveTaskMessages({ ...options, messages: [{ type: "say", say: "text", text: "Original", ts: 1 }] })
		await saveApiMessages({ ...options, messages: [{ role: "user", content: "Original", ts: 1 }] })
		const messages = await readTaskMessages(options)
		const api = await readApiMessages(options)
		await task.hydrateForRecovery("Explicit failure")
		await task.hydrateForRecovery("Explicit failure")
		expect(task.clineMessages.filter((message) => message.say === "error")).toEqual([
			expect.objectContaining({ text: "Explicit failure" }),
		])
		expect(await readTaskMessages(options)).toEqual(messages)
		expect(await readApiMessages(options)).toEqual(api)
	})

	it("rechecks shared ownership after asynchronous task-path resolution", async () => {
		const { task, token } = await create()
		const { artifact, terminal } = await sharedResources(task.taskId)
		const resolvePath = storagePaths.getTaskDirectoryPath
		vi.spyOn(storagePaths, "getTaskDirectoryPath").mockImplementationOnce(async (...args) => {
			const next = applied(await store.transferTaskExecution(token, store.ownerForRuntime("replacement"), true))
			fromHistory(next.history, next.token)
			return resolvePath(...args)
		})
		const cleanup = vi.spyOn(OutputInterceptor, "cleanup")
		const release = vi.spyOn(TerminalRegistry, "releaseTerminalsForTask")
		await task.dispose()
		expect(cleanup).not.toHaveBeenCalled()
		expect(release).not.toHaveBeenCalled()
		expect(terminal.taskId).toBe(task.taskId)
		expect(await fs.readFile(artifact, "utf8")).toBe("Live owner output")
	})

	it("fails closed on unreadable cleanup ownership but still disposes local resources", async () => {
		const { task } = await create()
		const { artifact, terminal } = await sharedResources(task.taskId)
		vi.spyOn(store, "readAuthoritative").mockRejectedValueOnce(new Error("unreadable"))
		const ignoreDispose = vi.spyOn(task.rooIgnoreController!, "dispose")
		const cleanup = vi.spyOn(OutputInterceptor, "cleanup")
		const release = vi.spyOn(TerminalRegistry, "releaseTerminalsForTask")
		await task.dispose()
		expect(task.cleanupSettled).toBe(false)
		expect(ignoreDispose).toHaveBeenCalledOnce()
		expect(cleanup).not.toHaveBeenCalled()
		expect(release).not.toHaveBeenCalled()
		expect(terminal.taskId).toBe(task.taskId)
		expect(await fs.readFile(artifact, "utf8")).toBe("Live owner output")
		terminal.taskId = undefined
	})

	it("does not adopt a token from history, start, scheduler, presenter, tools or model preparation", async () => {
		const { task, history } = await create("observer", true)
		expect(task.executionGeneration).toBe(history.executionGeneration)
		expect(task.executionToken).toBeUndefined()
		expect(task.executionBlocked).toBe(true)
		const scheduled = vi.fn(async () => {})
		const approval = vi.fn(async () => true)
		task.start()
		await task.run()
		await new TaskScheduler().schedule(task, scheduled)
		await presentAssistantMessage(task)
		await newTaskTool.execute({ mode: "code", message: "child" }, task, {
			askApproval: approval,
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		})
		expect(await collectStream(task.attemptApiRequest())).toEqual([])
		await expect(task["safeEnsureModelFetched"]()).rejects.toBeInstanceOf(ExecutionAuthorityError)
		expect(scheduled).not.toHaveBeenCalled()
		expect(approval).not.toHaveBeenCalled()
		expect(task.api.ensureModelFetched).not.toHaveBeenCalled()
	})

	it("captures an immutable token and refuses stale saves even after a fresh cache read", async () => {
		const { task, token } = await create()
		expect(task.instanceId).toBe(token.owner.runtimeId)
		expect(Object.isFrozen(task.executionToken)).toBe(true)
		expect(Object.isFrozen(task.executionToken?.owner)).toBe(true)
		await task.overwriteApiConversationHistory([{ role: "user", content: "Original", ts: 1 }])
		applied(await store.interruptTask(token))
		await store.reconcile()
		await task.overwriteApiConversationHistory([{ role: "user", content: "stale", ts: 2 }])
		expect(task.executionBlocked).toBe(true)
		expect(task.executionToken).toEqual(token)
		expect((await readApiMessages({ taskId: task.taskId, globalStoragePath: storage }))[0].content).toBe("Original")
		task.executionBlocked = false
		expect(await task.guardExecution()).toBe(false)
	})

	it("rechecks in-memory cancellation after the storage guard awaits", async () => {
		const { task } = await create()
		const barrier = deferred<void>()
		const entered = deferred<void>()
		const original = store.guardExecution.bind(store)
		vi.spyOn(store, "guardExecution").mockImplementation(async (token) => {
			const allowed = await original(token)
			entered.resolve()
			await barrier.promise
			return allowed
		})
		const guard = task.guardExecution()
		await entered.promise
		task.abort = true
		barrier.resolve()
		expect(await guard).toBe(false)
		expect(task.executionBlocked).toBe(true)
	})

	it("rechecks scheduler admission after a permit wait and deduplicates the incarnation", async () => {
		const first = await create("first")
		const second = await create("second")
		const scheduler = new TaskScheduler()
		const barrier = deferred<void>()
		const entered = deferred<void>()
		const running = scheduler.schedule(first.task, async () => {
			entered.resolve()
			await barrier.promise
		})
		await entered.promise
		const callback = vi.fn(async () => {})
		const queued = scheduler.schedule(second.task, callback)
		expect(scheduler.schedule(second.task, callback)).toBe(queued)
		await vi.waitFor(() => expect(scheduler.waiting).toBe(1))
		applied(await store.interruptTask(second.token))
		barrier.resolve()
		await Promise.all([running, queued])
		expect(callback).not.toHaveBeenCalled()
		expect(second.task.executionBlocked).toBe(true)
	})

	it("deduplicates different Task objects carrying the same immutable incarnation", async () => {
		const first = await create()
		const duplicate = new Task({
			provider,
			apiConfiguration: {},
			historyItem: first.history,
			executionToken: first.token,
			startTask: false,
			enableCheckpoints: false,
			workspacePath: storage,
		})
		tasks.push(duplicate)
		const scheduler = new TaskScheduler()
		const run = vi.fn(async () => {})
		await Promise.all([scheduler.schedule(first.task, run), scheduler.schedule(duplicate, run)])
		expect(run).toHaveBeenCalledTimes(1)
	})

	it("a supplied token for another task cannot authorize this task or its snapshot", async () => {
		const first = await create()
		const mismatched = new Task({
			provider,
			apiConfiguration: {},
			historyItem: { ...first.history, id: "other" },
			executionToken: first.token,
			startTask: false,
			enableCheckpoints: false,
			workspacePath: storage,
		})
		tasks.push(mismatched)
		expect(await mismatched.guardExecution()).toBe(false)
		expect(mismatched.executionToken).toEqual(first.token)
	})

	it.each(["local abort", "durable fence"] as const)(
		"releases queued feedback when ask publication races with %s",
		async (revocation) => {
			const { task, token } = await create()
			task.messageQueueService.addMessage("Keep this feedback")
			const remove = vi.spyOn(task.messageQueueService, "removeMessage")
			vi.mocked(provider.postClineMessageAppended).mockImplementationOnce(async () => {
				if (revocation === "local abort") task.abort = true
				else applied(await store.interruptTask(token))
			})

			await expect(task.ask("completion_result", "Done", false)).rejects.toBeInstanceOf(ExecutionAuthorityError)

			expect(task.executionBlocked).toBe(true)
			expect(remove).not.toHaveBeenCalled()
			expect(task.messageQueueService.messages).toHaveLength(1)
			expect(task.messageQueueService.claimNextMessage()?.text).toBe("Keep this feedback")
			expect(task.clineMessages.some((message) => message.say === "user_feedback")).toBe(false)
		},
	)

	it.each([true, false])("refuses approval after authority changes (automatic=%s)", async (automatic) => {
		const { task, token } = await create()
		vi.mocked(provider.getState).mockResolvedValue({
			...(await provider.getState()),
			autoApprovalEnabled: automatic,
			alwaysAllowSubtasks: true,
		})
		const published = deferred<void>()
		vi.mocked(provider.postClineMessageAppended).mockImplementation(async () => {
			if (automatic) applied(await store.interruptTask(token))
			published.resolve()
		})
		const asking = task.ask("tool", JSON.stringify({ tool: "newTask" }), false).catch((error: unknown) => error)
		await published.promise
		if (!automatic) {
			applied(await store.interruptTask(token))
			task.handleWebviewAskResponse("yesButtonClicked")
		}
		expect(await asking).toBeInstanceOf(ExecutionAuthorityError)
		expect(task.executionBlocked).toBe(true)
	})

	it("rechecks presenter after asynchronous checkpoint preparation", async () => {
		const { task, token } = await create()
		task.assistantMessageSavedToHistory = true
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "write",
				name: "write_to_file",
				params: {},
				partial: false,
				nativeArgs: { path: "file.txt", content: "content" },
			},
		]
		vi.spyOn(task, "checkpointSave").mockImplementation(async () => {
			applied(await store.interruptTask(token))
		})
		const tool = vi.spyOn(writeToFileTool, "handle").mockResolvedValue()
		await presentAssistantMessage(task)
		expect(tool).not.toHaveBeenCalled()
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("keeps the presenter lock across next-block guards so concurrent updates cannot dispatch twice", async () => {
		const { task } = await create()
		task.assistantMessageSavedToHistory = true
		task.assistantMessageContent = ["first", "second"].map((id) => ({
			type: "tool_use",
			id,
			name: "write_to_file",
			params: {},
			partial: false,
			nativeArgs: { path: "file.txt", content: id },
		}))
		const entered = deferred<void>()
		const barrier = deferred<void>()
		const tool = vi
			.spyOn(writeToFileTool, "handle")
			.mockImplementationOnce(async () => {
				entered.resolve()
				await barrier.promise
			})
			.mockResolvedValue()
		const presenting = presentAssistantMessage(task)
		await entered.promise
		await presentAssistantMessage(task)
		barrier.resolve()
		await presenting
		expect(tool).toHaveBeenCalledTimes(2)
		expect(task.currentStreamingContentIndex).toBe(2)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("does not dispatch a complete tool before durable assistant history or after cancellation during that wait", async () => {
		const { task } = await create()
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "write",
				name: "write_to_file",
				params: {},
				partial: false,
				nativeArgs: { path: "file.txt", content: "content" },
			},
		]
		const tool = vi.spyOn(writeToFileTool, "handle").mockResolvedValue()
		const presenting = presentAssistantMessage(task)
		await vi.waitFor(() => expect(task.presentAssistantMessageLocked).toBe(true))
		expect(tool).not.toHaveBeenCalled()
		await task.abortTask()
		task.assistantMessageSavedToHistory = true
		await presenting
		expect(tool).not.toHaveBeenCalled()
	})

	it("refuses a new-task approval after the captured origin loses authority", async () => {
		const { task, token } = await create()
		const persist = vi.fn(async (_id: string, _action: PendingTaskAction, origin?: Task) => {
			expect(origin).toBe(task)
		})
		const delegate = vi.fn()
		Object.assign(provider, {
			setPendingTaskAction: persist,
			validateTaskDelegation: async () => true,
			delegateParentAndOpenChild: delegate,
		})
		await newTaskTool.execute({ mode: "code", message: "Child" }, task, {
			toolCallId: "create",
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			askApproval: async () => {
				applied(await store.interruptTask(token))
				return true
			},
		})
		expect(persist).toHaveBeenCalledTimes(1)
		expect(delegate).not.toHaveBeenCalled()
		expect(task.executionBlocked).toBe(true)
	})

	it("does not reset abort or abandoned while returning from delegation", async () => {
		const { task } = await create()
		task.abort = true
		task.abandoned = true
		await task.resumeAfterDelegation()
		expect(task.abort).toBe(true)
		expect(task.abandoned).toBe(true)
		expect(task.api.createMessage).not.toHaveBeenCalled()
	})

	it("keeps cleanup unsettled for real work and background shell execution, not flags", async () => {
		const { task } = await create()
		const barrier = deferred<void>()
		void task.trackExecutionWork(barrier.promise)
		const process: RooTerminalProcess = Object.assign(new EventEmitter<RooTerminalProcessEvents>(), {
			command: "background",
			isHot: false,
			run: async () => {},
			continue: vi.fn(),
			abort: vi.fn(),
			hasUnretrievedOutput: () => false,
			getUnretrievedOutput: () => "",
			trimRetrievedOutput: vi.fn(),
		})
		task.terminalProcess = process
		task.terminalProcess = undefined
		await task.abortTask()
		await task.dispose()
		expect(process.abort).toHaveBeenCalled()
		expect(task.cleanupSettled).toBe(false)
		barrier.resolve()
		expect(await task.awaitExecutionCleanup()).toBe(false)
		process.emit("shell_execution_complete", { exitCode: 0 })
		expect(task.cleanupSettled).toBe(true)
	})

	it("tracks a non-handoff tool until its pending approval unwinds on cancellation", async () => {
		const { task } = await create()
		task.assistantMessageSavedToHistory = true
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "write",
				name: "write_to_file",
				params: {},
				partial: false,
				nativeArgs: { path: "file.txt", content: "content" },
			},
		]
		const waiting = deferred<void>()
		const tool = vi.spyOn(writeToFileTool, "handle").mockImplementation(async (_task, _block, callbacks) => {
			await callbacks.askApproval("tool", JSON.stringify({ tool: "editedExistingFile", path: "file.txt" }))
		})
		vi.mocked(provider.postClineMessageAppended).mockImplementation(async (_id, message) => {
			if (message.type === "ask") waiting.resolve()
		})
		const presenting = presentAssistantMessage(task)
		await waiting.promise
		await task.abortTask()
		expect(await task.awaitExecutionCleanup()).toBe(true)
		await presenting
		expect(tool).toHaveBeenCalledOnce()
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("does not launch an approved command after authority is fenced during terminal preparation", async () => {
		const { task, token } = await create()
		task.assistantMessageSavedToHistory = true
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "command",
				name: "execute_command",
				params: {},
				partial: false,
				nativeArgs: { command: "echo approved" },
			},
		]
		Object.assign(provider, { contextProxy: { getValue: () => false } })
		vi.spyOn(task.rooIgnoreController!, "validateCommand").mockReturnValue(undefined)
		vi.mocked(provider.postClineMessageAppended).mockImplementation(async (_id, message) => {
			if (message.ask === "command") task.handleWebviewAskResponse("yesButtonClicked")
		})
		const terminal = await TerminalRegistry.getOrCreateTerminal(storage, task.taskId, "execa")
		const launch = vi.spyOn(terminal, "runCommand").mockImplementation(() => {
			throw new Error("Unexpected command launch after fencing")
		})
		const entered = deferred<void>()
		const release = deferred<void>()
		vi.spyOn(TerminalRegistry, "getOrCreateTerminal").mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			return terminal
		})
		const presenting = presentAssistantMessage(task)
		await entered.promise
		try {
			applied(await store.interruptTask(token))
		} finally {
			release.resolve()
		}
		await presenting
		expect(launch).not.toHaveBeenCalled()
		expect(task.executionBlocked).toBe(true)
	})

	it("does not invoke an MCP tool after authority is fenced during request-start publication", async () => {
		const { task, token } = await create()
		const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "unexpected result" }] }))
		Object.assign(provider, {
			getMcpHub: () => ({ callTool }),
			postMessageToWebview: vi.fn(async () => {}),
		})
		vi.mocked(provider.postClineMessageAppended).mockImplementation(async (_id, message) => {
			if (message.say === "mcp_server_request_started") applied(await store.interruptTask(token))
		})
		const result = await useMcpToolTool["executeToolAndProcessResult"](
			task,
			"server",
			"tool",
			{},
			"execution",
			vi.fn(),
		).catch((error: unknown) => error)
		expect(callTool).not.toHaveBeenCalled()
		expect(result).toBeInstanceOf(ExecutionAuthorityError)
		expect(task.executionBlocked).toBe(true)
	})

	it("retains cleanup failure when workspace reversion rejects", async () => {
		const { task } = await create()
		task.diffViewProvider.isEditing = true
		vi.spyOn(task.diffViewProvider, "revertChanges").mockRejectedValue(new Error("workspace busy"))
		await task.abortTask()
		await task.dispose()
		expect(task.cleanupSettled).toBe(false)
	})

	it("hydrates recovery read-only and preserves failure while appending the explicit choice", async () => {
		const { task } = await create()
		const messages = [
			{
				role: "assistant" as const,
				ts: 1,
				content: [{ type: "tool_use" as const, id: "failed", name: "new_task", input: {} }],
			},
			{
				role: "user" as const,
				ts: 2,
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "failed",
						content: "Original failure",
						is_error: true,
					},
				],
			},
		]
		await saveApiMessages({ taskId: task.taskId, globalStoragePath: storage, messages })
		await saveTaskMessages({
			taskId: task.taskId,
			globalStoragePath: storage,
			messages: [{ type: "say", say: "error", text: "Original failure", ts: 2 }],
		})
		const loop = vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementation(async (content) => {
			await task["addToApiConversationHistory"]({ role: "user", content })
			return true
		})
		await task.resumeAfterRecovery("resume_independent")
		expect(loop).toHaveBeenCalledTimes(1)
		const content = loop.mock.calls[0][0]
		expect(content).toContainEqual(messages[1].content[0])
		expect(content).toContainEqual({ type: "text", text: "Explicit recovery choice: resume_independent." })
		expect(content.filter((block) => block.type === "tool_result")).toHaveLength(1)
		const before = await readTaskMessages({ taskId: task.taskId, globalStoragePath: storage })
		await task.hydrateForRecovery()
		expect(await readTaskMessages({ taskId: task.taskId, globalStoragePath: storage })).toEqual(before)
	})

	it("runs one real recovered model turn with the fresh choice and original failure, then drains completion", async () => {
		const owner = await create()
		const originalResult = {
			type: "tool_result" as const,
			tool_use_id: "failed",
			content: "Original failure",
			is_error: true,
		}
		const messages: ApiMessage[] = [
			{ role: "user", content: "Original", ts: 1 },
			{ role: "assistant", ts: 2, content: [{ type: "tool_use", id: "failed", name: "new_task", input: {} }] },
			{ role: "user", ts: 3, content: [originalResult] },
		]
		await owner.task.overwriteApiConversationHistory(messages)
		await owner.task.overwriteClineMessages([
			{ type: "say", say: "error", text: "Original failure", ts: 3, messageId: "delegation:failed" },
		])
		const fenced = applied(await store.interruptTask(owner.token))
		await owner.task.abortTask()
		expect(await owner.task.awaitExecutionCleanup()).toBe(true)
		applied(await store.settleTaskExecution(fenced.token, true))
		const preview = await store.previewRecovery(owner.task.taskId)
		const recovered = applied(
			await store.recoverTask({
				scope: preview.scope,
				owner: store.ownerForRuntime("recovered"),
				choice: "resume_independent",
				intent: "explicit_user_resume",
			}),
		)
		const task = fromHistory(recovered.history, recovered.token)
		task["getSystemPrompt"] = async () => "offline prompt"
		// No VS Code editor runtime is present; keep the actual request/presenter loop.
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue()
		const model = vi
			.spyOn(task.api, "createMessage")
			.mockImplementation(() => {
				// Bound retries independently of the production loop, without mocking that loop.
				task.executionBlocked = true
				return asyncStreamFrom([])
			})
			.mockImplementationOnce(() =>
				asyncStreamFrom<ApiStreamChunk>([
					{
						type: "tool_call_partial",
						index: 0,
						id: "finish-recovered",
						name: "attempt_completion",
						arguments: JSON.stringify({ result: "Recovered result" }),
					},
					{ type: "tool_call_end", id: "finish-recovered" },
					{ type: "usage", inputTokens: 1, outputTokens: 1 },
				]),
			)
		vi.mocked(provider.postClineMessageAppended).mockImplementation(async (_id, message) => {
			if (message.type === "ask" && message.ask === "completion_result")
				task.handleWebviewAskResponse("yesButtonClicked")
		})
		const complete = vi.fn(async (origin: Task, result: string) => {
			const completed = applied(await store.completeStandaloneTask(recovered.token, result))
			await origin.abortTask()
			expect(await origin.awaitExecutionCleanup()).toBe(true)
			applied(await store.settleTaskExecution(completed.token, true))
			return true
		})
		Object.assign(provider, { completeTask: complete })
		expect(await task.guardExecution()).toBe(true)
		await task.resumeAfterRecovery("resume_independent")
		await vi.waitFor(() => expect(task.presentAssistantMessageLocked).toBe(false))
		expect(
			model,
			JSON.stringify({ reason: task["executionRefusalReason"], messages: task.clineMessages }),
		).toHaveBeenCalledOnce()
		const request = model.mock.calls[0][1]
		const content = request.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		expect(content.filter((block) => block.type === "tool_result")).toEqual([originalResult])
		expect(content).toContainEqual({ type: "text", text: "Explicit recovery choice: resume_independent." })
		expect(complete).toHaveBeenCalledExactlyOnceWith(task, "Recovered result")
		const saved = await readApiMessages({ taskId: task.taskId, globalStoragePath: storage })
		expect(
			saved
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.filter((block) => block.type === "tool_result"),
		).toEqual([originalResult])
		expect(await store.readAuthoritative(task.taskId)).toMatchObject({ status: "completed" })
	}, 5_000)

	it("rechecks authority after awaited model metadata preparation", async () => {
		const { task, token } = await create()
		vi.mocked(task.api.ensureModelFetched!).mockImplementation(async () => {
			applied(await store.interruptTask(token))
		})
		await expect(task["safeEnsureModelFetched"]()).rejects.toBeInstanceOf(ExecutionAuthorityError)
		expect(task.api.createMessage).not.toHaveBeenCalled()
	})

	it("stops request issuance when tool preparation loses authority", async () => {
		const { task, token } = await create()
		vi.spyOn(task, "getTaskMode").mockImplementation(async () => {
			applied(await store.interruptTask(token))
			return "code"
		})
		await expect(collectStream(task.attemptApiRequest())).rejects.toBeInstanceOf(ExecutionAuthorityError)
		expect(task.api.createMessage).not.toHaveBeenCalled()
	})

	it("guards each yielded chunk and retains transport cleanup until a hung next actually settles", async () => {
		const { task } = await create()
		const waiting = deferred<void>()
		const release = deferred<void>()
		const stream = (async function* (): AsyncGenerator<ApiStreamChunk> {
			yield { type: "text", text: "first" }
			waiting.resolve()
			await release.promise
			yield { type: "text", text: "late" }
		})()
		vi.spyOn(task.api, "createMessage").mockReturnValue(stream)
		task.apiConversationHistory = [{ role: "user", content: "Original", ts: 1 }]
		// Prompt content is outside this transport boundary; retain real Task request guards.
		task["getSystemPrompt"] = async () => "offline prompt"
		const request = task.attemptApiRequest()
		expect(await request.next()).toMatchObject({ value: { type: "text", text: "first" } })
		const next = request.next().catch((error: unknown) => error)
		await waiting.promise
		// The foreground loop releases this reference before background usage work
		// necessarily finishes. The captured stream controller must still be aborted.
		task.currentRequestAbortController = undefined
		await task.abortTask()
		await task.dispose()
		expect(await next).toBeInstanceOf(ExecutionAuthorityError)
		expect(task.cleanupSettled).toBe(false)
		release.resolve()
		expect(await task.awaitExecutionCleanup()).toBe(true)
	})

	it("allows one current-owner stream and closes its iterator", async () => {
		const { task } = await create()
		const chunks: ApiStreamChunk[] = [
			{ type: "text", text: "current" },
			{ type: "usage", inputTokens: 1, outputTokens: 1 },
		]
		vi.spyOn(task.api, "createMessage").mockReturnValue(asyncStreamFrom(chunks))
		task["getSystemPrompt"] = async () => "offline prompt"
		expect(await collectStream(task.attemptApiRequest())).toEqual(chunks)
		await task.abortTask()
		expect(await task.awaitExecutionCleanup()).toBe(true)
	})

	it("does not yield a late model chunk after the real store fences its token", async () => {
		const { task, token } = await create()
		task["getSystemPrompt"] = async () => "offline prompt"
		const closed = vi.fn()
		vi.spyOn(task.api, "createMessage").mockReturnValue(
			(async function* (): AsyncGenerator<ApiStreamChunk> {
				try {
					yield { type: "text", text: "current" }
					applied(await store.interruptTask(token))
					yield { type: "text", text: "stale" }
				} finally {
					closed()
				}
			})(),
		)
		expect(await collectStream(task.attemptApiRequest())).toEqual([{ type: "text", text: "current" }])
		expect(task.executionBlocked).toBe(true)
		expect(closed).toHaveBeenCalledOnce()
	})

	it("standalone acceptance calls durable completion and never emits a public completion itself", async () => {
		const { task } = await create()
		const complete = vi.fn(async (_task: Task, _result: string) => false)
		Object.assign(provider, { completeTask: complete })
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
		const completed = vi.fn()
		task.on(RooCodeEventName.TaskCompleted, completed)
		await attemptCompletionTool.execute({ result: "Accepted" }, task, {
			askApproval: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: () => "complete",
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		})
		expect(complete).toHaveBeenCalledWith(task, "Accepted")
		expect(completed).not.toHaveBeenCalled()
		expect(task.executionBlocked).toBe(true)
		expect(
			(await readTaskMessages({ taskId: task.taskId, globalStoragePath: storage })).some(
				(m) => m.text === "Accepted",
			),
		).toBe(true)
	})

	it.each(["fresh", "resumed"])(
		"captures the exact completion request before approval and stops on refusal (%s)",
		async (route) => {
			const { task, token } = await create()
			// Lineage eligibility is the provider/store's contract, not this routing unit.
			Object.defineProperty(task, "parentTaskId", { value: "parent" })
			const finish: Extract<PendingTaskAction, { kind: "finish_subtask" }> = {
				kind: "finish_subtask",
				actionId: "finish",
				approvalText: JSON.stringify({ tool: "finishTask" }),
				parentTaskId: "parent",
				result: "Done",
			}
			const request: DelegatedCompletionRequest = {
				operationId: "complete",
				childToken: token,
				parentToken: { ...token, taskId: "parent" },
				childRevision: 1,
				parentRevision: 2,
				finish,
				resultTs: 3,
				creating: {
					actionId: "create",
					operationId: "create-operation",
					childId: task.taskId,
					ownerToken: "parent-runtime",
					generation: 1,
					phase: "committed",
					attempts: 1,
					revision: 1,
					resultTs: 1,
					intent: {
						kind: "create_subtask",
						actionId: "create",
						approvalText: "{}",
						mode: "code",
						message: "child",
						todos: [],
					},
				},
			}
			const order: string[] = []
			const persist = vi.fn(async (_id: string, _action: PendingTaskAction, origin?: Task) => {
				expect(origin).toBe(task)
				order.push("persist")
			})
			const prepare = vi.fn(async (origin: Task, action: PendingTaskAction) => {
				expect(origin).toBe(task)
				expect(action).toEqual(finish)
				order.push("prepare")
				return request
			})
			const reopen = vi.fn(async (args: { origin?: Task; request?: DelegatedCompletionRequest }) => {
				expect(args.origin).toBe(task)
				expect(args.request).toBe(request)
				order.push("commit")
				return false
			})
			const clear = vi.fn()
			const complete = vi.fn()
			Object.assign(provider, {
				setPendingTaskAction: persist,
				prepareDelegatedCompletion: prepare,
				reopenParentFromDelegation: reopen,
				clearPendingTaskAction: clear,
				completeTask: complete,
			})
			const approve = vi.fn(async () => {
				order.push("approve")
				return true
			})
			const ask = vi.spyOn(task, "ask").mockImplementation(async () => {
				await approve()
				return { response: "yesButtonClicked" }
			})
			if (route === "fresh") {
				await attemptCompletionTool.execute({ result: finish.result }, task, {
					toolCallId: finish.actionId,
					askApproval: vi.fn(),
					askFinishSubTaskApproval: approve,
					toolDescription: () => "complete",
					pushToolResult: vi.fn(),
					handleError: vi.fn(),
				})
				expect(order).toEqual(["persist", "prepare", "approve", "commit"])
				expect(ask).not.toHaveBeenCalled()
			} else {
				task.setPendingTaskAction(finish)
				await task["resumePendingTaskAction"](finish)
				expect(order).toEqual(["prepare", "approve", "commit"])
				expect(ask).toHaveBeenCalledTimes(1)
			}
			expect(task.executionBlocked).toBe(true)
			expect(task.getPendingTaskAction()).toEqual(finish)
			expect(clear).not.toHaveBeenCalled()
			expect(complete).not.toHaveBeenCalled()
		},
	)
})
