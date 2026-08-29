import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { readJsonBounded } from "../atomic-file.mjs"
import { ControlChannel, sendControlRequest } from "../control.mjs"
import { applyRetention, createEvidenceRun, EvidenceWriter, recoverIncompleteRuns } from "../evidence.mjs"
import { deterministicRandom, fakeClock } from "./fixtures.mjs"

async function tempDirectory() {
	return fs.mkdtemp(path.join(os.tmpdir(), "zoo-evidence-test-"))
}

test("evidence writer rotates bounded output and preserves monotonic record sequences", async () => {
	const root = await tempDirectory()
	try {
		const runDir = path.join(root, "run")
		await fs.mkdir(path.join(runDir, "events"), { recursive: true })
		await fs.mkdir(path.join(runDir, "metrics"), { recursive: true })
		const writer = new EvidenceWriter({
			runDir,
			maxRecordBytes: 8 * 1024,
			rotationBytes: 500,
			maxQueueRecords: 4,
			maxRunEvidenceBytes: 10_000,
		})
		for (let sequence = 1; sequence <= 12; sequence += 1) {
			await writer.write({
				schemaVersion: 1,
				runId: "a".repeat(20),
				recordSequence: sequence,
				utc: "2026-08-28T18:00:00.000Z",
				monotonicNs: String(sequence),
				source: "harness",
				recordType: "runStarted",
				browserEpoch: null,
				processEpoch: null,
				cdpConnectionEpoch: null,
				targetEpoch: null,
				rendererEpoch: null,
				capabilityState: "available",
				data: { status: "started" },
			})
		}
		await writer.close()
		const names = (await fs.readdir(path.join(runDir, "events"))).sort()
		assert.ok(names.length > 1)
		const records = []
		for (const name of names) {
			const lines = (await fs.readFile(path.join(runDir, "events", name), "utf8")).trim().split("\n")
			records.push(...lines.map(JSON.parse))
		}
		assert.deepEqual(
			records.map((record) => record.recordSequence),
			Array.from({ length: 12 }, (_, index) => index + 1),
		)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("evidence writer drops the oldest ordinary queued record before critical evidence", async () => {
	const root = await tempDirectory()
	try {
		const runDir = path.join(root, "run")
		await fs.mkdir(path.join(runDir, "events"), { recursive: true })
		await fs.mkdir(path.join(runDir, "metrics"), { recursive: true })
		const writer = new EvidenceWriter({
			runDir,
			maxRecordBytes: 8 * 1024,
			rotationBytes: 16_000,
			maxQueueRecords: 1,
			maxRunEvidenceBytes: 100_000,
		})
		const originalDrain = writer.drain.bind(writer)
		writer.drain = async () => {}
		const envelope = {
			schemaVersion: 1,
			runId: "a".repeat(20),
			utc: "2026-08-28T18:00:00.000Z",
			monotonicNs: "1",
			browserEpoch: null,
			processEpoch: null,
			cdpConnectionEpoch: null,
			targetEpoch: null,
			rendererEpoch: null,
			capabilityState: "available",
		}
		const ordinary = writer.write({
			...envelope,
			recordSequence: 1,
			source: "processSampler",
			recordType: "processMemory",
			data: {},
		})
		await new Promise((resolve) => setImmediate(resolve))
		const critical = writer.write({
			...envelope,
			recordSequence: 2,
			source: "harness",
			recordType: "runStopping",
			data: { reason: "controlRequest", diagnosticPause: false },
		})
		assert.equal(await ordinary, false)
		assert.equal(writer.status().droppedOrdinaryRecords, 1)
		writer.drain = originalDrain
		writer.draining = false
		writer.scheduleDrain()
		assert.equal(await critical, true)
		await writer.close()
		const text = await fs.readFile(path.join(runDir, "events", "events-000001.ndjson"), "utf8")
		assert.match(text, /"recordType":"runStopping"/)
		assert.equal(text.includes("processMemory"), false)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("evidence writer retries short writes and latches a no-progress failure", async () => {
	const root = await tempDirectory()
	try {
		const runDir = path.join(root, "run")
		await fs.mkdir(path.join(runDir, "events"), { recursive: true })
		await fs.mkdir(path.join(runDir, "metrics"), { recursive: true })
		const chunks = []
		let writeCount = 0
		const handle = {
			write: async (buffer, offset, length) => {
				writeCount += 1
				if (writeCount === 3) return { bytesWritten: 0 }
				const bytesWritten = Math.min(7, length)
				chunks.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)))
				return { bytesWritten }
			},
			sync: async () => {},
			close: async () => {},
		}
		const writer = new EvidenceWriter({
			runDir,
			maxRecordBytes: 8 * 1024,
			rotationBytes: 16_000,
			maxQueueRecords: 4,
			maxRunEvidenceBytes: 100_000,
			openFile: async () => handle,
		})
		const record = {
			schemaVersion: 1,
			runId: "a".repeat(20),
			recordSequence: 1,
			utc: "2026-08-28T18:00:00.000Z",
			monotonicNs: "1",
			source: "harness",
			recordType: "runStarted",
			browserEpoch: null,
			processEpoch: null,
			cdpConnectionEpoch: null,
			targetEpoch: null,
			rendererEpoch: null,
			capabilityState: "available",
			data: { status: "started" },
		}
		await assert.rejects(writer.write(record), (error) => error.code === "EVIDENCE_WRITE_FAILED")
		assert.equal(Buffer.concat(chunks).length > 7, true)
		await assert.rejects(
			writer.write({ ...record, recordSequence: 2 }),
			(error) => error.code === "EVIDENCE_WRITE_FAILED",
		)
		await assert.rejects(writer.close(), (error) => error.code === "EVIDENCE_WRITE_FAILED")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("evidence writer attempts to close every segment after a latched failure", async () => {
	const root = await tempDirectory()
	try {
		const runDir = path.join(root, "run")
		await fs.mkdir(path.join(runDir, "events"), { recursive: true })
		await fs.mkdir(path.join(runDir, "metrics"), { recursive: true })
		const writer = new EvidenceWriter({
			runDir,
			maxRecordBytes: 8 * 1024,
			rotationBytes: 16_000,
			maxQueueRecords: 4,
			maxRunEvidenceBytes: 100_000,
		})
		const closed = []
		for (const [name, segment] of Object.entries(writer.segments)) {
			segment.close = async () => {
				closed.push(name)
			}
		}
		writer.latchFailure(new Error("fixture failure"))
		await assert.rejects(writer.close(), (error) => error.code === "EVIDENCE_WRITE_FAILED")
		assert.deepEqual(closed.sort(), ["events", "processes", "renderer"])
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("manifest finalization is atomic and stale partial manifests recover", async () => {
	const root = await tempDirectory()
	try {
		const clock = fakeClock()
		const options = {
			command: "process",
			output: root,
			profileMode: undefined,
			rendererIntervalMs: 2_000,
			processIntervalMs: 5_000,
			heartbeatWarningMs: 5_000,
			heartbeatFailureMs: 10_000,
			heapWarningRatio: 0.7,
			heapCriticalRatio: 0.82,
			autoSnapshotEnabled: false,
			autoSnapshotSamples: 3,
			snapshotCooldownMs: 1_800_000,
			manifestIntervalMs: 30_000,
			rotationBytes: 16_000,
			maxRecordBytes: 8_192,
			maxQueueRecords: 256,
			retentionRuns: 10,
			retentionDays: 14,
			commandLineRoleProbe: true,
		}
		const identity = { harnessCreationTimeUtc: "2026-08-28T17:00:00.000Z" }
		const run = await createEvidenceRun(options, {
			clock,
			runId: "a".repeat(20),
			random: deterministicRandom,
			...identity,
		})
		await run.finalize({ outcome: "stopped", classification: "unknown" })
		assert.equal(await fs.stat(path.join(run.runDir, "manifest.json")).then(() => true), true)
		await assert.rejects(fs.stat(path.join(run.runDir, "manifest.partial.json")), /ENOENT/)

		const stale = await createEvidenceRun(options, {
			clock,
			runId: "b".repeat(20),
			random: deterministicRandom,
			...identity,
		})
		stale.manifest.harnessPid = 4_294_967_294
		await stale.updateState("capturing", { harnessPid: 4_294_967_294 })
		await stale.writer.close()
		const recovered = await recoverIncompleteRuns(root, {
			clock,
			inspectProcessIdentity: async () => ({ state: "absent", creationTimeUtc: null }),
		})
		assert.deepEqual(recovered, ["b".repeat(20)])
		const recoveredManifest = JSON.parse(await fs.readFile(path.join(stale.runDir, "manifest.json"), "utf8"))
		assert.equal(recoveredManifest.state, "incompleteRecovered")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("run-control files carry snapshot and stop requests without a daemon", async () => {
	const root = await tempDirectory()
	let channel
	try {
		const runDir = path.join(root, "run")
		await fs.mkdir(runDir)
		await fs.writeFile(path.join(runDir, "manifest.partial.json"), JSON.stringify({ runId: "c".repeat(20) }))
		const requests = []
		channel = await ControlChannel.create({
			runId: "c".repeat(20),
			harnessCreationTimeUtc: "2026-08-28T18:00:00.000Z",
			pollIntervalMs: 1,
			onRequest: async (request) => {
				requests.push(request)
				return { accepted: true }
			},
		})
		channel.start()
		const snapshot = await sendControlRequest(
			{
				command: "snapshot",
				runDir,
				targetOrdinal: 2,
				overrideCooldown: false,
				allowUnresponsiveAttempt: false,
				manualRiskAcknowledged: true,
			},
			{
				pollIntervalMs: 1,
				timeoutMs: 1_000,
				randomBytes: (size) => Buffer.alloc(size, 1),
				inspectProcessIdentity: async () => ({
					state: "present",
					creationTimeUtc: "2026-08-28T18:00:00.000Z",
				}),
			},
		)
		assert.equal(snapshot.accepted, true)
		assert.equal(requests[0].targetOrdinal, 2)
	} finally {
		await channel?.close()
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("control requests reject a descriptor whose PID was reused", async () => {
	const root = await tempDirectory()
	let channel
	try {
		const runDir = path.join(root, "run")
		await fs.mkdir(runDir)
		await fs.writeFile(path.join(runDir, "manifest.partial.json"), JSON.stringify({ runId: "d".repeat(20) }))
		channel = await ControlChannel.create({
			runId: "d".repeat(20),
			harnessCreationTimeUtc: "2026-08-28T18:00:00.000Z",
			onRequest: async () => ({ accepted: true }),
		})
		await assert.rejects(
			sendControlRequest(
				{ command: "stop", runDir, snapshotPolicy: "wait" },
				{
					inspectProcessIdentity: async () => ({
						state: "present",
						creationTimeUtc: "2026-08-28T19:00:00.000Z",
					}),
				},
			),
			(error) => error.code === "CONTROL_DESCRIPTOR_STALE",
		)
	} finally {
		await channel?.close()
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("control channel rejects a precreated request-directory reparse point", async (context) => {
	const runId = "e".repeat(20)
	const operationalDir = path.join(os.tmpdir(), "zoo-live-capture", runId)
	const outside = await tempDirectory()
	try {
		await fs.mkdir(operationalDir, { recursive: true })
		try {
			await fs.symlink(
				outside,
				path.join(operationalDir, "requests"),
				process.platform === "win32" ? "junction" : "dir",
			)
		} catch (error) {
			if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
				context.skip("Creating a directory reparse point is not permitted")
				return
			}
			throw error
		}
		await assert.rejects(
			ControlChannel.create({
				runId,
				harnessCreationTimeUtc: "2026-08-28T18:00:00.000Z",
				onRequest: async () => ({ accepted: true }),
			}),
			(error) => error.code === "CONTROL_PATH_UNSAFE",
		)
		assert.deepEqual(await fs.readdir(outside), [])
	} finally {
		await fs.rm(operationalDir, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	}
})

test("bounded JSON reads reject a regular-file reparse point", async (context) => {
	const root = await tempDirectory()
	try {
		const target = path.join(root, "target.json")
		const link = path.join(root, "link.json")
		await fs.writeFile(target, JSON.stringify({ accepted: true }))
		try {
			await fs.symlink(target, link, "file")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
				context.skip("Creating a file reparse point is not permitted")
				return
			}
			throw error
		}
		await assert.rejects(readJsonBounded(link), (error) => error.code === "JSON_INPUT_BOUNDS")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("control channel fails closed if its request directory is replaced after creation", async (context) => {
	const runId = "f".repeat(20)
	const operationalDir = path.join(os.tmpdir(), "zoo-live-capture", runId)
	const outside = await tempDirectory()
	let channel
	try {
		channel = await ControlChannel.create({
			runId,
			harnessCreationTimeUtc: "2026-08-28T18:00:00.000Z",
			onRequest: async () => ({ accepted: true }),
		})
		await fs.rm(path.join(operationalDir, "requests"), { recursive: true, force: true })
		try {
			await fs.symlink(
				outside,
				path.join(operationalDir, "requests"),
				process.platform === "win32" ? "junction" : "dir",
			)
		} catch (error) {
			if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
				context.skip("Creating a directory reparse point is not permitted")
				return
			}
			throw error
		}
		await assert.rejects(channel.poll(), (error) => error.code === "CONTROL_PATH_UNSAFE")
		assert.deepEqual(await fs.readdir(outside), [])
	} finally {
		await channel?.close({ removeOperationalState: false })
		await fs.rm(operationalDir, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	}
})

test("retention prunes only terminal runs and preserves active and incomplete evidence", async () => {
	const root = await tempDirectory()
	try {
		const terminal = path.join(root, "run-20260801T000000Z-aaaaaaaaaaaaaaaaaaaa")
		const active = path.join(root, "run-20260802T000000Z-bbbbbbbbbbbbbbbbbbbb")
		const incomplete = path.join(root, "run-20260803T000000Z-cccccccccccccccccccc")
		await Promise.all([terminal, active, incomplete].map((directory) => fs.mkdir(directory)))
		await fs.writeFile(
			path.join(terminal, "manifest.json"),
			JSON.stringify({ completedUtc: "2026-08-01T00:00:00.000Z" }),
		)
		await fs.writeFile(path.join(active, "manifest.partial.json"), JSON.stringify({ harnessPid: process.pid }))
		await fs.writeFile(path.join(incomplete, "opaque.bin"), "protected")
		const result = await applyRetention(
			root,
			{ retentionDays: 1, retentionRuns: 10 },
			{ nowMs: Date.parse("2026-08-28T00:00:00Z") },
		)
		assert.equal(result.pruned, 1)
		await assert.rejects(fs.stat(terminal), /ENOENT/)
		assert.equal((await fs.stat(active)).isDirectory(), true)
		assert.equal((await fs.stat(incomplete)).isDirectory(), true)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("retention fails closed on a run reparse point without touching its target", async (context) => {
	const root = await tempDirectory()
	const outside = await tempDirectory()
	try {
		const marker = path.join(outside, "user-marker.txt")
		await fs.writeFile(marker, "preserve")
		const link = path.join(root, "run-20260801T000000Z-aaaaaaaaaaaaaaaaaaaa")
		try {
			await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
				context.skip("Creating a directory reparse point is not permitted")
				return
			}
			throw error
		}
		await assert.rejects(
			applyRetention(root, { retentionDays: 1, retentionRuns: 1 }),
			(error) => error.code === "RETENTION_UNSAFE_ENTRY",
		)
		assert.equal(await fs.readFile(marker, "utf8"), "preserve")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	}
})
