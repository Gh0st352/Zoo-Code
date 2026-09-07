import path from "node:path"

import { type ProviderSettings, RooCodeEventName } from "@roo-code/types"

import { Task } from "../Task"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { getTaskDirectoryPath } from "../../../utils/storage"
import {
	createClaimedTask,
	createTaskProvider,
	installTaskHistoryFiles,
} from "../../../__tests__/helpers/task-fixtures"

// Mock dependencies
vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	realpath: vi.fn(async (value: string) => value),
	readdir: vi.fn().mockResolvedValue([]),
	mkdir: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn(),
	unlink: vi.fn(),
}))
vi.mock("../../../utils/safeWriteJson", () => ({ LOCK_STALE_MS: 31_000, safeWriteJson: vi.fn() }))
vi.mock("proper-lockfile", () => ({ lock: vi.fn(async () => async () => {}) }))
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
// Keep disposal tests independent of the real filesystem and output interceptor.
vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async (storage: string) => storage),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/path/tasks/test-task"),
}))
vi.mock("../../../integrations/terminal/OutputInterceptor", () => ({
	OutputInterceptor: {
		cleanup: vi.fn().mockResolvedValue(undefined),
	},
}))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../protect/RooProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({ info: {}, id: "test-model" }),
	})),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

describe("Task dispose method", () => {
	let mockProvider: ReturnType<typeof createTaskProvider>
	let historyFiles: ReturnType<typeof installTaskHistoryFiles>
	let mockApiConfiguration: ProviderSettings
	let task: Task
	let skipCleanup: boolean

	beforeEach(async () => {
		// Reset all mocks
		vi.clearAllMocks()
		skipCleanup = false
		historyFiles = installTaskHistoryFiles()
		vi.mocked(getTaskDirectoryPath).mockReset().mockResolvedValue("/test/path/tasks/test-task")
		vi.mocked(OutputInterceptor.cleanup).mockReset().mockResolvedValue(undefined)

		// Mock provider
		mockProvider = createTaskProvider("/test/path")

		// Mock API configuration
		mockApiConfiguration = {
			apiProvider: providerIdentifiers.anthropic,
			apiKey: "test-key",
		} as ProviderSettings

		// Create task instance without starting it
		task = await createClaimedTask({
			provider: mockProvider,
			taskId: "test-task",
			apiConfiguration: mockApiConfiguration,
			startTask: false,
		})
		vi.mocked(getTaskDirectoryPath).mockClear()
	})

	afterEach(async () => {
		if (task && !skipCleanup) {
			await task.dispose().catch(() => {})
		}
		mockProvider.taskHistoryStore.dispose()
		historyFiles.restore()
	})

	test("should expose completion of deferred command output cleanup", async () => {
		let resolveTaskDirectory: (taskDirectory: string) => void
		vi.mocked(getTaskDirectoryPath).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveTaskDirectory = resolve
			}),
		)

		const disposal = task.dispose()
		let disposalComplete = false
		void disposal.then(() => {
			disposalComplete = true
		})
		await vi.waitFor(() => expect(getTaskDirectoryPath).toHaveBeenCalledOnce())

		expect(disposalComplete).toBe(false)
		expect(OutputInterceptor.cleanup).not.toHaveBeenCalled()

		resolveTaskDirectory!("/test/path/tasks/test-task")
		await disposal

		expect(OutputInterceptor.cleanup).toHaveBeenCalledWith(
			path.join("/test/path/tasks/test-task", "command-output"),
		)
		expect(disposalComplete).toBe(true)
	})

	test("should reject the memoized completion promise when disposal cannot start", async () => {
		const disposalError = new Error("disposal failed")
		skipCleanup = true
		vi.spyOn(console, "log").mockImplementationOnce(() => {
			throw disposalError
		})

		const disposal = task.dispose()
		await expect(disposal).rejects.toBe(disposalError)
		expect(task.dispose()).toBe(disposal)
		expect(task.cleanupSettled).toBe(false)
	})

	test("should report command output cleanup failures before disposal completes", async () => {
		const cleanupError = new Error("cleanup failed")
		let disposalComplete = false
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			expect(disposalComplete).toBe(false)
		})
		let rejectTaskDirectory!: (error: Error) => void
		vi.mocked(getTaskDirectoryPath).mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectTaskDirectory = reject
			}),
		)

		const disposal = task.dispose()
		void disposal.then(() => {
			disposalComplete = true
		})
		await vi.waitFor(() => expect(getTaskDirectoryPath).toHaveBeenCalledOnce())
		rejectTaskDirectory(cleanupError)
		await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled())

		expect(consoleErrorSpy).toHaveBeenCalledWith("Error cleaning up shared task resources:", cleanupError)
		await disposal
		expect(disposalComplete).toBe(true)
		consoleErrorSpy.mockRestore()
	})

	test("should wait for deferred output cleanup and memoize repeated disposal", async () => {
		let resolveCleanup!: () => void
		vi.mocked(OutputInterceptor.cleanup).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveCleanup = resolve
			}),
		)
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")

		const firstDisposal = task.dispose()
		const secondDisposal = task.dispose()
		let disposalComplete = false
		void firstDisposal.then(() => {
			disposalComplete = true
		})
		await vi.waitFor(() => expect(OutputInterceptor.cleanup).toHaveBeenCalledOnce())

		expect(secondDisposal).toBe(firstDisposal)
		expect(disposalComplete).toBe(false)
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()

		resolveCleanup()
		await firstDisposal
		expect(disposalComplete).toBe(true)
	})

	test("should await diff reversion during abort without waiting for output cleanup", async () => {
		let resolveCleanup!: () => void
		let resolveReversion!: () => void
		vi.mocked(OutputInterceptor.cleanup).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveCleanup = resolve
			}),
		)
		task.isStreaming = true
		task.diffViewProvider.isEditing = true
		const revertChangesSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockReturnValue(
			new Promise((resolve) => {
				resolveReversion = resolve
			}),
		)
		const saveMessages = vi.fn(task["saveClineMessages"].bind(task))
		task["saveClineMessages"] = saveMessages
		const saveSnapshot = vi.spyOn(mockProvider.taskHistoryStore, "saveExecutionSnapshot")

		const abort = task.abortTask()
		await vi.waitFor(() => expect(revertChangesSpy).toHaveBeenCalledOnce())
		expect(saveMessages).not.toHaveBeenCalled()

		resolveReversion()
		await abort
		expect(saveMessages).toHaveBeenCalledOnce()
		expect(saveMessages).toHaveResolvedWith(false)
		expect(saveSnapshot).not.toHaveBeenCalled()

		let disposalComplete = false
		void task.dispose().then(() => {
			disposalComplete = true
		})
		await Promise.resolve()
		expect(disposalComplete).toBe(false)

		resolveCleanup()
		await task.dispose()
		expect(disposalComplete).toBe(true)
	})

	test("should expose completion of deferred diff reversion", async () => {
		let resolveReversion: () => void
		const reversion = new Promise<void>((resolve) => {
			resolveReversion = resolve
		})
		task.isStreaming = true
		task.diffViewProvider.isEditing = true
		const revertChangesSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockReturnValue(reversion)

		const disposal = task.dispose()
		await vi.waitFor(() => expect(OutputInterceptor.cleanup).toHaveBeenCalled())
		let disposalComplete = false
		void disposal.then(() => {
			disposalComplete = true
		})
		await Promise.resolve()
		expect(disposalComplete).toBe(false)
		expect(revertChangesSpy).toHaveBeenCalledOnce()

		resolveReversion!()
		await disposal
		expect(disposalComplete).toBe(true)
	})

	test("should log rejected diff reversion without permitting fenced abort persistence", async () => {
		const reversionError = new Error("reversion failed")
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		task.isStreaming = true
		task.diffViewProvider.isEditing = true
		vi.spyOn(task.diffViewProvider, "revertChanges").mockRejectedValue(reversionError)
		const saveMessages = vi.fn(task["saveClineMessages"].bind(task))
		task["saveClineMessages"] = saveMessages
		const saveSnapshot = vi.spyOn(mockProvider.taskHistoryStore, "saveExecutionSnapshot")

		await expect(task.abortTask()).resolves.toBeUndefined()
		await expect(task.dispose()).resolves.toBeUndefined()

		expect(consoleErrorSpy).toHaveBeenCalledWith("Error reverting diff changes:", reversionError)
		expect(task.cleanupSettled).toBe(false)
		expect(saveMessages).toHaveBeenCalledOnce()
		expect(saveMessages).toHaveResolvedWith(false)
		expect(saveSnapshot).not.toHaveBeenCalled()
		consoleErrorSpy.mockRestore()
	})

	test("should remove all event listeners when dispose is called", () => {
		// Add some event listeners using type assertion to bypass strict typing for testing
		const listener1 = vi.fn(() => {})
		const listener2 = vi.fn(() => {})
		const listener3 = vi.fn((taskId: string) => {})

		task.on(RooCodeEventName.TaskStarted, listener1)
		task.on(RooCodeEventName.TaskAborted, listener2)
		task.on(RooCodeEventName.TaskIdle, listener3)

		// Verify listeners are added
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(1)

		// Spy on removeAllListeners method
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")

		// Call dispose
		void task.dispose()

		// Verify removeAllListeners was called
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()

		// Verify all listeners are removed
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(0)
	})

	test("should handle errors when removing event listeners", () => {
		// Mock removeAllListeners to throw an error
		const originalRemoveAllListeners = task.removeAllListeners
		task.removeAllListeners = vi.fn(() => {
			throw new Error("Test error")
		})

		// Spy on console.error
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		// Call dispose - should not throw
		expect(() => void task.dispose()).not.toThrow()

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledWith("Error removing event listeners:", expect.any(Error))

		// Restore
		task.removeAllListeners = originalRemoveAllListeners
		consoleErrorSpy.mockRestore()
	})

	test("should clean up all resources in correct order", () => {
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")
		const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		// Call dispose
		void task.dispose()

		// Verify dispose was called and logged
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining(`[Task#dispose] disposing task ${task.taskId}.${task.instanceId}`),
		)

		// Verify removeAllListeners was called first (before other cleanup)
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()

		// Clean up
		consoleLogSpy.mockRestore()
	})

	test("should prevent memory leaks by removing listeners before other cleanup", () => {
		// Add multiple listeners of different types using type assertion for testing
		const listeners = {
			TaskStarted: vi.fn(() => {}),
			TaskAborted: vi.fn(() => {}),
			TaskIdle: vi.fn((_taskId: string) => {}),
			TaskActive: vi.fn((_taskId: string) => {}),
			TaskAskResponded: vi.fn(() => {}),
			Message: vi.fn(() => {}),
			TaskTokenUsageUpdated: vi.fn(() => {}),
			TaskToolFailed: vi.fn(() => {}),
			TaskUnpaused: vi.fn((_taskId: string) => {}),
		}

		task.on(RooCodeEventName.TaskStarted, listeners.TaskStarted)
		task.on(RooCodeEventName.TaskAborted, listeners.TaskAborted)
		task.on(RooCodeEventName.TaskIdle, listeners.TaskIdle)
		task.on(RooCodeEventName.TaskActive, listeners.TaskActive)
		task.on(RooCodeEventName.TaskAskResponded, listeners.TaskAskResponded)
		task.on(RooCodeEventName.Message, listeners.Message)
		task.on(RooCodeEventName.TaskTokenUsageUpdated, listeners.TaskTokenUsageUpdated)
		task.on(RooCodeEventName.TaskToolFailed, listeners.TaskToolFailed)
		task.on(RooCodeEventName.TaskUnpaused, listeners.TaskUnpaused)

		// Verify all listeners are added
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskActive)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskAskResponded)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.Message)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskTokenUsageUpdated)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskToolFailed)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskUnpaused)).toBe(1)

		// Call dispose
		void task.dispose()

		// Verify all listeners are removed
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskActive)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskAskResponded)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.Message)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskTokenUsageUpdated)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskToolFailed)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskUnpaused)).toBe(0)

		// Verify total listener count is 0
		expect(task.eventNames().length).toBe(0)
	})
})

describe("Task.run() idempotency", () => {
	const originalStartTask = Task.prototype["startTask"]
	let mockProvider: ReturnType<typeof createTaskProvider>
	let mockApiConfiguration: ProviderSettings
	let historyFiles: ReturnType<typeof installTaskHistoryFiles>

	beforeEach(() => {
		vi.clearAllMocks()
		historyFiles = installTaskHistoryFiles()
		mockProvider = createTaskProvider("/test/path")
		mockApiConfiguration = { apiProvider: providerIdentifiers.anthropic, apiKey: "test-key" } as ProviderSettings
	})

	afterEach(() => {
		Task.prototype["startTask"] = originalStartTask
		mockProvider.taskHistoryStore.dispose()
		historyFiles.restore()
		vi.restoreAllMocks()
	})

	test("run() does not invoke startTask when task was already started by constructor", async () => {
		// Spy on the prototype before construction so we capture the constructor's call too.
		const startTaskSpy = vi.fn<Task["startTask"]>().mockResolvedValue(undefined)
		Task.prototype["startTask"] = startTaskSpy

		const t = await createClaimedTask({
			provider: mockProvider,
			taskId: "test-task",
			apiConfiguration: mockApiConfiguration,
			task: "hello",
			startTask: true,
		})

		await vi.waitFor(() => expect(startTaskSpy).toHaveBeenCalledOnce())
		await t.run()
		expect(startTaskSpy).toHaveBeenCalledOnce()
		await t.dispose()
		Task.prototype["startTask"] = originalStartTask
	})

	test("run() does not invoke startTask when task was already started by start()", async () => {
		const startTaskSpy = vi.fn<Task["startTask"]>().mockResolvedValue(undefined)
		Task.prototype["startTask"] = startTaskSpy

		const t = await createClaimedTask({
			provider: mockProvider,
			taskId: "test-task",
			apiConfiguration: mockApiConfiguration,
			task: "hello",
			startTask: false,
		})
		t.start()
		await vi.waitFor(() => expect(startTaskSpy).toHaveBeenCalledOnce())

		await t.run()
		expect(startTaskSpy).toHaveBeenCalledOnce()
		await t.dispose()
		Task.prototype["startTask"] = originalStartTask
	})

	test("run() returns the same promise on repeated calls", async () => {
		const startTaskSpy = vi.fn<Task["startTask"]>().mockResolvedValue(undefined)
		Task.prototype["startTask"] = startTaskSpy

		const t = await createClaimedTask({
			provider: mockProvider,
			taskId: "test-task",
			apiConfiguration: mockApiConfiguration,
			task: "hello",
			startTask: false,
		})

		const p1 = t.run()
		const p2 = t.run()
		expect(p1).toBe(p2)
		await p1
		expect(startTaskSpy).toHaveBeenCalledOnce()
		await t.dispose()
		Task.prototype["startTask"] = originalStartTask
	})
})
