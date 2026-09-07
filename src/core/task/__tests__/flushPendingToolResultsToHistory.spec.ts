// npx vitest run core/task/__tests__/flushPendingToolResultsToHistory.spec.ts

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { GlobalState, ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { createClaimedTask, installTaskHistoryFiles } from "../../../__tests__/helpers/task-fixtures"
import { safeWriteJson } from "../../../utils/safeWriteJson"

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	LOCK_STALE_MS: 31_000,
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		realpath: vi.fn(async (value: string) => value),
		readdir: vi.fn().mockResolvedValue([]),
		...mockFunctions,
		default: mockFunctions,
	}
})

const { mockPWaitFor } = vi.hoisted(() => {
	return { mockPWaitFor: vi.fn().mockImplementation(async () => Promise.resolve()) }
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))
vi.mock("proper-lockfile", () => ({ lock: vi.fn(async () => async () => {}) }))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async (storage: string) => storage),
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

describe("flushPendingToolResultsToHistory", () => {
	let mockProvider: ClineProvider
	let historyFiles: ReturnType<typeof installTaskHistoryFiles>
	const tasks: Task[] = []
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		historyFiles = installTaskHistoryFiles()
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
	})

	afterEach(async () => {
		for (const task of tasks.splice(0)) await task.dispose()
		await mockProvider.taskHistoryStore.initialized
		mockProvider.taskHistoryStore.dispose()
		historyFiles.restore()
	})

	async function createTask() {
		const task = await createClaimedTask({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})
		tasks.push(task)
		return task
	}

	async function saveAssistant(task: Task, ...toolIds: string[]) {
		await task.overwriteApiConversationHistory([
			{
				role: "assistant",
				content: toolIds.map((id) => ({ type: "tool_use", id, name: "write_to_file", input: {} })),
			},
		])
		task.assistantMessageSavedToHistory = true
	}

	it("should not save anything when userMessageContent is empty", async () => {
		const task = await createTask()

		// Ensure userMessageContent is empty
		task.userMessageContent = []
		const initialHistoryLength = task.apiConversationHistory.length

		// Call flush
		await task.flushPendingToolResultsToHistory()

		// History should not have changed since userMessageContent was empty
		expect(task.apiConversationHistory.length).toBe(initialHistoryLength)
	})

	it("should save user message when userMessageContent has pending tool results", async () => {
		const task = await createTask()
		await saveAssistant(task, "tool-123")

		// Set up pending tool result in userMessageContent
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-123",
				content: "File written successfully",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// One user result follows the already-durable assistant tool call.
		expect(task.apiConversationHistory.length).toBe(2)

		// Check user message with tool result
		const userMessage = task.apiConversationHistory[1]
		expect(userMessage.role).toBe("user")
		expect(Array.isArray(userMessage.content)).toBe(true)
		expect((userMessage.content as any[])[0].type).toBe("tool_result")
		expect((userMessage.content as any[])[0].tool_use_id).toBe("tool-123")
	})

	it("should clear userMessageContent after flushing", async () => {
		const task = await createTask()
		await saveAssistant(task, "tool-456")

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-456",
				content: "Command executed",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// userMessageContent should be cleared
		expect(task.userMessageContent.length).toBe(0)
	})

	it("should handle multiple tool results in a single flush", async () => {
		const task = await createTask()
		await saveAssistant(task, "tool-1", "tool-2")

		// Set up multiple pending tool results
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content: "First result",
			},
			{
				type: "tool_result",
				tool_use_id: "tool-2",
				content: "Second result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// Check user message has both tool results
		const userMessage = task.apiConversationHistory[1]
		expect(Array.isArray(userMessage.content)).toBe(true)
		expect((userMessage.content as any[]).length).toBe(2)
		expect((userMessage.content as any[])[0].tool_use_id).toBe("tool-1")
		expect((userMessage.content as any[])[1].tool_use_id).toBe("tool-2")
	})

	it("should add timestamp to saved messages", async () => {
		const task = await createTask()
		await saveAssistant(task, "tool-ts")

		const beforeTs = Date.now()

		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-ts",
				content: "Result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		const afterTs = Date.now()

		// Message should have timestamp
		expect(task.apiConversationHistory[1].ts).toBeGreaterThanOrEqual(beforeTs)
		expect(task.apiConversationHistory[1].ts).toBeLessThanOrEqual(afterTs)
	})

	it("should skip waiting for assistantMessageSavedToHistory when flag is already true", async () => {
		const task = await createTask()

		// Set flag to true (assistant message already saved)
		await saveAssistant(task, "tool-skip-wait")

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-skip-wait",
				content: "Result when flag is true",
			},
		]

		// Clear mock call history
		mockPWaitFor.mockClear()

		await task.flushPendingToolResultsToHistory()

		// Should not have called pWaitFor since flag was already true
		expect(mockPWaitFor).not.toHaveBeenCalled()

		// Should still save the message
		expect(task.apiConversationHistory.length).toBe(2)
		expect(task.apiConversationHistory[1].content).toMatchObject([{ tool_use_id: "tool-skip-wait" }])
	})

	it("should wait for assistantMessageSavedToHistory when flag is false", async () => {
		const task = await createTask()

		// Flag is false by default - assistant message not yet saved
		expect(task.assistantMessageSavedToHistory).toBe(false)

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-wait",
				content: "Result when flag is false",
			},
		]

		// Clear mock call history
		mockPWaitFor.mockClear()
		mockPWaitFor.mockImplementationOnce(async () => {
			// Simulate the assistant-history write completing while we wait.
			await saveAssistant(task, "tool-wait")
		})

		await task.flushPendingToolResultsToHistory()

		// Should have called pWaitFor since flag was false
		expect(mockPWaitFor).toHaveBeenCalled()

		// The write completed before the wait returned; it is safe to save results.
		expect(task.apiConversationHistory.length).toBe(2)
	})

	it("should not flush when task is aborted during wait", async () => {
		const task = await createTask()

		// Flag is false - will need to wait
		task.assistantMessageSavedToHistory = false

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-aborted",
				content: "Should not be saved",
			},
		]

		mockPWaitFor.mockImplementationOnce(async () => {
			task.abort = true
		})

		await task.flushPendingToolResultsToHistory()

		// Should not have saved anything since task was aborted
		expect(task.apiConversationHistory.length).toBe(0)
	})

	it("refuses a result write when the wait resolves without assistant-history evidence", async () => {
		const task = await createTask()
		task.userMessageContent = [{ type: "tool_result", tool_use_id: "missing", content: "Keep me" }]
		vi.mocked(safeWriteJson).mockClear()
		expect(await task.flushPendingToolResultsToHistory()).toBe(false)
		expect(task.apiConversationHistory).toEqual([])
		expect(task.userMessageContent).toHaveLength(1)
		expect(safeWriteJson).not.toHaveBeenCalled()
	})

	it("refuses stale-owner persistence and retains pending tool results", async () => {
		const task = await createTask()
		await saveAssistant(task, "stale")
		task.userMessageContent = [{ type: "tool_result", tool_use_id: "stale", content: "Keep me" }]
		expect((await mockProvider.taskHistoryStore.interruptTask(task.executionToken!)).kind).toBe("applied")
		vi.mocked(safeWriteJson).mockClear()
		expect(await task.flushPendingToolResultsToHistory()).toBe(false)
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.executionBlocked).toBe(true)
		expect(safeWriteJson).not.toHaveBeenCalled()
	})
})
