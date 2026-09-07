import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { Task } from "../../core/task/Task"
import { makeExtensionContext } from "../../test-utils/vscode"
import { webviewMessageHandler } from "../../core/webview/webviewMessageHandler"
import { createLoopIssueTestApi } from "../loopIssueTestApi"
import { openClineInNewTab } from "../../activate/registerCommands"

vi.mock("vscode", async () => ({
	...(await vi.importActual<typeof vscode>("../../__mocks__/vscode")),
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}))
vi.mock("../../core/webview/webviewMessageHandler", () => ({ webviewMessageHandler: vi.fn() }))
vi.mock("../../activate/registerCommands", () => ({ openClineInNewTab: vi.fn() }))

describe("LoopIssue isolated-host test adapter", () => {
	function setup(mode = vscode.ExtensionMode.Test) {
		const provider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			context: { ...makeExtensionContext(), extensionMode: mode },
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			completeTask: vi.fn().mockResolvedValue(false),
			getCurrentTask: vi.fn<() => Task | undefined>(),
		})
		const output = vscode.window.createOutputChannel("LoopIssue test")
		return { provider, output }
	}

	beforeEach(() => vi.clearAllMocks())

	it.each([vscode.ExtensionMode.Production, vscode.ExtensionMode.Development])(
		"refuses mode %s before exposing hooks",
		(mode) => {
			const { provider, output } = setup(mode)
			expect(() => createLoopIssueTestApi(provider, output)).toThrow("isolated extension test host")
		},
	)

	it("forwards messages through the real publication boundary and restores it after rejection", async () => {
		const { provider, output } = setup()
		const post = provider.postMessageToWebview
		const hooks = createLoopIssueTestApi(provider, output)
		vi.mocked(webviewMessageHandler).mockImplementationOnce(async (source, message) => {
			expect(message).toEqual({ type: "previewTaskRecovery", taskId: "task", requestId: "request" })
			await source.postMessageToWebview({ type: "taskRecovery", taskRecovery: null, requestId: "request" })
		})
		expect(await hooks.dispatch({ type: "previewTaskRecovery", taskId: "task", requestId: "request" })).toEqual([
			{ type: "taskRecovery", taskRecovery: null, requestId: "request" },
		])
		expect(post).toHaveBeenCalledOnce()
		expect(provider.postMessageToWebview).toBe(post)
		vi.mocked(webviewMessageHandler).mockRejectedValueOnce(new Error("dispatch failed"))
		await expect(hooks.dispatch({ type: "askResponse", askResponse: "yesButtonClicked" })).rejects.toThrow(
			"dispatch failed",
		)
		expect(provider.postMessageToWebview).toBe(post)
	})

	it("retains the captured incarnation rather than delivering completion to its replacement", async () => {
		const { provider, output } = setup()
		const task = Object.assign(Object.create(Task.prototype) as Task, {
			taskId: "task",
			instanceId: "old",
			executionToken: { taskId: "task", generation: 1 },
		})
		provider.getCurrentTask.mockReturnValue(task)
		const callback = createLoopIssueTestApi(provider, output).captureCompletion()
		provider.getCurrentTask.mockReturnValue(undefined)
		expect(await callback.deliver("late")).toBe(false)
		expect(provider.completeTask).toHaveBeenCalledExactlyOnceWith(task, "late")
	})

	it("rejects overlapping dispatch rather than nesting publication interceptors", async () => {
		const { provider, output } = setup()
		let release!: () => void
		vi.mocked(webviewMessageHandler).mockImplementationOnce(
			() =>
				new Promise<void>((done) => {
					release = done
				}),
		)
		const hooks = createLoopIssueTestApi(provider, output)
		const first = hooks.dispatch({ type: "previewTaskRecovery", taskId: "task" })
		await expect(hooks.dispatch({ type: "previewTaskRecovery", taskId: "other" })).rejects.toThrow("sequential")
		release()
		await first
		expect(webviewMessageHandler).toHaveBeenCalledOnce()
	})

	it("awaits the provider disposal invoked by the panel event", async () => {
		const { provider, output } = setup()
		let release!: () => void
		const dispose = vi.fn(
			() =>
				new Promise<void>((done) => {
					release = done
				}),
		)
		const observer = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			taskHistoryStore: { initialized: Promise.resolve() },
			isViewLaunched: true,
			showTaskWithId: vi.fn().mockResolvedValue(undefined),
			dispose,
		})
		Object.assign(observer, {
			view: {
				dispose: () => {
					void observer.dispose()
				},
			},
		})
		vi.mocked(openClineInNewTab).mockResolvedValueOnce(observer)
		const view = await createLoopIssueTestApi(provider, output).openObserver("task")
		let settled = false
		const closing = view.close().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		expect(dispose).toHaveBeenCalledOnce()
		release()
		await closing
		await view.close()
		expect(dispose).toHaveBeenCalledOnce()
		expect(settled).toBe(true)
	})

	it("cleans an observer if history installation fails", async () => {
		const { provider, output } = setup()
		const observer = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			taskHistoryStore: { initialized: Promise.resolve() },
			isViewLaunched: true,
			showTaskWithId: vi.fn().mockRejectedValue(new Error("history unavailable")),
			dispose: vi.fn().mockResolvedValue(undefined),
		})
		vi.mocked(openClineInNewTab).mockResolvedValueOnce(observer)
		await expect(createLoopIssueTestApi(provider, output).openObserver("task")).rejects.toThrow(
			"history unavailable",
		)
		expect(observer.dispose).toHaveBeenCalledOnce()
	})
})
