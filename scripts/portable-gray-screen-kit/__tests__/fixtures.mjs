import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceLauncherPath = fileURLToPath(new URL("../Start-ZooCodeGrayScreenCapture.ps1", import.meta.url))

export const powershellPath = path.join(
	process.env.SystemRoot ?? String.raw`C:\Windows`,
	"System32",
	"WindowsPowerShell",
	"v1.0",
	"powershell.exe",
)

const fakeCollectorSource = String.raw`
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

const args = process.argv.slice(2)
const command = args[0]

function option(name) {
	const index = args.indexOf(name)
	return index < 0 ? undefined : args[index + 1]
}

function logInvocation() {
	if (!process.env.ZOO_FAKE_COLLECTOR_LOG) return
	fs.appendFileSync(
		process.env.ZOO_FAKE_COLLECTOR_LOG,
		JSON.stringify({ pid: process.pid, args }) + "\n",
		"utf8",
	)
}

function processCreationUtc() {
	const powershell = path.join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	)
	const script = [
		"$processId = [int][Environment]::GetEnvironmentVariable('ZOO_FIXTURE_PROCESS_ID')",
		"$item = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $processId)",
		"if ($null -eq $item) { exit 2 }",
		"$value = if ($item.CreationDate -is [datetime]) { [datetime]$item.CreationDate } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$item.CreationDate) }",
		"[Console]::Out.Write($value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture))",
	].join("; ")
	return execFileSync(
		powershell,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
		{
			encoding: "utf8",
			windowsHide: true,
			env: { ...process.env, ZOO_FIXTURE_PROCESS_ID: String(process.pid) },
		},
	).trim()
}

async function launch() {
	const output = option("--output")
	if (!output) process.exit(64)
	await fsp.mkdir(output, { recursive: true })
	const manifestDelayMs = Number(process.env.ZOO_FAKE_COLLECTOR_MANIFEST_DELAY_MS ?? 0)
	if (Number.isFinite(manifestDelayMs) && manifestDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, manifestDelayMs))
	}
	const runPath = path.join(output, "run-fixture-" + process.pid)
	await fsp.mkdir(runPath, { recursive: true })
	const manifest = {
		schemaVersion: 1,
		runId: "fixture-" + process.pid,
		state: "capturing",
		harnessPid: process.pid,
		harnessCreationTimeUtc: processCreationUtc(),
		captureConfig: {
			autoSnapshotEnabled: args.includes("--enable-auto-snapshot"),
			heapCriticalRatio: Number(option("--heap-critical-ratio") ?? 0.82),
			autoSnapshotSamples: Number(option("--auto-snapshot-samples") ?? 3),
		},
	}
	await fsp.writeFile(path.join(runPath, "manifest.partial.json"), JSON.stringify(manifest), "utf8")
	if (process.env.ZOO_FAKE_COLLECTOR_DUPLICATE_RUN === "1") {
		const duplicateRunPath = path.join(output, "run-fixture-duplicate-" + process.pid)
		await fsp.mkdir(duplicateRunPath, { recursive: true })
		await fsp.writeFile(path.join(duplicateRunPath, "manifest.partial.json"), JSON.stringify(manifest), "utf8")
	}
	if (process.env.ZOO_FAKE_COLLECTOR_MODE === "exit-after-capture") {
		await new Promise((resolve) => setTimeout(resolve, 750))
		manifest.state = "completed"
		manifest.classification = "fixtureCompleted"
		await fsp.writeFile(path.join(runPath, "manifest.json"), JSON.stringify(manifest), "utf8")
		await fsp.rm(path.join(runPath, "manifest.partial.json"), { force: true })
		return
	}
	const stopPath = path.join(runPath, "fixture-stop-request")
	while (!fs.existsSync(stopPath)) await new Promise((resolve) => setTimeout(resolve, 25))
	manifest.state = "completed"
	manifest.classification = "fixtureStopped"
	await fsp.writeFile(path.join(runPath, "manifest.json"), JSON.stringify(manifest), "utf8")
	await fsp.rm(path.join(runPath, "manifest.partial.json"), { force: true })
}

async function control() {
	const runPath = option("--run-dir")
	if (!runPath) process.exit(64)
	if (command === "stop") {
		await fsp.writeFile(path.join(runPath, "fixture-stop-request"), "stop", "utf8")
		process.stdout.write("Fixture stop requested.\n")
		return
	}
	if (command === "snapshot") {
		await fsp.writeFile(path.join(runPath, "fixture-snapshot-request"), JSON.stringify(args), "utf8")
		process.stdout.write("Fixture snapshot requested.\n")
		return
	}
	process.exit(64)
}

logInvocation()
if (command === "launch") await launch()
else await control()
`

const fakeCodeSource = String.raw`
using System;
using System.Linq;

public static class Program
{
	public static int Main(string[] args)
	{
		if (args.Contains("--version"))
		{
			Console.WriteLine("1.100.0");
			Console.WriteLine("fixture-commit");
			Console.WriteLine("x64");
			return 0;
		}

		if (args.Contains("--list-extensions"))
		{
			Console.WriteLine("ZooCodeOrganization.zoo-code@3.80.0");
			return 0;
		}

		return 0;
	}
}
`

function sha256(value) {
	return createHash("sha256").update(value).digest("hex")
}

async function writePayload(bundleRoot, relativePath, value) {
	const filePath = path.join(bundleRoot, ...relativePath.split("/"))
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, value)
	return filePath
}

async function compileFakeCode(outputPath) {
	const command = [
		"$source = [Environment]::GetEnvironmentVariable('ZOO_FIXTURE_CODE_SOURCE')",
		"$output = [Environment]::GetEnvironmentVariable('ZOO_FIXTURE_CODE_OUTPUT')",
		"Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $output -OutputType ConsoleApplication",
	].join("; ")
	const result = await execFileResult(
		powershellPath,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
		{
			env: {
				...process.env,
				ZOO_FIXTURE_CODE_SOURCE: fakeCodeSource,
				ZOO_FIXTURE_CODE_OUTPUT: outputPath,
			},
		},
	)
	if (result.exitCode !== 0) {
		throw new Error(`Could not compile fixture Code.exe:\n${result.stderr || result.stdout}`)
	}
}

export async function createPortableKitFixture(testContext, options = {}) {
	const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "Zoo portable kit Ω-"))
	const repositoryPath = path.join(fixtureRoot, "external repo Ω with spaces")
	const bundleRoot = path.join(repositoryPath, "ZooCodeGrayScreenCapture.bundle")
	const launcherPath = path.join(repositoryPath, "Start-ZooCodeGrayScreenCapture.ps1")
	const localAppData = path.join(fixtureRoot, "private local app data")
	const evidencePath = path.join(fixtureRoot, "private evidence")
	const fakeCodePath = path.join(fixtureRoot, "fake VS Code Ω", "Code.exe")
	const collectorLogPath = path.join(fixtureRoot, "collector invocations.jsonl")

	await Promise.all([
		fs.mkdir(repositoryPath, { recursive: true }),
		fs.mkdir(localAppData, { recursive: true }),
		fs.mkdir(path.dirname(fakeCodePath), { recursive: true }),
	])
	await compileFakeCode(fakeCodePath)

	const payloadValues = new Map([
		["collector/live-gray-screen-capture.mjs", options.collectorSource ?? fakeCollectorSource],
		["extension/zoo-code-3.80.0.vsix", Buffer.from("fixture-vsix\n", "utf8")],
		["notices/Zoo-Code-LICENSE.txt", "fixture license\n"],
		["README.md", "# Fixture portable kit\n"],
	])
	for (const [relativePath, value] of Object.entries(options.additionalPayload ?? {})) {
		payloadValues.set(relativePath, value)
	}

	const payload = []
	for (const [relativePath, value] of [...payloadValues].sort(([left], [right]) => left.localeCompare(right))) {
		const filePath = await writePayload(bundleRoot, relativePath, value)
		const bytes = await fs.readFile(filePath)
		payload.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) })
	}

	const extensionPayload = payload.find(({ path: relativePath }) => relativePath === "extension/zoo-code-3.80.0.vsix")
	const manifest = {
		schemaVersion: 1,
		kitFormatVersion: 1,
		source: { revision: "0123456789abcdef", dirty: false },
		prerequisites: {
			minimumNodeMajor: 22,
			testedNodeVersion: "22.23.1",
			minimumPowerShellMajor: 5,
			platform: "win32",
			architectures: [process.arch],
		},
		collector: { schemaVersion: 1, entry: "collector/live-gray-screen-capture.mjs" },
		extension: {
			id: "ZooCodeOrganization.zoo-code",
			name: "zoo-code",
			version: "3.80.0",
			enginesVscode: "^1.100.0",
			packagePath: "extension/zoo-code-3.80.0.vsix",
			bytes: extensionPayload.bytes,
			sha256: extensionPayload.sha256,
		},
		payload,
	}
	options.mutateManifest?.(manifest)
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
	await fs.writeFile(path.join(bundleRoot, "kit-manifest.json"), manifestText, "utf8")

	const sourceLauncher = await fs.readFile(sourceLauncherPath, "utf8")
	const placeholder = "__KIT_MANIFEST_SHA256__"
	const occurrences = sourceLauncher.split(placeholder).length - 1
	if (occurrences !== 1) throw new Error(`Expected one launcher manifest placeholder, found ${occurrences}.`)
	const launcherText = options.unstamped ? sourceLauncher : sourceLauncher.replace(placeholder, sha256(manifestText))
	await fs.writeFile(launcherPath, launcherText, "utf8")

	const fixture = {
		root: fixtureRoot,
		repositoryPath,
		bundleRoot,
		launcherPath,
		localAppData,
		evidencePath,
		fakeCodePath,
		collectorLogPath,
		manifest,
		env: {
			...process.env,
			LOCALAPPDATA: localAppData,
			ZOO_FAKE_COLLECTOR_LOG: collectorLogPath,
		},
	}
	testContext.after(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
	})
	return fixture
}

export async function initializeConventionalGitRepository(fixture, preexistingExclude = "") {
	const result = await execFileResult("git.exe", ["init", "--quiet", fixture.repositoryPath], {
		cwd: fixture.root,
		env: fixture.env,
	})
	if (result.exitCode !== 0) throw new Error(`Could not initialize fixture Git repository:\n${result.stderr}`)
	const excludePath = path.join(fixture.repositoryPath, ".git", "info", "exclude")
	if (preexistingExclude) await fs.appendFile(excludePath, preexistingExclude, "utf8")
	return excludePath
}

export async function readCollectorInvocations(fixture) {
	try {
		const text = await fs.readFile(fixture.collectorLogPath, "utf8")
		return text
			.split(/\r?\n/u)
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	} catch (error) {
		if (error?.code === "ENOENT") return []
		throw error
	}
}

export function launcherStatePaths(fixture) {
	const key = sha256(Buffer.from(path.resolve(fixture.launcherPath).toLowerCase(), "utf8"))
	const directory = path.join(fixture.localAppData, "ZooCode", "GrayScreenCapture", "state")
	return {
		directory,
		state: path.join(directory, `launcher-${key}.json`),
		lock: path.join(directory, `launcher-${key}.lock`),
	}
}

export function launcherArguments(fixture, action, additionalArguments = [], options = {}) {
	return [
		"-Action",
		action,
		"-NodePath",
		options.nodePath ?? process.execPath,
		"-CodePath",
		options.codePath ?? fixture.fakeCodePath,
		"-OutputPath",
		options.outputPath ?? fixture.evidencePath,
		...additionalArguments,
	]
}

export function execFileResult(filePath, args, options = {}) {
	return new Promise((resolve) => {
		execFile(
			filePath,
			args,
			{
				cwd: options.cwd,
				env: options.env,
				timeout: options.timeout ?? 30_000,
				windowsHide: true,
				maxBuffer: 2 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				resolve({
					exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
					signal: error?.signal ?? null,
					stdout,
					stderr,
					error,
				})
			},
		)
	})
}

export function runLauncher(fixture, action, additionalArguments = [], options = {}) {
	return execFileResult(
		powershellPath,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			fixture.launcherPath,
			...launcherArguments(fixture, action, additionalArguments, options),
		],
		{
			cwd: options.cwd ?? fixture.repositoryPath,
			env: { ...fixture.env, ...options.env },
			timeout: options.timeout,
		},
	)
}

export function spawnLauncher(fixture, action, additionalArguments = [], options = {}) {
	return spawn(
		powershellPath,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			fixture.launcherPath,
			...launcherArguments(fixture, action, additionalArguments, options),
		],
		{
			cwd: options.cwd ?? fixture.repositoryPath,
			env: { ...fixture.env, ...options.env },
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	)
}

export async function waitFor(predicate, options = {}) {
	const deadline = Date.now() + (options.timeout ?? 10_000)
	let lastError
	while (Date.now() < deadline) {
		try {
			const value = await predicate()
			if (value) return value
		} catch (error) {
			lastError = error
		}
		await new Promise((resolve) => setTimeout(resolve, options.interval ?? 25))
	}
	if (lastError) throw lastError
	throw new Error(options.message ?? "Timed out waiting for fixture condition.")
}
