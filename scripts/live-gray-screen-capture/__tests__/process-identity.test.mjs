import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { inspectProcessIdentity } from "../process-identity.mjs"

function powershellFixture(output) {
	return () => {
		const child = new EventEmitter()
		child.stdout = new EventEmitter()
		child.stdin = {
			end: () =>
				queueMicrotask(() => {
					child.stdout.emit("data", Buffer.from(output))
					child.emit("close", 0)
				}),
		}
		child.kill = () => {}
		return child
	}
}

test("Windows process identity returns a normalized creation time without command interpolation", async () => {
	let invocation
	const result = await inspectProcessIdentity(4321, {
		platform: "win32",
		spawn: (...args) => {
			invocation = args
			return powershellFixture('{"state":"present","creationTimeUtc":"2026-08-28T18:00:00.0000000Z"}')()
		},
	})
	assert.deepEqual(result, { state: "present", creationTimeUtc: "2026-08-28T18:00:00.000Z" })
	assert.equal(invocation[2].shell, false)
	assert.equal(
		invocation[1].some((argument) => argument === "4321"),
		false,
	)
})

test("process identity distinguishes absent and malformed responses", async () => {
	assert.deepEqual(
		await inspectProcessIdentity(4321, {
			platform: "win32",
			spawn: powershellFixture('{"state":"absent"}'),
		}),
		{ state: "absent", creationTimeUtc: null },
	)
	assert.deepEqual(
		await inspectProcessIdentity(4321, { platform: "win32", spawn: powershellFixture("PRIVATE_MALFORMED") }),
		{ state: "unknown", creationTimeUtc: null },
	)
})
