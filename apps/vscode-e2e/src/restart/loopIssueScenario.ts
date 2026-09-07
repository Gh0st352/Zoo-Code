import { runTests } from "@vscode/test-electron"
import { LOOP_RESTART } from "../fixtures/loop-issue"
import { readPhaseResult } from "./phaseProtocol"
import type { ScenarioWorkspace } from "./scenarioWorkspace"

async function restartRequestCount(mockUrl: string | undefined): Promise<number> {
	if (!mockUrl) throw new Error("Restart request assertions require the local mock")
	const response = await fetch(`${mockUrl}/__aimock/journal`)
	if (!response.ok) throw new Error(`Mock journal failed: ${response.status}`)
	const entries = (await response.json()) as Array<{
		body?: { messages?: Array<{ role?: string; content?: unknown }> }
	}>
	return entries.filter((entry) =>
		entry.body?.messages?.some(
			(message) => message.role === "user" && JSON.stringify(message.content ?? "").includes(LOOP_RESTART),
		),
	).length
}

export async function runLoopIssueScenario(options: {
	version: string
	extensionDevelopmentPath: string
	extensionTestsPath: string
	environment: NodeJS.ProcessEnv
	workspace: ScenarioWorkspace
}): Promise<void> {
	for (const phase of ["create", "verify"] as const) {
		const requestsBefore = await restartRequestCount(options.environment.AIMOCK_URL)
		let launchFailure: unknown
		try {
			await runTests({
				version: options.version,
				extensionDevelopmentPath: options.extensionDevelopmentPath,
				extensionTestsPath: options.extensionTestsPath,
				launchArgs: [
					options.workspace.workspace,
					`--user-data-dir=${options.workspace.userData}`,
					`--extensions-dir=${options.workspace.extensions}`,
					"--disable-workspace-trust",
					"--skip-welcome",
					"--skip-release-notes",
				],
				extensionTestsEnv: {
					...options.environment,
					E2E_PHASE: phase,
					E2E_SCENARIO: "loop-issue-restart",
					E2E_RESULTS_DIR: options.workspace.results,
				},
			})
		} catch (error) {
			launchFailure = error
		}
		// A launch error or crash without the explicit durable receipt is never a host pass.
		let result
		try {
			result = await readPhaseResult(options.workspace.results, phase)
		} catch (error) {
			throw launchFailure ?? error
		}
		if (result.status !== "passed") throw new Error(result.error?.message ?? `${phase} failed`)
		if (launchFailure) throw launchFailure
		const requestDelta = (await restartRequestCount(options.environment.AIMOCK_URL)) - requestsBefore
		if (requestDelta !== (phase === "create" ? 1 : 0)) {
			throw new Error(`[LoopIssue restart:${phase}] unexpected task request delta: ${requestDelta}`)
		}
		console.log(
			`[LoopIssue restart:${phase}] verified receipt ${JSON.stringify({ pid: result.values?.pid, session: result.values?.session, termination: result.values?.termination, requestDelta })}`,
		)
	}
}
