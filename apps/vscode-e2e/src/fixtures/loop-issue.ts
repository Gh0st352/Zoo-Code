import type { LLMock } from "@copilotkit/aimock"

export const LOOP_MULTI_PARENT = "LOOP_ISSUE_MULTI_PARENT"
export const LOOP_MULTI_CHILD = "LOOP_ISSUE_MULTI_CHILD"
export const LOOP_CANCEL = "LOOP_ISSUE_CANCEL"
export const LOOP_DELAYED = "LOOP_ISSUE_DELAYED"
export const LOOP_RESTART = "LOOP_ISSUE_RESTART"
export const LOOP_RESULT = "LOOP_ISSUE_COMPLETED"
export const LOOP_SEND = "LOOP_ISSUE_CHAT_SEND"
export const LOOP_SEND_REPLY = "LOOP_ISSUE_CHAT_REPLY"
export const LOOP_SEND_FEEDBACK = "LOOP_ISSUE_CHAT_FEEDBACK"

export function addLoopIssueFixtures(mock: LLMock): void {
	mock.addFixture({
		match: { userMessage: LOOP_SEND, sequenceIndex: 0 },
		response: {
			toolCalls: [
				{
					name: "ask_followup_question",
					id: "call_loop_send_question",
					arguments: JSON.stringify({
						question: "Reply?",
						follow_up: [
							{ text: LOOP_SEND_REPLY, mode: null },
							{ text: "Stop", mode: null },
						],
					}),
				},
			],
		},
	})
	for (const marker of [LOOP_SEND_REPLY, LOOP_SEND_FEEDBACK]) {
		mock.addFixture({
			match: { userMessage: marker },
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						id: `call_${marker}`,
						arguments: JSON.stringify({ result: LOOP_RESULT }),
					},
				],
			},
		})
	}
	mock.addFixture({
		match: { userMessage: LOOP_MULTI_PARENT, sequenceIndex: 0 },
		response: {
			toolCalls: [
				{
					name: "new_task",
					id: "call_loop_multi_child",
					arguments: JSON.stringify({ mode: "ask", message: LOOP_MULTI_CHILD }),
				},
			],
		},
	})
	for (const marker of [LOOP_MULTI_CHILD, LOOP_CANCEL, LOOP_DELAYED, LOOP_RESTART]) {
		mock.addFixture({
			match: { userMessage: marker },
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						id: `call_${marker}`,
						arguments: JSON.stringify({ result: LOOP_RESULT }),
					},
				],
			},
		})
	}
	mock.addFixture({
		match: { toolCallId: "call_loop_multi_child" },
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					id: "call_loop_parent_done",
					arguments: JSON.stringify({ result: LOOP_RESULT }),
				},
			],
		},
	})
	mock.addFixture({
		match: { model: "openai/gpt-4.1", userMessage: /Explicit recovery choice: resume_independent\./ },
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					id: "call_loop_recovered",
					arguments: JSON.stringify({ result: LOOP_RESULT }),
				},
			],
		},
	})
}
