import * as fs from "fs/promises"
import path from "path"
import type { HistoryItem } from "@roo-code/types"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import { safeWriteJson, type SafeWriteJsonOptions } from "../../utils/safeWriteJson"

/** File adapter only: keep the real store's authoritative reads, reducers and merge fences. */
export function installWebviewHistoryFiles() {
	const files = new Map<string, string>()
	const readFile = vi.mocked(fs.readFile).getMockImplementation()
	const writeJson = vi.mocked(safeWriteJson).getMockImplementation()
	const unlink = vi.mocked(fs.unlink).getMockImplementation()
	vi.mocked(fs.readFile).mockImplementation(async (file) => {
		const key = path.normalize(String(file))
		const contents = files.get(key)
		if (contents === undefined) throw Object.assign(new Error(`Missing test file: ${key}`), { code: "ENOENT" })
		return contents
	})
	vi.mocked(safeWriteJson).mockImplementation(async (file: string, data: unknown, options?: SafeWriteJsonOptions) => {
		const key = path.normalize(file)
		const contents = files.get(key)
		const existing: unknown = contents === undefined ? null : JSON.parse(contents)
		files.set(key, JSON.stringify(options?.merge ? options.merge(existing, data) : data))
	})
	vi.mocked(fs.unlink).mockImplementation(async (file) => {
		files.delete(path.normalize(String(file)))
	})
	return {
		seedHistory(storage: string, history: HistoryItem) {
			files.set(path.join(storage, "tasks", history.id, "history_item.json"), JSON.stringify(history))
		},
		restore() {
			if (readFile) vi.mocked(fs.readFile).mockImplementation(readFile)
			else vi.mocked(fs.readFile).mockReset()
			if (writeJson) vi.mocked(safeWriteJson).mockImplementation(writeJson)
			else vi.mocked(safeWriteJson).mockReset()
			if (unlink) vi.mocked(fs.unlink).mockImplementation(unlink)
			else vi.mocked(fs.unlink).mockReset()
		},
	}
}

/** Explicit new-task authority before construction; never adopt a token merely read from history. */
export async function claimWebviewHistory(provider: ClineProvider, history: HistoryItem) {
	const claim = await provider.taskHistoryStore.claimNewTask(
		history,
		provider.taskHistoryStore.ownerForRuntime(`runtime-${history.id}`),
	)
	if (claim.kind !== "applied") throw new Error(`Test claim refused: ${claim.reason}`)
	const token = Object.freeze({ ...claim.token, owner: Object.freeze({ ...claim.token.owner }) })
	provider["rememberExecution"](token)
	return { executionToken: token, startTask: false }
}
