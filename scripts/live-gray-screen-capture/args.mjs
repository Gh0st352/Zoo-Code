import path from "node:path"

import { DEFAULTS, EXIT_CODES, PROFILE_MODES, SNAPSHOT_TRIGGER_REASONS } from "./constants.mjs"

const COMMAND_ALIASES = Object.freeze({
	"process-only": "process",
	"validate-snapshot": "validate",
})

const BOOLEAN_OPTIONS = new Set([
	"help",
	"dry-run",
	"enable-auto-snapshot",
	"disable-auto-snapshot",
	"no-command-line-role-probe",
	"acknowledge-profile-reuse-risk",
	"enable-transport-diagnostics",
	"enable-partial-coalescing",
	"override-cooldown",
	"allow-unresponsive-attempt",
	"acknowledge-manual-snapshot-risk",
])

const VALUE_OPTIONS = new Set([
	"output",
	"renderer-interval-ms",
	"process-interval-ms",
	"heartbeat-warning-ms",
	"heartbeat-failure-ms",
	"heap-warning-ratio",
	"heap-critical-ratio",
	"auto-snapshot-ratio",
	"auto-snapshot-samples",
	"snapshot-cooldown-ms",
	"manifest-interval-ms",
	"retention-runs",
	"retention-days",
	"duration-ms",
	"code",
	"workspace",
	"extension-development-path",
	"extension-vsix",
	"profile-mode",
	"user-data-dir",
	"extensions-dir",
	"cdp-port",
	"cdp-endpoint",
	"expected-root-pid",
	"pid",
	"run-dir",
	"reason",
	"target-ordinal",
	"snapshot-policy",
	"file",
	"validation-timeout-ms",
])

const COMMAND_OPTIONS = Object.freeze({
	launch: new Set([
		"output",
		"renderer-interval-ms",
		"process-interval-ms",
		"heartbeat-warning-ms",
		"heartbeat-failure-ms",
		"heap-warning-ratio",
		"heap-critical-ratio",
		"auto-snapshot-ratio",
		"auto-snapshot-samples",
		"snapshot-cooldown-ms",
		"manifest-interval-ms",
		"retention-runs",
		"retention-days",
		"duration-ms",
		"enable-auto-snapshot",
		"disable-auto-snapshot",
		"no-command-line-role-probe",
		"dry-run",
		"code",
		"workspace",
		"extension-development-path",
		"extension-vsix",
		"profile-mode",
		"user-data-dir",
		"extensions-dir",
		"acknowledge-profile-reuse-risk",
		"cdp-port",
		"enable-transport-diagnostics",
		"enable-partial-coalescing",
	]),
	attach: new Set([
		"output",
		"renderer-interval-ms",
		"process-interval-ms",
		"heartbeat-warning-ms",
		"heartbeat-failure-ms",
		"heap-warning-ratio",
		"heap-critical-ratio",
		"auto-snapshot-ratio",
		"auto-snapshot-samples",
		"snapshot-cooldown-ms",
		"manifest-interval-ms",
		"retention-runs",
		"retention-days",
		"duration-ms",
		"enable-auto-snapshot",
		"disable-auto-snapshot",
		"no-command-line-role-probe",
		"cdp-port",
		"cdp-endpoint",
		"expected-root-pid",
	]),
	process: new Set([
		"output",
		"process-interval-ms",
		"manifest-interval-ms",
		"retention-runs",
		"retention-days",
		"duration-ms",
		"no-command-line-role-probe",
		"pid",
	]),
	snapshot: new Set([
		"run-dir",
		"reason",
		"target-ordinal",
		"override-cooldown",
		"allow-unresponsive-attempt",
		"acknowledge-manual-snapshot-risk",
	]),
	stop: new Set(["run-dir", "snapshot-policy"]),
	validate: new Set(["file", "output", "validation-timeout-ms"]),
})

const PROTECTED_LAUNCH_ARGUMENTS = new Set([
	"--extensions-dir",
	"--extensiondevelopmentpath",
	"--extension-development-path",
	"--remote-debugging-address",
	"--remote-debugging-pipe",
	"--remote-debugging-port",
	"--user-data-dir",
	"--inspect",
	"--inspect-brk",
	"--inspect-port",
	"--js-flags",
	"--proxy-bypass-list",
	"--proxy-pac-url",
	"--proxy-server",
])

export class UsageError extends Error {
	constructor(code, message) {
		super(message)
		this.name = "UsageError"
		this.code = code
		this.exitCode = EXIT_CODES.usage
	}
}

function fail(code, message) {
	throw new UsageError(code, message)
}

function parseInteger(name, value, minimum, maximum) {
	if (!/^(0|[1-9]\d*)$/.test(value)) fail("invalidInteger", `--${name} must be an integer`)
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		fail("integerOutOfRange", `--${name} must be between ${minimum} and ${maximum}`)
	}
	return parsed
}

function parseRatio(name, value) {
	if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) fail("invalidRatio", `--${name} must be a decimal ratio`)
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 0.95) {
		fail("ratioOutOfRange", `--${name} must be between 0.50 and 0.95`)
	}
	return parsed
}

function parseRawOptions(tokens) {
	const values = new Map()
	const passthroughIndex = tokens.indexOf("--")
	const optionTokens = passthroughIndex === -1 ? tokens : tokens.slice(0, passthroughIndex)
	const passthrough = passthroughIndex === -1 ? [] : tokens.slice(passthroughIndex + 1)

	for (let index = 0; index < optionTokens.length; index += 1) {
		const token = optionTokens[index]
		if (!token.startsWith("--") || token === "--") fail("unexpectedArgument", "Only named --options are accepted")
		const equals = token.indexOf("=")
		const name = token.slice(2, equals === -1 ? undefined : equals)
		if (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) fail("unknownOption", `Unknown option --${name}`)
		if (values.has(name)) fail("duplicateOption", `Option --${name} may be supplied only once`)

		if (BOOLEAN_OPTIONS.has(name)) {
			if (equals !== -1) fail("booleanValue", `Option --${name} does not accept a value`)
			values.set(name, true)
			continue
		}

		let value
		if (equals !== -1) {
			value = token.slice(equals + 1)
		} else {
			index += 1
			value = optionTokens[index]
		}
		if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
			fail("missingOptionValue", `Option --${name} requires a value`)
		}
		values.set(name, value)
	}

	return { values, passthrough }
}

function validateLaunchPassthrough(passthrough) {
	for (const token of passthrough) {
		if (typeof token !== "string" || !token.startsWith("--")) continue
		const name = token.slice(0, token.indexOf("=") === -1 ? undefined : token.indexOf("=")).toLowerCase()
		if (PROTECTED_LAUNCH_ARGUMENTS.has(name)) {
			fail(
				"protectedPassthroughArgument",
				`${name} is controlled by the capture harness and cannot be forwarded after --`,
			)
		}
	}
}

function commonCaptureOptions(values) {
	if (values.has("enable-auto-snapshot") && values.has("disable-auto-snapshot")) {
		fail("conflictingAutoSnapshot", "--enable-auto-snapshot and --disable-auto-snapshot conflict")
	}
	const warningRatio = parseRatio("heap-warning-ratio", values.get("heap-warning-ratio") ?? "0.70")
	const criticalRatio = parseRatio(
		"heap-critical-ratio",
		values.get("heap-critical-ratio") ?? values.get("auto-snapshot-ratio") ?? "0.82",
	)
	if (warningRatio >= criticalRatio) fail("thresholdOrder", "Heap warning ratio must be below the critical ratio")

	const heartbeatWarningMs = parseInteger(
		"heartbeat-warning-ms",
		values.get("heartbeat-warning-ms") ?? String(DEFAULTS.heartbeatWarningMs),
		2_000,
		60_000,
	)
	const heartbeatFailureMs = parseInteger(
		"heartbeat-failure-ms",
		values.get("heartbeat-failure-ms") ?? String(DEFAULTS.heartbeatFailureMs),
		heartbeatWarningMs,
		120_000,
	)

	return {
		output: path.resolve(values.get("output") ?? DEFAULTS.output),
		rendererIntervalMs: parseInteger(
			"renderer-interval-ms",
			values.get("renderer-interval-ms") ?? String(DEFAULTS.rendererIntervalMs),
			500,
			60_000,
		),
		processIntervalMs: parseInteger(
			"process-interval-ms",
			values.get("process-interval-ms") ?? String(DEFAULTS.processIntervalMs),
			2_000,
			60_000,
		),
		heartbeatWarningMs,
		heartbeatFailureMs,
		heapWarningRatio: warningRatio,
		heapCriticalRatio: criticalRatio,
		autoSnapshotEnabled: values.has("enable-auto-snapshot"),
		autoSnapshotSamples: parseInteger(
			"auto-snapshot-samples",
			values.get("auto-snapshot-samples") ?? String(DEFAULTS.autoSnapshotSamples),
			2,
			20,
		),
		snapshotCooldownMs: parseInteger(
			"snapshot-cooldown-ms",
			values.get("snapshot-cooldown-ms") ?? String(DEFAULTS.snapshotCooldownMs),
			60_000,
			86_400_000,
		),
		manifestIntervalMs: parseInteger(
			"manifest-interval-ms",
			values.get("manifest-interval-ms") ?? String(DEFAULTS.manifestIntervalMs),
			5_000,
			120_000,
		),
		retentionRuns: parseInteger(
			"retention-runs",
			values.get("retention-runs") ?? String(DEFAULTS.retentionRuns),
			1,
			100,
		),
		retentionDays: parseInteger(
			"retention-days",
			values.get("retention-days") ?? String(DEFAULTS.retentionDays),
			1,
			365,
		),
		commandLineRoleProbe: !values.has("no-command-line-role-probe"),
		durationMs: values.has("duration-ms")
			? parseInteger("duration-ms", values.get("duration-ms"), 100, 604_800_000)
			: null,
		rotationBytes: DEFAULTS.rotationBytes,
		maxRecordBytes: DEFAULTS.maxRecordBytes,
		maxQueueRecords: DEFAULTS.maxQueueRecords,
	}
}

function requireValue(values, name) {
	const value = values.get(name)
	if (!value) fail("requiredOption", `--${name} is required`)
	return value
}

function validateCommandOptions(command, values) {
	const allowed = COMMAND_OPTIONS[command]
	for (const name of values.keys()) {
		if (name !== "help" && !allowed.has(name)) fail("optionNotAllowed", `--${name} is not valid for ${command}`)
	}
}

export function parseArgs(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { command: "help" }
	if (argv[0].startsWith("-")) fail("missingCommand", "A command is required before options")
	const command = COMMAND_ALIASES[argv[0]] ?? argv[0]
	if (!Object.hasOwn(COMMAND_OPTIONS, command)) fail("unknownCommand", `Unknown command ${argv[0]}`)
	const { values, passthrough } = parseRawOptions(argv.slice(1))
	if (values.has("help")) return { command: "help", helpCommand: command }
	validateCommandOptions(command, values)
	if (command !== "launch" && passthrough.length > 0)
		fail("passthroughNotAllowed", "Arguments after -- are launch-only")
	if (command === "launch") validateLaunchPassthrough(passthrough)

	if (command === "validate") {
		return {
			command,
			file: path.resolve(requireValue(values, "file")),
			output: path.resolve(values.get("output") ?? path.join(DEFAULTS.output, "snapshot-validation")),
			validationTimeoutMs: parseInteger(
				"validation-timeout-ms",
				values.get("validation-timeout-ms") ?? String(DEFAULTS.validationTimeoutMs),
				1_000,
				86_400_000,
			),
		}
	}

	if (command === "snapshot") {
		const reason = values.get("reason") ?? "manual"
		if (!SNAPSHOT_TRIGGER_REASONS.includes(reason) || reason !== "manual") {
			fail("invalidSnapshotReason", "The standalone control command accepts only --reason manual")
		}
		if (!values.has("acknowledge-manual-snapshot-risk")) {
			fail(
				"manualSnapshotAcknowledgementRequired",
				"Manual snapshots require --acknowledge-manual-snapshot-risk because capture can pause or destabilize the renderer",
			)
		}
		return {
			command,
			runDir: path.resolve(requireValue(values, "run-dir")),
			reason,
			targetOrdinal: values.has("target-ordinal")
				? parseInteger("target-ordinal", values.get("target-ordinal"), 1, 1_000_000)
				: null,
			overrideCooldown: values.has("override-cooldown"),
			allowUnresponsiveAttempt: values.has("allow-unresponsive-attempt"),
			manualRiskAcknowledged: true,
		}
	}

	if (command === "stop") {
		const snapshotPolicy = values.get("snapshot-policy") ?? "wait"
		if (!["wait", "abort"].includes(snapshotPolicy))
			fail("invalidSnapshotPolicy", "--snapshot-policy must be wait or abort")
		return { command, runDir: path.resolve(requireValue(values, "run-dir")), snapshotPolicy }
	}

	const common = commonCaptureOptions(values)
	if (command === "process") {
		return {
			command,
			...common,
			rendererIntervalMs: DEFAULTS.rendererIntervalMs,
			heartbeatWarningMs: DEFAULTS.heartbeatWarningMs,
			heartbeatFailureMs: DEFAULTS.heartbeatFailureMs,
			heapWarningRatio: DEFAULTS.heapWarningRatio,
			heapCriticalRatio: DEFAULTS.heapCriticalRatio,
			autoSnapshotEnabled: false,
			pid: parseInteger("pid", requireValue(values, "pid"), 1, 4_294_967_295),
		}
	}

	if (command === "attach") {
		if (values.has("cdp-port") === values.has("cdp-endpoint")) {
			fail("attachEndpoint", "Attach requires exactly one of --cdp-port or --cdp-endpoint")
		}
		return {
			command,
			...common,
			cdpPort: values.has("cdp-port") ? parseInteger("cdp-port", values.get("cdp-port"), 1, 65_535) : null,
			cdpEndpoint: values.get("cdp-endpoint") ?? null,
			expectedRootPid: values.has("expected-root-pid")
				? parseInteger("expected-root-pid", values.get("expected-root-pid"), 1, 4_294_967_295)
				: null,
		}
	}

	const profileMode = values.get("profile-mode") ?? "isolated"
	if (!PROFILE_MODES.includes(profileMode))
		fail("invalidProfileMode", "--profile-mode must be isolated, default, or custom")
	const developmentPath = values.get("extension-development-path")
	const vsixPath = values.get("extension-vsix")
	if (developmentPath && vsixPath) fail("extensionSourceConflict", "Choose one extension source strategy")
	if (profileMode === "isolated" && !developmentPath && !vsixPath) {
		fail("extensionSourceRequired", "Isolated launch requires --extension-development-path or --extension-vsix")
	}
	if (profileMode !== "isolated" && !values.has("acknowledge-profile-reuse-risk")) {
		fail("profileRiskAcknowledgement", "Default/custom profile launch requires --acknowledge-profile-reuse-risk")
	}
	if (profileMode === "custom" && (!values.has("user-data-dir") || !values.has("extensions-dir"))) {
		fail("customProfileDirectories", "Custom profile launch requires --user-data-dir and --extensions-dir")
	}
	if (profileMode !== "custom" && (values.has("user-data-dir") || values.has("extensions-dir"))) {
		fail("customProfileOnly", "--user-data-dir and --extensions-dir are valid only with --profile-mode custom")
	}

	return {
		command,
		...common,
		dryRun: values.has("dry-run"),
		code: values.has("code") ? path.resolve(values.get("code")) : null,
		workspace: values.has("workspace") ? path.resolve(values.get("workspace")) : null,
		extensionDevelopmentPath: developmentPath ? path.resolve(developmentPath) : null,
		extensionVsix: vsixPath ? path.resolve(vsixPath) : null,
		profileMode,
		userDataDir: values.has("user-data-dir") ? path.resolve(values.get("user-data-dir")) : null,
		extensionsDir: values.has("extensions-dir") ? path.resolve(values.get("extensions-dir")) : null,
		profileRiskAcknowledged: values.has("acknowledge-profile-reuse-risk"),
		cdpPort: parseInteger("cdp-port", values.get("cdp-port") ?? "0", 0, 65_535),
		enableTransportDiagnostics: values.has("enable-transport-diagnostics"),
		enablePartialCoalescing: values.has("enable-partial-coalescing"),
		passthrough,
	}
}

export function helpText(command = null) {
	const header = `ZooCode live gray-screen capture (standalone MVP)\n\nUsage:\n  node .\\scripts\\live-gray-screen-capture.mjs launch [options] [-- <VS Code args>]\n  node .\\scripts\\live-gray-screen-capture.mjs attach (--cdp-port <port> | --cdp-endpoint <url>) [options]\n  node .\\scripts\\live-gray-screen-capture.mjs process --pid <pid> [options]\n  node .\\scripts\\live-gray-screen-capture.mjs snapshot --run-dir <dir> --acknowledge-manual-snapshot-risk [options]\n  node .\\scripts\\live-gray-screen-capture.mjs validate --file <snapshot> [--output <dir>]\n  node .\\scripts\\live-gray-screen-capture.mjs stop --run-dir <dir> [--snapshot-policy wait|abort]\n`
	const privacy = `\nPrivacy and safety:\n  CDP is restricted to literal loopback addresses. Target URLs/titles, console arguments,\n  exception text/stacks, DOM text, source, paths, command lines, prompts, transcripts, and\n  request bodies are not retained. Heap snapshots can contain private user content and are\n  marked private. Automatic snapshots are OFF unless --enable-auto-snapshot is supplied.\n`
	const common = `\nCapture options:\n  --output <dir>                         Default: plans\\diagnostics\n  --renderer-interval-ms <500..60000>   Default: 2000\n  --process-interval-ms <2000..60000>   Default: 5000\n  --heartbeat-warning-ms <2000..60000>  Default: 5000\n  --heartbeat-failure-ms <warn..120000> Default: 10000\n  --heap-warning-ratio <0.50..0.95>     Default: 0.70\n  --heap-critical-ratio <0.50..0.95>    Default: 0.82\n  --enable-auto-snapshot                Explicit opt-in; default is disabled\n  --auto-snapshot-samples <2..20>       Default: 3\n  --snapshot-cooldown-ms <60000..86400000> Default: 1800000\n  --no-command-line-role-probe          Disable transient role-only command-line inspection\n`
	const launch = `\nLaunch options:\n  --code <Code.exe>                     Optional safe common-location discovery if omitted\n  --workspace <dir>                     Operational input; never retained\n  --extension-development-path <dir>    Required for isolated mode unless --extension-vsix\n  --extension-vsix <file>               Installed into the isolated extension directory\n  --profile-mode isolated|default|custom Default: isolated\n  --acknowledge-profile-reuse-risk      Required for default/custom profile use\n  --cdp-port <0..65535>                 Default: 0 (browser-selected)\n  --enable-transport-diagnostics        Child-only diagnostic environment flag\n  --enable-partial-coalescing           Child-only transport flag\n  --dry-run                             Validate and print only a sanitized launch plan\n`
	const control = `\nSnapshot options:\n  --target-ordinal <n>                  Required when target identity is ambiguous\n  --override-cooldown                   Manual-only cooldown override\n  --allow-unresponsive-attempt          Permit an attempt after heartbeat loss; resource gates remain\n  --acknowledge-manual-snapshot-risk    Required acknowledgment of pause/pressure risk\n`
	if (command === "launch") return header + privacy + common + launch
	if (["attach", "process"].includes(command)) return header + privacy + common
	if (command === "snapshot") return header + privacy + control
	return header + privacy + common + launch + control
}
