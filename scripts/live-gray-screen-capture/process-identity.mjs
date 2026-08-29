import { spawn } from "node:child_process"
import fs from "node:fs/promises"

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const WINDOWS_PROCESS_IDENTITY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$pidValue = [int]$request.pid
$item = Get-CimInstance -ClassName Win32_Process | Where-Object { [int]$_.ProcessId -eq $pidValue } | Select-Object -First 1 CreationDate
if ($null -eq $item) { [Console]::Out.Write('{"state":"absent"}'); exit 0 }
$creationUtc = $null
try {
	if ($item.CreationDate -is [datetime]) { $creationUtc = ([datetime]$item.CreationDate).ToUniversalTime().ToString('o') }
	else { $creationUtc = ([Management.ManagementDateTimeConverter]::ToDateTime([string]$item.CreationDate)).ToUniversalTime().ToString('o') }
} catch {}
if ($null -eq $creationUtc) { [Console]::Out.Write('{"state":"unknown"}'); exit 0 }
[Console]::Out.Write(([ordered]@{ state = 'present'; creationTimeUtc = $creationUtc } | ConvertTo-Json -Compress))
`

function boundedProcess(command, argumentsList, stdin, dependencies = {}) {
	const spawnImpl = dependencies.spawn ?? spawn
	const timeoutMs = dependencies.timeoutMs ?? 3_000
	return new Promise((resolve) => {
		const child = spawnImpl(command, argumentsList, {
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
			shell: false,
		})
		const chunks = []
		let byteCount = 0
		let settled = false
		const finish = (value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(value)
		}
		const timer = setTimeout(() => {
			child.kill()
			finish(null)
		}, timeoutMs)
		child.stdout.on("data", (chunk) => {
			byteCount += chunk.length
			if (byteCount > 512) {
				child.kill()
				finish(null)
				return
			}
			chunks.push(chunk)
		})
		child.on("error", () => finish(null))
		child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : null))
		child.stdin.end(stdin)
	})
}

async function inspectWindowsProcess(pid, dependencies) {
	const text = await boundedProcess(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			WINDOWS_PROCESS_IDENTITY,
		],
		JSON.stringify({ pid }),
		dependencies,
	)
	if (text === null) return { state: "unknown", creationTimeUtc: null }
	try {
		const parsed = JSON.parse(text)
		if (parsed?.state === "absent") return { state: "absent", creationTimeUtc: null }
		if (parsed?.state === "present" && typeof parsed.creationTimeUtc === "string") {
			const normalized = new Date(parsed.creationTimeUtc).toISOString()
			if (ISO_UTC_PATTERN.test(normalized)) return { state: "present", creationTimeUtc: normalized }
		}
	} catch {}
	return { state: "unknown", creationTimeUtc: null }
}

async function inspectProcProcess(pid, dependencies) {
	const readFile = dependencies.readFile ?? fs.readFile
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8")
		const closingParenthesis = stat.lastIndexOf(")")
		if (closingParenthesis < 0) return { state: "unknown", creationTimeUtc: null }
		const fields = stat.slice(closingParenthesis + 2).split(" ")
		const startTicks = Number(fields[19])
		const procStat = await readFile("/proc/stat", "utf8")
		const bootSeconds = Number(/^btime (\d+)$/m.exec(procStat)?.[1])
		const ticksPerSecond = dependencies.clockTicksPerSecond ?? 100
		if (!Number.isSafeInteger(startTicks) || startTicks < 0 || !Number.isSafeInteger(bootSeconds)) {
			return { state: "unknown", creationTimeUtc: null }
		}
		return {
			state: "present",
			creationTimeUtc: new Date((bootSeconds + startTicks / ticksPerSecond) * 1_000).toISOString(),
		}
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ESRCH") return { state: "absent", creationTimeUtc: null }
		return { state: "unknown", creationTimeUtc: null }
	}
}

export async function inspectProcessIdentity(pid, dependencies = {}) {
	if (!Number.isSafeInteger(pid) || pid < 1 || pid > 4_294_967_295) {
		return { state: "unknown", creationTimeUtc: null }
	}
	const platform = dependencies.platform ?? process.platform
	if (platform === "win32") return inspectWindowsProcess(pid, dependencies)
	if (platform === "linux") return inspectProcProcess(pid, dependencies)
	try {
		process.kill(pid, 0)
		return { state: "unknown", creationTimeUtc: null }
	} catch (error) {
		return error?.code === "ESRCH"
			? { state: "absent", creationTimeUtc: null }
			: { state: "unknown", creationTimeUtc: null }
	}
}

let currentIdentityPromise

export async function currentProcessCreationTimeUtc(dependencies = {}) {
	if (Object.keys(dependencies).length > 0) {
		const identity = await inspectProcessIdentity(process.pid, dependencies)
		return identity.state === "present" ? identity.creationTimeUtc : null
	}
	currentIdentityPromise ??= inspectProcessIdentity(process.pid)
	const identity = await currentIdentityPromise
	return identity.state === "present" ? identity.creationTimeUtc : null
}

export function isValidCreationTimeUtc(value) {
	return typeof value === "string" && ISO_UTC_PATTERN.test(value)
}
