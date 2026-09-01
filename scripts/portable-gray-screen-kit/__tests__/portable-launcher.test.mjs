import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import test from "node:test"

import {
	createPortableKitFixture,
	execFileResult,
	initializeConventionalGitRepository,
	launcherStatePaths,
	powershellPath,
	readCollectorInvocations,
	runLauncher,
	spawnLauncher,
	waitFor,
} from "./fixtures.mjs"

const windowsTest = process.platform === "win32" ? test : test.skip

function observeChild(child) {
	let stdout = ""
	let stderr = ""
	child.stdout.setEncoding("utf8")
	child.stderr.setEncoding("utf8")
	child.stdout.on("data", (chunk) => {
		stdout += chunk
	})
	child.stderr.on("data", (chunk) => {
		stderr += chunk
	})
	const exited = new Promise((resolve, reject) => {
		child.once("error", reject)
		child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }))
	})
	return {
		get stdout() {
			return stdout
		},
		get stderr() {
			return stderr
		},
		exited,
	}
}

async function terminateFixtureProcess(child) {
	if (child.exitCode !== null || child.signalCode !== null) return
	await execFileResult("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 15_000 })
}

async function readJsonWhenPresent(filePath) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	} catch (error) {
		if (error?.code === "ENOENT" || error instanceof SyntaxError) return null
		throw error
	}
}

windowsTest("validates a stamped kit copied to an external repository with spaces and Unicode", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const result = await runLauncher(fixture, "Validate")

	assert.equal(result.exitCode, 0, result.stderr)
	assert.match(result.stdout, /Portable ZooCode gray-screen kit is valid\./)
	assert.match(result.stdout, /ZooCodeOrganization\.zoo-code@3\.80\.0/)
	assert.match(result.stdout, /external repo Ω with spaces/)
	assert.equal(result.stderr, "")
	assert.deepEqual(await readCollectorInvocations(fixture), [])
})

windowsTest("rejects a payload changed after the launcher was stamped", async (t) => {
	const fixture = await createPortableKitFixture(t)
	await fs.appendFile(path.join(fixture.bundleRoot, "README.md"), "changed\n", "utf8")

	const result = await runLauncher(fixture, "Validate")

	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /PAYLOAD_MISMATCH/)
})

windowsTest("rejects an unexpected payload file", async (t) => {
	const fixture = await createPortableKitFixture(t)
	await fs.writeFile(path.join(fixture.bundleRoot, "unexpected.txt"), "unexpected\n", "utf8")

	const result = await runLauncher(fixture, "Validate")

	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /EXTRA_PAYLOAD/)
})

windowsTest("rejects the unstamped source launcher", async (t) => {
	const fixture = await createPortableKitFixture(t, { unstamped: true })

	const result = await runLauncher(fixture, "Validate")

	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /UNSTAMPED_LAUNCHER/)
})

windowsTest("adds exact local-only Git exclusions idempotently and preserves tracked ignore files", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const excludePath = await initializeConventionalGitRepository(
		fixture,
		"# pre-existing local rule\n/private-local-only/\n",
	)
	const trackedIgnorePath = path.join(fixture.repositoryPath, ".gitignore")
	await fs.writeFile(trackedIgnorePath, "# tracked content must not change\n", "utf8")
	const addResult = await execFileResult("git.exe", ["-C", fixture.repositoryPath, "add", ".gitignore"])
	assert.equal(addResult.exitCode, 0, addResult.stderr)

	for (let run = 0; run < 2; run += 1) {
		const result = await runLauncher(fixture, "Start", [], {
			env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
			timeout: 15_000,
		})
		assert.equal(result.exitCode, 0, result.stderr)
	}
	const repositoryEvidencePath = path.join(fixture.repositoryPath, "private evidence [Ω] #!")
	const repositoryResult = await runLauncher(fixture, "Start", [], {
		outputPath: repositoryEvidencePath,
		env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
		timeout: 15_000,
	})
	assert.equal(repositoryResult.exitCode, 0, repositoryResult.stderr)

	const excludeText = await fs.readFile(excludePath, "utf8")
	assert.match(excludeText, /# pre-existing local rule\n\/private-local-only\//)
	assert.equal((excludeText.match(/# ZooCode gray-screen portable kit \(local only\)/gu) ?? []).length, 1)
	assert.match(excludeText, /^\/Start-ZooCodeGrayScreenCapture\.ps1$/mu)
	assert.match(excludeText, /^\/ZooCodeGrayScreenCapture\.bundle\/$/mu)
	assert.ok(excludeText.split(/\r?\n/u).includes(String.raw`/private\ evidence\ \[Ω\]\ \#\!/`))
	assert.equal(await fs.readFile(trackedIgnorePath, "utf8"), "# tracked content must not change\n")
})

windowsTest(
	"preserves exact Start arguments and safe defaults across spaces Unicode quotes and trailing backslashes",
	async (t) => {
		const fixture = await createPortableKitFixture(t)
		const explicitWorkspace = path.join(fixture.root, "workspace Ω apostrophe's and spaces")
		await fs.mkdir(explicitWorkspace, { recursive: true })
		const benignCodeArgument = '--locale=Ω value "quoted" C:\\fixture path\\'

		const result = await runLauncher(
			fixture,
			"Start",
			["-WorkspacePath", explicitWorkspace, "-CodeArgument", benignCodeArgument],
			{
				env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
				timeout: 15_000,
			},
		)

		assert.equal(result.exitCode, 0, result.stderr)
		assert.match(result.stdout, /currently open VS Code window will remain UNMONITORED/)
		assert.match(result.stdout, /PRIVATE SNAPSHOT WARNING/)
		assert.match(result.stdout, /MONITORING ACTIVE/)
		const invocations = await readCollectorInvocations(fixture)
		assert.equal(invocations.length, 1)
		const args = invocations[0].args
		assert.equal(args[0], "launch")
		assert.equal(args[args.indexOf("--workspace") + 1], explicitWorkspace)
		assert.equal(args[args.indexOf("--output") + 1], fixture.evidencePath)
		assert.equal(args[args.indexOf("--code") + 1], fixture.fakeCodePath)
		assert.equal(
			args[args.indexOf("--extension-vsix") + 1],
			path.join(fixture.bundleRoot, "extension", "zoo-code-3.80.0.vsix"),
		)
		assert.equal(args[args.indexOf("--profile-mode") + 1], "isolated")
		assert.equal(args[args.indexOf("--cdp-port") + 1], "0")
		assert.equal(args[args.indexOf("--heap-critical-ratio") + 1], "0.82")
		assert.equal(args[args.indexOf("--auto-snapshot-samples") + 1], "3")
		assert.ok(args.includes("--enable-transport-diagnostics"))
		assert.ok(args.includes("--enable-partial-coalescing"))
		assert.ok(args.includes("--enable-auto-snapshot"))
		assert.deepEqual(args.slice(args.indexOf("--") + 1), ["--new-window", benignCodeArgument])
	},
)

windowsTest("uses the launcher parent as workspace regardless of caller current directory", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const differentCurrentDirectory = path.join(fixture.root, "different caller directory")
	await fs.mkdir(differentCurrentDirectory, { recursive: true })

	const result = await runLauncher(fixture, "Start", [], {
		cwd: differentCurrentDirectory,
		env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
		timeout: 15_000,
	})

	assert.equal(result.exitCode, 0, result.stderr)
	const [invocation] = await readCollectorInvocations(fixture)
	assert.equal(invocation.args[invocation.args.indexOf("--workspace") + 1], fixture.repositoryPath)
})

windowsTest("omits optional diagnostics and automatic snapshots only when explicitly disabled", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const result = await runLauncher(
		fixture,
		"Start",
		["-DisableTransportDiagnostics", "-DisablePartialCoalescing", "-DisableAutoSnapshots"],
		{
			env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
			timeout: 15_000,
		},
	)

	assert.equal(result.exitCode, 0, result.stderr)
	assert.doesNotMatch(result.stdout, /PRIVATE SNAPSHOT WARNING/)
	const [invocation] = await readCollectorInvocations(fixture)
	for (const omitted of [
		"--enable-transport-diagnostics",
		"--enable-partial-coalescing",
		"--enable-auto-snapshot",
		"--heap-critical-ratio",
		"--auto-snapshot-samples",
	]) {
		assert.ok(!invocation.args.includes(omitted), `Unexpected argument: ${omitted}`)
	}
})

windowsTest("rejects protected VS Code passthrough before starting the collector", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const result = await runLauncher(fixture, "Start", ["-CodeArgument", "--remote-debugging-port=9333"])

	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /PROTECTED_CODE_ARGUMENT/)
	assert.deepEqual(await readCollectorInvocations(fixture), [])
})

windowsTest("rejects an explicitly occupied loopback CDP port before starting the collector", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const server = net.createServer()
	await new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))
	const { port } = server.address()

	const result = await runLauncher(fixture, "Start", ["-CdpPort", String(port)])

	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /CDP_PORT_IN_USE/)
	assert.deepEqual(await readCollectorInvocations(fixture), [])
})

windowsTest("warns without mutating Git metadata for an indirection worktree", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const conventionalExcludePath = await initializeConventionalGitRepository(
		fixture,
		"# shared metadata remains untouched\n",
	)
	const actualGitDirectory = path.join(fixture.root, "shared Git metadata Ω")
	await fs.rename(path.join(fixture.repositoryPath, ".git"), actualGitDirectory)
	await fs.writeFile(path.join(fixture.repositoryPath, ".git"), `gitdir: ${actualGitDirectory}\n`, "utf8")
	const excludePath = path.join(actualGitDirectory, "info", "exclude")
	assert.equal(conventionalExcludePath.endsWith(path.join(".git", "info", "exclude")), true)

	const result = await runLauncher(fixture, "Start", [], {
		env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
		timeout: 15_000,
	})

	assert.equal(result.exitCode, 0, result.stderr)
	assert.match(`${result.stdout}\n${result.stderr}`, /Linked or unusual worktree detected/)
	assert.equal(
		await fs.readFile(excludePath, "utf8"),
		"# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n# shared metadata remains untouched\n",
	)
})

windowsTest(
	"SkipLocalGitExclude is warning-only and repository output then needs explicit acknowledgment",
	async (t) => {
		const fixture = await createPortableKitFixture(t)
		const excludePath = await initializeConventionalGitRepository(fixture, "# unchanged\n")
		const before = await fs.readFile(excludePath, "utf8")
		const repositoryEvidencePath = path.join(fixture.repositoryPath, "sensitive evidence")

		const refused = await runLauncher(fixture, "Start", ["-SkipLocalGitExclude"], {
			outputPath: repositoryEvidencePath,
		})
		assert.equal(refused.exitCode, 1)
		assert.match(refused.stderr, /REPOSITORY_OUTPUT_ACK_REQUIRED/)
		assert.equal(await fs.readFile(excludePath, "utf8"), before)
		assert.deepEqual(await readCollectorInvocations(fixture), [])

		const acknowledged = await runLauncher(
			fixture,
			"Start",
			["-SkipLocalGitExclude", "-AcknowledgeRepositoryOutputRisk"],
			{
				outputPath: repositoryEvidencePath,
				env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
				timeout: 15_000,
			},
		)
		assert.equal(acknowledged.exitCode, 0, acknowledged.stderr)
		assert.match(`${acknowledged.stdout}\n${acknowledged.stderr}`, /Local Git exclusion was skipped explicitly/)
		assert.equal(await fs.readFile(excludePath, "utf8"), before)
	},
)

windowsTest(
	"foreground Start supports active Status Snapshot and cross-terminal Stop with private state cleanup",
	{ timeout: 30_000 },
	async (t) => {
		const fixture = await createPortableKitFixture(t)
		const statePaths = launcherStatePaths(fixture)
		const start = spawnLauncher(fixture, "Start")
		const observed = observeChild(start)
		t.after(() => terminateFixtureProcess(start))

		const activeState = await waitFor(() => readJsonWhenPresent(statePaths.state), {
			timeout: 12_000,
			message: "Timed out waiting for private active launcher state.",
		})
		await waitFor(() => observed.stdout.includes("MONITORING ACTIVE"), {
			timeout: 5_000,
			message: "Timed out waiting for the monitored-window banner.",
		})
		assert.equal(start.exitCode, null, "Start must remain foreground while capture is active")
		assert.equal(activeState.outputPath, fixture.evidencePath)
		assert.equal(
			activeState.collectorPath,
			path.join(fixture.bundleRoot, "collector", "live-gray-screen-capture.mjs"),
		)
		assert.ok(!activeState.runPath.startsWith(fixture.repositoryPath + path.sep))
		assert.deepEqual(Object.keys(activeState).sort(), [
			"collectorCreationTimeUtc",
			"collectorPath",
			"collectorPid",
			"kitFormatVersion",
			"nodePath",
			"outputPath",
			"runPath",
			"schemaVersion",
			"startedUtc",
		])
		const aclCommand = [
			"$acl = Get-Acl -LiteralPath $env:ZOO_FIXTURE_STATE_DIRECTORY",
			"[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; identities = @($acl.Access | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress",
		].join("; ")
		const aclResult = await execFileResult(
			powershellPath,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclCommand],
			{ env: { ...process.env, ZOO_FIXTURE_STATE_DIRECTORY: statePaths.directory } },
		)
		assert.equal(aclResult.exitCode, 0, aclResult.stderr)
		const stateAcl = JSON.parse(aclResult.stdout)
		assert.equal(stateAcl.protected, true)
		assert.deepEqual(new Set(stateAcl.identities).size, 1)

		const status = await runLauncher(fixture, "Status")
		assert.equal(status.exitCode, 0, status.stderr)
		assert.match(status.stdout, /State: capturing/)
		assert.match(status.stdout, /Auto snapshots: True; threshold: 0\.82; consecutive samples: 3/)

		const refusedSnapshot = await runLauncher(fixture, "Snapshot")
		assert.equal(refusedSnapshot.exitCode, 1)
		assert.match(refusedSnapshot.stderr, /SNAPSHOT_ACK_REQUIRED/)

		const snapshot = await runLauncher(fixture, "Snapshot", [
			"-AcknowledgeSnapshotPrivacyRisk",
			"-TargetOrdinal",
			"7",
			"-OverrideCooldown",
			"-AllowUnresponsiveAttempt",
		])
		assert.equal(snapshot.exitCode, 0, snapshot.stderr)
		assert.match(snapshot.stdout, /Fixture snapshot requested/)
		const snapshotArguments = JSON.parse(
			await fs.readFile(path.join(activeState.runPath, "fixture-snapshot-request"), "utf8"),
		)
		assert.deepEqual(snapshotArguments, [
			"snapshot",
			"--run-dir",
			activeState.runPath,
			"--reason",
			"manual",
			"--acknowledge-manual-snapshot-risk",
			"--target-ordinal",
			"7",
			"--override-cooldown",
			"--allow-unresponsive-attempt",
		])

		const stop = await runLauncher(fixture, "Stop", ["-SnapshotPolicy", "Abort"])
		assert.equal(stop.exitCode, 0, stop.stderr)
		assert.match(stop.stdout, /Fixture stop requested/)
		const terminal = await observed.exited
		assert.equal(terminal.exitCode, 0, observed.stderr)
		assert.match(observed.stdout, /Capture ended\./)
		assert.match(observed.stdout, /Classification: fixtureStopped/)

		const completedStatus = await runLauncher(fixture, "Status", ["-RunPath", activeState.runPath])
		assert.equal(completedStatus.exitCode, 0, completedStatus.stderr)
		assert.match(completedStatus.stdout, /State: completed/)
		assert.match(completedStatus.stdout, /Classification: fixtureStopped/)
		await assert.rejects(fs.stat(statePaths.state), (error) => error.code === "ENOENT")
		await assert.rejects(fs.stat(statePaths.lock), (error) => error.code === "ENOENT")

		const invocations = await readCollectorInvocations(fixture)
		assert.deepEqual(
			invocations.map(({ args }) => args[0]),
			["launch", "snapshot", "stop"],
		)
		assert.deepEqual(invocations[2].args, ["stop", "--run-dir", activeState.runPath, "--snapshot-policy", "abort"])
	},
)

windowsTest(
	"a concurrent Start is refused by the live launcher lock before active state exists",
	{ timeout: 30_000 },
	async (t) => {
		const fixture = await createPortableKitFixture(t)
		const statePaths = launcherStatePaths(fixture)
		const start = spawnLauncher(fixture, "Start", [], {
			env: { ZOO_FAKE_COLLECTOR_MANIFEST_DELAY_MS: "4000" },
		})
		const observed = observeChild(start)
		t.after(() => terminateFixtureProcess(start))
		await waitFor(
			async () => {
				try {
					await fs.stat(statePaths.lock)
					return true
				} catch (error) {
					if (error?.code === "ENOENT") return false
					throw error
				}
			},
			{ timeout: 10_000 },
		)
		assert.equal(await readJsonWhenPresent(statePaths.state), null)

		const second = await runLauncher(fixture, "Start", [], {
			env: { ZOO_FAKE_COLLECTOR_MANIFEST_DELAY_MS: "4000" },
		})
		assert.equal(second.exitCode, 1)
		assert.match(second.stderr, /CAPTURE_ALREADY_STARTING/)

		const activeState = await waitFor(() => readJsonWhenPresent(statePaths.state), { timeout: 10_000 })
		const stop = await runLauncher(fixture, "Stop")
		assert.equal(stop.exitCode, 0, stop.stderr)
		const terminal = await observed.exited
		assert.equal(terminal.exitCode, 0, observed.stderr)
		assert.ok(activeState.runPath)
		const invocations = await readCollectorInvocations(fixture)
		assert.deepEqual(
			invocations.map(({ args }) => args[0]),
			["launch", "stop"],
		)
	},
)

windowsTest("recovers a proven stale launcher lock but preserves a malformed lock", async (t) => {
	const staleFixture = await createPortableKitFixture(t)
	const stalePaths = launcherStatePaths(staleFixture)
	await fs.mkdir(stalePaths.directory, { recursive: true })
	await fs.writeFile(
		stalePaths.lock,
		JSON.stringify({ pid: 2_147_483_647, creationTimeUtc: "2000-01-01T00:00:00.000Z" }),
		"utf8",
	)
	const recovered = await runLauncher(staleFixture, "Start", [], {
		env: { ZOO_FAKE_COLLECTOR_MODE: "exit-after-capture" },
		timeout: 15_000,
	})
	assert.equal(recovered.exitCode, 0, recovered.stderr)
	await assert.rejects(fs.stat(stalePaths.lock), (error) => error.code === "ENOENT")

	const malformedFixture = await createPortableKitFixture(t)
	const malformedPaths = launcherStatePaths(malformedFixture)
	await fs.mkdir(malformedPaths.directory, { recursive: true })
	const malformedText = '{"pid":"not-an-integer"}'
	await fs.writeFile(malformedPaths.lock, malformedText, "utf8")
	const refused = await runLauncher(malformedFixture, "Start")
	assert.equal(refused.exitCode, 1)
	assert.match(refused.stderr, /LOCK_UNAVAILABLE/)
	assert.equal(await fs.readFile(malformedPaths.lock, "utf8"), malformedText)
	assert.deepEqual(await readCollectorInvocations(malformedFixture), [])
})

windowsTest("ambiguous PID and creation identity fails closed and cleans up the owned collector", async (t) => {
	const fixture = await createPortableKitFixture(t)
	const statePaths = launcherStatePaths(fixture)
	const result = await runLauncher(fixture, "Start", [], {
		env: { ZOO_FAKE_COLLECTOR_DUPLICATE_RUN: "1" },
		timeout: 20_000,
	})

	assert.equal(result.exitCode, 1)
	assert.match(result.stderr, /RUN_AMBIGUOUS/)
	await assert.rejects(fs.stat(statePaths.state), (error) => error.code === "ENOENT")
	await assert.rejects(fs.stat(statePaths.lock), (error) => error.code === "ENOENT")
	const [launchInvocation] = await readCollectorInvocations(fixture)
	assert.equal(launchInvocation.args[0], "launch")
	const processProbe = await execFileResult("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`if (Get-Process -Id ${launchInvocation.pid} -ErrorAction SilentlyContinue) { exit 1 }`,
	])
	assert.equal(processProbe.exitCode, 0, "The ambiguous collector process was left running")
})
