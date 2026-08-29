import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { SnapshotCoordinator, validateInWorker, writeBufferFully } from "../snapshot.mjs"
import { deterministicRandom, fakeClock, minimalSnapshot } from "./fixtures.mjs"

async function fixture(overrides = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-snapshot-coordinator-"))
	const runDir = path.join(root, "run")
	await Promise.all([
		fs.mkdir(path.join(runDir, "snapshots"), { recursive: true }),
		fs.mkdir(path.join(runDir, "failures"), { recursive: true }),
	])
	const target = {
		ordinal: 1,
		sessionId: "session-fixture",
		epoch: "e-aaaaaaaaaaaaaaaa",
		rendererEpoch: "e-bbbbbbbbbbbbbbbb",
	}
	let listener = null
	let disconnectListener = null
	let abortCount = 0
	let releaseCommand
	const commandGate = new Promise((resolve) => {
		releaseCommand = resolve
	})
	const cdp = {
		resolveSnapshotTarget: () => target,
		latestMemory: () => ({ usedJsHeapBytes: 512 * 1024 * 1024, jsHeapLimitBytes: 4 * 1024 * 1024 * 1024 }),
		setDiagnosticPause: () => {},
		setSnapshotListener: (value) => {
			listener = value
		},
		setSnapshotDisconnectListener: (value) => {
			disconnectListener = value
		},
		abortSnapshot: () => {
			abortCount += 1
			disconnectListener?.("stopping")
			releaseCommand()
		},
		client: {
			command: async () => {
				if (overrides.waitForRelease) {
					await Promise.race([
						commandGate,
						new Promise((_, reject) => {
							disconnectListener = (code) => reject(Object.assign(new Error("Disconnected"), { code }))
						}),
					])
				}
				const text = minimalSnapshot()
				listener?.({
					method: "HeapProfiler.addHeapSnapshotChunk",
					sessionId: target.sessionId,
					params: { chunk: text.slice(0, 11) },
				})
				listener?.({
					method: "HeapProfiler.addHeapSnapshotChunk",
					sessionId: target.sessionId,
					params: { chunk: text.slice(11) },
				})
			},
		},
	}
	const records = []
	const manifests = []
	const coordinator = new SnapshotCoordinator({
		run: { runDir, manifest: { runId: "a".repeat(20) } },
		cdp,
		processSampler: { latestAvailableMemoryBytes: 8 * 1024 * 1024 * 1024 },
		clock: fakeClock(),
		options: { heapCriticalRatio: 0.82, snapshotCooldownMs: 60_000, validationTimeoutMs: 10_000 },
		onRecord: async (type, data) => records.push({ type, data }),
		onManifest: async (patch) => manifests.push(patch),
		dependencies: {
			availableDiskBytes: async () => 20 * 1024 * 1024 * 1024,
			currentProcessCreationTimeUtc: async () => "2026-08-28T16:00:00.000Z",
		},
	})
	return {
		root,
		runDir,
		coordinator,
		cdp,
		records,
		manifests,
		releaseCommand,
		disconnect: (code) => {
			disconnectListener?.(code)
			releaseCommand()
		},
		emitChunk: (chunk) =>
			listener?.({
				method: "HeapProfiler.addHeapSnapshotChunk",
				sessionId: target.sessionId,
				params: { chunk },
			}),
		abortCount: () => abortCount,
	}
}

test("snapshot coordinator streams, validates, and promotes only a complete snapshot", async () => {
	const context = await fixture()
	try {
		const syncedDirectories = []
		context.coordinator.dependencies.syncDirectory = async (directory) => syncedDirectories.push(directory)
		const result = await context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.equal(result.status, "completed")
		const names = await fs.readdir(path.join(context.runDir, "snapshots"))
		assert.equal(names.filter((name) => name.endsWith(".heapsnapshot")).length, 1)
		assert.equal(names.filter((name) => name.endsWith(".tmp") || name === "snapshot.lock").length, 0)
		const sidecarName = names.find((name) => name.endsWith(".json"))
		const sidecar = JSON.parse(await fs.readFile(path.join(context.runDir, "snapshots", sidecarName), "utf8"))
		assert.equal(sidecar.privateArtifact, true)
		assert.equal(typeof sidecar.sha256, "string")
		assert.deepEqual(syncedDirectories, [
			path.join(context.runDir, "snapshots"),
			path.join(context.runDir, "snapshots"),
		])
		assert.deepEqual(
			context.records.map((entry) => entry.type),
			["snapshotStarted", "snapshotCompleted"],
		)
	} finally {
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator rejects concurrent work and actively aborts without promotion", async () => {
	const context = await fixture({ waitForRelease: true })
	try {
		const first = context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		while (!context.coordinator.active) await new Promise((resolve) => setImmediate(resolve))
		const second = await context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.deepEqual(second, { status: "rejected", code: "snapshotBusy" })
		await context.coordinator.stop("abort")
		context.releaseCommand()
		assert.deepEqual(await first, { status: "failed", code: "stopping" })
		const names = await fs.readdir(path.join(context.runDir, "snapshots"))
		assert.equal(
			names.some((name) => name.endsWith(".heapsnapshot")),
			false,
		)
		assert.equal(
			names.some((name) => name.endsWith(".tmp")),
			false,
		)
	} finally {
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator reserves its in-process mutex before asynchronous preflight gates", async () => {
	const context = await fixture()
	let releaseGate
	let gateCalls = 0
	const gate = new Promise((resolve) => {
		releaseGate = resolve
	})
	context.coordinator.dependencies.availableDiskBytes = async () => {
		gateCalls += 1
		await gate
		return 20 * 1024 * 1024 * 1024
	}
	try {
		const first = context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		while (gateCalls === 0) await new Promise((resolve) => setImmediate(resolve))
		const second = await context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.deepEqual(second, { status: "rejected", code: "snapshotBusy" })
		assert.equal(gateCalls, 1)
		releaseGate()
		assert.equal((await first).status, "completed")
	} finally {
		releaseGate?.()
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot stream failure stops its pinned CDP producer before cleanup", async () => {
	const context = await fixture({ waitForRelease: true })
	try {
		const request = context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		while (!context.coordinator.abortActive) await new Promise((resolve) => setImmediate(resolve))
		context.emitChunk("x".repeat(16 * 1024 * 1024 + 1))
		assert.deepEqual(await request, { status: "failed", code: "chunkTooLarge" })
		assert.equal(context.abortCount(), 1)
		assert.equal((await fs.readdir(path.join(context.runDir, "snapshots"))).length, 0)
	} finally {
		context.releaseCommand()
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator treats CDP loss as a scalar failure and removes partial bytes", async () => {
	const context = await fixture({ waitForRelease: true })
	try {
		const request = context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		const resultPromise = request.then((value) => value)
		while (!context.coordinator.abortActive) await new Promise((resolve) => setImmediate(resolve))
		context.disconnect("cdpConnectionLost")
		assert.deepEqual(await resultPromise, { status: "failed", code: "cdpConnectionLost" })
		context.releaseCommand()
		assert.equal((await fs.readdir(path.join(context.runDir, "snapshots"))).length, 0)
		const failure = JSON.parse(
			await fs.readFile(path.join(context.runDir, "failures", "snapshot-001.json"), "utf8"),
		)
		assert.equal(failure.code, "cdpConnectionLost")
		assert.equal(Object.hasOwn(failure, "sha256"), false)
	} finally {
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator recovers a well-formed stale lock but preserves an active lock", async () => {
	const stale = await fixture()
	try {
		const lockPath = path.join(stale.runDir, "snapshots", "snapshot.lock")
		await fs.writeFile(
			lockPath,
			`schema=1\nrun=${"a".repeat(20)}\npid=999999\nprocessCreated=2026-08-28T16:00:00.000Z\nattempt=4\nstarted=2026-08-28T17:00:00.000Z\n`,
		)
		stale.coordinator.dependencies.inspectProcessIdentity = async () => ({ state: "absent", creationTimeUtc: null })
		const result = await stale.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.equal(result.status, "completed")
		assert.equal((await fs.readdir(path.join(stale.runDir, "snapshots"))).includes("snapshot.lock"), false)
	} finally {
		await fs.rm(stale.root, { recursive: true, force: true })
	}

	const active = await fixture()
	try {
		const lockPath = path.join(active.runDir, "snapshots", "snapshot.lock")
		await fs.writeFile(
			lockPath,
			`schema=1\nrun=${"a".repeat(20)}\npid=${process.pid}\nprocessCreated=2026-08-28T16:00:00.000Z\nattempt=4\nstarted=2026-08-28T17:00:00.000Z\n`,
		)
		active.coordinator.dependencies.inspectProcessIdentity = async () => ({
			state: "present",
			creationTimeUtc: "2026-08-28T16:00:00.000Z",
		})
		const result = await active.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.deepEqual(result, { status: "failed", code: "lockUnavailable" })
		assert.equal((await fs.readFile(lockPath, "utf8")).includes(`pid=${process.pid}`), true)
	} finally {
		await fs.rm(active.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator preserves a stale lock that changes during identity inspection", async () => {
	const context = await fixture()
	context.coordinator.dependencies.inspectProcessIdentity = async () => {
		await fs.appendFile(path.join(context.runDir, "snapshots", "snapshot.lock"), "changed=true\n")
		return { state: "absent", creationTimeUtc: null }
	}
	try {
		const lockPath = path.join(context.runDir, "snapshots", "snapshot.lock")
		await fs.writeFile(
			lockPath,
			"schema=1\nrun=aaaaaaaaaaaaaaaaaaaa\npid=999999\nprocessCreated=2026-08-28T17:00:00.000Z\nattempt=1\nstarted=2026-08-28T18:00:00.000Z\n",
		)
		assert.equal(await context.coordinator.removeStaleLock(lockPath), false)
		assert.equal((await fs.readFile(lockPath, "utf8")).includes("changed=true"), true)
	} finally {
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator removes temporary bytes and records an atomic promotion failure", async () => {
	const context = await fixture()
	try {
		context.coordinator.dependencies.rename = async () => {
			throw Object.assign(new Error("rename failed"), { code: "EACCES" })
		}
		const result = await context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.deepEqual(result, { status: "failed", code: "promotionFailed" })
		const names = await fs.readdir(path.join(context.runDir, "snapshots"))
		assert.equal(
			names.some((name) => name.endsWith(".tmp") || name.endsWith(".heapsnapshot")),
			false,
		)
		const failure = JSON.parse(
			await fs.readFile(path.join(context.runDir, "failures", "snapshot-001.json"), "utf8"),
		)
		assert.equal(failure.stage, "promoting")
		assert.equal(failure.code, "promotionFailed")
	} finally {
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator removes a promoted snapshot if sidecar finalization fails", async () => {
	const context = await fixture()
	try {
		context.coordinator.dependencies.writeJsonAtomic = async (filePath, value) => {
			if (path.dirname(filePath).endsWith("snapshots")) {
				throw Object.assign(new Error("sidecar failed"), { code: "EIO" })
			}
			await fs.writeFile(filePath, `${JSON.stringify(value)}\n`)
		}
		const result = await context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.deepEqual(result, { status: "failed", code: "promotionFailed" })
		const names = await fs.readdir(path.join(context.runDir, "snapshots"))
		assert.equal(
			names.some((name) => name.endsWith(".heapsnapshot") || name.endsWith(".json")),
			false,
		)
	} finally {
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot coordinator removes a durable pending sidecar if final sidecar rename fails", async () => {
	const context = await fixture()
	try {
		const rename = fs.rename.bind(fs)
		context.coordinator.dependencies.rename = async (source, destination) => {
			if (source.endsWith(".json.pending")) {
				throw Object.assign(new Error("sidecar rename failed"), { code: "EIO" })
			}
			await rename(source, destination)
		}
		const result = await context.coordinator.request({ reason: "manual", manualRiskAcknowledged: true })
		assert.deepEqual(result, { status: "failed", code: "promotionFailed" })
		const names = await fs.readdir(path.join(context.runDir, "snapshots"))
		assert.equal(
			names.some((name) => name.endsWith(".heapsnapshot") || name.endsWith(".pending")),
			false,
		)
	} finally {
		await fs.rm(context.root, { recursive: true, force: true })
	}
})

test("snapshot validator worker rejects an unexpected exit without waiting for its timeout", async () => {
	class ExitingWorker extends EventEmitter {
		constructor() {
			super()
			queueMicrotask(() => this.emit("exit", 1))
		}
		terminate() {
			return Promise.resolve(1)
		}
	}
	await assert.rejects(
		validateInWorker("unused", { timeoutMs: 10_000 }, { WorkerImpl: ExitingWorker }),
		(error) => error.code === "validationWorkerFailed",
	)
})

test("snapshot validator worker uses an explicit memory ceiling", async () => {
	let workerOptions
	class WorkerFixture extends EventEmitter {
		constructor(_url, options) {
			super()
			workerOptions = options
			queueMicrotask(() => this.emit("message", { status: "failed", code: "validationFailed" }))
		}

		terminate() {
			return Promise.resolve(0)
		}
	}
	await assert.rejects(validateInWorker("fixture", {}, { WorkerImpl: WorkerFixture }))
	assert.deepEqual(workerOptions.resourceLimits, {
		maxOldGenerationSizeMb: 128,
		maxYoungGenerationSizeMb: 16,
		stackSizeMb: 4,
	})
})

test("snapshot writes retry short writes and reject a zero-progress write", async () => {
	const observed = []
	const handle = {
		write: async (buffer, offset, length) => {
			const bytesWritten = Math.min(2, length)
			observed.push(buffer.subarray(offset, offset + bytesWritten).toString("utf8"))
			return { bytesWritten }
		},
	}
	await writeBufferFully(handle, Buffer.from("abcdef"))
	assert.equal(observed.join(""), "abcdef")
	await assert.rejects(
		writeBufferFully({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from("x")),
		(error) => error.code === "writeFailed",
	)
})
