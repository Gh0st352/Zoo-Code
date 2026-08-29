import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

function isWithin(candidate, parent) {
	const relative = path.relative(parent, candidate)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function isGitMetadata(candidate) {
	return path
		.resolve(candidate)
		.split(path.sep)
		.some((segment) => segment.toLowerCase() === ".git")
}

function outputPathError(message) {
	return Object.assign(new Error(message), { code: "OUTPUT_PATH_UNSAFE" })
}

async function assertNoReparsePoints(candidate, { allowMissingLeaf = false } = {}) {
	const resolved = path.resolve(candidate)
	const parsed = path.parse(resolved)
	const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
	let current = parsed.root
	for (let index = 0; index < segments.length; index += 1) {
		current = path.join(current, segments[index])
		let stat
		try {
			stat = await fs.lstat(current)
		} catch (error) {
			if (error.code === "ENOENT" && allowMissingLeaf) return
			throw error
		}
		if (stat.isSymbolicLink()) throw outputPathError("Evidence output may not traverse a reparse point")
	}
}

const WINDOWS_DRIVE_PROJECTION = String.raw`
$ErrorActionPreference = 'Stop'
$value = [Console]::In.ReadToEnd()
$root = [System.IO.Path]::GetPathRoot($value)
$drive = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $root.TrimEnd('\') + "'") | Select-Object -First 1 DriveType
if ($null -eq $drive) { throw 'drive-not-found' }
[Console]::Out.Write([int]$drive.DriveType)
`

export function verifyWindowsFixedDrive(output, options = {}) {
	if (process.platform !== "win32" && !options.force) return Promise.resolve()
	const spawnImpl = options.spawn ?? spawn
	return new Promise((resolve, reject) => {
		const child = spawnImpl(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				WINDOWS_DRIVE_PROJECTION,
			],
			{ stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false },
		)
		const chunks = []
		let bytes = 0
		let settled = false
		const fail = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.kill()
			reject(
				Object.assign(new Error("Evidence output must use a local fixed drive"), {
					code: "OUTPUT_PATH_UNSAFE",
				}),
			)
		}
		const timer = setTimeout(fail, options.timeoutMs ?? 3_000)
		child.stdout.on("data", (chunk) => {
			bytes += chunk.length
			if (bytes > 64) return fail()
			chunks.push(chunk)
		})
		child.on("error", fail)
		child.on("close", (code) => {
			if (settled) return
			if (code !== 0 || Buffer.concat(chunks).toString("utf8").trim() !== "3") return fail()
			settled = true
			clearTimeout(timer)
			resolve()
		})
		child.stdin.end(output)
	})
}

export async function assertSafeOutputRoot(
	output,
	{ forbiddenRoots = [], verifyFixedDrive = verifyWindowsFixedDrive, create = true } = {},
) {
	let resolved = path.resolve(output)
	if (resolved.startsWith("\\\\") || isGitMetadata(resolved)) {
		throw outputPathError("Evidence output must be a local non-.git path")
	}
	await assertNoReparsePoints(resolved, { allowMissingLeaf: true })
	if (create) {
		await fs.mkdir(resolved, { recursive: true })
		await assertNoReparsePoints(resolved)
		resolved = await fs.realpath(resolved)
	} else {
		let probe = resolved
		const suffix = []
		while (true) {
			try {
				probe = await fs.realpath(probe)
				break
			} catch (error) {
				if (error.code !== "ENOENT" || path.dirname(probe) === probe) throw error
				suffix.unshift(path.basename(probe))
				probe = path.dirname(probe)
			}
		}
		resolved = path.join(probe, ...suffix)
	}
	if (resolved.startsWith("\\\\") || isGitMetadata(resolved)) {
		throw outputPathError("Evidence output must resolve to a local non-.git path")
	}
	for (const entry of forbiddenRoots.filter(Boolean)) {
		const absolute = path.resolve(entry)
		const forbidden = await fs.realpath(absolute).catch(() => absolute)
		if (isWithin(resolved, forbidden) || isWithin(forbidden, resolved)) {
			throw outputPathError("Evidence output overlaps operational state")
		}
	}
	await verifyFixedDrive(resolved)
	return resolved
}
