import type { DelegatedCompletionRequest, ExecutionToken } from "@roo-code/types"

import { Task } from "../../core/task/Task"
import { ClineProvider } from "../../core/webview/ClineProvider"

function token(taskId: string): ExecutionToken {
	return {
		taskId,
		generation: 1,
		owner: {
			hostSessionId: "test-host",
			providerId: "test-provider",
			runtimeId: `runtime-${taskId}`,
			processId: 1,
			machineId: "test-machine",
			machineProof: "local",
		},
	}
}

function freeze<T extends object>(value: T): T {
	for (const child of Object.values(value)) {
		if (child !== null && typeof child === "object") freeze(child)
	}
	return Object.freeze(value)
}

/** An immutable, explicitly approved routing fixture, not a store-authority substitute. */
function completionRequest(task: Task, finish: DelegatedCompletionRequest["finish"]): DelegatedCompletionRequest {
	if (!task.executionToken) throw new Error("Completion fixture requires an execution token")
	const parentToken = token(finish.parentTaskId)
	return freeze(
		structuredClone({
			operationId: `complete-${finish.actionId}`,
			childToken: task.executionToken,
			parentToken,
			childRevision: 2,
			parentRevision: 3,
			creating: {
				actionId: "create-child",
				operationId: "delegate-child",
				childId: task.taskId,
				ownerToken: parentToken.owner.runtimeId,
				executionToken: parentToken,
				generation: parentToken.generation,
				revision: 1,
				phase: "committed",
				attempts: 1,
				resultTs: 1,
				intent: {
					kind: "create_subtask",
					actionId: "create-child",
					approvalText: "{}",
					mode: "code",
					message: "Child",
					todos: [],
				},
			},
			finish,
			resultTs: 2,
		} satisfies DelegatedCompletionRequest),
	)
}

/** Pure provider mocks for replay/tool units; real authority is tested with the real store. */
export function createCompletionProvider() {
	return Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
		completeTask: vi.fn<ClineProvider["completeTask"]>().mockResolvedValue(true),
		setPendingTaskAction: vi.fn<ClineProvider["setPendingTaskAction"]>().mockResolvedValue(undefined),
		clearPendingTaskAction: vi.fn<ClineProvider["clearPendingTaskAction"]>().mockResolvedValue(true),
		prepareDelegatedCompletion: vi
			.fn<ClineProvider["prepareDelegatedCompletion"]>()
			.mockImplementation(async (task, finish) => completionRequest(task, finish)),
		reopenParentFromDelegation: vi.fn<ClineProvider["reopenParentFromDelegation"]>().mockResolvedValue(true),
		validateTaskDelegation: vi.fn<ClineProvider["validateTaskDelegation"]>().mockResolvedValue(true),
		denyTaskDelegation: vi.fn<ClineProvider["denyTaskDelegation"]>().mockResolvedValue(undefined),
		delegateParentAndOpenChild: vi.fn<ClineProvider["delegateParentAndOpenChild"]>(),
		log: vi.fn<ClineProvider["log"]>(),
	} satisfies Partial<ClineProvider>)
}

/**
 * Isolate orchestration from Task construction and the model loop. This guard grants
 * explicit test permission to the supplied generation only, and keeps STOP monotonic.
 * It deliberately does not mock persistence or claim to validate real store ownership.
 */
export function createCompletionTask(provider?: ClineProvider, overrides: Partial<Task> = {}): Task {
	const task = Object.create(Task.prototype) as Task
	const executionToken = freeze(token(overrides.taskId ?? "task_1"))
	Object.assign(task, {
		taskId: executionToken.taskId,
		instanceId: executionToken.owner.runtimeId,
		executionToken,
		executionGeneration: executionToken.generation,
		executionBlocked: false,
		abort: false,
		abandoned: false,
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn<Task["recordToolError"]>(),
		say: vi.fn<Task["say"]>().mockResolvedValue(undefined),
		ask: vi.fn<Task["ask"]>().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		emit: vi.fn<Task["emit"]>(),
		emitFinalTokenUsageUpdate: vi.fn<Task["emitFinalTokenUsageUpdate"]>(),
		flushTelemetryInstallment: vi.fn<Task["flushTelemetryInstallment"]>(),
		setPendingTaskAction: vi.fn<Task["setPendingTaskAction"]>().mockImplementation((action) => {
			task["pendingAction"] = action
		}),
		persistQueuedFeedbackAndAcknowledge: vi
			.fn<Task["persistQueuedFeedbackAndAcknowledge"]>()
			.mockResolvedValue(true),
		guardExecution: vi.fn<Task["guardExecution"]>().mockImplementation(async () => {
			if (
				task.executionToken !== executionToken ||
				task.taskId !== executionToken.taskId ||
				task.executionGeneration !== executionToken.generation ||
				task.executionBlocked ||
				task.abort ||
				task.abandoned
			) {
				task.executionBlocked = true
				return false
			}
			return true
		}),
		...overrides,
	} satisfies Partial<Task>)
	// An absent provider is intentional in the provider-unavailable replay test.
	Object.assign(task, { providerRef: { deref: () => provider } })
	task["initiateTaskLoop"] = vi.fn<Task["initiateTaskLoop"]>().mockResolvedValue(undefined)
	return task
}
