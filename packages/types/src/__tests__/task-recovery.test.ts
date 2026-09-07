import {
	taskRecoveryChoices,
	taskRecoveryDecisionSchema,
	type ExecutionRefusalReason,
	type ExtensionMessage,
	type ExtensionState,
	type TaskProviderLike,
	type TaskRecoveryDecision,
	type TaskRecoveryPrompt,
	type TaskRecoveryResponse,
	type WebviewMessage,
} from "../index.js"

const decision: TaskRecoveryDecision = {
	taskId: "task",
	promptId: "prompt",
	choice: "resume_independent",
	intent: "explicit_user_resume",
}

describe("task recovery contracts", () => {
	it.each(taskRecoveryChoices)("accepts explicit %s decisions without adding authority", (choice) => {
		const input = { ...decision, choice }
		const parsed = taskRecoveryDecisionSchema.parse(input)
		expect(parsed).toEqual(input)
		expect(parsed).not.toBe(input)
	})

	it.each(["owner", "scope", "generation", "cleanup", "cleanupPending", "revision", "claim", "action"])(
		"rejects client-supplied %s instead of stripping it",
		(field) => {
			expect(taskRecoveryDecisionSchema.safeParse({ ...decision, [field]: {} }).success).toBe(false)
		},
	)

	it.each([
		undefined,
		null,
		[],
		{},
		{ ...decision, taskId: undefined },
		{ ...decision, taskId: 1 },
		{ ...decision, taskId: "" },
		{ ...decision, promptId: undefined },
		{ ...decision, promptId: 1 },
		{ ...decision, promptId: "" },
		{ ...decision, choice: undefined },
		{ ...decision, choice: "retry" },
		{ ...decision, intent: undefined },
		{ ...decision, intent: "automatic_approval" },
		{ ...decision, intent: "yesButtonClicked" },
	])("rejects malformed or implicit recovery %#", (input) => {
		expect(taskRecoveryDecisionSchema.safeParse(input).success).toBe(false)
	})

	it("exposes only the safe prompt and decision keys", () => {
		expectTypeOf<keyof TaskRecoveryPrompt>().toEqualTypeOf<"taskId" | "promptId" | "choices" | "reason">()
		expectTypeOf<keyof TaskRecoveryDecision>().toEqualTypeOf<"taskId" | "promptId" | "choice" | "intent">()
		expectTypeOf<TaskRecoveryPrompt["reason"]>().toEqualTypeOf<ExecutionRefusalReason | undefined>()
	})

	it("requires an explicit preview task ID while retaining ordinary message compatibility", () => {
		expectTypeOf<{ type: "previewTaskRecovery" }>().not.toExtend<WebviewMessage>()
		expectTypeOf<{ type: "previewTaskRecovery"; taskId: number }>().not.toExtend<WebviewMessage>()
		const messages: WebviewMessage[] = [
			{ type: "previewTaskRecovery", taskId: "task" },
			{ type: "recoverTask", taskRecoveryDecision: decision },
			{ type: "askResponse", askResponse: "yesButtonClicked" },
		]
		expect(messages).toHaveLength(3)
	})

	it("round trips prompt clearing and applied/refused responses through typed messages", () => {
		const prompt: TaskRecoveryPrompt = { taskId: "task", promptId: "prompt", choices: ["resume_independent"] }
		const applied: TaskRecoveryResponse = { kind: "applied", taskId: "task", promptId: "prompt" }
		const refused: TaskRecoveryResponse = { kind: "refused", taskId: "task", reason: "owner_live" }
		const state: Partial<ExtensionState> = { taskRecovery: prompt }
		const messages: ExtensionMessage[] = [
			{ type: "state", state },
			{ type: "taskRecovery", taskRecovery: prompt },
			{ type: "taskRecovery", taskRecovery: null },
			{ type: "taskRecoveryResult", taskRecoveryResult: applied },
			{ type: "taskRecoveryResult", taskRecoveryResult: refused },
		]
		expect(JSON.parse(JSON.stringify(messages))).toEqual(messages)
		expectTypeOf<ExtensionState["taskRecovery"]>().toEqualTypeOf<TaskRecoveryPrompt | null | undefined>()
		expectTypeOf<Extract<TaskRecoveryResponse, { kind: "applied" }>["promptId"]>().toEqualTypeOf<string>()
		expectTypeOf<
			Extract<TaskRecoveryResponse, { kind: "refused" }>["reason"]
		>().toEqualTypeOf<ExecutionRefusalReason>()
	})

	it("requires recovery provider APIs without strengthening generic resume", () => {
		expectTypeOf<TaskProviderLike["previewTaskRecovery"]>().toEqualTypeOf<
			(taskId: string) => Promise<TaskRecoveryPrompt>
		>()
		expectTypeOf<TaskProviderLike["recoverTask"]>().toEqualTypeOf<
			(request: TaskRecoveryDecision) => Promise<TaskRecoveryResponse>
		>()
		expectTypeOf<TaskProviderLike["resumeTask"]>().toEqualTypeOf<(taskId: string) => void>()
	})
})
