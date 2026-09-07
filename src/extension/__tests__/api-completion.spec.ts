import { EventEmitter } from "events"
import type * as vscode from "vscode"
import {
	RooCodeEventName,
	type HistoryItem,
	type TaskEvents,
	type TaskProviderEvents,
	type TokenUsage,
} from "@roo-code/types"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { Task } from "../../core/task/Task"
import { makeExtensionContext } from "../../test-utils/vscode"

vi.mock("vscode")

describe("API durable completion forwarding", () => {
	const usage: TokenUsage = { totalTokensIn: 10, totalTokensOut: 5, totalCost: 0, contextTokens: 15 }

	function setup(parentTaskId?: string) {
		const events = new EventEmitter<TaskProviderEvents>()
		const history: HistoryItem = {
			id: "finished",
			number: 1,
			ts: 1,
			task: "Finished task",
			tokensIn: 10,
			tokensOut: 5,
			totalCost: 0,
			status: "completed",
			parentTaskId,
		}
		// Only the event boundary is under test; no provider startup or Task execution.
		const provider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
			context: makeExtensionContext(),
			on: events.on.bind(events),
			taskHistoryStore: { get: vi.fn((id: string) => (id === history.id ? history : undefined)) },
			getCurrentTask: vi.fn(() => undefined),
		})
		const output: vscode.OutputChannel = {
			name: "test",
			append: vi.fn(),
			appendLine: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}
		const api = new API(output, provider)
		const published = vi.fn()
		api.on(RooCodeEventName.TaskCompleted, published)
		const taskEvents = new EventEmitter<TaskEvents>()
		const task = Object.assign(Object.create(Task.prototype) as Task, {
			taskId: history.id,
			parentTaskId,
			on: taskEvents.on.bind(taskEvents),
		})
		events.emit(RooCodeEventName.TaskCreated, task)
		return { events, taskEvents, published, history }
	}

	it.each([undefined, "parent"])(
		"forwards provider completion after task listeners are disposed (parent=%s)",
		(parentTaskId) => {
			const { events, taskEvents, published } = setup(parentTaskId)
			taskEvents.removeAllListeners()
			events.emit(RooCodeEventName.TaskCompleted, "finished", usage, {})
			expect(published).toHaveBeenCalledExactlyOnceWith("finished", usage, {}, { isSubtask: !!parentTaskId })
		},
	)

	it("does not publish an uncommitted raw Task completion, only the provider's committed event", () => {
		const { events, taskEvents, published } = setup()
		taskEvents.emit(RooCodeEventName.TaskCompleted, "finished", usage, {})
		expect(published).not.toHaveBeenCalled()
		events.emit(RooCodeEventName.TaskCompleted, "finished", usage, {})
		expect(published).toHaveBeenCalledExactlyOnceWith("finished", usage, {}, { isSubtask: false })
	})

	it("uses committed lineage rather than the original Task lineage after independent recovery", () => {
		const { events, taskEvents, published, history } = setup("former-parent")
		history.parentTaskId = undefined
		history.lineageProvenance = { parentTaskId: "former-parent" }
		taskEvents.removeAllListeners()
		events.emit(RooCodeEventName.TaskCompleted, "finished", usage, {})
		expect(published).toHaveBeenCalledExactlyOnceWith("finished", usage, {}, { isSubtask: false })
	})
})
