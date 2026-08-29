import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { Worker } from "node:worker_threads"

import { DEFAULTS } from "./constants.mjs"
import { generateEpochId } from "./records.mjs"

const POWERSHELL_PROJECTION = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputJson = [Console]::In.ReadToEnd()
$request = $inputJson | ConvertFrom-Json
$rootPid = [int]$request.rootPid
$inspectCommandLine = [bool]$request.inspectCommandLine
$all = Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
$byParent = @{}
foreach ($item in $all) {
	$parent = [int]$item.ParentProcessId
	if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = [System.Collections.Generic.List[object]]::new() }
	$byParent[$parent].Add($item)
}
$selected = [System.Collections.Generic.List[object]]::new()
$queue = [System.Collections.Generic.Queue[int]]::new()
$seen = [System.Collections.Generic.HashSet[int]]::new()
$queue.Enqueue($rootPid)
while ($queue.Count -gt 0) {
	$pidValue = $queue.Dequeue()
	if (-not $seen.Add($pidValue)) { continue }
	$current = $all | Where-Object { [int]$_.ProcessId -eq $pidValue } | Select-Object -First 1
	if ($null -ne $current) { $selected.Add($current) }
	if ($byParent.ContainsKey($pidValue)) {
		foreach ($child in $byParent[$pidValue]) { $queue.Enqueue([int]$child.ProcessId) }
	}
}
$output = [System.Collections.Generic.List[object]]::new()
foreach ($item in $selected) {
	$pidValue = [int]$item.ProcessId
	$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
	$role = 'other'
	$confidence = 'unresolved'
	if ($pidValue -eq $rootPid) {
		$role = 'browser'; $confidence = 'exact'
	} elseif ($inspectCommandLine -and $null -ne $item.CommandLine) {
		$commandLine = [string]$item.CommandLine
		if ($commandLine -match '(?:^|\s)--type=gpu-process(?:\s|$)') {
			$role = 'gpu'; $confidence = 'exact'
		} elseif ($commandLine -match '(?:^|\s)--type=renderer(?:\s|$)') {
			$role = 'renderer'; $confidence = 'strongCandidate'
		} elseif ($commandLine -match '(?:^|\s)--type=utility(?:\s|$)' -and $commandLine -match '(?:extensionHost|extension-host|extension-host-kind)') {
			$role = 'extensionHost'; $confidence = 'strongCandidate'
		} elseif ($commandLine -match '(?:^|\s)--type=utility(?:\s|$)') {
			$role = 'utility'; $confidence = 'ambiguous'
		}
	}
	$workingSet = $null
	$privateBytes = $null
	$pagedBytes = $null
	$cpuMs = $null
	$threads = $null
	$handles = $null
	if ($null -ne $process) {
		try { $workingSet = [double]$process.WorkingSet64 } catch {}
		try { $privateBytes = [double]$process.PrivateMemorySize64 } catch {}
		try { $pagedBytes = [double]$process.PagedMemorySize64 } catch {}
		try { $cpuMs = [double]$process.TotalProcessorTime.TotalMilliseconds } catch {}
		try { $threads = [int]$process.Threads.Count } catch {}
		try { $handles = [int]$process.HandleCount } catch {}
	}
	$creationUtc = $null
	try {
		if ($item.CreationDate -is [datetime]) {
			$creationUtc = ([datetime]$item.CreationDate).ToUniversalTime().ToString('o')
		} else {
			$creationUtc = ([Management.ManagementDateTimeConverter]::ToDateTime([string]$item.CreationDate)).ToUniversalTime().ToString('o')
		}
	} catch {}
	$output.Add([ordered]@{
		pid = $pidValue
		parentPid = [int]$item.ParentProcessId
		creationTimeUtc = $creationUtc
		role = $role
		confidence = $confidence
		workingSetBytes = $workingSet
		privateBytes = $privateBytes
		pagedBytes = $pagedBytes
		cpuTimeMs = $cpuMs
		threadCount = $threads
		handleCount = $handles
		present = ($null -ne $process)
	})
}
$availableMemory = $null
try {
	$os = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object -First 1 FreePhysicalMemory
	if ($null -ne $os.FreePhysicalMemory) { $availableMemory = [double]$os.FreePhysicalMemory * 1024 }
} catch {}
[Console]::Out.Write(([ordered]@{ schemaVersion = 1; processes = $output; systemAvailableMemoryBytes = $availableMemory } | ConvertTo-Json -Compress -Depth 4))
`

const ALLOWED_ROLES = new Set(["browser", "renderer", "gpu", "extensionHost", "utility", "other"])
const ALLOWED_CONFIDENCE = new Set(["exact", "strongCandidate", "ambiguous", "unresolved"])
const MAX_PROCESS_EPOCHS = 256

function finiteMetric(value, integer = false) {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER &&
		(!integer || Number.isInteger(value))
	)
}

export function sanitizeProcessProjection(projection, rootPid) {
	if (
		!projection ||
		typeof projection !== "object" ||
		Array.isArray(projection) ||
		Object.keys(projection).some(
			(key) => !new Set(["schemaVersion", "processes", "systemAvailableMemoryBytes"]).has(key),
		) ||
		projection.schemaVersion !== 1 ||
		!Array.isArray(projection.processes) ||
		projection.processes.length > 512
	) {
		throw Object.assign(new Error("Process projection is malformed"), { code: "processProjectionMalformed" })
	}
	const systemAvailableMemoryBytes = finiteMetric(projection.systemAvailableMemoryBytes)
		? projection.systemAvailableMemoryBytes
		: null
	const processes = []
	const identities = new Set()
	for (const raw of projection.processes) {
		const allowedKeys = new Set([
			"pid",
			"parentPid",
			"creationTimeUtc",
			"role",
			"confidence",
			"workingSetBytes",
			"privateBytes",
			"pagedBytes",
			"cpuTimeMs",
			"threadCount",
			"handleCount",
			"present",
		])
		if (!raw || typeof raw !== "object" || Object.keys(raw).some((key) => !allowedKeys.has(key))) {
			throw Object.assign(new Error("Process projection contains a forbidden field"), {
				code: "processProjectionUnsafe",
			})
		}
		if (!finiteMetric(raw.pid, true) || raw.pid < 1 || !finiteMetric(raw.parentPid, true)) continue
		if (raw.pid > 4_294_967_295 || raw.parentPid > 4_294_967_295) continue
		if (!ALLOWED_ROLES.has(raw.role) || !ALLOWED_CONFIDENCE.has(raw.confidence)) continue
		const creationTimeUtc =
			typeof raw.creationTimeUtc === "string" &&
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(raw.creationTimeUtc)
				? new Date(raw.creationTimeUtc).toISOString()
				: null
		const process = {
			pid: raw.pid,
			parentPid: raw.parentPid,
			creationTimeUtc,
			role: raw.pid === rootPid ? "browser" : raw.role,
			confidence: raw.pid === rootPid ? "exact" : raw.confidence,
			present: raw.present === true,
			unavailable: [],
		}
		const identity = `${process.pid}:${process.creationTimeUtc ?? "unknown"}`
		if (identities.has(identity)) {
			throw Object.assign(new Error("Process projection contains a duplicate identity"), {
				code: "processProjectionMalformed",
			})
		}
		identities.add(identity)
		for (const [key, integer] of [
			["workingSetBytes", false],
			["privateBytes", false],
			["pagedBytes", false],
			["cpuTimeMs", false],
			["threadCount", true],
			["handleCount", true],
		]) {
			if (finiteMetric(raw[key], integer)) process[key] = raw[key]
			else process.unavailable.push("notSampled")
		}
		if (systemAvailableMemoryBytes !== null) process.systemAvailableMemoryBytes = systemAvailableMemoryBytes
		else process.unavailable.push("notSampled")
		processes.push(process)
	}
	return { processes, systemAvailableMemoryBytes }
}

export function runPowerShellProjection(
	{ rootPid, inspectCommandLine, timeoutMs = DEFAULTS.processSampleTimeoutMs },
	dependencies = {},
) {
	const spawnImpl = dependencies.spawn ?? spawn
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
				POWERSHELL_PROJECTION,
			],
			{ stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false },
		)
		const chunks = []
		let bytes = 0
		let settled = false
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			child.kill()
			reject(Object.assign(new Error("Process sample timed out"), { code: "processSampleTimedOut" }))
		}, timeoutMs)
		child.stdout.on("data", (chunk) => {
			bytes += chunk.length
			if (bytes > 1024 * 1024) {
				settled = true
				clearTimeout(timer)
				child.kill()
				reject(
					Object.assign(new Error("Process projection exceeded the fixed bound"), {
						code: "processProjectionUnsafe",
					}),
				)
				return
			}
			chunks.push(chunk)
		})
		child.on("error", () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(Object.assign(new Error("Process sampler could not start"), { code: "processSampleFailed" }))
		})
		child.on("close", (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (code !== 0) {
				reject(Object.assign(new Error("Process sampler failed"), { code: "processSampleFailed" }))
				return
			}
			try {
				resolve(sanitizeProcessProjection(JSON.parse(Buffer.concat(chunks).toString("utf8")), rootPid))
			} catch (error) {
				reject(error)
			}
		})
		child.stdin.end(JSON.stringify({ rootPid, inspectCommandLine }))
	})
}

export class ProcessSampler extends EventEmitter {
	constructor({
		rootPid,
		intervalMs,
		commandLineRoleProbe,
		clock,
		sampleProvider = null,
		random,
		WorkerImpl = Worker,
	}) {
		super()
		this.rootPid = rootPid
		this.intervalMs = intervalMs
		this.commandLineRoleProbe = commandLineRoleProbe
		this.clock = clock
		this.sampleProvider = sampleProvider
		this.random = random
		this.WorkerImpl = WorkerImpl
		this.timer = null
		this.worker = null
		this.workerRestartHandle = null
		this.workerRestartCount = 0
		this.workerStopPromise = null
		this.workerStopResolve = null
		this.inFlight = false
		this.closed = false
		this.epochs = new Map()
		this.previous = new Map()
		this.consecutiveMisses = 0
		this.latestAvailableMemoryBytes = null
		this.rootCreationTimeUtc = null
		this.rootExited = false
	}

	start() {
		if (this.timer || this.worker || this.closed) return
		if (!this.sampleProvider) {
			this.startWorker()
			return
		}
		this.timer = setInterval(
			() => void this.sample().catch(() => this.acceptSampleError("processSampleFailed")),
			this.intervalMs,
		)
		this.timer.unref?.()
		void this.sample().catch(() => this.acceptSampleError("processSampleFailed"))
	}

	startWorker() {
		const timeoutMs = Math.max(1, Math.min(DEFAULTS.processSampleTimeoutMs, this.intervalMs - 100))
		const worker = new this.WorkerImpl(new URL("./process-sampler-worker.mjs", import.meta.url), {
			workerData: {
				rootPid: this.rootPid,
				intervalMs: this.intervalMs,
				commandLineRoleProbe: this.commandLineRoleProbe,
				timeoutMs,
			},
		})
		this.worker = worker
		let failureReported = false
		const reportFailure = () => {
			if (failureReported || this.closed) return
			failureReported = true
			this.acceptSampleError("processSampleFailed")
		}
		worker.on("message", (message) => {
			if (!message || !Number.isSafeInteger(message.sequence)) return
			try {
				if (Number.isSafeInteger(message.droppedSamples) && message.droppedSamples > 0) {
					this.emit("dropped", { droppedCount: message.droppedSamples })
				}
				if (message.type === "projection") {
					this.workerRestartCount = 0
					this.acceptProjection(message.payload)
				} else if (message.type === "sampleError") this.acceptSampleError(message.payload?.code)
				else if (message.type === "stopped") this.workerStopResolve?.()
			} finally {
				if (this.worker === worker) worker.postMessage({ type: "ack", sequence: message.sequence })
			}
		})
		worker.on("error", reportFailure)
		worker.on("exit", () => {
			reportFailure()
			if (this.worker === worker) this.worker = null
			this.workerStopResolve?.()
			if (!this.closed && this.workerRestartCount < 3) {
				this.workerRestartCount += 1
				this.workerRestartHandle = setImmediate(() => {
					this.workerRestartHandle = null
					if (!this.closed && !this.worker) this.startWorker()
				})
				this.workerRestartHandle.unref?.()
			}
		})
	}

	async sample() {
		if (this.inFlight || this.closed) return
		if (!this.sampleProvider) {
			this.worker?.postMessage({ type: "sampleNow" })
			return
		}
		this.inFlight = true
		try {
			const result = await this.sampleProvider({
				rootPid: this.rootPid,
				inspectCommandLine: this.commandLineRoleProbe,
				timeoutMs: Math.max(1, Math.min(DEFAULTS.processSampleTimeoutMs, this.intervalMs - 100)),
			})
			this.acceptProjection(result)
		} catch (error) {
			this.acceptSampleError(error.code)
		} finally {
			this.inFlight = false
		}
	}

	acceptProjection(result) {
		this.consecutiveMisses = 0
		this.latestAvailableMemoryBytes = result.systemAvailableMemoryBytes
		const projectedRoot = result.processes.find((entry) => entry.pid === this.rootPid && entry.present === true)
		if (!this.rootCreationTimeUtc && projectedRoot?.creationTimeUtc) {
			this.rootCreationTimeUtc = projectedRoot.creationTimeUtc
		}
		if (
			this.rootCreationTimeUtc &&
			projectedRoot?.creationTimeUtc &&
			projectedRoot.creationTimeUtc !== this.rootCreationTimeUtc
		) {
			if (!this.rootExited) {
				this.rootExited = true
				this.emit("rootExited", {
					pid: this.rootPid,
					creationTimeUtc: this.rootCreationTimeUtc,
					reason: "pidReused",
				})
			}
			return
		}
		const current = new Map()
		for (const processInfo of result.processes) {
			const identity = `${processInfo.pid}:${processInfo.creationTimeUtc ?? "unknown"}`
			let epoch = this.epochs.get(identity)
			if (!epoch) {
				epoch = generateEpochId(this.random)
				this.epochs.set(identity, epoch)
			}
			current.set(identity, { ...processInfo, processEpoch: epoch })
			this.emit("sample", { ...processInfo, processEpoch: epoch })
		}
		for (const [identity, previous] of this.previous) {
			if (!current.has(identity)) this.emit("disappeared", previous)
		}
		this.previous = current
		this.pruneEpochs(current)
		if (![...current.values()].some((entry) => entry.pid === this.rootPid) && !this.rootExited) {
			this.rootExited = true
			this.emit("rootExited", {
				pid: this.rootPid,
				...(this.rootCreationTimeUtc ? { creationTimeUtc: this.rootCreationTimeUtc } : {}),
				reason: "processExited",
			})
		}
	}

	pruneEpochs(current) {
		if (this.epochs.size <= MAX_PROCESS_EPOCHS) return
		const retained = new Set(current.keys())
		for (const identity of this.epochs.keys()) {
			if (retained.has(identity)) continue
			this.epochs.delete(identity)
			if (this.epochs.size <= MAX_PROCESS_EPOCHS) break
		}
	}

	acceptSampleError(rawCode) {
		const code =
			typeof rawCode === "string" && /^[A-Za-z0-9_]{1,64}$/.test(rawCode) ? rawCode : "processSampleFailed"
		this.consecutiveMisses += 1
		this.emit("missed", { code, consecutiveMisses: this.consecutiveMisses })
		if (this.consecutiveMisses >= 3) this.emit("degraded", { code, consecutiveMisses: this.consecutiveMisses })
	}

	async stop({ finalSample = true } = {}) {
		this.closed = true
		if (this.workerRestartHandle) clearImmediate(this.workerRestartHandle)
		this.workerRestartHandle = null
		if (this.worker) {
			const worker = this.worker
			this.workerStopPromise = new Promise((resolve) => {
				this.workerStopResolve = resolve
			})
			worker.postMessage({ type: "stop", finalSample })
			let stopTimer
			try {
				await Promise.race([
					this.workerStopPromise,
					new Promise((resolve) => {
						stopTimer = setTimeout(resolve, DEFAULTS.processSampleTimeoutMs + 1_000)
						stopTimer.unref?.()
					}),
				])
			} finally {
				clearTimeout(stopTimer)
			}
			await worker.terminate()
			this.worker = null
			this.workerStopPromise = null
			this.workerStopResolve = null
			return
		}
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		while (this.inFlight) await new Promise((resolve) => setImmediate(resolve))
		if (finalSample) {
			this.closed = false
			await this.sample()
			this.closed = true
		}
	}
}
