import path from "node:path"

import { writeJsonAtomic } from "./atomic-file.mjs"
import { SCHEMA_VERSION } from "./constants.mjs"
import { assertSafeOutputRoot } from "./path-safety.mjs"
import { validateInWorker } from "./snapshot.mjs"

export async function runValidate(options, dependencies = {}) {
	options.output = await (dependencies.assertSafeOutputRoot ?? assertSafeOutputRoot)(options.output)
	const resultPath = path.join(
		options.output,
		`validation-${new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(
				/\.(\d{3})Z$/,
				"-$1Z",
			)}-${process.pid}-${(dependencies.randomSuffix ?? (() => Math.random().toString(36).slice(2, 10)))()}.json`,
	)
	const resultFile = path.basename(resultPath)
	try {
		const result = await (dependencies.validateInWorker ?? validateInWorker)(options.file, {
			timeoutMs: options.validationTimeoutMs,
		})
		const manifest = {
			schemaVersion: SCHEMA_VERSION,
			status: "valid",
			privateSourceArtifact: true,
			validatorVersion: result.validatorVersion,
			byteCount: result.byteCount,
			sha256: result.sha256,
			nodeCount: result.nodeCount,
			edgeCount: result.edgeCount,
			nodeFieldCount: result.nodeFieldCount,
			edgeFieldCount: result.edgeFieldCount,
		}
		await writeJsonAtomic(resultPath, manifest)
		return { valid: true, resultPath, resultFile, result: manifest }
	} catch (error) {
		const manifest = {
			schemaVersion: SCHEMA_VERSION,
			status: "invalid",
			privateSourceArtifact: true,
			code:
				typeof error?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(error.code)
					? error.code
					: "validationFailed",
		}
		await writeJsonAtomic(resultPath, manifest)
		return { valid: false, resultPath, resultFile, result: manifest }
	}
}
