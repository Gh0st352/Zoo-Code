import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { minimalSnapshot } from "./fixtures.mjs"
import { assertSupportedRuntime } from "../runtime.mjs"

const entry = path.resolve("scripts/live-gray-screen-capture.mjs")

test("runtime gate rejects pre-22 Node and missing built-in WebSocket support", () => {
	assert.throws(
		() => assertSupportedRuntime({ nodeVersion: "21.9.0", WebSocketImpl: class {} }),
		(error) => error.code === "UNSUPPORTED_RUNTIME",
	)
	assert.throws(
		() => assertSupportedRuntime({ nodeVersion: "22.0.0", WebSocketImpl: undefined }),
		(error) => error.code === "UNSUPPORTED_RUNTIME",
	)
	assert.doesNotThrow(() => assertSupportedRuntime({ nodeVersion: "22.0.0", WebSocketImpl: class {} }))
})

function runCli(argumentsList) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [entry, ...argumentsList], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		})
		const stdout = []
		const stderr = []
		child.stdout.on("data", (chunk) => stdout.push(chunk))
		child.stderr.on("data", (chunk) => stderr.push(chunk))
		child.on("error", reject)
		child.on("close", (exitCode) =>
			resolve({
				exitCode,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		)
	})
}

test("CLI help, dry-run launch, and streamed validation are runnable without package dependencies", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-cli-integration-"))
	try {
		const executable = path.join(root, "Code.exe")
		const extension = path.join(root, "extension")
		const output = path.join(root, "evidence")
		const snapshot = path.join(root, "fixture.heapsnapshot")
		await fs.writeFile(executable, "fixture")
		await fs.mkdir(extension)
		await fs.writeFile(snapshot, minimalSnapshot())

		const help = await runCli(["--help"])
		assert.equal(help.exitCode, 0)
		assert.match(help.stdout, /standalone MVP/)

		const dryRun = await runCli([
			"launch",
			"--code",
			executable,
			"--extension-development-path",
			extension,
			"--output",
			output,
			"--dry-run",
		])
		assert.equal(dryRun.exitCode, 0, dryRun.stderr)
		assert.equal(JSON.parse(dryRun.stdout).status, "dry-run")
		assert.equal(dryRun.stdout.includes(executable), false)
		assert.equal(dryRun.stdout.includes(extension), false)
		await assert.rejects(fs.stat(output), (error) => error.code === "ENOENT")

		const validation = await runCli(["validate", "--file", snapshot, "--output", path.join(root, "validation")])
		assert.equal(validation.exitCode, 0, validation.stderr)
		const result = JSON.parse(validation.stdout)
		assert.equal(result.status, "valid")
		assert.match(result.resultFile, /^validation-[A-Za-z0-9-]+\.json$/)
		assert.equal(validation.stdout.includes(snapshot), false)
		assert.equal(validation.stdout.includes(root), false)
		assert.equal(validation.stderr.includes("MODULE_TYPELESS_PACKAGE_JSON"), false)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("CLI validation rejects a zero-byte snapshot with the documented snapshot exit code", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-cli-zero-byte-"))
	try {
		const snapshot = path.join(root, "empty.heapsnapshot")
		await fs.writeFile(snapshot, "")
		const result = await runCli([
			"validate-snapshot",
			"--file",
			snapshot,
			"--output",
			path.join(root, "validation"),
		])
		assert.equal(result.exitCode, 5)
		assert.equal(JSON.parse(result.stdout).code, "zeroByteFile")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("concurrent CLI validations use distinct result files", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-cli-concurrent-validation-"))
	try {
		const snapshot = path.join(root, "fixture.heapsnapshot")
		const output = path.join(root, "validation")
		await fs.writeFile(snapshot, minimalSnapshot())
		const [first, second] = await Promise.all([
			runCli(["validate", "--file", snapshot, "--output", output]),
			runCli(["validate", "--file", snapshot, "--output", output]),
		])
		assert.equal(first.exitCode, 0, first.stderr)
		assert.equal(second.exitCode, 0, second.stderr)
		const firstResult = JSON.parse(first.stdout)
		const secondResult = JSON.parse(second.stdout)
		assert.notEqual(firstResult.resultFile, secondResult.resultFile)
		assert.equal(path.isAbsolute(firstResult.resultFile), false)
		assert.equal(path.isAbsolute(secondResult.resultFile), false)
		assert.equal((await fs.readdir(output)).length, 2)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
