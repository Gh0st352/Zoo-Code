import { act, renderHook } from "@testing-library/react"
import type { ChatInput, ExtensionMessage } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { useChatSubmission } from "../useChatSubmission"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
const fresh: ChatInput = { kind: "new", scope: null, requestId: "receipt", text: "draft", images: [] }
const receive = (chatInputResult: ExtensionMessage["chatInputResult"]) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "chatInputResult", chatInputResult } }))
	})

describe("chat submission receipt lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})
	it("retries only the exact request after missing acknowledgment and rejects double Enter", () => {
		vi.useFakeTimers()
		const clearDraft = vi.fn()
		const { result } = renderHook(() => useChatSubmission({ text: "draft", images: [], clearDraft }))
		act(() => {
			result.current.submit(fresh)
			result.current.submit({ ...fresh, requestId: "duplicate" })
		})
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		act(() => vi.advanceTimersByTime(15000))
		expect(result.current.status).toBe("unknown")
		act(() => result.current.retryReceipt())
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "submitChatMessage", chatInput: fresh })
		receive({ requestId: fresh.requestId, kind: "accepted", taskId: "created" })
		expect(clearDraft).toHaveBeenCalledTimes(1)
	})
	it("does not clear an unrelated draft when a suggestion or invoked send is accepted", () => {
		const clearDraft = vi.fn()
		const { result } = renderHook(() => useChatSubmission({ text: "unrelated draft", images: [], clearDraft }))
		act(() => result.current.submit(fresh))
		receive({ requestId: fresh.requestId, kind: "accepted", taskId: "created" })
		expect(clearDraft).not.toHaveBeenCalled()
	})
	it("ignores an old runtime receipt after a same-task replacement", () => {
		const clearDraft = vi.fn()
		const { result, rerender } = renderHook(
			({ instanceId }) =>
				useChatSubmission({
					taskId: "task",
					instanceId,
					text: "draft",
					images: [],
					clearDraft,
				}),
			{ initialProps: { instanceId: "old" } },
		)
		act(() => result.current.submit({ ...fresh, kind: "queue", scope: { taskId: "task", instanceId: "old" } }))
		rerender({ instanceId: "new" })
		receive({ requestId: fresh.requestId, kind: "accepted", taskId: "task" })
		expect(clearDraft).not.toHaveBeenCalled()
		expect(result.current.status).toBeUndefined()
	})
})
