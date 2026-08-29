import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { parseArgs, UsageError } from "../args.mjs"
import { validateLoopbackEndpoint } from "../cdp-client.mjs"
import { assertSafeOutputRoot, verifyWindowsFixedDrive } from "../path-safety.mjs"
import { createRecordFactory } from "../records.mjs"
import { deterministicRandom, fakeClock } from "./fixtures.mjs"

test("CLI validates required options, bounds, conflicts, and snapshot acknowledgement", () => {
	assert.throws(() => parseArgs(["attach", "--cdp-port", "0"]), UsageError)
	assert.throws(() => parseArgs(["process", "--pid", "-1"]), UsageError)
	assert.throws(
		() =>
			parseArgs([
				"launch",
				"--extension-development-path",
				".",
				"--heap-warning-ratio",
				"0.9",
				"--heap-critical-ratio",
				"0.8",
			]),
		/Heap warning ratio/,
	)
	assert.throws(() => parseArgs(["snapshot", "--run-dir", "."]), /acknowledge-manual-snapshot-risk/)
	const snapshot = parseArgs(["snapshot", "--run-dir", ".", "--acknowledge-manual-snapshot-risk"])
	assert.equal(snapshot.manualRiskAcknowledged, true)
})

test("launch passthrough rejects arguments that can override harness security boundaries", () => {
	const base = ["launch", "--extension-development-path", "."]
	for (const protectedArguments of [
		["--remote-debugging-address=0.0.0.0"],
		["--REMOTE-DEBUGGING-PORT", "9333"],
		["--user-data-dir=shared-profile"],
		["--extensions-dir", "shared-extensions"],
		["--extensionDevelopmentPath=other-extension"],
		["--inspect=127.0.0.1:9229"],
		["--js-flags=--expose-gc"],
		["--proxy-server=http://private.invalid"],
	]) {
		assert.throws(
			() => parseArgs([...base, "--", ...protectedArguments]),
			(error) => error instanceof UsageError && error.code === "protectedPassthroughArgument",
		)
	}

	const parsed = parseArgs([...base, "--", "--new-window"])
	assert.deepEqual(parsed.passthrough, ["--new-window"])
})

test("loopback endpoint enforcement rejects hostnames, remote IPs, credentials, query, and fragments", () => {
	for (const value of [
		"http://localhost:9222/",
		"http://192.168.1.2:9222/",
		"http://user:pass@127.0.0.1:9222/",
		"http://127.0.0.1:9222/?token=private",
		"http://127.0.0.1:9222/#private",
		"https://127.0.0.1:9222/",
	]) {
		assert.throws(() => validateLoopbackEndpoint(value), /loopback/i)
	}
	assert.equal(validateLoopbackEndpoint("http://127.0.0.2:9222/").hostname, "127.0.0.2")
	assert.equal(validateLoopbackEndpoint("http://[::1]:9222/").port, "9222")
})

test("record constructors reject privacy-poison and arbitrary fields", () => {
	const makeRecord = createRecordFactory({ runId: "a".repeat(20), clock: fakeClock(), random: deterministicRandom })
	assert.throws(
		() =>
			makeRecord({
				source: "cdp",
				recordType: "targetCreated",
				data: { targetOrdinal: 1, targetType: "page", title: "PRIVATE_TITLE", url: "https://private.invalid" },
			}),
		/forbidden field/,
	)
	assert.throws(
		() =>
			makeRecord({
				source: "cdp",
				recordType: "runtimeException",
				data: { targetOrdinal: 1, category: "exception", uncaught: true, message: "PRIVATE_EXCEPTION" },
			}),
		/forbidden field/,
	)
})

test("output path guard rejects .git, UNC, and operational-state overlap", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-path-safety-"))
	try {
		await assert.rejects(
			assertSafeOutputRoot(path.join(root, ".git", "evidence")),
			(error) => error.code === "OUTPUT_PATH_UNSAFE",
		)
		await assert.rejects(
			assertSafeOutputRoot("\\\\server\\share\\evidence"),
			(error) => error.code === "OUTPUT_PATH_UNSAFE",
		)
		await assert.rejects(
			assertSafeOutputRoot(path.join(root, "operational", "evidence"), {
				forbiddenRoots: [path.join(root, "operational")],
			}),
			(error) => error.code === "OUTPUT_PATH_UNSAFE",
		)
		assert.equal(
			(
				await fs.stat(await assertSafeOutputRoot(path.join(root, "safe"), { verifyFixedDrive: async () => {} }))
			).isDirectory(),
			true,
		)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("output path guard fails closed on symlink or junction traversal", async (context) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-path-reparse-"))
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-path-outside-"))
	try {
		const link = path.join(root, "linked-output")
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
			assertSafeOutputRoot(path.join(link, "evidence"), { verifyFixedDrive: async () => {} }),
			(error) => error.code === "OUTPUT_PATH_UNSAFE",
		)
		await assert.rejects(fs.stat(path.join(outside, "evidence")), (error) => error.code === "ENOENT")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	}
})

test("Windows output inspection accepts only fixed local drives", async () => {
	function spawnFixture(output) {
		return () => {
			const child = new EventEmitter()
			child.stdout = new EventEmitter()
			child.stdin = {
				end: () =>
					queueMicrotask(() => {
						child.stdout.emit("data", Buffer.from(output))
						child.emit("close", 0)
					}),
			}
			child.kill = () => {}
			return child
		}
	}
	await verifyWindowsFixedDrive("C:\\evidence", { force: true, spawn: spawnFixture("3") })
	await assert.rejects(
		verifyWindowsFixedDrive("Z:\\evidence", { force: true, spawn: spawnFixture("4") }),
		(error) => error.code === "OUTPUT_PATH_UNSAFE",
	)
})
