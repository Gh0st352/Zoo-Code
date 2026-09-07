import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { ClineProvider } from "../ClineProvider"
import { Task } from "../../task/Task"
import { TaskRegistry } from "../../task/TaskRegistry"
import { ContextProxy } from "../../config/ContextProxy"
import type { ProviderSettings, HistoryItem, DelegationAction, ExecutionCommandResult } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { commitDelegation, executionClaim, reserveDelegation } from "../../task-persistence/taskLifecycle"

type MockTask = Partial<Task> &
	Pick<Task, "taskId" | "instanceId"> & {
		parentTaskId?: string
		rootTask?: { taskId: string }
		parentTask?: { taskId: string }
		cancelCurrentRequest?: ReturnType<typeof vi.fn>
		isStreaming?: boolean
		didFinishAbortingStream?: boolean
		isWaitingForFirstChunk?: boolean
	}
function seedRegistry(provider: ClineProvider, ...tasks: unknown[]) {
	const registry = new TaskRegistry()
	for (const value of tasks) {
		const task = value as MockTask
		task.dispose ??= vi.fn().mockResolvedValue(undefined)
		task.abortTask ??= vi.fn<Task["abortTask"]>().mockResolvedValue(undefined)
		task.awaitExecutionCleanup ??= vi.fn<Task["awaitExecutionCleanup"]>().mockResolvedValue(true)
		task.apiConversationHistory ??= []
		task.clineMessages ??= []
		task.getPendingTaskAction ??= vi.fn<Task["getPendingTaskAction"]>()
		// These lifecycle test doubles intentionally implement only the Task surface used here.
		registry.push(task as unknown as Task)
	}
	provider["taskRegistry"] = registry
}

// Mock dependencies
vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	return {
		workspace: {
			getConfiguration: vi.fn(() => ({
				get: vi.fn((_key: string, fallback: unknown) => fallback),
				update: vi.fn().mockResolvedValue(undefined),
			})),
			workspaceFolders: [],
			onDidChangeConfiguration: vi.fn(() => mockDisposable),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return {
				event: vi.fn(),
				fire: vi.fn(),
			}
		}),
		Disposable: {
			from: vi.fn(),
		},
		window: {
			showErrorMessage: vi.fn(),
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			onDidChangeActiveTextEditor: vi.fn(() => mockDisposable),
		},
		Uri: {
			file: vi.fn().mockReturnValue({ toString: () => "file://test" }),
		},
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function () {
		return {
			taskId: "mock-task-id",
			instanceId: "mock-instance-id",
			abortTask: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}
	}),
}))
vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn().mockResolvedValue({
			registerClient: vi.fn(),
			unregisterClient: vi.fn(),
		}),
		unregisterProvider: vi.fn(),
	},
}))
vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))
vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn().mockReturnValue("/test/workspace"),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			setProvider: vi.fn(),
			captureTaskCreated: vi.fn(),
		},
	},
}))

// Mock CloudService
vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(false),
		instance: {
			isAuthenticated: vi.fn().mockReturnValue(false),
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://api.roo-code.com"),
}))

vi.mock("../../../shared/embeddingModels", () => ({
	EMBEDDING_MODEL_PROFILES: [],
}))

vi.mock("../../../shared/modes", () => ({
	modes: [{ slug: "code", name: "Code Mode", roleDefinition: "You are a code assistant", groups: ["read", "edit"] }],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	getGroupName: vi.fn().mockReturnValue("General Tools"),
	defaultModeSlug: "code",
}))

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("axios", () => ({
	default: { get: vi.fn().mockResolvedValue({ data: { data: [] } }), post: vi.fn() },
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
	}),
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockImplementation(async () => "mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../prompts/sections/custom-instructions")

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("file content"),
}))

vi.mock("../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return { getName: () => "test-strategy", applyDiff: vi.fn() }
	}),
}))

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	CallToolResultSchema: {},
	ListResourcesResultSchema: {},
	ListResourceTemplatesResultSchema: {},
	ListToolsResultSchema: {},
	ReadResourceResultSchema: {},
	ErrorCode: { InvalidRequest: "InvalidRequest", MethodNotFound: "MethodNotFound", InternalError: "InternalError" },
	McpError: class McpError extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
			this.name = "McpError"
		}
	},
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			listTools: vi.fn().mockResolvedValue({ tools: [] }),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
		}
	}),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(function () {
		return { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }
	}),
}))

vi.mock("../../../services/skills/SkillsManager", () => ({
	SkillsManager: vi.fn().mockImplementation(function () {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

describe("ClineProvider flicker-free cancel", () => {
	let provider: ClineProvider
	let directory: string
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockTask1: MockTask
	let mockTask2: MockTask
	let consoleLogSpy: ReturnType<typeof vi.spyOn>
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	const mockApiConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiKey: "test-key",
	} as ProviderSettings

	beforeAll(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterAll(() => {
		consoleLogSpy.mockRestore()
		consoleErrorSpy.mockRestore()
	})

	beforeEach(async () => {
		vi.clearAllMocks()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-cancel-"))

		// Setup mock extension context
		mockContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: directory },
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			extensionUri: { fsPath: "/test/extension" },
		} as unknown as vscode.ExtensionContext

		// Setup mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		// Setup mock context proxy
		const mockContextProxy = {
			getValues: vi.fn().mockReturnValue({}),
			getValue: vi.fn().mockReturnValue(undefined),
			setValue: vi.fn().mockResolvedValue(undefined),
			getProviderSettings: vi.fn().mockReturnValue(mockApiConfig),
			extensionUri: mockContext.extensionUri,
			globalStorageUri: mockContext.globalStorageUri,
		}

		// Create provider instance
		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			mockContextProxy as unknown as ContextProxy,
		)

		// Mock provider methods
		provider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: mockApiConfig,
			mode: "code",
		})

		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		// Mock private method used by the rehydration path.
		provider["updateGlobalState"] = vi.fn().mockResolvedValue(undefined)
		provider.activateProviderProfile = vi.fn().mockResolvedValue(undefined)
		provider.performPreparationTasks = vi.fn().mockResolvedValue(undefined)
		provider.getTaskWithId = vi.fn().mockImplementation((id) =>
			Promise.resolve({
				historyItem: {
					id,
					number: 1,
					ts: Date.now(),
					task: "test task",
					tokensIn: 100,
					tokensOut: 200,
					totalCost: 0.001,
					workspace: "/test/workspace",
				},
			}),
		)

		// Setup mock tasks
		mockTask1 = {
			taskId: "task-1",
			instanceId: "instance-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			dispose: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}

		mockTask2 = {
			taskId: "task-1", // Same ID for rehydration scenario
			instanceId: "instance-2", // Different instance
			emit: vi.fn(),
			dispose: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			off: vi.fn(),
			abortTask: vi.fn<Task["abortTask"]>().mockResolvedValue(undefined),
			awaitExecutionCleanup: vi.fn<Task["awaitExecutionCleanup"]>().mockResolvedValue(true),
			hydrateForRecovery: vi.fn<Task["hydrateForRecovery"]>().mockResolvedValue(undefined),
			apiConversationHistory: [],
			clineMessages: [],
			run: vi.fn<Task["run"]>().mockResolvedValue(undefined),
		}

		// Mock Task constructor
		vi.mocked(Task).mockImplementation(function (options) {
			Object.assign(mockTask2, {
				taskId: options.historyItem?.id,
				executionToken: options.executionToken,
				executionBlocked: !options.executionToken,
			})
			return mockTask2 as unknown as Task
		})
		await provider.taskHistoryStore.initialize()
		for (const id of ["task-1", "task-2"]) {
			await provider.taskHistoryStore.upsert({
				id,
				number: 1,
				ts: 1,
				task: id,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})
		}
	})

	afterEach(async () => {
		await provider.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("should not remove current task from stack when rehydrating same taskId", async () => {
		// Setup: Add a task to the registry first
		seedRegistry(provider, mockTask1)

		// Mock event listeners for cleanup
		provider["taskEventListeners"] = new WeakMap()
		const mockCleanupFunctions = [vi.fn(), vi.fn()]
		provider["taskEventListeners"].set(mockTask1 as unknown as Task, mockCleanupFunctions)

		// Spy on removeClineFromStack to verify it's NOT called
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack")

		// Create history item with same taskId as current task
		const historyItem: HistoryItem = {
			id: "task-1", // Same as mockTask1.taskId
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Act: Create task with history item (should rehydrate in-place)
		await provider.createTaskWithHistoryItem(historyItem)
		// No claim was supplied: viewing history may only install an observer.
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.executionBlocked).toBe(true)
		expect(mockTask2.hydrateForRecovery).toHaveBeenCalledOnce()
		expect(mockTask2.run).not.toHaveBeenCalled()

		// Assert: removeClineFromStack should NOT be called
		expect(removeClineFromStackSpy).not.toHaveBeenCalled()

		// Verify the task was replaced in-place
		const registry = provider["taskRegistry"]
		expect(registry.length).toBe(1)
		expect(registry.current).toBe(mockTask2)

		// Verify old event listeners were cleaned up
		expect(mockCleanupFunctions[0]).toHaveBeenCalled()
		expect(mockCleanupFunctions[1]).toHaveBeenCalled()

		// Verify new task received focus event
		expect(mockTask2.emit).toHaveBeenCalledWith("taskFocused")
	})

	it("should remove task from stack when creating different task", async () => {
		// Setup: Add a task to the registry first
		seedRegistry(provider, mockTask1)

		// Spy on removeClineFromStack to verify it IS called
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack").mockImplementation(async () => {
			provider["taskRegistry"].pop()
		})

		// Create history item with different taskId
		const historyItem: HistoryItem = {
			id: "task-2", // Different from mockTask1.taskId
			number: 2,
			task: "different task",
			ts: Date.now(),
			tokensIn: 150,
			tokensOut: 250,
			totalCost: 0.002,
			workspace: "/test/workspace",
		}

		// Act: Create task with different history item
		await provider.createTaskWithHistoryItem(historyItem)
		expect(mockTask2.taskId).toBe(historyItem.id)
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.hydrateForRecovery).toHaveBeenCalledOnce()
		expect(mockTask2.run).not.toHaveBeenCalled()

		// Assert: removeClineFromStack should be called
		expect(removeClineFromStackSpy).toHaveBeenCalled()
	})

	it("should handle empty stack gracefully during rehydration attempt", async () => {
		// Setup: Empty registry (default)
		seedRegistry(provider)

		// Spy on removeClineFromStack
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack").mockImplementation(async () => {
			provider["taskRegistry"].pop()
		})

		// Create history item
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Empty history navigation installs an observer; there is no runtime to remove.
		await provider.createTaskWithHistoryItem(historyItem)

		expect(removeClineFromStackSpy).not.toHaveBeenCalled()
		expect(provider.getCurrentTask()).toBe(mockTask2)
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.hydrateForRecovery).toHaveBeenCalledOnce()
		expect(mockTask2.run).not.toHaveBeenCalled()
	})

	it("should maintain task stack integrity during flicker-free replacement", async () => {
		// Setup: Registry with parent task then current task
		const mockParentTask = {
			taskId: "parent-task",
			instanceId: "parent-instance",
			abort: false,
			abandoned: false,
			emit: vi.fn(),
		}

		seedRegistry(provider, mockParentTask, mockTask1)
		provider["taskEventListeners"] = new WeakMap()
		provider["taskEventListeners"].set(mockTask1 as unknown as Task, [vi.fn()])

		// Act: Rehydrate the current (top) task
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		await provider.createTaskWithHistoryItem(historyItem)

		// Ownerless navigation must remain observation, including beside another task.
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.executionBlocked).toBe(true)
		expect(mockTask2.hydrateForRecovery).toHaveBeenCalledOnce()
		expect(mockTask2.run).not.toHaveBeenCalled()
		// Assert: Registry should maintain parent task and replace current task
		const registry = provider["taskRegistry"]
		expect(registry.length).toBe(2)
		expect(registry.getAll()[0]).toBe(mockParentTask)
		expect(registry.getAll()[1]).toBe(mockTask2)
	})

	it("should preserve stack order when rehydrating a focused non-top task", async () => {
		// Regression test for issue #1: if setCurrent() has focused a non-top task,
		// rehydrating it must not move it to the top of the stack.
		const mockTopTask = {
			taskId: "top-task",
			instanceId: "top-instance",
			abort: false,
			abandoned: false,
			emit: vi.fn(),
		}

		// Seed: [mockTask1 (focused), mockTopTask (top-of-stack)]
		seedRegistry(provider, mockTask1, mockTopTask)
		provider["taskRegistry"].setCurrent("task-1")
		provider["taskEventListeners"] = new WeakMap()
		provider["taskEventListeners"].set(mockTask1 as unknown as Task, [vi.fn()])

		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		await provider.createTaskWithHistoryItem(historyItem)

		// Observation must neither grant authority nor disturb unrelated stack entries.
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.executionBlocked).toBe(true)
		expect(mockTask2.hydrateForRecovery).toHaveBeenCalledOnce()
		expect(mockTask2.run).not.toHaveBeenCalled()
		const registry = provider["taskRegistry"]
		// Stack order must be unchanged: replacement stays at index 0, top-task stays at index 1
		expect(registry.length).toBe(2)
		expect(registry.getAll()[0]).toBe(mockTask2)
		expect(registry.getAll()[1]).toBe(mockTopTask)
		// Focus follows the replacement
		expect(registry.current).toBe(mockTask2)
	})

	const applied = (result: ExecutionCommandResult) => {
		expect(result.kind).toBe("applied")
		if (result.kind !== "applied") throw new Error(result.reason)
		return result
	}

	async function claimedChild() {
		const store = provider.taskHistoryStore
		const history = (id: string): HistoryItem => ({
			id,
			number: 1,
			ts: 1,
			task: id,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})
		const parent = applied(await store.claimNewTask(history("parent-1"), store.ownerForRuntime("parent")))
		const intent = {
			kind: "create_subtask" as const,
			actionId: "create",
			approvalText: "{}",
			message: "Child",
			mode: "code",
			todos: [],
		}
		const pending = await store.lifecycleCommand(
			"parent-1",
			(item) => ({ ...item, pendingAction: intent }),
			[],
			false,
			parent.token,
		)
		const receipt: DelegationAction = {
			actionId: intent.actionId,
			intent,
			operationId: "operation",
			childId: "child-1",
			ownerToken: parent.token.owner.runtimeId,
			executionToken: parent.token,
			generation: parent.token.generation,
			revision: pending.lifecycleRevision!,
			phase: "prepared",
			attempts: 1,
			resultTs: 2,
		}
		await store.lifecycleCommand("parent-1", (item) => reserveDelegation(item, receipt), [], false, parent.token)
		const child = applied(
			await store.claimDelegationChild(
				{
					...history("child-1"),
					parentTaskId: "parent-1",
					rootTaskId: "parent-1",
					delegationOrigin: { parentId: "parent-1", operationId: receipt.operationId },
				},
				store.ownerForRuntime("child"),
				parent.token,
				receipt,
			),
		)
		await store.lifecycleCommand(
			"parent-1",
			(item) => commitDelegation(item, receipt),
			["child-1"],
			false,
			parent.token,
		)
		Object.assign(mockTask1, {
			taskId: "child-1",
			instanceId: child.token.owner.runtimeId,
			parentTaskId: "parent-1",
			executionToken: child.token,
			apiConversationHistory: [],
			clineMessages: [],
			getPendingTaskAction: vi.fn<Task["getPendingTaskAction"]>(),
		})
		seedRegistry(provider, mockTask1)
		const task = provider.getCurrentTask()!
		provider["rememberExecution"](child.token, task)
		return { store, task, child, parent: await store.readAuthoritative("parent-1") }
	}

	it("marks a cancelled delegated child interrupted, preserves lineage and opens only a recovery observer", async () => {
		const { store, task, child, parent } = await claimedChild()
		const create = vi.spyOn(provider, "createTaskWithHistoryItem")
		await provider.cancelTask()
		const stopped = await store.readAuthoritative("child-1")
		expect(stopped).toMatchObject({
			status: "interrupted",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
			delegationOrigin: child.history.delegationOrigin,
		})
		expect(executionClaim(stopped)).toMatchObject({ phase: "settled", cleanupPending: false })
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(create).toHaveBeenCalledWith(stopped, { recoveryOnly: true, isCurrent: expect.any(Function) })
		expect(task.executionToken).toEqual(child.token)
		expect(provider.getCurrentTask()).toBe(mockTask2)
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.executionBlocked).toBe(true)
		expect(mockTask2.hydrateForRecovery).toHaveBeenCalledOnce()
		expect(mockTask2.run).not.toHaveBeenCalled()
		expect(provider["recoveryPrompt"]?.presentation.choices).toEqual(["resume_linked"])
		expect(await store.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "stale_generation" })
	})

	it("retains lineage and cleanup authority when cancellation snapshot persistence fails", async () => {
		const { store, task, child, parent } = await claimedChild()
		vi.spyOn(store, "saveExecutionSnapshot").mockRejectedValue(new Error("snapshot persist failed"))
		const settle = vi.spyOn(store, "settleTaskExecution")
		await provider.cancelTask()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Fence/snapshot failed for child-1"),
		)
		expect(await store.readAuthoritative("child-1")).toMatchObject({
			status: "interrupted",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
		})
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(executionClaim(await store.readAuthoritative("child-1"))).toMatchObject({
			phase: "suspended",
			cleanupPending: true,
		})
		expect(task.executionBlocked).toBe(true)
		expect(settle).not.toHaveBeenCalled()
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.run).not.toHaveBeenCalled()
		expect(provider["recoveryPrompt"]?.presentation).toMatchObject({ choices: [], reason: "cleanup_pending" })
		expect(await store.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "stale_generation" })
	})

	it("does not rehydrate or detach a cancelled child when authoritative persistence is unavailable", async () => {
		const { store, task, child, parent } = await claimedChild()
		const read = vi
			.spyOn(store, "readAuthoritative")
			.mockRejectedValue(new Error("authoritative history unavailable"))
		const create = vi.spyOn(provider, "createTaskWithHistoryItem")
		await expect(provider.cancelTask()).rejects.toThrow("authoritative history unavailable")
		expect(create).not.toHaveBeenCalled()
		expect(task.executionBlocked).toBe(true)
		expect(task.abortTask).toHaveBeenCalledWith(true)
		expect(provider.getCurrentTask()).toBe(task)
		expect(provider["ownedExecutions"].get("child-1")?.snapshotFailed).toBe(true)
		read.mockRestore()
		expect(await store.readAuthoritative("child-1")).toEqual(child.history)
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
	})

	it("fences cancellation before unfinished cleanup without severing parent ownership", async () => {
		const { store, task, child, parent } = await claimedChild()
		vi.mocked(task.awaitExecutionCleanup).mockResolvedValue(false)
		const settle = vi.spyOn(store, "settleTaskExecution")
		await provider.cancelTask()
		expect(await store.readAuthoritative("child-1")).toMatchObject({
			status: "interrupted",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
		})
		expect(await store.readAuthoritative("parent-1")).toEqual(parent)
		expect(executionClaim(await store.readAuthoritative("child-1")).cleanupPending).toBe(true)
		expect(settle).not.toHaveBeenCalled()
		expect(provider["recoveryPrompt"]?.presentation).toMatchObject({ choices: [], reason: "cleanup_pending" })
		expect(await store.guardExecution(child.token)).toMatchObject({ kind: "refused", reason: "stale_generation" })
		expect(mockTask2.executionToken).toBeUndefined()
		expect(mockTask2.run).not.toHaveBeenCalled()
	})

	it("removeClineFromStack never mutates delegation metadata (pure lifecycle after refactor)", async () => {
		// After the refactor, removeClineFromStack() is pure lifecycle: pop, abort, clean up.
		// Delegation state is owned by authoritative completion and stop commands.
		const childTask = {
			taskId: "child-1",
			instanceId: "inst-child",
			parentTaskId: "parent-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}
		seedRegistry(provider, childTask)
		provider["taskEventListeners"] = new Map()

		provider.getTaskWithId = vi.fn() as unknown as ClineProvider["getTaskWithId"]
		const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([])

		await provider["removeClineFromStack"]()

		expect(provider["taskRegistry"].length).toBe(0)
		expect(childTask.abortTask).toHaveBeenCalledWith(true)
		// No history writes — lifecycle only
		expect(updateTaskHistorySpy).not.toHaveBeenCalled()
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
	})

	afterAll(() => {
		vi.restoreAllMocks()
	})
})
