import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { ProcessSampler, runPowerShellProjection, sanitizeProcessProjection } from "../process-sampler.mjs"
import { evaluateSnapshotGates } from "../snapshot.mjs"
import { deterministicRandom, fakeClock } from "./fixtures.mjs"

test("process projection records only allowlisted scalars and rejects command lines", () => {
	const safe = sanitizeProcessProjection(
		{
			schemaVersion: 1,
			systemAvailableMemoryBytes: 8_000,
			processes: [
				{
					pid: 10,
					parentPid: 1,
					creationTimeUtc: "2026-08-28T18:00:00.000Z",
					role: "renderer",
					confidence: "strongCandidate",
					workingSetBytes: 100,
					privateBytes: 90,
					pagedBytes: 20,
					cpuTimeMs: 3,
					threadCount: 4,
					handleCount: 5,
					present: true,
				},
			],
		},
		10,
	)
	assert.equal(safe.processes[0].role, "browser")
	assert.equal(JSON.stringify(safe).includes("CommandLine"), false)
	assert.throws(
		() =>
			sanitizeProcessProjection(
				{
					schemaVersion: 1,
					processes: [
						{
							pid: 10,
							parentPid: 1,
							role: "renderer",
							confidence: "strongCandidate",
							present: true,
							commandLine: "PRIVATE_PATH",
						},
					],
				},
				10,
			),
		(error) => error.code === "processProjectionUnsafe",
	)
	assert.throws(
		() =>
			sanitizeProcessProjection(
				{ schemaVersion: 1, processes: [], systemAvailableMemoryBytes: 1, environment: "PRIVATE_ENV" },
				10,
			),
		(error) => error.code === "processProjectionMalformed",
	)
	const duplicate = {
		schemaVersion: 1,
		processes: [
			{ pid: 10, parentPid: 1, role: "browser", confidence: "exact", present: true },
			{ pid: 10, parentPid: 1, role: "browser", confidence: "exact", present: true },
		],
	}
	assert.throws(
		() => sanitizeProcessProjection(duplicate, 10),
		(error) => error.code === "processProjectionMalformed",
	)
})

test("process sampler emits disappearance and keeps role confidence under injected fixtures", async () => {
	const samples = [
		{
			systemAvailableMemoryBytes: 10_000,
			processes: [
				{
					pid: 10,
					parentPid: 1,
					creationTimeUtc: "2026-08-28T18:00:00.000Z",
					role: "browser",
					confidence: "exact",
					present: true,
					unavailable: [],
				},
				{
					pid: 11,
					parentPid: 10,
					creationTimeUtc: "2026-08-28T18:00:01.000Z",
					role: "gpu",
					confidence: "exact",
					present: true,
					unavailable: [],
				},
			],
		},
		{
			systemAvailableMemoryBytes: 9_000,
			processes: [
				{
					pid: 10,
					parentPid: 1,
					creationTimeUtc: "2026-08-28T18:00:00.000Z",
					role: "browser",
					confidence: "exact",
					present: true,
					unavailable: [],
				},
			],
		},
	]
	const sampler = new ProcessSampler({
		rootPid: 10,
		intervalMs: 5_000,
		commandLineRoleProbe: true,
		clock: fakeClock(),
		random: deterministicRandom,
		sampleProvider: async () => samples.shift(),
	})
	const disappeared = []
	sampler.on("disappeared", (value) => disappeared.push(value))
	await sampler.sample()
	await sampler.sample()
	assert.equal(disappeared[0].role, "gpu")
})

test("process sampler pins the root PID to its first creation time and rejects PID reuse", () => {
	const sampler = new ProcessSampler({
		rootPid: 10,
		intervalMs: 5_000,
		commandLineRoleProbe: true,
		clock: fakeClock(),
		random: deterministicRandom,
		sampleProvider: async () => ({ processes: [], systemAvailableMemoryBytes: null }),
	})
	const rootExit = []
	const samples = []
	sampler.on("rootExited", (value) => rootExit.push(value))
	sampler.on("sample", (value) => samples.push(value))
	const projection = (creationTimeUtc) => ({
		systemAvailableMemoryBytes: 10_000,
		processes: [
			{
				pid: 10,
				parentPid: 1,
				creationTimeUtc,
				role: "browser",
				confidence: "exact",
				present: true,
				unavailable: [],
			},
		],
	})
	sampler.acceptProjection(projection("2026-08-28T18:00:00.000Z"))
	sampler.acceptProjection(projection("2026-08-28T19:00:00.000Z"))
	assert.equal(samples.length, 1)
	assert.deepEqual(rootExit, [{ pid: 10, creationTimeUtc: "2026-08-28T18:00:00.000Z", reason: "pidReused" }])
})

test("process sampler bounds retained process epochs after processes disappear", () => {
	const sampler = new ProcessSampler({
		rootPid: 10,
		intervalMs: 5_000,
		commandLineRoleProbe: true,
		clock: fakeClock(),
		random: deterministicRandom,
		sampleProvider: async () => ({ processes: [], systemAvailableMemoryBytes: null }),
	})
	const root = {
		pid: 10,
		parentPid: 1,
		creationTimeUtc: "2026-08-28T18:00:00.000Z",
		role: "browser",
		confidence: "exact",
		present: true,
		unavailable: [],
	}
	for (let sample = 0; sample < 300; sample += 1) {
		sampler.acceptProjection({
			systemAvailableMemoryBytes: 10_000,
			processes: [
				root,
				{
					pid: 1_000 + sample,
					parentPid: 10,
					creationTimeUtc: new Date(Date.UTC(2026, 7, 28, 18, 0, sample)).toISOString(),
					role: "utility",
					confidence: "ambiguous",
					present: true,
					unavailable: [],
				},
			],
		})
	}
	assert.equal(sampler.epochs.size <= 256, true)
	assert.equal(sampler.epochs.has("10:2026-08-28T18:00:00.000Z"), true)
})

test("process sampler worker acknowledges records, reports drops, takes a final sample, and stops", async () => {
	class WorkerFixture extends EventEmitter {
		static instances = []

		constructor(url, options) {
			super()
			this.url = url
			this.options = options
			this.messages = []
			this.terminated = false
			WorkerFixture.instances.push(this)
		}

		postMessage(message) {
			this.messages.push(message)
			if (message.type === "stop") {
				queueMicrotask(() => {
					this.emit("message", {
						type: "projection",
						sequence: 7,
						payload: {
							systemAvailableMemoryBytes: 4096,
							processes: [
								{
									pid: 10,
									parentPid: 1,
									creationTimeUtc: "2026-08-28T18:00:00.000Z",
									role: "browser",
									confidence: "exact",
									present: true,
									unavailable: [],
								},
							],
						},
						droppedSamples: 3,
					})
					this.emit("message", { type: "stopped", sequence: 8, payload: {}, droppedSamples: 0 })
				})
			}
		}

		async terminate() {
			this.terminated = true
			return 0
		}
	}

	const sampler = new ProcessSampler({
		rootPid: 10,
		intervalMs: 2_000,
		commandLineRoleProbe: true,
		clock: fakeClock(),
		random: deterministicRandom,
		WorkerImpl: WorkerFixture,
	})
	const samples = []
	const drops = []
	sampler.on("sample", (sample) => samples.push(sample))
	sampler.on("dropped", (event) => drops.push(event.droppedCount))
	sampler.start()
	const worker = WorkerFixture.instances[0]
	assert.match(worker.url.href, /process-sampler-worker\.mjs$/)
	assert.equal(worker.options.workerData.timeoutMs, 1_900)
	await sampler.stop({ finalSample: true })
	assert.equal(
		worker.messages.some((message) => message.type === "stop" && message.finalSample),
		true,
	)
	assert.equal(
		worker.messages.some((message) => message.type === "ack" && message.sequence === 7),
		true,
	)
	assert.equal(
		worker.messages.some((message) => message.type === "ack" && message.sequence === 8),
		true,
	)
	assert.equal(worker.terminated, true)
	assert.equal(samples.length, 1)
	assert.deepEqual(drops, [3])
})

test("process sampler reports a worker crash once and restarts sampling", async () => {
	class WorkerFixture extends EventEmitter {
		static instances = []

		constructor() {
			super()
			this.messages = []
			WorkerFixture.instances.push(this)
		}

		postMessage(message) {
			this.messages.push(message)
			if (message.type === "stop") {
				queueMicrotask(() =>
					this.emit("message", { type: "stopped", sequence: 1, payload: {}, droppedSamples: 0 }),
				)
			}
		}

		async terminate() {
			return 0
		}
	}

	const sampler = new ProcessSampler({
		rootPid: 10,
		intervalMs: 2_000,
		commandLineRoleProbe: true,
		clock: fakeClock(),
		random: deterministicRandom,
		WorkerImpl: WorkerFixture,
	})
	const misses = []
	sampler.on("missed", (event) => misses.push(event))
	sampler.start()
	const first = WorkerFixture.instances[0]
	first.emit("error", new Error("fixture crash"))
	first.emit("exit", 1)
	await new Promise((resolve) => setImmediate(resolve))

	assert.equal(misses.length, 1)
	assert.equal(WorkerFixture.instances.length, 2)
	await sampler.stop({ finalSample: false })
})

test("PowerShell projection fails closed on timeout and malformed output", async () => {
	function childFixture({ output = "", closeCode = 0, neverCloses = false }) {
		const child = new EventEmitter()
		child.stdout = new EventEmitter()
		child.stdin = { end() {} }
		child.kill = () => {
			if (neverCloses) queueMicrotask(() => child.emit("close", 1))
		}
		queueMicrotask(() => {
			if (output) child.stdout.emit("data", Buffer.from(output))
			if (!neverCloses) child.emit("close", closeCode)
		})
		return child
	}
	await assert.rejects(
		runPowerShellProjection(
			{ rootPid: 10, inspectCommandLine: true, timeoutMs: 5 },
			{ spawn: () => childFixture({ neverCloses: true }) },
		),
		(error) => error.code === "processSampleTimedOut",
	)
	await assert.rejects(
		runPowerShellProjection(
			{ rootPid: 10, inspectCommandLine: true, timeoutMs: 100 },
			{ spawn: () => childFixture({ output: '{"schemaVersion":1,"processes":' }) },
		),
		(error) => error instanceof SyntaxError,
	)
})

test("snapshot gates cover disk, cooldown, concurrency-independent resources, and manual threshold override", async () => {
	const base = {
		trigger: "manual",
		usedJsHeapBytes: 512 * 1024 * 1024,
		jsHeapLimitBytes: 4 * 1024 * 1024 * 1024,
		availablePhysicalMemoryBytes: 8 * 1024 * 1024 * 1024,
		destinationDirectory: ".",
		heapCriticalRatio: 0.82,
		lastAttemptMonotonicMs: null,
		nowMonotonicMs: 10_000,
		cooldownMs: 60_000,
		overrideCooldown: false,
		successfulSnapshots: 0,
		maxSnapshots: 3,
	}
	assert.equal(
		(await evaluateSnapshotGates(base, { availableDiskBytes: async () => 20 * 1024 * 1024 * 1024 })).allowed,
		true,
	)
	assert.equal(
		(
			await evaluateSnapshotGates(
				{ ...base, trigger: "heapThreshold" },
				{ availableDiskBytes: async () => 20 * 1024 ** 3 },
			)
		).code,
		"heapRatioBelowThreshold",
	)
	assert.equal(
		(
			await evaluateSnapshotGates(
				{ ...base, lastAttemptMonotonicMs: 1 },
				{ availableDiskBytes: async () => 20 * 1024 ** 3 },
			)
		).code,
		"cooldownActive",
	)
	assert.equal(
		(await evaluateSnapshotGates(base, { availableDiskBytes: async () => 1 })).code,
		"diskHeadroomInsufficient",
	)
	assert.equal(
		(
			await evaluateSnapshotGates(
				{ ...base, availablePhysicalMemoryBytes: 1 },
				{ availableDiskBytes: async () => 20 * 1024 ** 3 },
			)
		).code,
		"physicalMemoryInsufficient",
	)
})
