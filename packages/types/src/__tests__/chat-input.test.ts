import { chatInputSchema } from "../task.js"

describe("chat input routing contract", () => {
	const content = { requestId: "send-1", text: "hello", images: [] }
	it("separates blank chat creation from scoped runtime input", () => {
		expect(chatInputSchema.safeParse({ ...content, kind: "new", scope: null }).success).toBe(true)
		expect(chatInputSchema.safeParse({ ...content, kind: "queue", scope: null }).success).toBe(false)
		expect(
			chatInputSchema.safeParse({
				...content,
				kind: "response",
				scope: { taskId: "task", instanceId: "runtime" },
				askTs: 1,
			}).success,
		).toBe(true)
	})
	it.each([
		{ kind: "queue", scope: { taskId: "task" } },
		{ kind: "response", scope: { taskId: "task", instanceId: "runtime" } },
		{ kind: "new", scope: null, executionToken: "untrusted" },
		{ kind: "queue", scope: { taskId: "task", instanceId: "runtime", generation: 1 } },
	])("rejects missing identity and client authority: %j", (fields) => {
		expect(chatInputSchema.safeParse({ ...content, ...fields }).success).toBe(false)
	})
})
