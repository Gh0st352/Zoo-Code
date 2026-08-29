import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { parseArgs } from "../args.mjs"
import { buildLaunchPlan, launchVsCode, terminateDedicatedChild } from "../launch.mjs"

function childFixture({ exitsOnKill }) {
	const child = new EventEmitter()
	child.pid = 4321
	child.exitCode = null
	child.signalCode = null
	child.killCount = 0
	child.kill = () => {
		child.killCount += 1
		if (exitsOnKill) queueMicrotask(() => child.emit("exit", 0, null))
	}
	return child
}

test("dedicated child termination waits for graceful exit before considering a tree force", async () => {
	const child = childFixture({ exitsOnKill: true })
	let forced = false
	const result = await terminateDedicatedChild(child, {
		timeoutMs: 10,
		spawnSync: () => {
			forced = true
			return { status: 0 }
		},
	})
	assert.equal(result, "completed")
	assert.equal(child.killCount, 1)
	assert.equal(forced, false)
})

test("dedicated child termination force-kills only the explicit child tree after timeout", async () => {
	const child = childFixture({ exitsOnKill: false })
	let invocation
	const result = await terminateDedicatedChild(child, {
		timeoutMs: 1,
		spawnSync: (file, args, options) => {
			invocation = { file, args, options }
			return { status: 0 }
		},
	})
	assert.equal(result, "forced")
	assert.equal(invocation.file, "taskkill.exe")
	assert.deepEqual(invocation.args, ["/PID", "4321", "/T", "/F"])
	assert.equal(invocation.options.shell, false)
})

test("launch plan forwards only a minimal environment plus explicitly enabled feature flags", () => {
	const previous = process.env.ZOO_PRIVATE_LAUNCH_SECRET
	const previousNodeOptions = process.env.NODE_OPTIONS
	const previousProxy = process.env.HTTPS_PROXY
	process.env.ZOO_PRIVATE_LAUNCH_SECRET = "must-not-reach-child"
	process.env.NODE_OPTIONS = "--require=PRIVATE_INJECTION"
	process.env.HTTPS_PROXY = "http://PRIVATE_PROXY.invalid"
	try {
		const options = parseArgs([
			"launch",
			"--extension-development-path",
			".",
			"--enable-transport-diagnostics",
			"--enable-partial-coalescing",
		])
		const plan = buildLaunchPlan(options, {
			codePath: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
			operationalDir: "C:\\capture-operation",
		})

		assert.equal(plan.childEnvironment.ZOO_PRIVATE_LAUNCH_SECRET, undefined)
		assert.equal(plan.childEnvironment.NODE_OPTIONS, undefined)
		assert.equal(plan.childEnvironment.HTTPS_PROXY, undefined)
		assert.equal(plan.childEnvironment.ROO_CODE_TRANSCRIPT_TRANSPORT_DIAGNOSTICS, "1")
		assert.equal(plan.childEnvironment.ROO_CODE_TRANSCRIPT_PARTIAL_COALESCING, "1")
		assert.ok(Object.keys(plan.childEnvironment).length < Object.keys(process.env).length + 2)
	} finally {
		if (previous === undefined) delete process.env.ZOO_PRIVATE_LAUNCH_SECRET
		else process.env.ZOO_PRIVATE_LAUNCH_SECRET = previous
		if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
		else process.env.NODE_OPTIONS = previousNodeOptions
		if (previousProxy === undefined) delete process.env.HTTPS_PROXY
		else process.env.HTTPS_PROXY = previousProxy
	}
})

test("dry-run has no profile-directory or VSIX-installation side effects", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-launch-dry-run-"))
	const operationalDir = path.join(root, "not-created")
	let installCount = 0
	try {
		const options = parseArgs(["launch", "--extension-vsix", path.join(root, "extension.vsix"), "--dry-run"])
		const result = await launchVsCode(options, "r".repeat(20), {
			locateCode: async () => path.join(root, "Code.exe"),
			operationalDir,
			installVsix: async () => {
				installCount += 1
			},
		})

		assert.equal(result.dryRun, true)
		assert.equal(installCount, 0)
		await assert.rejects(fs.stat(operationalDir), (error) => error.code === "ENOENT")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
