import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { execFileResult, powershellPath } from "./fixtures.mjs"

const packagerPath = fileURLToPath(new URL("../Build-PortableGrayScreenKit.ps1", import.meta.url))
const launcherPath = fileURLToPath(new URL("../Start-ZooCodeGrayScreenCapture.ps1", import.meta.url))
const portableReadmePath = fileURLToPath(new URL("../README.md", import.meta.url))
const operatorGuidePath = fileURLToPath(new URL("../OPERATOR-GUIDE.md", import.meta.url))
const liveCollectorPath = fileURLToPath(new URL("../../live-gray-screen-capture.mjs", import.meta.url))

const extensionVersion = "3.80.0"
const kitName = `ZooCodeGrayScreenCapture-${extensionVersion}-kit1`
const fixedEpoch = 1_700_000_000

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
		return 0;
	}
}
`

const fakeCollectorEntry = String.raw`#!/usr/bin/env node
import { SCHEMA_VERSION } from "./live-gray-screen-capture/constants.mjs"

if (process.argv.includes("--help")) {
	process.stdout.write("fixture collector schema " + SCHEMA_VERSION + "\n")
	process.exitCode = 0
} else {
	process.exitCode = 64
}
`

function sha256(value) {
	return createHash("sha256").update(value).digest("hex")
}

async function writeFile(filePath, value) {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, value)
}

async function readTree(root) {
	const records = []
	async function visit(current) {
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name)
			if (entry.isDirectory()) await visit(fullPath)
			else if (entry.isFile()) {
				const bytes = await fs.readFile(fullPath)
				records.push({
					path: path.relative(root, fullPath).replaceAll(path.sep, "/"),
					bytes: bytes.byteLength,
					sha256: sha256(bytes),
				})
			}
		}
	}
	await visit(root)
	return records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
}

async function runPowerShellCommand(command, env = process.env) {
	const result = await execFileResult(
		powershellPath,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
		{ env, timeout: 120_000 },
	)
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
	return result.stdout
}

async function compileFakeCode(outputPath) {
	await fs.mkdir(path.dirname(outputPath), { recursive: true })
	const asciiBuildRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-code-build-"))
	const temporaryOutput = path.join(asciiBuildRoot, "Code.exe")
	const command = [
		"$source = [Environment]::GetEnvironmentVariable('ZOO_FIXTURE_CODE_SOURCE')",
		"$output = [Environment]::GetEnvironmentVariable('ZOO_FIXTURE_CODE_OUTPUT')",
		"Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $output -OutputType ConsoleApplication",
	].join("; ")
	try {
		await runPowerShellCommand(command, {
			...process.env,
			ZOO_FIXTURE_CODE_SOURCE: fakeCodeSource,
			ZOO_FIXTURE_CODE_OUTPUT: temporaryOutput,
		})
		await fs.copyFile(temporaryOutput, outputPath)
	} finally {
		await fs.rm(asciiBuildRoot, { recursive: true, force: true })
	}
}

async function createVsix(vsixPath, options = {}) {
	const packageManifest = {
		name: "zoo-code",
		publisher: "ZooCodeOrganization",
		version: extensionVersion,
		engines: { vscode: "^1.100.0", node: "22.23.1" },
		main: "./dist/extension.js",
	}
	const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
			<Identity Id="zoo-code" Version="${extensionVersion}" Publisher="ZooCodeOrganization" />
  </Metadata>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
  </Assets>
</PackageManifest>
`
	const entries = [
		[
			"[Content_Types].xml",
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" />\n',
		],
		["extension.vsixmanifest", vsixManifest],
		["extension/package.json", `${JSON.stringify(packageManifest)}\n`],
		["extension/dist/extension.js", "module.exports = {}\n"],
		["extension/webview-ui/build/assets/main.css", "body{}\n"],
		["extension/webview-ui/build/assets/main.js", "console.log('fixture')\n"],
	]
	if (options.extraEntry) entries.push([options.extraEntry, "extra\n"])
	await fs.mkdir(path.dirname(vsixPath), { recursive: true })
	await fs.rm(vsixPath, { force: true })
	const command = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.IO.Compression",
		"Add-Type -AssemblyName System.IO.Compression.FileSystem",
		"$destination = [Environment]::GetEnvironmentVariable('ZOO_FIXTURE_ZIP_DESTINATION')",
		"$records = [Environment]::GetEnvironmentVariable('ZOO_FIXTURE_ZIP_RECORDS') | ConvertFrom-Json",
		"$utf8 = New-Object System.Text.UTF8Encoding($false)",
		"$stream = New-Object System.IO.FileStream($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
		"$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true, $utf8)",
		"try { foreach ($record in $records) { $entry = $archive.CreateEntry([string]$record.path, [System.IO.Compression.CompressionLevel]::Optimal); $output = $entry.Open(); try { $bytes = [Convert]::FromBase64String([string]$record.base64); $output.Write($bytes, 0, $bytes.Length) } finally { $output.Dispose() } } } finally { $archive.Dispose(); $stream.Dispose() }",
	].join("; ")
	await runPowerShellCommand(command, {
		...process.env,
		ZOO_FIXTURE_ZIP_DESTINATION: vsixPath,
		ZOO_FIXTURE_ZIP_RECORDS: JSON.stringify(
			entries.map(([entryPath, value]) => ({
				path: entryPath,
				base64: Buffer.from(value, "utf8").toString("base64"),
			})),
		),
	})
}

async function createSourceFixture(testContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "Zoo packager source Ω with spaces-"))
	const sourceRoot = path.join(root, "external source Ω with spaces")
	const outputRoot = path.join(root, "generated output Ω with spaces")
	const fakeCodePath = path.join(root, "fake VS Code Ω", "Code.exe")
	const vsixPath = path.join(root, "fixture package Ω", `zoo-code-${extensionVersion}.vsix`)
	const fixturePackagerRoot = path.join(sourceRoot, "scripts", "portable-gray-screen-kit")
	const fixturePackagerPath = path.join(fixturePackagerRoot, "Build-PortableGrayScreenKit.ps1")
	await fs.mkdir(sourceRoot, { recursive: true })
	await fs.mkdir(fixturePackagerRoot, { recursive: true })
	await compileFakeCode(fakeCodePath)

	const packageJson = {
		name: "roo-code-fixture",
		engines: { node: "22.23.1" },
		scripts: { vsix: "fixture-only" },
	}
	const extensionPackageJson = {
		name: "zoo-code",
		publisher: "ZooCodeOrganization",
		version: extensionVersion,
		engines: { vscode: "^1.100.0", node: "22.23.1" },
		main: "./dist/extension.js",
	}
	await Promise.all([
		fs.copyFile(packagerPath, fixturePackagerPath),
		fs.copyFile(launcherPath, path.join(fixturePackagerRoot, "Start-ZooCodeGrayScreenCapture.ps1")),
		fs.copyFile(portableReadmePath, path.join(fixturePackagerRoot, "README.md")),
		fs.copyFile(operatorGuidePath, path.join(fixturePackagerRoot, "OPERATOR-GUIDE.md")),
		writeFile(path.join(sourceRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
		writeFile(path.join(sourceRoot, "src", "package.json"), `${JSON.stringify(extensionPackageJson, null, 2)}\n`),
		writeFile(path.join(sourceRoot, ".nvmrc"), "22.23.1\n"),
		writeFile(path.join(sourceRoot, "LICENSE"), "fixture license\n"),
		writeFile(path.join(sourceRoot, "scripts", "live-gray-screen-capture.mjs"), fakeCollectorEntry),
		writeFile(
			path.join(sourceRoot, "scripts", "live-gray-screen-capture", "constants.mjs"),
			"export const SCHEMA_VERSION = 1\n",
		),
		writeFile(
			path.join(sourceRoot, "scripts", "live-gray-screen-capture", "process-sampler-worker.mjs"),
			"export const worker = 'process'\n",
		),
		writeFile(
			path.join(sourceRoot, "scripts", "live-gray-screen-capture", "snapshot-validator-worker.mjs"),
			"export const worker = 'snapshot'\n",
		),
		writeFile(
			path.join(sourceRoot, "scripts", "live-gray-screen-capture", "runtime-extra.mjs"),
			"export const runtime = true\n",
		),
		writeFile(path.join(sourceRoot, "scripts", "live-gray-screen-capture", "README.md"), "must not be copied\n"),
		writeFile(
			path.join(sourceRoot, "scripts", "live-gray-screen-capture", "__tests__", "must-not-copy.test.mjs"),
			"throw new Error()\n",
		),
	])
	await createVsix(vsixPath)

	const init = await execFileResult("git.exe", ["init", "--quiet", sourceRoot], { cwd: root })
	assert.equal(init.exitCode, 0, init.stderr)
	const configureName = await execFileResult("git.exe", ["-C", sourceRoot, "config", "user.name", "Zoo Fixture"], {
		cwd: root,
	})
	assert.equal(configureName.exitCode, 0, configureName.stderr)
	const configureEmail = await execFileResult(
		"git.exe",
		["-C", sourceRoot, "config", "user.email", "zoo@example.invalid"],
		{ cwd: root },
	)
	assert.equal(configureEmail.exitCode, 0, configureEmail.stderr)
	const add = await execFileResult("git.exe", ["-C", sourceRoot, "add", "--all"], { cwd: root })
	assert.equal(add.exitCode, 0, add.stderr)
	const commit = await execFileResult("git.exe", ["-C", sourceRoot, "commit", "--quiet", "-m", "fixture source"], {
		cwd: root,
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2023-11-14T22:13:20Z",
			GIT_COMMITTER_DATE: "2023-11-14T22:13:20Z",
		},
	})
	assert.equal(commit.exitCode, 0, commit.stderr)

	testContext.after(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
	})
	return { root, sourceRoot, outputRoot, fakeCodePath, vsixPath, fixturePackagerPath }
}

function prependExecutablePaths(environment, directories) {
	const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "Path"
	return {
		...environment,
		[pathKey]: [...directories, environment[pathKey]].filter(Boolean).join(path.delimiter),
	}
}

function packagerArguments(fixture, extra = []) {
	return [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		fixture.fixturePackagerPath,
		"-OutputRoot",
		fixture.outputRoot,
		"-SkipVsixBuild",
		"-VsixPath",
		fixture.vsixPath,
		"-SourceDateEpoch",
		String(fixedEpoch),
		...extra,
	]
}

function runPackager(fixture, extra = [], options = {}) {
	return execFileResult(powershellPath, packagerArguments(fixture, extra), {
		cwd: options.cwd ?? fixture.root,
		env: prependExecutablePaths(options.env ?? process.env, [
			path.dirname(fixture.fakeCodePath),
			path.dirname(process.execPath),
		]),
		timeout: options.timeout ?? 180_000,
	})
}

async function listZip(vsixOrZipPath) {
	const command = [
		"Add-Type -AssemblyName System.IO.Compression.FileSystem",
		"$archivePath = [Environment]::GetEnvironmentVariable('ZOO_FIXTURE_ARCHIVE')",
		"$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)",
		"try { $archive.Entries | ForEach-Object { [pscustomobject]@{ path = $_.FullName; bytes = $_.Length; timestamp = $_.LastWriteTime.UtcDateTime.ToString('o') } } | ConvertTo-Json -Compress } finally { $archive.Dispose() }",
	].join("; ")
	const stdout = await runPowerShellCommand(command, { ...process.env, ZOO_FIXTURE_ARCHIVE: vsixOrZipPath })
	const parsed = JSON.parse(stdout)
	return Array.isArray(parsed) ? parsed : [parsed]
}

test(
	"packages, stamps, validates, and deterministically archives a fixture source outside the checkout",
	{ timeout: 180_000 },
	async (t) => {
		const fixture = await createSourceFixture(t)
		const unrelatedCwd = await fs.mkdtemp(path.join(fixture.root, "unrelated caller Ω with spaces-"))
		const result = await runPackager(fixture, [], { cwd: unrelatedCwd })
		assert.equal(result.exitCode, 0, result.stderr || result.stdout)
		assert.match(result.stdout, /Portable ZooCode gray-screen kit built and validated\./u)

		const unpackedRoot = path.join(fixture.outputRoot, kitName)
		const zipPath = path.join(fixture.outputRoot, `${kitName}.zip`)
		const bundleRoot = path.join(unpackedRoot, "ZooCodeGrayScreenCapture.bundle")
		const manifestPath = path.join(bundleRoot, "kit-manifest.json")
		const generatedLauncherPath = path.join(unpackedRoot, "Start-ZooCodeGrayScreenCapture.ps1")
		const manifestBytes = await fs.readFile(manifestPath)
		const manifestText = manifestBytes.toString("utf8")
		const manifest = JSON.parse(manifestText)
		assert.equal(manifestText.endsWith("\n"), true)
		assert.equal(manifestText.includes("\r"), false)
		assert.equal(manifest.source.dirty, false)
		assert.equal(manifest.prerequisites.testedNodeVersion, "22.23.1")
		assert.deepEqual(manifest.prerequisites.architectures, [process.arch])
		assert.equal(manifest.extension.id, "ZooCodeOrganization.zoo-code")
		assert.equal(manifest.extension.version, extensionVersion)

		const payloadPaths = manifest.payload.map(({ path: relativePath }) => relativePath)
		assert.deepEqual(
			payloadPaths,
			[...payloadPaths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
		)
		assert.equal(payloadPaths.includes("collector/live-gray-screen-capture/process-sampler-worker.mjs"), true)
		assert.equal(payloadPaths.includes("collector/live-gray-screen-capture/snapshot-validator-worker.mjs"), true)
		assert.equal(payloadPaths.includes("OPERATOR-GUIDE.md"), true)
		assert.equal(
			payloadPaths.some((relativePath) => relativePath.includes("__tests__")),
			false,
		)
		assert.equal(
			payloadPaths.some(
				(relativePath) => relativePath.endsWith("README.md") && relativePath.startsWith("collector/"),
			),
			false,
		)

		const actualPayload = (await readTree(bundleRoot)).filter(
			({ path: relativePath }) => relativePath !== "kit-manifest.json",
		)
		assert.deepEqual(actualPayload, manifest.payload)
		const generatedLauncher = await fs.readFile(generatedLauncherPath, "utf8")
		assert.equal(generatedLauncher.includes("__KIT_MANIFEST_SHA256__"), false)
		const manifestHash = sha256(manifestBytes)
		assert.equal(generatedLauncher.split(manifestHash).length - 1, 1)

		const zipEntries = await listZip(zipPath)
		const zipPaths = zipEntries.map(({ path: entryPath }) => entryPath)
		assert.deepEqual(
			zipPaths,
			[...zipPaths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
		)
		assert.equal(
			zipPaths.every((entryPath) => entryPath.startsWith(`${kitName}/`)),
			true,
		)
		assert.equal(
			zipPaths.some((entryPath) => entryPath.includes("../") || entryPath.startsWith("/")),
			false,
		)
		assert.equal(new Set(zipEntries.map(({ timestamp }) => timestamp)).size, 1)
		assert.equal(zipEntries[0].timestamp, "2023-11-14T22:13:20.0000000Z")

		const zipHashOne = sha256(await fs.readFile(zipPath))
		const forceResult = await runPackager(fixture, ["-Force"], { cwd: unrelatedCwd })
		assert.equal(forceResult.exitCode, 0, forceResult.stderr || forceResult.stdout)
		const zipHashTwo = sha256(await fs.readFile(zipPath))
		assert.equal(zipHashTwo, zipHashOne)
	},
)

test(
	"requires Force for an existing version and never merges stale generated files",
	{ timeout: 180_000 },
	async (t) => {
		const fixture = await createSourceFixture(t)
		const first = await runPackager(fixture)
		assert.equal(first.exitCode, 0, first.stderr || first.stdout)
		const unpackedRoot = path.join(fixture.outputRoot, kitName)
		const stalePath = path.join(unpackedRoot, "stale-file-that-must-not-survive.txt")
		await fs.writeFile(stalePath, "stale\n")

		const refused = await runPackager(fixture)
		assert.equal(refused.exitCode, 1)
		assert.match(refused.stderr, /OUTPUT_EXISTS/u)
		assert.equal(await fs.readFile(stalePath, "utf8"), "stale\n")

		const replaced = await runPackager(fixture, ["-Force"])
		assert.equal(replaced.exitCode, 0, replaced.stderr || replaced.stdout)
		await assert.rejects(fs.access(stalePath), { code: "ENOENT" })
	},
)

test("a staging validation failure leaves no final kit or ZIP", { timeout: 180_000 }, async (t) => {
	const fixture = await createSourceFixture(t)
	await fs.writeFile(fixture.fakeCodePath, "not a Windows executable\n")
	const result = await runPackager(fixture)
	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /CODE_VERSION|PORTABLE_PACKAGER_FAILED/u)
	await assert.rejects(fs.access(path.join(fixture.outputRoot, kitName)), { code: "ENOENT" })
	await assert.rejects(fs.access(path.join(fixture.outputRoot, `${kitName}.zip`)), { code: "ENOENT" })
	const leftovers = await fs
		.readdir(fixture.outputRoot)
		.catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)))
	assert.deepEqual(leftovers, [])
})

test("rejects unsafe or incomplete VSIX input before generated output", { timeout: 180_000 }, async (t) => {
	const fixture = await createSourceFixture(t)
	await fs.writeFile(fixture.vsixPath, "not a VSIX ZIP\n")
	const result = await runPackager(fixture)
	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /VSIX_INVALID_ZIP|VSIX_ENTRY_COUNT|VSIX_LAYOUT/u)
	await assert.rejects(fs.access(path.join(fixture.outputRoot, kitName)), { code: "ENOENT" })
})

test(
	"real package integrity can be selected explicitly",
	{ timeout: 600_000, skip: process.env.ZOO_RUN_REAL_PORTABLE_PACKAGE_TEST !== "1" },
	async (t) => {
		const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))
		const rootPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"))
		const extensionPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, "src", "package.json"), "utf8"))
		assert.equal(rootPackage.engines.node, "22.23.1")
		const realVsixPath =
			process.env.ZOO_REAL_VSIX_PATH ??
			path.join(repositoryRoot, "bin", `zoo-code-${extensionPackage.version}.vsix`)
		const realCodePath = process.env.ZOO_REAL_CODE_PATH
		assert.ok(realCodePath, "ZOO_REAL_CODE_PATH must identify stable Code.exe for the real package gate")
		const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "Zoo real package gate Ω with spaces-"))
		t.after(async () => fs.rm(outputRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
		const args = [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			packagerPath,
			"-OutputRoot",
			outputRoot,
			"-SourceDateEpoch",
			String(fixedEpoch),
			...(process.env.ZOO_REAL_VSIX_PATH ? ["-SkipVsixBuild", "-VsixPath", realVsixPath] : []),
			...(process.env.ZOO_ALLOW_DIRTY_REAL_PACKAGE_TEST === "1" ? ["-AllowDirtySource"] : []),
		]
		const result = await new Promise((resolve) => {
			execFile(
				powershellPath,
				args,
				{
					cwd: repositoryRoot,
					env: prependExecutablePaths(process.env, [
						path.dirname(realCodePath),
						path.dirname(process.execPath),
					]),
					timeout: 600_000,
					windowsHide: true,
					maxBuffer: 8 * 1024 * 1024,
				},
				(error, stdout, stderr) =>
					resolve({ exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr }),
			)
		})
		assert.equal(result.exitCode, 0, result.stderr || result.stdout)
		const realKitName = `ZooCodeGrayScreenCapture-${extensionPackage.version}-kit1`
		const manifest = JSON.parse(
			await fs.readFile(
				path.join(outputRoot, realKitName, "ZooCodeGrayScreenCapture.bundle", "kit-manifest.json"),
				"utf8",
			),
		)
		assert.equal(manifest.extension.sha256, sha256(await fs.readFile(realVsixPath)))
		assert.equal(manifest.extension.id, `${extensionPackage.publisher}.${extensionPackage.name}`)
		assert.equal(manifest.extension.enginesVscode, extensionPackage.engines.vscode)
		assert.ok(
			manifest.payload.some(({ path: relativePath }) => relativePath.endsWith("process-sampler-worker.mjs")),
		)
		assert.ok(
			manifest.payload.some(({ path: relativePath }) => relativePath.endsWith("snapshot-validator-worker.mjs")),
		)
	},
)

test("packager source files remain parseable and the launcher placeholder occurs exactly once", async () => {
	const sourceLauncher = await fs.readFile(launcherPath, "utf8")
	const packagerSource = await fs.readFile(packagerPath, "utf8")
	const publicParameterBlock = packagerSource.slice(0, packagerSource.indexOf("Set-StrictMode"))
	assert.equal(sourceLauncher.split("__KIT_MANIFEST_SHA256__").length - 1, 1)
	assert.doesNotMatch(publicParameterBlock, /\$(?:NodePath|CodePath|SourceRoot|SourceRevision|SourceCommitEpoch)\b/u)
	assert.match(await fs.readFile(portableReadmePath, "utf8"), /original.*unmonitored|remains \*\*unmonitored\*\*/isu)
	assert.match(await fs.readFile(liveCollectorPath, "utf8"), /assertSupportedRuntime/u)
	const command = [
		"$tokens = $null",
		"$errors = $null",
		"[void][System.Management.Automation.Language.Parser]::ParseFile([Environment]::GetEnvironmentVariable('ZOO_PACKAGER_PATH'), [ref]$tokens, [ref]$errors)",
		"if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
	].join("; ")
	await runPowerShellCommand(command, { ...process.env, ZOO_PACKAGER_PATH: packagerPath })
})
