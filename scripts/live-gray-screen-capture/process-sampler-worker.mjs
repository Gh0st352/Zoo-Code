import { parentPort, workerData } from "node:worker_threads"

import { runPowerShellProjection } from "./process-sampler.mjs"

const MAX_QUEUE = 256
let timer = null
let inFlight = false
let stopping = false
let awaitingSequence = null
let nextSequence = 1
let droppedSamples = 0
const queue = []

function enqueue(type, payload, critical = false) {
	if (queue.length >= MAX_QUEUE) {
		const ordinaryIndex = queue.findIndex((entry) => entry.type === "projection")
		if (ordinaryIndex !== -1) {
			queue.splice(ordinaryIndex, 1)
			droppedSamples += 1
		} else {
			droppedSamples += 1
			if (critical) queue.shift()
			else return
		}
	}
	queue.push({ type, payload, critical })
	drain()
}

function drain() {
	if (awaitingSequence !== null || queue.length === 0) return
	const entry = queue.shift()
	const sequence = nextSequence++
	awaitingSequence = sequence
	parentPort.postMessage({
		type: entry.type,
		sequence,
		payload: entry.payload,
		droppedSamples,
	})
	droppedSamples = 0
}

async function sample() {
	if (inFlight || stopping) return
	inFlight = true
	try {
		const result = await runPowerShellProjection({
			rootPid: workerData.rootPid,
			inspectCommandLine: workerData.commandLineRoleProbe,
			timeoutMs: workerData.timeoutMs,
		})
		enqueue("projection", result)
	} catch (error) {
		const code =
			typeof error?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(error.code)
				? error.code
				: "processSampleFailed"
		enqueue("sampleError", { code }, true)
	} finally {
		inFlight = false
	}
}

async function stop(finalSample) {
	if (stopping) return
	stopping = true
	clearInterval(timer)
	while (inFlight) await new Promise((resolve) => setImmediate(resolve))
	if (finalSample) {
		stopping = false
		await sample()
		stopping = true
	}
	enqueue("stopped", {}, true)
}

parentPort.on("message", (message) => {
	if (message?.type === "ack" && message.sequence === awaitingSequence) {
		awaitingSequence = null
		drain()
	} else if (message?.type === "sampleNow") {
		void sample()
	} else if (message?.type === "stop") {
		void stop(message.finalSample === true)
	}
})

timer = setInterval(() => void sample(), workerData.intervalMs)
timer.unref?.()
void sample()
