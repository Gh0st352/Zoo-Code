#!/usr/bin/env node

import path from "node:path"

import { parseArgs, helpText, UsageError } from "./live-gray-screen-capture/args.mjs"
import { EXIT_CODES } from "./live-gray-screen-capture/constants.mjs"
import { sendControlRequest } from "./live-gray-screen-capture/control.mjs"
import { runCapture } from "./live-gray-screen-capture/run.mjs"
import { assertSupportedRuntime } from "./live-gray-screen-capture/runtime.mjs"
import { runValidate } from "./live-gray-screen-capture/validate-command.mjs"

function mapErrorExitCode(error) {
	if (error instanceof UsageError) return EXIT_CODES.usage
	if (
		/^(UNSUPPORTED_RUNTIME|CODE_NOT_FOUND|PROFILE_|CDP_PORT_DISCOVERY|RETENTION_|OUTPUT_PATH_|nonLoopback|listenerInspection|endpointMismatch|BROWSER_PID_MISMATCH)/.test(
			error?.code ?? "",
		)
	) {
		return EXIT_CODES.preflight
	}
	if (/^(cdp|webSocket|BROWSER_PID_UNAVAILABLE|target)/.test(error?.code ?? "")) return EXIT_CODES.capability
	if (/snapshot|validation/i.test(error?.code ?? "")) return EXIT_CODES.snapshot
	return EXIT_CODES.evidence
}

function printResult(result) {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

async function main(argv) {
	const options = parseArgs(argv)
	if (options.command === "help") {
		process.stdout.write(helpText(options.helpCommand))
		return EXIT_CODES.success
	}
	if (options.command === "validate") {
		const result = await runValidate(options)
		printResult({ status: result.valid ? "valid" : "invalid", resultFile: result.resultFile, ...result.result })
		return result.valid ? EXIT_CODES.success : EXIT_CODES.snapshot
	}
	if (options.command === "snapshot" || options.command === "stop") {
		const result = await sendControlRequest(options)
		printResult({ status: "completed", result })
		return EXIT_CODES.success
	}
	const result = await runCapture(options)
	if (result.dryRun) printResult({ status: "dry-run", sanitizedLaunchPlan: result.plan })
	else {
		const { runDir: _runDir, ...sanitizedResult } = result
		printResult({ ...sanitizedResult, runDirectory: path.basename(result.runDir) })
	}
	return result.exitCode ?? EXIT_CODES.success
}

let interrupted = false
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		if (interrupted) process.exit(EXIT_CODES.interrupted)
		interrupted = true
		process.emit("zoo-live-capture-stop", signal)
	})
}

try {
	assertSupportedRuntime()
	process.exitCode = await main(process.argv.slice(2))
} catch (error) {
	const exitCode = mapErrorExitCode(error)
	const code =
		typeof error?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : "operationFailed"
	process.stderr.write(`ZooCode live capture failed (${code}).\n`)
	if (error instanceof UsageError) process.stderr.write(`${error.message}\n\n${helpText()}\n`)
	process.exitCode = exitCode
}
