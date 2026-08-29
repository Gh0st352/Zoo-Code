import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { validateHeapSnapshot } from "../snapshot-validator.mjs"
import { minimalSnapshot, writeSnapshot } from "./fixtures.mjs"

async function withTemp(testBody) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-snapshot-test-"))
	try {
		await testBody(directory)
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
}

test("stream validator accepts a valid snapshot across one-byte stream chunks", async () => {
	await withTemp(async (directory) => {
		const file = path.join(directory, "valid.heapsnapshot")
		const written = await writeSnapshot(file)
		const result = await validateHeapSnapshot(file, { bufferBytes: 1, expectedSha256: written.sha256 })
		assert.equal(result.valid, true)
		assert.equal(result.nodeCount, 1)
		assert.equal(result.edgeCount, 1)
		assert.equal(result.sha256, written.sha256)
	})
})

test("stream validator rejects zero byte, malformed, truncated, schema, and count failures", async () => {
	await withTemp(async (directory) => {
		const cases = [
			["zero", "", "zeroByteFile"],
			["malformed", "{]", "invalidObjectKey"],
			["truncated", minimalSnapshot().slice(0, -2), "truncatedJson"],
			["schema", minimalSnapshot({ remove: "snapshot.meta.node_fields" }), "missingNodeFields"],
			["node-count", minimalSnapshot({ nodes: [0] }), "nodeArrayCountMismatch"],
			["edge-count", minimalSnapshot({ edges: [0] }), "edgeArrayCountMismatch"],
			["zero-count", minimalSnapshot({ nodeCount: 0, nodes: [] }), "invalidNodeCount"],
			["trailing", `${minimalSnapshot()}null`, "trailingJsonData"],
		]
		for (const [name, text, code] of cases) {
			const file = path.join(directory, `${name}.heapsnapshot`)
			await fs.writeFile(file, text)
			await assert.rejects(validateHeapSnapshot(file, { bufferBytes: 3 }), (error) => {
				assert.equal(error.code, code, `${name} returned ${error.code} instead of ${code}`)
				return true
			})
		}
	})
})

test("stream validator accepts only JSON whitespace", async () => {
	await withTemp(async (directory) => {
		const file = path.join(directory, "non-json-whitespace.heapsnapshot")
		await fs.writeFile(file, `\u00a0${minimalSnapshot()}`)
		await assert.rejects(validateHeapSnapshot(file, { bufferBytes: 1 }), (error) => {
			assert.equal(error.code, "invalidJsonToken")
			return true
		})
	})
})

test("stream validator enforces Unicode surrogate pairing across chunk boundaries", async () => {
	await withTemp(async (directory) => {
		const valid = path.join(directory, "paired-surrogate.heapsnapshot")
		await fs.writeFile(valid, minimalSnapshot().replace('"PRIVATE_POISON_TRANSCRIPT"', '"\\ud83d\\ude00"'))
		assert.equal((await validateHeapSnapshot(valid, { bufferBytes: 1 })).valid, true)

		for (const [name, escaped] of [
			["unpaired-high", "\\ud83d"],
			["unpaired-low", "\\ude00"],
			["high-followed-by-text", "\\ud83dx"],
		]) {
			const file = path.join(directory, `${name}.heapsnapshot`)
			await fs.writeFile(file, minimalSnapshot().replace('"PRIVATE_POISON_TRANSCRIPT"', `"${escaped}"`))
			await assert.rejects(
				validateHeapSnapshot(file, { bufferBytes: 1 }),
				(error) => error.code === "invalidUnicodeSurrogate",
			)
		}
	})
})

test("stream validator rejects duplicate structural snapshot and meta parents", async () => {
	await withTemp(async (directory) => {
		const cases = [
			[
				"duplicate-snapshot",
				'{"snapshot":{"meta":{"node_fields":["type"],"node_types":["hidden"],"edge_fields":["type"],"edge_types":["context"]},"node_count":1},"snapshot":{"edge_count":1},"nodes":[0],"edges":[0]}',
			],
			[
				"duplicate-meta",
				'{"snapshot":{"meta":{"node_fields":["type"],"node_types":["hidden"]},"meta":{"edge_fields":["type"],"edge_types":["context"]},"node_count":1,"edge_count":1},"nodes":[0],"edges":[0]}',
			],
		]
		for (const [name, text] of cases) {
			const file = path.join(directory, `${name}.heapsnapshot`)
			await fs.writeFile(file, text)
			await assert.rejects(validateHeapSnapshot(file, { bufferBytes: 2 }), (error) => {
				assert.equal(error.code, "duplicateSchemaField")
				return true
			})
		}
	})
})

test("stream validator requires one type descriptor for every node and edge field", async () => {
	await withTemp(async (directory) => {
		for (const [name, text, code] of [
			[
				"node-schema-length",
				minimalSnapshot().replace('"node_types":[["hidden"],"string"]', '"node_types":[["hidden"]]'),
				"nodeSchemaLengthMismatch",
			],
			[
				"edge-schema-length",
				minimalSnapshot().replace(
					'"edge_types":[["context"],"string_or_number","node"]',
					'"edge_types":[["context"],"string_or_number"]',
				),
				"edgeSchemaLengthMismatch",
			],
		]) {
			const file = path.join(directory, `${name}.heapsnapshot`)
			await fs.writeFile(file, text)
			await assert.rejects(validateHeapSnapshot(file, { bufferBytes: 2 }), (error) => error.code === code)
		}
	})
})

test("stream validator rejects object values in structural arrays", async () => {
	await withTemp(async (directory) => {
		for (const [name, text] of [
			["object-node-type", minimalSnapshot().replace('[["hidden"],"string"]', '[{"hidden":true},"string"]')],
			["object-node-value", minimalSnapshot().replace('"nodes":[0,0]', '"nodes":[{},0]')],
		]) {
			const file = path.join(directory, `${name}.heapsnapshot`)
			await fs.writeFile(file, text)
			await assert.rejects(
				validateHeapSnapshot(file, { bufferBytes: 2 }),
				(error) => error.code === "invalidSchemaArrayElement",
			)
		}
	})
})

test("stream validator rejects checksum mismatch and never emits snapshot string content", async () => {
	await withTemp(async (directory) => {
		const file = path.join(directory, "valid.heapsnapshot")
		await writeSnapshot(file, { strings: ["PRIVATE_TRANSCRIPT_POISON"] })
		await assert.rejects(validateHeapSnapshot(file, { expectedSha256: "0".repeat(64) }), (error) => {
			assert.equal(error.code, "checksumMismatch")
			assert.equal(error.message.includes("PRIVATE_TRANSCRIPT_POISON"), false)
			return true
		})
	})
})
