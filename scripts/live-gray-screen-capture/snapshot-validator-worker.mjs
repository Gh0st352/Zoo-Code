import { parentPort, workerData } from "node:worker_threads"

import { validateHeapSnapshot } from "./snapshot-validator.mjs"

try {
	const result = await validateHeapSnapshot(workerData.filePath, workerData.options)
	parentPort.postMessage({ status: "completed", result })
} catch (error) {
	parentPort.postMessage({ status: "failed", code: error?.code ?? "validationFailed" })
}
