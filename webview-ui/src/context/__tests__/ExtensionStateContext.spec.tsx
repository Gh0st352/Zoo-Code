import { providerIdentifiers } from "@roo-code/types"
import { render, screen, act, appendClineMessage, hydrateExtensionState } from "@/utils/test-utils"
import React from "react"

import {
	type ProviderSettings,
	type ExperimentId,
	type ExtensionState,
	type ExtensionMessage,
	type ClineMessage,
	type MarketplaceItem,
	type MarketplaceInstalledMetadata,
	type RouterModels,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_DIFF_FUZZY_THRESHOLD,
} from "@roo-code/types"

import { ExtensionStateContextProvider, useExtensionState, mergeExtensionState } from "../ExtensionStateContext"
import { vscode } from "@/utils/vscode"

const dispatchExtensionMessage = (message: ExtensionMessage) => {
	window.dispatchEvent(new MessageEvent("message", { data: message }))
}

const makeMessage = (ts: number, text: string): ClineMessage => ({ ts, type: "say", say: "text", text })

const TestComponent = () => {
	const { allowedCommands, setAllowedCommands, soundEnabled, showRooIgnoredFiles, setShowRooIgnoredFiles } =
		useExtensionState()

	return (
		<div>
			<div data-testid="allowed-commands">{JSON.stringify(allowedCommands)}</div>
			<div data-testid="sound-enabled">{JSON.stringify(soundEnabled)}</div>
			<div data-testid="show-rooignored-files">{JSON.stringify(showRooIgnoredFiles)}</div>
			<button data-testid="update-button" onClick={() => setAllowedCommands(["npm install", "git status"])}>
				Update Commands
			</button>
			<button data-testid="toggle-rooignore-button" onClick={() => setShowRooIgnoredFiles(!showRooIgnoredFiles)}>
				Update Commands
			</button>
		</div>
	)
}

const RulesTestComponent = () => {
	const { rules } = useExtensionState()

	return <div data-testid="rules">{JSON.stringify(rules)}</div>
}

const ChatFontSizeTestComponent = () => {
	const { chatFontSize, setChatFontSize } = useExtensionState()

	return (
		<div>
			<div data-testid="chat-font-size">{JSON.stringify(chatFontSize ?? null)}</div>
			<button data-testid="set-font-size-button" onClick={() => setChatFontSize(20)}>
				Set Font Size
			</button>
			<button data-testid="reset-font-size-button" onClick={() => setChatFontSize(undefined)}>
				Reset Font Size
			</button>
		</div>
	)
}

const ApiConfigTestComponent = () => {
	const { apiConfiguration, setApiConfiguration } = useExtensionState()

	return (
		<div>
			<div data-testid="api-configuration">{JSON.stringify(apiConfiguration)}</div>
			<button
				data-testid="update-api-config-button"
				onClick={() =>
					setApiConfiguration({ apiModelId: "new-model", apiProvider: providerIdentifiers.anthropic })
				}>
				Update API Config
			</button>
			<button data-testid="partial-update-button" onClick={() => setApiConfiguration({ modelTemperature: 0.7 })}>
				Partial Update
			</button>
		</div>
	)
}

const InitialStateTestComponent = () => {
	const {
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		includeTaskHistoryInEnhance,
		includeCurrentTime,
		includeCurrentCost,
		routerModels,
		marketplaceItems,
		marketplaceInstalledMetadata,
	} = useExtensionState()

	return (
		<div data-testid="initial-state">
			{JSON.stringify({
				alwaysAllowFollowupQuestions,
				followupAutoApproveTimeoutMs,
				includeTaskHistoryInEnhance,
				includeCurrentTime,
				includeCurrentCost,
				routerModels,
				marketplaceItems,
				marketplaceInstalledMetadata,
			})}
		</div>
	)
}

const TranscriptTestComponent = () => {
	const {
		currentTaskId,
		currentTaskItem,
		currentTaskTodos,
		messageQueue,
		currentCheckpoint,
		clineMessages,
		clineMessagesSeq,
	} = useExtensionState()

	return (
		<div data-testid="transcript-state">
			{JSON.stringify({
				currentTaskId: currentTaskId ?? null,
				currentTaskItem: currentTaskItem ?? null,
				currentTaskTodos: currentTaskTodos ?? [],
				messageQueue: messageQueue ?? [],
				currentCheckpoint: currentCheckpoint ?? null,
				clineMessages,
				clineMessagesSeq: clineMessagesSeq ?? 0,
			})}
		</div>
	)
}

describe("ExtensionStateContext", () => {
	it("initializes with empty allowedCommands array", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual([])
	})

	it("initializes with empty rules array", () => {
		render(
			<ExtensionStateContextProvider>
				<RulesTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("rules").textContent!)).toEqual([])
	})

	it("updates rules from incoming rules message", () => {
		render(
			<ExtensionStateContextProvider>
				<RulesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "rules",
						rules: [
							{
								id: "global:generic:generic:rule.md",
								name: "rule.md",
								scope: "global",
								kind: "generic",
								filePath: "/home/.roo/rules/rule.md",
								relativePath: "rule.md",
								directoryPath: "/home/.roo/rules",
							},
						],
					},
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("rules").textContent!)).toEqual([
			expect.objectContaining({ id: "global:generic:generic:rule.md", name: "rule.md" }),
		])
	})

	it("clears rules when incoming rules message omits rules", () => {
		render(
			<ExtensionStateContextProvider>
				<RulesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "rules",
						rules: [
							{
								id: "global:generic:generic:rule.md",
								name: "rule.md",
								scope: "global",
								kind: "generic",
								filePath: "/home/.roo/rules/rule.md",
								relativePath: "rule.md",
								directoryPath: "/home/.roo/rules",
							},
						],
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "rules" },
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("rules").textContent!)).toEqual([])
	})

	it("initializes with soundEnabled set to false", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("sound-enabled").textContent!)).toBe(false)
	})

	it("initializes with showRooIgnoredFiles set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(true)
	})

	it("initializes shadowed context fields from initialState", () => {
		const routerModels = {} as RouterModels
		const marketplaceItems: MarketplaceItem[] = [
			{
				id: "mode-item",
				name: "Test mode",
				description: "A test mode",
				type: "mode",
				content: "custom mode content",
			},
		]
		const marketplaceInstalledMetadata: MarketplaceInstalledMetadata = {
			project: { "mode-item": { type: "mode" } },
			global: {},
		}

		render(
			<ExtensionStateContextProvider
				initialState={{
					alwaysAllowFollowupQuestions: true,
					followupAutoApproveTimeoutMs: 1500,
					includeTaskHistoryInEnhance: false,
					includeCurrentTime: false,
					includeCurrentCost: false,
					routerModels,
					marketplaceItems,
					marketplaceInstalledMetadata,
				}}>
				<InitialStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("initial-state").textContent!)).toEqual({
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1500,
			includeTaskHistoryInEnhance: false,
			includeCurrentTime: false,
			includeCurrentCost: false,
			routerModels: {},
			marketplaceItems,
			marketplaceInstalledMetadata,
		})
	})

	it("updates showRooIgnoredFiles through setShowRooIgnoredFiles", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("toggle-rooignore-button").click()
		})

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(false)
	})

	it("does not set the chat font-size CSS variable when unset (init)", () => {
		document.documentElement.style.removeProperty("--zoo-chat-font-size")

		render(
			<ExtensionStateContextProvider>
				<ChatFontSizeTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("chat-font-size").textContent!)).toBe(null)
		expect(document.documentElement.style.getPropertyValue("--zoo-chat-font-size")).toBe("")
	})

	it("applies the chat font-size CSS variable when set, and clears it on reset", () => {
		document.documentElement.style.removeProperty("--zoo-chat-font-size")

		render(
			<ExtensionStateContextProvider>
				<ChatFontSizeTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("set-font-size-button").click()
		})

		expect(JSON.parse(screen.getByTestId("chat-font-size").textContent!)).toBe(20)
		expect(document.documentElement.style.getPropertyValue("--zoo-chat-font-size")).toBe("20px")

		act(() => {
			screen.getByTestId("reset-font-size-button").click()
		})

		expect(JSON.parse(screen.getByTestId("chat-font-size").textContent!)).toBe(null)
		expect(document.documentElement.style.getPropertyValue("--zoo-chat-font-size")).toBe("")
	})

	it("updates allowedCommands through setAllowedCommands", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("update-button").click()
		})

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual(["npm install", "git status"])
	})

	it("throws error when used outside provider", () => {
		const useContextSpy = vi.spyOn(React, "useContext").mockReturnValue(undefined)

		try {
			expect(() => useExtensionState()).toThrow(
				"useExtensionState must be used within an ExtensionStateContextProvider",
			)
		} finally {
			useContextSpy.mockRestore()
		}
	})

	it("updates apiConfiguration through setApiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		const initialContent = screen.getByTestId("api-configuration").textContent!
		expect(initialContent).toBeDefined()

		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")

		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: providerIdentifiers.anthropic,
			}),
		)
	})

	it("correctly merges partial updates to apiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		// First set the initial configuration
		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		// Verify initial update
		const initialContent = screen.getByTestId("api-configuration").textContent!
		const initialConfig = JSON.parse(initialContent || "{}")
		expect(initialConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: providerIdentifiers.anthropic,
			}),
		)

		// Now perform a partial update
		act(() => {
			screen.getByTestId("partial-update-button").click()
		})

		// Verify that the partial update was merged with the existing configuration
		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")
		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model", // Should retain this from previous update
				apiProvider: providerIdentifiers.anthropic, // Should retain this from previous update
				modelTemperature: 0.7, // Should add this from partial update
			}),
		)
	})

	describe("dedicated transcript transport", () => {
		const readTranscript = () => JSON.parse(screen.getByTestId("transcript-state").textContent!)
		const readTranscriptFields = () => {
			const { currentTaskId, clineMessages, clineMessagesSeq } = readTranscript()
			return { currentTaskId, clineMessages, clineMessagesSeq }
		}
		const renderTranscript = (initialState: Partial<ExtensionState> = {}) =>
			render(
				<ExtensionStateContextProvider initialState={{ currentTaskId: "task-1", ...initialState }}>
					<TranscriptTestComponent />
				</ExtensionStateContextProvider>,
			)

		it("reconstructs a snapshot and applies contiguous append and update deltas", () => {
			render(
				<ExtensionStateContextProvider initialState={{ currentTaskId: "task-1" }}>
					<TranscriptTestComponent />
				</ExtensionStateContextProvider>,
			)

			const first = makeMessage(1, "first")
			const second = makeMessage(2, "second")
			act(() => {
				dispatchExtensionMessage({
					type: "clineMessagesSnapshotStart",
					taskId: "task-1",
					clineMessagesSeq: 4,
					snapshotId: "snapshot-1",
					snapshotTotal: 1,
				})
				dispatchExtensionMessage({
					type: "clineMessagesSnapshotChunk",
					taskId: "task-1",
					clineMessagesSeq: 4,
					snapshotId: "snapshot-1",
					snapshotStartIndex: 0,
					clineMessages: [first],
				})
				dispatchExtensionMessage({
					type: "clineMessagesSnapshotEnd",
					taskId: "task-1",
					clineMessagesSeq: 4,
					snapshotId: "snapshot-1",
					snapshotTotal: 1,
				})
				dispatchExtensionMessage({
					type: "clineMessageAppended",
					taskId: "task-1",
					clineMessagesSeq: 5,
					clineMessage: second,
				})
				dispatchExtensionMessage({
					type: "clineMessageUpdated",
					taskId: "task-1",
					clineMessagesSeq: 6,
					clineMessage: { ...second, text: "updated" },
				})
			})

			expect(readTranscriptFields()).toEqual({
				currentTaskId: "task-1",
				clineMessages: [first, { ...second, text: "updated" }],
				clineMessagesSeq: 6,
			})
		})

		it("ignores transcript fields in generic state and clears transport state on task switch", () => {
			const existing = makeMessage(1, "existing")
			render(
				<ExtensionStateContextProvider
					initialState={{ currentTaskId: "task-1", clineMessages: [existing], clineMessagesSeq: 3 }}>
					<TranscriptTestComponent />
				</ExtensionStateContextProvider>,
			)

			act(() => {
				dispatchExtensionMessage({
					type: "state",
					state: { clineMessages: [makeMessage(2, "stale")], clineMessagesSeq: 99 },
				})
			})
			expect(readTranscript().clineMessages).toEqual([existing])
			expect(readTranscript().clineMessagesSeq).toBe(3)

			act(() => {
				dispatchExtensionMessage({ type: "state", state: { currentTaskId: "task-2" } })
				dispatchExtensionMessage({
					type: "clineMessageAppended",
					taskId: "task-1",
					clineMessagesSeq: 4,
					clineMessage: makeMessage(3, "wrong task"),
				})
			})

			expect(readTranscriptFields()).toEqual({ currentTaskId: "task-2", clineMessages: [], clineMessagesSeq: 0 })
		})

		it("clears task-scoped state for a JSON-round-tripped authoritative no-task transition", () => {
			const existing = makeMessage(1, "existing")
			const currentTaskItem = {
				id: "task-1",
				number: 1,
				ts: 1,
				task: "Existing task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			renderTranscript({
				clineMessages: [existing],
				clineMessagesSeq: 3,
				currentTaskItem,
				currentTaskTodos: [{ id: "todo-1", content: "Existing todo", status: "in_progress" }],
				messageQueue: [{ id: "queued-1", timestamp: 1, text: "Queued message" }],
			})

			act(() => {
				dispatchExtensionMessage({ type: "currentCheckpointUpdated", text: "checkpoint-1" })
				const clearState = JSON.parse(JSON.stringify({ currentTaskId: null })) as Partial<ExtensionState>
				dispatchExtensionMessage({ type: "state", state: clearState })
				dispatchExtensionMessage({
					type: "clineMessagesSnapshotStart",
					clineMessagesSeq: 0,
					snapshotId: "no-task-snapshot",
					snapshotTotal: 0,
				})
				dispatchExtensionMessage({
					type: "clineMessagesSnapshotEnd",
					clineMessagesSeq: 0,
					snapshotId: "no-task-snapshot",
					snapshotTotal: 0,
				})
			})

			expect(readTranscript()).toEqual({
				currentTaskId: null,
				currentTaskItem: null,
				currentTaskTodos: [],
				messageQueue: [],
				currentCheckpoint: null,
				clineMessages: [],
				clineMessagesSeq: 0,
			})
		})

		it("preserves task-scoped state when a partial state update omits currentTaskId", () => {
			const existing = makeMessage(1, "existing")
			const currentTaskItem = {
				id: "task-1",
				number: 1,
				ts: 1,
				task: "Existing task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			const currentTaskTodos = [{ id: "todo-1", content: "Existing todo", status: "pending" as const }]
			const messageQueue = [{ id: "queued-1", timestamp: 1, text: "Queued message" }]
			renderTranscript({
				clineMessages: [existing],
				clineMessagesSeq: 3,
				currentTaskItem,
				currentTaskTodos,
				messageQueue,
			})

			act(() => {
				dispatchExtensionMessage({ type: "currentCheckpointUpdated", text: "checkpoint-1" })
				dispatchExtensionMessage({ type: "state", state: { version: "2.0.0" } })
			})

			expect(readTranscript()).toEqual({
				currentTaskId: "task-1",
				currentTaskItem,
				currentTaskTodos,
				messageQueue,
				currentCheckpoint: "checkpoint-1",
				clineMessages: [existing],
				clineMessagesSeq: 3,
			})
		})

		it("requests one resync when a delta sequence has a gap", () => {
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				render(
					<ExtensionStateContextProvider
						initialState={{
							currentTaskId: "task-1",
							clineMessages: [makeMessage(1, "first")],
							clineMessagesSeq: 1,
						}}>
						<TranscriptTestComponent />
					</ExtensionStateContextProvider>,
				)
				postMessage.mockClear() // Ignore webviewDidLaunch.

				act(() => {
					dispatchExtensionMessage({
						type: "clineMessageAppended",
						taskId: "task-1",
						clineMessagesSeq: 3,
						clineMessage: makeMessage(3, "gap"),
					})
					dispatchExtensionMessage({
						type: "clineMessageAppended",
						taskId: "task-1",
						clineMessagesSeq: 4,
						clineMessage: makeMessage(4, "another gap"),
					})
				})

				expect(postMessage).toHaveBeenCalledTimes(1)
				expect(postMessage).toHaveBeenCalledWith({
					type: "requestClineMessagesResync",
					taskId: "task-1",
					expectedSeq: 2,
					receivedSeq: 3,
				})
			} finally {
				postMessage.mockRestore()
			}
		})

		it("retires a failed resync and recovers from a replacement snapshot", () => {
			const first = makeMessage(1, "first")
			const recovered = makeMessage(2, "recovered")
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				renderTranscript({ clineMessages: [first], clineMessagesSeq: 1 })
				postMessage.mockClear()

				act(() => {
					dispatchExtensionMessage({
						type: "clineMessageAppended",
						taskId: "task-1",
						clineMessagesSeq: 3,
						clineMessage: makeMessage(3, "gap"),
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 3,
						snapshotId: "invalid-snapshot",
						snapshotTotal: 2,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotChunk",
						taskId: "task-1",
						clineMessagesSeq: 3,
						snapshotId: "invalid-snapshot",
						snapshotStartIndex: 1,
						clineMessages: [first],
					})
				})

				expect(postMessage).toHaveBeenCalledTimes(2)
				expect(postMessage).toHaveBeenLastCalledWith({
					type: "requestClineMessagesResync",
					taskId: "task-1",
					expectedSeq: 2,
					receivedSeq: 3,
				})

				act(() => {
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 3,
						snapshotId: "replacement-snapshot",
						snapshotTotal: 2,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotChunk",
						taskId: "task-1",
						clineMessagesSeq: 3,
						snapshotId: "replacement-snapshot",
						snapshotStartIndex: 0,
						clineMessages: [first, recovered],
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotEnd",
						taskId: "task-1",
						clineMessagesSeq: 3,
						snapshotId: "replacement-snapshot",
						snapshotTotal: 2,
					})
					dispatchExtensionMessage({
						type: "clineMessageAppended",
						taskId: "task-1",
						clineMessagesSeq: 4,
						clineMessage: makeMessage(4, "after recovery"),
					})
				})

				expect(readTranscriptFields()).toEqual({
					currentTaskId: "task-1",
					clineMessages: [first, recovered, makeMessage(4, "after recovery")],
					clineMessagesSeq: 4,
				})
			} finally {
				postMessage.mockRestore()
			}
		})

		it("allows another resync when a response is lost", async () => {
			vi.useFakeTimers()
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				renderTranscript({ clineMessagesSeq: 1 })
				postMessage.mockClear()

				act(() => {
					appendClineMessage(makeMessage(3, "gap"), 3, "task-1")
					appendClineMessage(makeMessage(4, "suppressed while pending"), 4, "task-1")
				})
				expect(postMessage).toHaveBeenCalledTimes(1)

				await act(async () => {
					await vi.advanceTimersByTimeAsync(5_000)
				})
				act(() => appendClineMessage(makeMessage(5, "retry"), 5, "task-1"))

				expect(postMessage).toHaveBeenCalledTimes(2)
				expect(postMessage).toHaveBeenLastCalledWith(
					expect.objectContaining({
						type: "requestClineMessagesResync",
						expectedSeq: 2,
						receivedSeq: 5,
					}),
				)
			} finally {
				postMessage.mockRestore()
				vi.useRealTimers()
			}
		})

		it("rejects malformed deltas and updates to unknown messages", () => {
			const first = makeMessage(1, "first")
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				renderTranscript({ clineMessages: [first], clineMessagesSeq: 1 })
				postMessage.mockClear()

				act(() => {
					dispatchExtensionMessage({ type: "clineMessageAppended", taskId: "task-1" })
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 1,
						snapshotId: "same-sequence",
						snapshotTotal: 1,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotChunk",
						taskId: "task-1",
						clineMessagesSeq: 1,
						snapshotId: "same-sequence",
						snapshotStartIndex: 0,
						clineMessages: [first],
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotEnd",
						taskId: "task-1",
						clineMessagesSeq: 1,
						snapshotId: "same-sequence",
						snapshotTotal: 1,
					})
					dispatchExtensionMessage({
						type: "clineMessageUpdated",
						taskId: "task-1",
						clineMessagesSeq: 2,
						clineMessage: makeMessage(99, "unknown"),
					})
				})

				expect(postMessage).toHaveBeenCalledTimes(2)
				expect(postMessage).toHaveBeenLastCalledWith(
					expect.objectContaining({ type: "requestClineMessagesResync", receivedSeq: 2 }),
				)
				expect(readTranscript().clineMessages).toEqual([first])
			} finally {
				postMessage.mockRestore()
			}
		})

		it("ignores covered and stale deltas but restarts after a newer delta interleaves", () => {
			const first = makeMessage(1, "first")
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				renderTranscript({ clineMessages: [first], clineMessagesSeq: 1 })
				postMessage.mockClear()

				act(() => {
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 4,
						snapshotId: "in-flight",
						snapshotTotal: 1,
					})
					appendClineMessage(makeMessage(4, "already covered"), 4, "task-1")
					appendClineMessage(makeMessage(5, "interleaved"), 5, "task-1")
					appendClineMessage(makeMessage(1, "stale"), 1, "task-1")
				})

				expect(postMessage).toHaveBeenCalledTimes(1)
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ type: "requestClineMessagesResync", receivedSeq: 5 }),
				)
				expect(readTranscriptFields()).toEqual({
					currentTaskId: "task-1",
					clineMessages: [first],
					clineMessagesSeq: 1,
				})
			} finally {
				postMessage.mockRestore()
			}
		})

		it("validates snapshot starts and ignores stale or duplicate starts", () => {
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				renderTranscript({ clineMessagesSeq: 1 })
				postMessage.mockClear()

				act(() => {
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "other-task",
						clineMessagesSeq: 2,
						snapshotId: "wrong-task",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: -1,
						snapshotId: "invalid-sequence",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 1,
						snapshotId: "stale",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 4,
						snapshotId: "newest",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 4,
						snapshotId: "newest",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 3,
						snapshotId: "older-active",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 5,
						snapshotId: "",
						snapshotTotal: -1,
					})
				})

				expect(postMessage).toHaveBeenCalledTimes(2)
				expect(postMessage.mock.calls.map(([message]) => message.receivedSeq)).toEqual([-1, 5])
			} finally {
				postMessage.mockRestore()
			}
		})

		it("rejects missing, mismatched, and incomplete snapshot chunks and endings", () => {
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				renderTranscript({ clineMessagesSeq: 1 })
				postMessage.mockClear()

				act(() => {
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotChunk",
						taskId: "other-task",
						clineMessagesSeq: 2,
						snapshotId: "ignored",
						snapshotStartIndex: 0,
						clineMessages: [makeMessage(1, "ignored")],
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotChunk",
						taskId: "task-1",
						clineMessagesSeq: 2,
						snapshotId: "missing-start",
						snapshotStartIndex: 0,
						clineMessages: [makeMessage(1, "missing")],
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 3,
						snapshotId: "chunk-check",
						snapshotTotal: 1,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotChunk",
						taskId: "task-1",
						clineMessagesSeq: 4,
						snapshotId: "newer-mismatch",
						snapshotStartIndex: 0,
						clineMessages: [makeMessage(1, "mismatch")],
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 5,
						snapshotId: "bad-chunk",
						snapshotTotal: 1,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotChunk",
						taskId: "task-1",
						clineMessagesSeq: 5,
						snapshotId: "bad-chunk",
						snapshotStartIndex: 1,
						clineMessages: [makeMessage(1, "bad index")],
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotEnd",
						taskId: "other-task",
						clineMessagesSeq: 6,
						snapshotId: "ignored-end",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotEnd",
						taskId: "task-1",
						clineMessagesSeq: 6,
						snapshotId: "missing-end-start",
						snapshotTotal: 0,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotStart",
						taskId: "task-1",
						clineMessagesSeq: 7,
						snapshotId: "incomplete",
						snapshotTotal: 1,
					})
					dispatchExtensionMessage({
						type: "clineMessagesSnapshotEnd",
						taskId: "task-1",
						clineMessagesSeq: 7,
						snapshotId: "incomplete",
						snapshotTotal: 1,
					})
				})

				expect(postMessage).toHaveBeenCalledTimes(5)
				expect(readTranscriptFields()).toEqual({
					currentTaskId: "task-1",
					clineMessages: [],
					clineMessagesSeq: 1,
				})
			} finally {
				postMessage.mockRestore()
			}
		})

		it("requests recovery for legacy unsequenced updates", () => {
			const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
			try {
				renderTranscript({ clineMessagesSeq: 2 })
				postMessage.mockClear()

				act(() => dispatchExtensionMessage({ type: "messageUpdated", clineMessagesSeq: 9 }))

				expect(postMessage).toHaveBeenCalledWith({
					type: "requestClineMessagesResync",
					taskId: "task-1",
					expectedSeq: 3,
					receivedSeq: 9,
				})
			} finally {
				postMessage.mockRestore()
			}
		})

		it("hydrates metadata, non-empty transcripts, and empty transcripts through shared helpers", () => {
			renderTranscript({ clineMessages: [makeMessage(1, "existing")], clineMessagesSeq: 1 })

			act(() => {
				hydrateExtensionState({ version: "2.0.0" })
			})
			expect(readTranscript().clineMessages).toEqual([makeMessage(1, "existing")])

			act(() => {
				hydrateExtensionState({
					currentTaskId: "task-1",
					clineMessages: [makeMessage(2, "hydrated")],
					clineMessagesSeq: 4,
				})
				appendClineMessage(makeMessage(3, "appended"), 5, "task-1")
			})
			expect(readTranscriptFields()).toEqual({
				currentTaskId: "task-1",
				clineMessages: [makeMessage(2, "hydrated"), makeMessage(3, "appended")],
				clineMessagesSeq: 5,
			})

			act(() => {
				hydrateExtensionState({ clineMessages: [] }, { taskId: "task-1", clineMessagesSeq: 6 })
			})
			expect(readTranscriptFields()).toEqual({ currentTaskId: "task-1", clineMessages: [], clineMessagesSeq: 6 })
		})
	})
})

describe("mergeExtensionState", () => {
	it("should correctly merge extension states", () => {
		const baseState: ExtensionState = {
			version: "",
			mcpEnabled: false,
			clineMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			enableCheckpoints: true,
			writeDelayMs: 1000,
			mode: "default",
			experiments: {} as Record<ExperimentId, boolean>,
			customModes: [],
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 100,
			apiConfiguration: { providerId: providerIdentifiers.openrouter } as ProviderSettings,
			telemetrySetting: "unset",
			showRooIgnoredFiles: true,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			cloudUserInfo: null,
			organizationAllowList: { allowAll: true, providers: {} },
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			cloudIsAuthenticated: false,
			sharingEnabled: false,
			publicSharingEnabled: false,
			profileThresholds: {},
			hasOpenedModeSelector: false, // Add the new required property
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			taskSyncEnabled: false,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, // Add the checkpoint timeout property
			maxReadFileLine: -1,
			diffFuzzyThreshold: DEFAULT_DIFF_FUZZY_THRESHOLD,
		}

		const prevState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxTokens: 1234, modelMaxThinkingTokens: 123 },
			experiments: {} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS - 5,
		}

		const newState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxThinkingTokens: 456, modelTemperature: 0.3 },
			experiments: {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
			} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS + 5,
		}

		const result = mergeExtensionState(prevState, newState)

		expect(result.apiConfiguration).toEqual({
			modelMaxThinkingTokens: 456,
			modelTemperature: 0.3,
		})

		expect(result.experiments).toEqual({
			preventFocusDisruption: false,
			imageGeneration: false,
			runSlashCommand: false,
			customTools: false,
		})
	})
})
