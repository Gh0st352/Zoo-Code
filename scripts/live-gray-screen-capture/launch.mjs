import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { DEFAULTS } from "./constants.mjs"
import { operationalRoot } from "./control.mjs"

const COMMON_CODE_LOCATIONS = [
	() => path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
	() => path.join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "Code.exe"),
	() => path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft VS Code", "Code.exe"),
]

// Keep the dedicated diagnostic instance functional without forwarding provider
// credentials, tokens, Node/Electron injection flags, or unrelated application state.
const CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
	"ALLUSERSPROFILE",
	"APPDATA",
	"CommonProgramFiles",
	"CommonProgramFiles(x86)",
	"CommonProgramW6432",
	"ComSpec",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"Path",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"SystemDrive",
	"SystemRoot",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"windir",
])

const FORBIDDEN_ENVIRONMENT_PATTERN =
	/^(?:NODE_OPTIONS|ELECTRON_RUN_AS_NODE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i

function minimalChildEnvironment(environment = process.env) {
	const entriesByLowerName = new Map(
		Object.entries(environment).map(([name, value]) => [name.toLowerCase(), [name, value]]),
	)
	const childEnvironment = {}
	for (const allowedName of CHILD_ENVIRONMENT_ALLOWLIST) {
		const entry = entriesByLowerName.get(allowedName.toLowerCase())
		if (entry && typeof entry[1] === "string" && !FORBIDDEN_ENVIRONMENT_PATTERN.test(entry[0])) {
			childEnvironment[entry[0]] = entry[1]
		}
	}
	return childEnvironment
}

export async function locateCode(explicitPath = null) {
	if (explicitPath) {
		const stat = await fs.stat(explicitPath).catch(() => null)
		if (!stat?.isFile())
			throw Object.assign(new Error("VS Code executable is unavailable"), { code: "CODE_NOT_FOUND" })
		return path.resolve(explicitPath)
	}
	for (const location of COMMON_CODE_LOCATIONS.map((factory) => factory()).filter(Boolean)) {
		const stat = await fs.stat(location).catch(() => null)
		if (stat?.isFile()) return path.resolve(location)
	}
	throw Object.assign(new Error("VS Code executable was not found in a safe common location"), {
		code: "CODE_NOT_FOUND",
	})
}

export function buildLaunchPlan(options, { codePath, operationalDir }) {
	let userDataDir = options.userDataDir
	let extensionsDir = options.extensionsDir
	if (options.profileMode === "isolated") {
		userDataDir = path.join(operationalDir, "user-data")
		extensionsDir = path.join(operationalDir, "extensions")
	}
	const argumentsList = []
	if (options.profileMode !== "default") {
		argumentsList.push(`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`)
	}
	argumentsList.push(
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${options.cdpPort}`,
		"--disable-workspace-trust",
		"--skip-welcome",
		"--skip-release-notes",
	)
	if (options.extensionDevelopmentPath)
		argumentsList.push(`--extensionDevelopmentPath=${options.extensionDevelopmentPath}`)
	if (options.workspace) argumentsList.push(options.workspace)
	argumentsList.push(...options.passthrough)
	const childEnvironment = minimalChildEnvironment()
	if (options.enableTransportDiagnostics) childEnvironment.ROO_CODE_TRANSCRIPT_TRANSPORT_DIAGNOSTICS = "1"
	if (options.enablePartialCoalescing) childEnvironment.ROO_CODE_TRANSCRIPT_PARTIAL_COALESCING = "1"
	return {
		codePath,
		argumentsList,
		childEnvironment,
		operationalDir,
		userDataDir,
		extensionsDir,
		sanitized: {
			profileMode: options.profileMode,
			cdpPort: options.cdpPort,
			extensionSource: options.extensionDevelopmentPath
				? "developmentPath"
				: options.extensionVsix
					? "vsix"
					: "installed",
			workspaceArgumentPresent: Boolean(options.workspace || options.passthrough.length),
			transportDiagnostics: options.enableTransportDiagnostics ? "enabled" : "disabled",
			partialCoalescing: options.enablePartialCoalescing ? "enabled" : "disabled",
			isolatedOperationalState: options.profileMode === "isolated",
		},
	}
}

function ensureNoCodeProcesses() {
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$value = @(Get-Process -Name Code -ErrorAction SilentlyContinue).Count; [Console]::Out.Write($value)",
		],
		{ encoding: "utf8", windowsHide: true, shell: false, timeout: 5_000 },
	)
	if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) {
		throw Object.assign(new Error("Unable to verify normal-profile process isolation"), {
			code: "PROFILE_PROCESS_CHECK_FAILED",
		})
	}
	if (Number(result.stdout.trim()) > 0) {
		throw Object.assign(new Error("Normal/custom profile launch is refused while VS Code is running"), {
			code: "PROFILE_IN_USE",
		})
	}
}

async function readDevToolsActivePort(
	userDataDir,
	timeoutMs,
	wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
	const candidates = [path.join(userDataDir, "DevToolsActivePort")]
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		for (const candidate of candidates) {
			try {
				const text = await fs.readFile(candidate, "utf8")
				const port = Number(text.split(/\r?\n/, 1)[0])
				if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port
			} catch {}
		}
		await wait(100)
	}
	throw Object.assign(new Error("VS Code did not advertise a CDP port"), { code: "CDP_PORT_DISCOVERY_FAILED" })
}

async function installVsix(codePath, extensionsDir, vsixPath) {
	await fs.mkdir(extensionsDir, { recursive: true })
	const result = spawnSync(
		codePath,
		[`--extensions-dir=${extensionsDir}`, "--install-extension", vsixPath, "--force"],
		{ stdio: "ignore", windowsHide: true, shell: false, timeout: 120_000 },
	)
	if (result.status !== 0) throw Object.assign(new Error("VSIX installation failed"), { code: "VSIX_INSTALL_FAILED" })
}

export async function launchVsCode(options, runId, dependencies = {}) {
	const codePath = await (dependencies.locateCode ?? locateCode)(options.code)
	const operationalDir = dependencies.operationalDir ?? operationalRoot(runId)
	const plan = buildLaunchPlan(options, { codePath, operationalDir })
	if (options.dryRun) return { dryRun: true, plan: plan.sanitized }
	await fs.mkdir(operationalDir, { recursive: true, mode: 0o700 })
	if (options.profileMode !== "isolated") (dependencies.ensureNoCodeProcesses ?? ensureNoCodeProcesses)()
	if (options.extensionVsix)
		await (dependencies.installVsix ?? installVsix)(codePath, plan.extensionsDir, options.extensionVsix)
	if (options.profileMode === "isolated") {
		await fs.mkdir(plan.userDataDir, { recursive: true })
		await fs.mkdir(plan.extensionsDir, { recursive: true })
	}
	const child = (dependencies.spawn ?? spawn)(plan.codePath, plan.argumentsList, {
		stdio: "ignore",
		detached: false,
		windowsHide: false,
		shell: false,
		env: plan.childEnvironment,
	})
	await new Promise((resolve, reject) => {
		child.once("spawn", resolve)
		child.once("error", () =>
			reject(Object.assign(new Error("VS Code launch failed"), { code: "CODE_LAUNCH_FAILED" })),
		)
	})
	let cdpPort = options.cdpPort
	if (cdpPort === 0) {
		try {
			cdpPort = await (dependencies.readDevToolsActivePort ?? readDevToolsActivePort)(
				plan.userDataDir,
				options.launchTimeoutMs ?? DEFAULTS.launchTimeoutMs,
				dependencies.wait,
			)
		} catch (error) {
			child.kill()
			throw error
		}
	}
	return { dryRun: false, child, rootPid: child.pid, cdpPort, operationalDir, plan: plan.sanitized }
}

export async function cleanupOperationalState(operationalDir, profileMode) {
	if (!operationalDir) return "completed"
	if (profileMode !== "isolated") {
		await fs.rm(path.join(operationalDir, "control.json"), { force: true }).catch(() => {})
		return "completed"
	}
	try {
		await fs.rm(operationalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
		return "completed"
	} catch {
		return "failed"
	}
}

export async function terminateDedicatedChild(child, options = {}) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return "notRunning"
	const timeoutMs = options.timeoutMs ?? 5_000
	const exited = new Promise((resolve) => child.once("exit", () => resolve(true)))
	child.kill()
	if (await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]))
		return "completed"
	const spawnSyncImpl = options.spawnSync ?? spawnSync
	const result = spawnSyncImpl("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
		stdio: "ignore",
		windowsHide: true,
		shell: false,
		timeout: timeoutMs,
	})
	return result.status === 0 ? "forced" : "failed"
}
