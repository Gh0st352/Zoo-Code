import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { parseArgs } from "../args.mjs"
import { buildLaunchPlan, installVsix, launchVsCode, terminateDedicatedChild } from "../launch.mjs"

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

test("isolated VSIX installation creates and passes both profile directories with exact Unicode paths", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-vsix-profile Ω with spaces-"))
	const codePath = path.join(root, "fake Code Ω", "Code.exe")
	const userDataDir = path.join(root, "user data Ω")
	const extensionsDir = path.join(root, "extensions Ω")
	const vsixPath = path.join(root, "ZooCode package Ω.vsix")
	let invocation
	try {
		await installVsix(codePath, userDataDir, extensionsDir, vsixPath, (file, args, options) => {
			assert.equal(fsSync.statSync(userDataDir).isDirectory(), true)
			assert.equal(fsSync.statSync(extensionsDir).isDirectory(), true)
			invocation = { file, args, options }
			return { status: 0 }
		})

		assert.equal(invocation.file, codePath)
		assert.deepEqual(invocation.args, [
			`--user-data-dir=${userDataDir}`,
			`--extensions-dir=${extensionsDir}`,
			"--install-extension",
			vsixPath,
			"--force",
		])
		assert.equal(invocation.options.shell, false)
		assert.equal(invocation.options.timeout, 120_000)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("isolated launch installs into the same directories before spawning the GUI", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-vsix-order Ω with spaces-"))
	const operationalDir = path.join(root, "operation Ω")
	const codePath = path.join(root, "Code.exe")
	const vsixPath = path.join(root, "ZooCode Ω.vsix")
	const events = []
	const child = childFixture({ exitsOnKill: true })
	try {
		const options = parseArgs(["launch", "--extension-vsix", vsixPath, "--cdp-port", "9333"])
		const result = await launchVsCode(options, "r".repeat(20), {
			locateCode: async () => codePath,
			operationalDir,
			installVsix: async (installedCode, userDataDir, extensionsDir, installedVsix) => {
				events.push("install")
				assert.equal(installedCode, codePath)
				assert.equal(userDataDir, path.join(operationalDir, "user-data"))
				assert.equal(extensionsDir, path.join(operationalDir, "extensions"))
				assert.equal(installedVsix, vsixPath)
				assert.equal((await fs.stat(userDataDir)).isDirectory(), true)
				assert.equal((await fs.stat(extensionsDir)).isDirectory(), true)
			},
			spawn: (file, args, spawnOptions) => {
				events.push("spawn")
				assert.equal(file, codePath)
				assert.ok(args.includes(`--user-data-dir=${path.join(operationalDir, "user-data")}`))
				assert.ok(args.includes(`--extensions-dir=${path.join(operationalDir, "extensions")}`))
				assert.equal(spawnOptions.shell, false)
				queueMicrotask(() => child.emit("spawn"))
				return child
			},
		})

		assert.deepEqual(events, ["install", "spawn"])
		assert.equal(result.rootPid, child.pid)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("VSIX installation failure prevents the monitored GUI from launching", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-vsix-failure-"))
	let spawnCount = 0
	try {
		const options = parseArgs(["launch", "--extension-vsix", path.join(root, "ZooCode.vsix"), "--cdp-port", "9333"])
		await assert.rejects(
			launchVsCode(options, "r".repeat(20), {
				locateCode: async () => path.join(root, "Code.exe"),
				operationalDir: path.join(root, "operation"),
				installVsix: async () => {
					throw Object.assign(new Error("fixture install failure"), { code: "VSIX_INSTALL_FAILED" })
				},
				spawn: () => {
					spawnCount += 1
				},
			}),
			(error) => error.code === "VSIX_INSTALL_FAILED",
		)
		assert.equal(spawnCount, 0)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
