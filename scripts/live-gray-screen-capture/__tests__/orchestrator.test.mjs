import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { DEFAULTS } from "../constants.mjs"
import { CaptureOrchestrator } from "../run.mjs"
import { deterministicRandom, fakeClock } from "./fixtures.mjs"

class ProcessSamplerFixture extends EventEmitter {
	constructor(rootPid) {
		super()
		this.rootPid = rootPid
		this.started = false
		this.stopped = false
		this.latestAvailableMemoryBytes = 8 * 1024 ** 3
	}

	start() {
		this.started = true
		queueMicrotask(() =>
			this.emit("sample", {
				pid: this.rootPid,
				parentPid: 1,
				creationTimeUtc: "2026-08-28T18:00:00.000Z",
				role: "browser",
				confidence: "exact",
				workingSetBytes: 1024,
				privateBytes: 768,
				pagedBytes: 512,
				cpuTimeMs: 4,
				threadCount: 2,
				handleCount: 3,
				present: true,
				systemAvailableMemoryBytes: this.latestAvailableMemoryBytes,
				unavailable: [],
				processEpoch: "e-aaaaaaaaaaaaaaaa",
			}),
		)
	}

	async stop({ finalSample }) {
		this.stopped = finalSample
	}
}

function processOptions(output, overrides = {}) {
	return {
		command: "process",
		output,
		pid: 1234,
		processIntervalMs: 5_000,
		manifestIntervalMs: 60_000,
		retentionRuns: 5,
		retentionDays: 7,
		commandLineRoleProbe: true,
		durationMs: null,
		rotationBytes: DEFAULTS.rotationBytes,
		maxRecordBytes: DEFAULTS.maxRecordBytes,
		maxQueueRecords: DEFAULTS.maxQueueRecords,
		rendererIntervalMs: DEFAULTS.rendererIntervalMs,
		heartbeatWarningMs: DEFAULTS.heartbeatWarningMs,
		heartbeatFailureMs: DEFAULTS.heartbeatFailureMs,
		heapWarningRatio: DEFAULTS.heapWarningRatio,
		heapCriticalRatio: DEFAULTS.heapCriticalRatio,
		autoSnapshotEnabled: false,
		...overrides,
	}
}

test("process-only orchestrator captures scalar evidence and finalizes gracefully", async () => {
	const output = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-orchestrator-"))
	const clock = fakeClock()
	let sampler
	const options = processOptions(output)
	const orchestrator = new CaptureOrchestrator(options, {
		clock,
		random: deterministicRandom,
		harnessCreationTimeUtc: "2026-08-28T17:00:00.000Z",
		processSamplerFactory: (rootPid) => {
			sampler = new ProcessSamplerFixture(rootPid)
			return sampler
		},
	})
	try {
		const capture = orchestrator.start()
		while (orchestrator.run?.manifest.state !== "capturing") await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))
		orchestrator.requestStop("controlRequest")
		const result = await capture

		assert.equal(result.exitCode, 0)
		assert.equal(result.outcome, "stopped")
		assert.equal(sampler.started, true)
		assert.equal(sampler.stopped, true)
		const manifest = JSON.parse(await fs.readFile(path.join(result.runDir, "manifest.json"), "utf8"))
		assert.equal(manifest.state, "completed")
		assert.equal(manifest.captureOutcome, "stopped")
		await assert.rejects(
			fs.stat(path.join(result.runDir, "manifest.partial.json")),
			(error) => error.code === "ENOENT",
		)
		const eventText = await fs.readFile(path.join(result.runDir, "events", "events-000001.ndjson"), "utf8")
		const processText = await fs.readFile(path.join(result.runDir, "metrics", "processes-000001.ndjson"), "utf8")
		assert.match(eventText, /"recordType":"runStarted"/)
		assert.match(eventText, /"recordType":"runStopping"/)
		assert.match(eventText, /"recordType":"runFinalized"/)
		assert.match(processText, /"recordType":"processMemory"/)
		const forbidden = [
			"PRIVATE_POISON",
			"PRIVATE_TITLE_POISON",
			"URL_POISON",
			"PRIVATE_TRANSCRIPT_POISON",
			"C:\\Users\\Private\\workspace",
			"https://private.invalid/?secret=1",
		]
		let evidenceBytes = 0
		let evidenceFiles = 0
		const retainedText = []
		async function measure(directory) {
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				const target = path.join(directory, entry.name)
				if (entry.isDirectory()) await measure(target)
				else {
					evidenceBytes += (await fs.stat(target)).size
					evidenceFiles += 1
					if (!entry.name.endsWith(".heapsnapshot")) retainedText.push(await fs.readFile(target, "utf8"))
				}
			}
		}
		await measure(result.runDir)
		for (const poison of forbidden) assert.equal(retainedText.join("\n").includes(poison), false)
		assert.ok(evidenceBytes > 0 && evidenceBytes < 64 * 1024)
		assert.ok(evidenceFiles >= 5)
	} finally {
		await fs.rm(output, { recursive: true, force: true })
	}
})

test("repeated synthetic process captures remain bounded and clean up listeners", async () => {
	const output = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-orchestrator-soak-"))
	const baselineListeners = process.listenerCount("zoo-live-capture-stop")
	const baselineHandles = process._getActiveHandles().length
	const rssSamples = []
	const iterations = 20
	try {
		for (let iteration = 0; iteration < iterations; iteration += 1) {
			const orchestrator = new CaptureOrchestrator(processOptions(output), {
				clock: fakeClock(new Date(Date.parse("2026-08-28T18:00:00.000Z") + iteration * 1_000).toISOString()),
				random: (size) => Buffer.alloc(size, iteration + 1),
				harnessCreationTimeUtc: "2026-08-28T17:00:00.000Z",
				processSamplerFactory: (rootPid) => new ProcessSamplerFixture(rootPid),
			})
			const capture = orchestrator.start()
			while (orchestrator.run?.manifest.state !== "capturing")
				await new Promise((resolve) => setImmediate(resolve))
			await new Promise((resolve) => setImmediate(resolve))
			orchestrator.requestStop("controlRequest")
			const result = await capture
			assert.equal(result.exitCode, 0)
			assert.equal(orchestrator.pendingWrites.size, 0)
			assert.equal(orchestrator.control.closed, true)
			await fs.rm(orchestrator.control.operationalDir, { recursive: true, force: true })
			rssSamples.push(process.memoryUsage().rss)
		}
		const runNames = (await fs.readdir(output)).filter((name) => name.startsWith("run-"))
		assert.ok(runNames.length <= 6)
		assert.equal(process.listenerCount("zoo-live-capture-stop"), baselineListeners)
		assert.ok(process._getActiveHandles().length <= baselineHandles + 2)
		const steadyState = rssSamples.slice(5)
		assert.ok(Math.max(...steadyState) - Math.min(...steadyState) < 64 * 1024 * 1024)
	} finally {
		await fs.rm(output, { recursive: true, force: true })
	}
})

test("orchestrator terminates a launched child when startup fails", async () => {
	const output = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-orchestrator-fail-"))
	const child = new EventEmitter()
	let terminated = 0
	const options = {
		command: "launch",
		output,
		profileMode: "isolated",
		processIntervalMs: 5_000,
		manifestIntervalMs: 60_000,
		retentionRuns: 5,
		retentionDays: 7,
		commandLineRoleProbe: true,
		durationMs: null,
		rotationBytes: DEFAULTS.rotationBytes,
		maxRecordBytes: DEFAULTS.maxRecordBytes,
		maxQueueRecords: DEFAULTS.maxQueueRecords,
		rendererIntervalMs: DEFAULTS.rendererIntervalMs,
		heartbeatWarningMs: DEFAULTS.heartbeatWarningMs,
		heartbeatFailureMs: DEFAULTS.heartbeatFailureMs,
		heapWarningRatio: DEFAULTS.heapWarningRatio,
		heapCriticalRatio: DEFAULTS.heapCriticalRatio,
		autoSnapshotEnabled: false,
	}
	const orchestrator = new CaptureOrchestrator(options, {
		clock: fakeClock(),
		random: deterministicRandom,
		harnessCreationTimeUtc: "2026-08-28T17:00:00.000Z",
		launchVsCode: async () => ({ child, rootPid: 1234, cdpPort: 9333 }),
		processSamplerFactory: (rootPid) => new ProcessSamplerFixture(rootPid),
		cdpCollectorFactory: () => ({
			connect: async () => {
				throw Object.assign(new Error("fixture failure"), { code: "webSocketClosed" })
			},
			stop: async () => {},
		}),
		terminateDedicatedChild: async (candidate) => {
			assert.equal(candidate, child)
			terminated += 1
		},
	})
	try {
		await assert.rejects(orchestrator.start(), (error) => error.code === "webSocketClosed")
		await assert.rejects(
			orchestrator.fail(Object.assign(new Error("fixture failure"), { code: "webSocketClosed" })),
		)
		assert.equal(terminated, 1)
	} finally {
		await fs.rm(output, { recursive: true, force: true })
	}
})

test("signal stop finalizes as interrupted with exit code 130", async () => {
	const output = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-orchestrator-signal-"))
	const options = processOptions(output)
	const orchestrator = new CaptureOrchestrator(options, {
		clock: fakeClock(),
		random: deterministicRandom,
		harnessCreationTimeUtc: "2026-08-28T17:00:00.000Z",
		processSamplerFactory: (rootPid) => new ProcessSamplerFixture(rootPid),
	})
	try {
		const capture = orchestrator.start()
		while (orchestrator.run?.manifest.state !== "capturing") await new Promise((resolve) => setImmediate(resolve))
		orchestrator.requestStop("signal")
		const result = await capture
		assert.equal(result.exitCode, 130)
		assert.equal(result.outcome, "interrupted")
		const manifest = JSON.parse(await fs.readFile(path.join(result.runDir, "manifest.json"), "utf8"))
		assert.equal(manifest.captureOutcome, "interrupted")
	} finally {
		await fs.rm(output, { recursive: true, force: true })
	}
})

test("orchestrator classifies only destruction of the selected renderer as renderer termination", async () => {
	const orchestrator = new CaptureOrchestrator({ command: "attach" })
	orchestrator.run = {
		makeRecord: (record) => record,
		writer: { write: async () => {} },
	}

	await orchestrator.writeRecord(
		"targetDestroyed",
		{ targetOrdinal: 2, reason: "targetDestroyed" },
		{ selectedRenderer: false },
	)
	assert.equal(orchestrator.state.targetDestroyed, false)

	await orchestrator.writeRecord(
		"targetDestroyed",
		{ targetOrdinal: 1, reason: "targetDestroyed" },
		{ selectedRenderer: true },
	)
	assert.equal(orchestrator.state.targetDestroyed, true)
})

test("orchestrator awaits queued records and preserves the root PID reuse reason", async () => {
	const orchestrator = new CaptureOrchestrator({ command: "process" })
	let releaseWrite
	const blockedWrite = new Promise((resolve) => {
		releaseWrite = resolve
	})
	const records = []
	orchestrator.run = {
		makeRecord: (record) => record,
		writer: {
			write: async (record) => {
				records.push(record)
				await blockedWrite
			},
		},
	}
	orchestrator.queueRecord("browserProcessExited", { pid: 1234, reason: "pidReused" })
	let idle = false
	const wait = orchestrator.waitForPendingWrites().then(() => {
		idle = true
	})
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(idle, false)
	assert.equal(records[0].data.reason, "pidReused")
	releaseWrite()
	await wait
	assert.equal(idle, true)
})

test("orchestrator turns an asynchronous manifest heartbeat failure into a bounded capture stop", async () => {
	const orchestrator = new CaptureOrchestrator({ command: "process" })
	orchestrator.run = {
		heartbeat: async () => {
			throw Object.assign(new Error("fixture heartbeat failure"), { code: "EVIDENCE_WRITE_FAILED" })
		},
	}
	orchestrator.queueManifestHeartbeat()
	while (!orchestrator.stopping) await new Promise((resolve) => setImmediate(resolve))
	assert.equal(orchestrator.stopReason, "captureFailure")
	await assert.rejects(orchestrator.waitForPendingWrites(), (error) => error.code === "EVIDENCE_WRITE_FAILED")
})
