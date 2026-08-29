import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { readJsonBounded, writeJsonAtomic } from "./atomic-file.mjs"
import { DEFAULTS, SCHEMA_VERSION } from "./constants.mjs"
import { currentProcessCreationTimeUtc, inspectProcessIdentity, isValidCreationTimeUtc } from "./process-identity.mjs"
import { isGeneratedRunId } from "./records.mjs"

const TOKEN_PATTERN = /^[a-f0-9]{64}$/
const REQUEST_ID_PATTERN = /^[a-f0-9]{24}$/

function controlPathError() {
	return Object.assign(new Error("Control operational path is unsafe"), { code: "CONTROL_PATH_UNSAFE" })
}

async function assertSafeDirectory(directory, { create = false } = {}) {
	if (create) {
		try {
			await fs.mkdir(directory, { mode: 0o700 })
		} catch (error) {
			if (error.code !== "EEXIST") throw error
		}
	}
	let stat
	try {
		stat = await fs.lstat(directory)
	} catch (error) {
		if (error.code === "ENOENT") throw controlPathError()
		throw error
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw controlPathError()
}

async function assertSafeOperationalTree(operationalDir, { create = false } = {}) {
	const parent = path.dirname(operationalDir)
	await assertSafeDirectory(os.tmpdir())
	await assertSafeDirectory(parent, { create })
	await assertSafeDirectory(operationalDir, { create })
	await assertSafeDirectory(path.join(operationalDir, "requests"), { create })
	await assertSafeDirectory(path.join(operationalDir, "responses"), { create })
}

function hasExactKeys(value, allowed) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === allowed.size &&
		Object.keys(value).every((key) => allowed.has(key))
	)
}

export function operationalRoot(runId) {
	if (!isGeneratedRunId(runId)) throw new TypeError("Invalid run ID")
	return path.join(os.tmpdir(), "zoo-live-capture", runId)
}

function validToken(left, right) {
	if (!TOKEN_PATTERN.test(left ?? "") || !TOKEN_PATTERN.test(right ?? "")) return false
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

function validateControlRequest(request, expectedRunId, token) {
	if (!request || typeof request !== "object" || Array.isArray(request)) return null
	const common = new Set(["schemaVersion", "runId", "requestId", "token", "type"])
	const allowed =
		request.type === "stop"
			? new Set([...common, "snapshotPolicy"])
			: request.type === "snapshot"
				? new Set([
						...common,
						"reason",
						"targetOrdinal",
						"overrideCooldown",
						"allowUnresponsiveAttempt",
						"manualRiskAcknowledged",
					])
				: null
	if (!allowed || Object.keys(request).some((key) => !allowed.has(key))) return null
	if (
		request.schemaVersion !== SCHEMA_VERSION ||
		request.runId !== expectedRunId ||
		!REQUEST_ID_PATTERN.test(request.requestId ?? "") ||
		!validToken(request.token, token)
	) {
		return null
	}
	if (request.type === "stop") {
		if (!["wait", "abort"].includes(request.snapshotPolicy)) return null
		return { type: "stop", requestId: request.requestId, snapshotPolicy: request.snapshotPolicy }
	}
	if (
		request.reason !== "manual" ||
		typeof request.overrideCooldown !== "boolean" ||
		typeof request.allowUnresponsiveAttempt !== "boolean" ||
		request.manualRiskAcknowledged !== true ||
		(request.targetOrdinal !== null &&
			(!Number.isSafeInteger(request.targetOrdinal) ||
				request.targetOrdinal < 1 ||
				request.targetOrdinal > 1_000_000))
	) {
		return null
	}
	return {
		type: "snapshot",
		requestId: request.requestId,
		reason: "manual",
		targetOrdinal: request.targetOrdinal,
		overrideCooldown: request.overrideCooldown,
		allowUnresponsiveAttempt: request.allowUnresponsiveAttempt,
		manualRiskAcknowledged: true,
	}
}

export class ControlChannel {
	constructor({ runId, operationalDir, token, pollIntervalMs, onRequest }) {
		this.runId = runId
		this.operationalDir = operationalDir
		this.token = token
		this.pollIntervalMs = pollIntervalMs
		this.onRequest = onRequest
		this.timer = null
		this.processing = false
		this.closed = false
	}

	static async create({
		runId,
		harnessPid = process.pid,
		harnessCreationTimeUtc = null,
		pollIntervalMs = 250,
		onRequest,
		dependencies = {},
	}) {
		const operationalDir = operationalRoot(runId)
		await assertSafeOperationalTree(operationalDir, { create: true })
		const token = randomBytes(32).toString("hex")
		const processCreated =
			harnessCreationTimeUtc ??
			(await (dependencies.currentProcessCreationTimeUtc ?? currentProcessCreationTimeUtc)())
		if (!isValidCreationTimeUtc(processCreated)) {
			throw Object.assign(new Error("Harness process identity is unavailable"), {
				code: "CONTROL_IDENTITY_UNAVAILABLE",
			})
		}
		await writeJsonAtomic(path.join(operationalDir, "control.json"), {
			schemaVersion: SCHEMA_VERSION,
			runId,
			harnessPid,
			harnessCreationTimeUtc: processCreated,
			token,
		})
		return new ControlChannel({ runId, operationalDir, token, pollIntervalMs, onRequest })
	}

	start() {
		if (this.timer || this.closed) return
		this.timer = setInterval(() => {
			void this.poll().catch(() => {
				this.closed = true
				if (this.timer) clearInterval(this.timer)
				this.timer = null
			})
		}, this.pollIntervalMs)
		this.timer.unref?.()
	}

	async poll() {
		if (this.processing || this.closed) return
		this.processing = true
		try {
			await assertSafeOperationalTree(this.operationalDir)
			const requestsDir = path.join(this.operationalDir, "requests")
			const names = (await fs.readdir(requestsDir))
				.filter((name) => /^request-[a-f0-9]{24}\.json$/.test(name))
				.sort()
			for (const name of names.slice(0, 16)) {
				const requestPath = path.join(requestsDir, name)
				let request
				try {
					request = await readJsonBounded(requestPath, 8 * 1024)
				} catch {
					await fs.unlink(requestPath).catch(() => {})
					continue
				}
				const sanitized = validateControlRequest(request, this.runId, this.token)
				if (!sanitized) {
					await fs.unlink(requestPath).catch(() => {})
					continue
				}
				let response
				try {
					const result = await this.onRequest(sanitized)
					response = {
						schemaVersion: SCHEMA_VERSION,
						requestId: sanitized.requestId,
						status: "completed",
						result,
					}
				} catch (error) {
					response = {
						schemaVersion: SCHEMA_VERSION,
						requestId: sanitized.requestId,
						status: "failed",
						code:
							typeof error?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(error.code)
								? error.code
								: "controlFailed",
					}
				}
				await writeJsonAtomic(
					path.join(this.operationalDir, "responses", `response-${sanitized.requestId}.json`),
					response,
				)
				await fs.unlink(requestPath).catch(() => {})
			}
		} finally {
			this.processing = false
		}
	}

	async close({ removeOperationalState = true } = {}) {
		this.closed = true
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		while (this.processing) await new Promise((resolve) => setImmediate(resolve))
		if (removeOperationalState) await fs.rm(this.operationalDir, { recursive: true, force: true })
	}
}

async function readRunId(runDir) {
	for (const fileName of ["manifest.partial.json", "manifest.json"]) {
		try {
			const manifest = await readJsonBounded(path.join(runDir, fileName), 256 * 1024)
			if (isGeneratedRunId(manifest.runId)) return manifest.runId
		} catch (error) {
			if (error.code !== "ENOENT") throw error
		}
	}
	throw Object.assign(new Error("Run manifest is unavailable"), { code: "RUN_MANIFEST_UNAVAILABLE" })
}

export async function sendControlRequest(options, dependencies = {}) {
	const runId = await readRunId(options.runDir)
	const operationalDir = operationalRoot(runId)
	await assertSafeOperationalTree(operationalDir)
	const descriptor = await readJsonBounded(path.join(operationalDir, "control.json"), 8 * 1024)
	if (
		!hasExactKeys(
			descriptor,
			new Set(["schemaVersion", "runId", "harnessPid", "harnessCreationTimeUtc", "token"]),
		) ||
		descriptor.schemaVersion !== SCHEMA_VERSION ||
		descriptor.runId !== runId ||
		!Number.isSafeInteger(descriptor.harnessPid) ||
		descriptor.harnessPid < 1 ||
		!isValidCreationTimeUtc(descriptor.harnessCreationTimeUtc) ||
		!TOKEN_PATTERN.test(descriptor.token ?? "")
	) {
		throw Object.assign(new Error("Control descriptor is invalid"), { code: "CONTROL_DESCRIPTOR_INVALID" })
	}
	const identity = await (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(descriptor.harnessPid)
	if (identity.state !== "present" || identity.creationTimeUtc !== descriptor.harnessCreationTimeUtc) {
		throw Object.assign(new Error("Control harness identity is stale"), { code: "CONTROL_DESCRIPTOR_STALE" })
	}
	const requestId = (dependencies.randomBytes ?? randomBytes)(12).toString("hex")
	const request =
		options.command === "stop"
			? {
					schemaVersion: SCHEMA_VERSION,
					runId,
					requestId,
					token: descriptor.token,
					type: "stop",
					snapshotPolicy: options.snapshotPolicy,
				}
			: {
					schemaVersion: SCHEMA_VERSION,
					runId,
					requestId,
					token: descriptor.token,
					type: "snapshot",
					reason: "manual",
					targetOrdinal: options.targetOrdinal,
					overrideCooldown: options.overrideCooldown,
					allowUnresponsiveAttempt: options.allowUnresponsiveAttempt,
					manualRiskAcknowledged: options.manualRiskAcknowledged,
				}
	await writeJsonAtomic(path.join(operationalDir, "requests", `request-${requestId}.json`), request)
	const responsePath = path.join(operationalDir, "responses", `response-${requestId}.json`)
	const timeoutMs = dependencies.timeoutMs ?? DEFAULTS.controlTimeoutMs
	const pollIntervalMs = dependencies.pollIntervalMs ?? 100
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await assertSafeOperationalTree(operationalDir)
			const response = await readJsonBounded(responsePath, 8 * 1024)
			await fs.unlink(responsePath).catch(() => {})
			const responseKeys =
				response?.status === "completed"
					? new Set(["schemaVersion", "requestId", "status", "result"])
					: new Set(["schemaVersion", "requestId", "status", "code"])
			if (
				!hasExactKeys(response, responseKeys) ||
				response.schemaVersion !== SCHEMA_VERSION ||
				response.requestId !== requestId ||
				!REQUEST_ID_PATTERN.test(response.requestId)
			) {
				throw Object.assign(new Error("Control response is invalid"), { code: "CONTROL_RESPONSE_INVALID" })
			}
			if (response.status !== "completed") {
				const code =
					typeof response.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(response.code)
						? response.code
						: "CONTROL_FAILED"
				throw Object.assign(new Error("Control request failed"), { code })
			}
			return response.result
		} catch (error) {
			if (error.code !== "ENOENT") throw error
		}
		await (dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(pollIntervalMs)
	}
	throw Object.assign(new Error("Control request timed out"), { code: "CONTROL_TIMEOUT" })
}
