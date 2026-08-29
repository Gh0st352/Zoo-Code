import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import http from "node:http"
import test from "node:test"

import { CdpCollector } from "../cdp-collector.mjs"
import { CdpClient, discoverCdp, verifyWindowsLoopbackListener } from "../cdp-client.mjs"
import { RendererCollector } from "../renderer.mjs"
import { TargetRegistry } from "../targets.mjs"
import { createSyntheticCdpServer, deterministicRandom, fakeClock } from "./fixtures.mjs"

class StubWebSocket {
	static OPEN = 1
}

function createConnectedCdpClient(options = {}) {
	const sent = []
	const client = new CdpClient({
		webSocketUrl: "ws://127.0.0.1:9333/devtools/browser/test",
		WebSocketImpl: StubWebSocket,
		...options,
	})
	client.connected = true
	client.socket = {
		readyState: StubWebSocket.OPEN,
		send: (message) => sent.push(JSON.parse(message)),
		close: () => {},
	}
	return { client, sent }
}

test("synthetic loopback CDP fixture supports discovery, structural selection, and redaction", async () => {
	const server = await createSyntheticCdpServer()
	const retained = []
	let collector
	try {
		const endpoint = new URL(`http://127.0.0.1:${server.port}/`)
		const discovery = await discoverCdp(endpoint, { verifyListener: async () => {} })
		assert.equal(discovery.version.protocolVersion, "1.3")
		assert.equal(JSON.stringify(discovery).includes("PRIVATE_TITLE_POISON"), false)
		assert.equal(JSON.stringify(discovery).includes("URL_POISON"), false)

		collector = new CdpCollector({
			options: {
				cdpPort: server.port,
				rendererIntervalMs: 60_000,
				heartbeatWarningMs: 5_000,
				heartbeatFailureMs: 10_000,
				heapWarningRatio: 0.7,
				heapCriticalRatio: 0.82,
				autoSnapshotSamples: 3,
				autoSnapshotEnabled: false,
				verifyListener: async () => {},
			},
			clock: fakeClock(),
			random: deterministicRandom,
			onRecord: async (type, data) => retained.push({ type, data }),
			onCapability: async () => {},
		})
		await collector.connect()
		assert.equal(collector.registry.selection().state, "strongCandidate")
		assert.equal(JSON.stringify(retained).includes("PRIVATE_TITLE_POISON"), false)
		assert.equal(JSON.stringify(retained).includes("URL_POISON"), false)
	} finally {
		await collector?.stop()
		await server.close()
	}
})

test("CDP discovery rejects redirects and malicious advertised websocket endpoints", async () => {
	const cases = [
		{ statusCode: 302, location: "http://127.0.0.1:1/json/version", code: "httpFailed" },
		{ advertised: "ws://127.0.0.1:1/devtools/browser/fixture", code: "endpointMismatch" },
		{ advertised: "ws://localhost:9333/devtools/browser/fixture", code: "endpointMismatch" },
		{ advertised: "ws://127.0.0.1:9333/devtools/page/fixture", code: "endpointMismatch" },
		{ advertised: "ws://127.0.0.1:9333/devtools/browser/fixture?secret=1", code: "endpointMismatch" },
	]
	for (const fixture of cases) {
		let port
		const server = http.createServer((request, response) => {
			if (request.url === "/json/version") {
				if (fixture.statusCode) {
					response.statusCode = fixture.statusCode
					response.setHeader("Location", fixture.location)
					response.end()
					return
				}
				response.setHeader("Content-Type", "application/json")
				response.end(JSON.stringify({ webSocketDebuggerUrl: fixture.advertised.replace(":9333", `:${port}`) }))
				return
			}
			response.setHeader("Content-Type", "application/json")
			response.end("[]")
		})
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
		port = server.address().port
		try {
			await assert.rejects(
				discoverCdp(new URL(`http://127.0.0.1:${port}/`), { verifyListener: async () => {} }),
				(error) => error.code === fixture.code,
			)
		} finally {
			await new Promise((resolve) => server.close(resolve))
		}
	}
})

test("target registry preserves ambiguity and requires an explicit snapshot ordinal", () => {
	const client = { command: async () => ({ result: { value: {} } }) }
	const registry = new TargetRegistry({ client, random: deterministicRandom })
	const first = registry.observe({ targetId: "one", type: "page", title: "PRIVATE", url: "https://private" })
	const second = registry.observe({ targetId: "two", type: "page", title: "PRIVATE2", url: "https://private2" })
	registry.attach("one", "session-one")
	registry.attach("two", "session-two")
	first.strongCandidate = true
	second.strongCandidate = true
	assert.equal(registry.selection().state, "ambiguous")
	assert.throws(
		() => registry.resolveSnapshotTarget(),
		(error) => error.code === "targetAmbiguous",
	)
	assert.equal(registry.resolveSnapshotTarget(2).ordinal, 2)
})

test("target registry ignores stale detach after a target is reattached", () => {
	const registry = new TargetRegistry({ client: {}, random: deterministicRandom })
	const target = registry.observe({ targetId: "one", type: "page" })
	registry.attach("one", "session-old")
	registry.attach("one", "session-current")

	assert.equal(registry.detach("session-old"), null)
	assert.equal(target.sessionId, "session-current")
	assert.equal(registry.detach("session-current"), target)
	assert.equal(target.sessionId, null)
	assert.equal(registry.selection().state, "unresolved")
})

test("target registry bounds retained live and recent target epochs", () => {
	const registry = new TargetRegistry({ client: {}, random: deterministicRandom })
	for (let ordinal = 1; ordinal <= 80; ordinal += 1) {
		const target = registry.observe({ targetId: `target-${ordinal}`, type: "page" })
		registry.destroy(target.rawId)
	}
	assert.equal(registry.byRawId.size, 64)
	assert.equal(registry.byRawId.has("target-1"), false)
	assert.equal(registry.byRawId.has("target-80"), true)
})

test("explicit snapshot ordinal cannot select a non-ZooCode target", () => {
	const registry = new TargetRegistry({ client: {}, random: deterministicRandom })
	const target = registry.observe({ targetId: "unrelated", type: "page" })
	registry.attach("unrelated", "session-unrelated")
	assert.equal(target.strongCandidate, false)
	assert.throws(
		() => registry.resolveSnapshotTarget(target.ordinal),
		(error) => error.code === "targetUnavailable",
	)
})

test("renderer collector reports heartbeat loss/recovery and heap threshold without wall-clock sleeps", async () => {
	const clock = fakeClock()
	const events = []
	const collector = new RendererCollector({
		client: {},
		options: {
			heartbeatWarningMs: 5_000,
			heartbeatFailureMs: 10_000,
			heapWarningRatio: 0.7,
			heapCriticalRatio: 0.82,
		},
		clock,
		onMemory: async () => {},
		onProbe: async () => {},
		onEvent: async (type, data) => events.push({ type, data }),
	})
	await collector.updateHeartbeat({ timerSequence: 1 })
	clock.advance(5_000)
	await collector.updateHeartbeat({ timerSequence: 1 })
	clock.advance(5_000)
	await collector.updateHeartbeat({ timerSequence: 1 })
	assert.deepEqual(
		events.map((event) => event.type),
		["heartbeatDelayed", "rendererBlockedSuspected"],
	)
	await collector.updateHeartbeat({ timerSequence: 2 })
	await collector.updateHeartbeat({ timerSequence: 3 })
	assert.equal(events.filter((event) => event.type === "heartbeatRecovered").length, 2)
	await collector.updateHeapState({ usedJsHeapBytes: 850, jsHeapLimitBytes: 1000, heapRatio: 0.85 })
	assert.equal(
		events.some((event) => event.type === "heapThresholdCrossed" && event.data.threshold === "critical"),
		true,
	)
})

test("renderer collector requests one automatic snapshot after the configured consecutive critical samples", async () => {
	const events = []
	let automaticSnapshots = 0
	const collector = new RendererCollector({
		client: {},
		options: {
			heartbeatWarningMs: 5_000,
			heartbeatFailureMs: 10_000,
			heapWarningRatio: 0.7,
			heapCriticalRatio: 0.82,
			autoSnapshotSamples: 3,
		},
		clock: fakeClock(),
		onMemory: async () => {},
		onProbe: async () => {},
		onEvent: async (type, data) => events.push({ type, data }),
		onCriticalSamples: async () => {
			automaticSnapshots += 1
		},
	})

	for (let sample = 0; sample < 5; sample += 1) {
		await collector.updateHeapState({ usedJsHeapBytes: 850, jsHeapLimitBytes: 1000, heapRatio: 0.85 })
	}
	assert.equal(automaticSnapshots, 1)
	assert.equal(
		events.filter((event) => event.type === "heapThresholdCrossed" && event.data.threshold === "critical").length,
		1,
	)
})

test("renderer collector requests at most one automatic snapshot in a renderer epoch", async () => {
	let automaticSnapshots = 0
	const collector = new RendererCollector({
		client: {},
		options: {
			heartbeatWarningMs: 5_000,
			heartbeatFailureMs: 10_000,
			heapWarningRatio: 0.7,
			heapCriticalRatio: 0.82,
			autoSnapshotSamples: 2,
		},
		clock: fakeClock(),
		onMemory: async () => {},
		onProbe: async () => {},
		onEvent: async () => {},
		onCriticalSamples: async () => {
			automaticSnapshots += 1
		},
	})

	for (const heapRatio of [0.85, 0.85, 0.5, 0.85, 0.85]) {
		await collector.updateHeapState({
			usedJsHeapBytes: heapRatio * 1_000,
			jsHeapLimitBytes: 1_000,
			heapRatio,
		})
	}
	assert.equal(automaticSnapshots, 1)
})

test("renderer sanitization omits unknown counters and does not assert process liveness", async () => {
	const clock = fakeClock()
	const probes = []
	const events = []
	const responses = [
		{ result: { value: { available: false } } },
		{},
		{},
		{
			result: {
				value: {
					available: true,
					timerSequence: 1,
					documentVisibility: "malformed",
					domNodeCount: "unknown",
				},
			},
		},
	]
	const collector = new RendererCollector({
		client: { command: async () => responses.shift() },
		options: {
			rendererIntervalMs: 60_000,
			metricTimeoutMs: 100,
			heartbeatWarningMs: 5_000,
			heartbeatFailureMs: 10_000,
			heapWarningRatio: 0.7,
			heapCriticalRatio: 0.82,
			autoSnapshotSamples: 3,
		},
		clock,
		onMemory: async () => {},
		onProbe: async (probe) => probes.push(probe),
		onEvent: async (type, data) => events.push({ type, data }),
	})
	collector.target = { sessionId: "session" }
	await collector.poll()
	assert.equal(Object.hasOwn(probes[0], "animationFrameSequence"), false)
	assert.equal(Object.hasOwn(probes[0], "domNodeCount"), false)
	assert.equal(probes[0].documentVisibility, "unavailable")

	await collector.updateHeartbeat({ timerSequence: 1 })
	clock.advance(10_000)
	await collector.updateHeartbeat({ timerSequence: 1 })
	const blocked = events.find((event) => event.type === "rendererBlockedSuspected")
	assert.equal(Object.hasOwn(blocked.data, "processExists"), false)
})

test("renderer heartbeat remains unknown until a valid probe establishes a baseline", async () => {
	const clock = fakeClock()
	const events = []
	const collector = new RendererCollector({
		client: {},
		options: { heartbeatWarningMs: 5_000, heartbeatFailureMs: 10_000 },
		clock,
		onMemory: async () => {},
		onProbe: async () => {},
		onEvent: async (type) => events.push(type),
	})
	await collector.updateHeartbeat(null)
	clock.advance(20_000)
	await collector.updateHeartbeat(null)
	assert.deepEqual(events, [])
	assert.equal(collector.previousProbe, null)
})

test("CDP client emits crash/detach/navigation event frames and rejects timed out commands", async () => {
	const server = await createSyntheticCdpServer()
	const events = []
	let client
	try {
		const discovery = await discoverCdp(new URL(`http://127.0.0.1:${server.port}/`), {
			verifyListener: async () => {},
		})
		client = new CdpClient({ webSocketUrl: discovery.webSocketUrl, commandTimeoutMs: 20 })
		client.on("event", (event) => events.push(event.method))
		await client.connect()
		server.send({ method: "Inspector.targetCrashed", sessionId: "session-fixture", params: {} })
		server.send({ method: "Target.detachedFromTarget", params: { sessionId: "session-fixture" } })
		server.send({
			method: "Page.frameNavigated",
			sessionId: "session-fixture",
			params: { frame: { id: "f", url: "PRIVATE" } },
		})
		await new Promise((resolve) => setImmediate(resolve))
		assert.deepEqual(events, ["Inspector.targetCrashed", "Target.detachedFromTarget", "Page.frameNavigated"])
	} finally {
		client?.close()
		await server.close()
	}
})

test("CDP client bounds the number of pending commands", async () => {
	const { client, sent } = createConnectedCdpClient({ maxPendingCommands: 2 })
	const commands = [
		client.command("Runtime.enable", {}, { timeoutMs: 60_000 }),
		client.command("Runtime.enable", {}, { timeoutMs: 60_000 }),
		client.command("Runtime.enable", {}, { timeoutMs: 60_000 }),
	]
	const settlements = Promise.allSettled(commands)
	try {
		assert.equal(client.pending.size, 2)
		assert.equal(sent.length, 2)
	} finally {
		client.close()
	}
	const results = await settlements
	assert.equal(results[2].status, "rejected")
	assert.equal(results[2].reason.code, "cdpProtocolError")
})

test("CDP client fails closed at request ID exhaustion instead of reusing IDs", async () => {
	const { client, sent } = createConnectedCdpClient()
	client.nextRequestId = 2_147_483_647
	const finalCommand = client.command("Runtime.enable", {}, { timeoutMs: 60_000 })
	assert.equal(sent[0].id, 2_147_483_647)
	client.handleMessage(JSON.stringify({ id: 2_147_483_647, result: {} }))
	await finalCommand

	const exhaustedCommand = client.command("Runtime.enable", {}, { timeoutMs: 60_000 })
	const settlement = Promise.allSettled([exhaustedCommand])
	try {
		assert.equal(client.pending.size, 0)
		assert.equal(sent.length, 1)
	} finally {
		client.close()
	}
	const [result] = await settlement
	assert.equal(result.status, "rejected")
	assert.equal(result.reason.code, "cdpProtocolError")
})

test("CDP client ignores stale responses with unknown request IDs", async () => {
	const { client, sent } = createConnectedCdpClient()
	const command = client.command("Runtime.enable", {}, { timeoutMs: 60_000 })
	let settled = false
	void command.finally(() => {
		settled = true
	})

	client.handleMessage(JSON.stringify({ id: sent[0].id + 1, result: { stale: true } }))
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(settled, false)
	assert.equal(client.pending.size, 1)

	client.handleMessage(JSON.stringify({ id: sent[0].id, result: { accepted: true } }))
	assert.deepEqual(await command, { accepted: true })
	client.close()
})

test("CDP collector reconnects with a new epoch, fresh targets, and snapshot cancellation", async () => {
	const server = await createSyntheticCdpServer()
	const records = []
	const waits = []
	let collector
	try {
		collector = new CdpCollector({
			options: {
				cdpPort: server.port,
				rendererIntervalMs: 60_000,
				heartbeatWarningMs: 5_000,
				heartbeatFailureMs: 10_000,
				heapWarningRatio: 0.7,
				heapCriticalRatio: 0.82,
				autoSnapshotSamples: 3,
				autoSnapshotEnabled: false,
				verifyListener: async () => {},
				reconnectBackoffMs: [17],
				wait: async (milliseconds) => waits.push(milliseconds),
			},
			clock: fakeClock(),
			random: (() => {
				let value = 0
				return (size) => Buffer.alloc(size, ++value)
			})(),
			onRecord: async (type, data) => records.push({ type, data }),
			onCapability: async () => {},
		})
		const first = await collector.connect()
		const firstRegistry = collector.registry
		const firstTargetEpoch = firstRegistry.sanitizedTargets()[0].targetEpoch
		let disconnectCode = null
		collector.setSnapshotDisconnectListener((code) => {
			disconnectCode = code
		})

		server.disconnect()
		await server.waitForConnectionCount(2)
		while (collector.registry.sanitizedTargets().length === 0) await new Promise((resolve) => setImmediate(resolve))

		assert.deepEqual(waits, [17])
		assert.equal(disconnectCode, "cdpConnectionLost")
		assert.notEqual(collector.connectionEpoch, first.connectionEpoch)
		assert.notEqual(collector.registry, firstRegistry)
		assert.notEqual(collector.registry.sanitizedTargets()[0].targetEpoch, firstTargetEpoch)
		assert.equal(records.filter((record) => record.type === "cdpConnectionOpened").length, 2)
		assert.equal(records.filter((record) => record.type === "cdpConnectionClosed").length, 1)
	} finally {
		await collector?.stop()
		await server.close()
	}
})

test("CDP collector detaches every listener from a replaced client", async () => {
	class FakeClient extends EventEmitter {
		constructor() {
			super()
			this.connected = false
		}

		async connect() {
			this.connected = true
		}

		async command(method) {
			if (method === "SystemInfo.getProcessInfo") return { processInfo: [] }
			if (method === "Target.getTargets") return { targetInfos: [] }
			return {}
		}

		close() {
			this.connected = false
		}
	}

	const clients = []
	const collector = new CdpCollector({
		options: {
			cdpPort: 9333,
			verifyListener: async () => {},
		},
		clock: fakeClock(),
		random: deterministicRandom,
		onRecord: async () => {},
		onCapability: async () => {},
		clientFactory: () => {
			const client = new FakeClient()
			clients.push(client)
			return client
		},
	})
	collector.endpoint = new URL("http://127.0.0.1:9333/")
	collector.discovery = {
		webSocketUrl: "ws://127.0.0.1:9333/devtools/browser/test",
		version: {},
		initialTargetCount: 0,
	}
	collector.options.verifyListener = async () => {}

	const originalFetch = globalThis.fetch
	try {
		// connectOnce performs discovery through the imported bounded HTTP helper, so use
		// a minimal local server rather than replacing module bindings.
		const server = await createSyntheticCdpServer()
		try {
			collector.endpoint = new URL(`http://127.0.0.1:${server.port}/`)
			await collector.connectOnce()
			const first = clients[0]
			assert.equal(first.listenerCount("event"), 1)
			assert.equal(first.listenerCount("commandTimeout"), 1)
			assert.equal(first.listenerCount("close"), 1)

			await collector.connectOnce()
			assert.equal(first.listenerCount("event"), 0)
			assert.equal(first.listenerCount("commandTimeout"), 0)
			assert.equal(first.listenerCount("close"), 0)
		} finally {
			await server.close()
		}
	} finally {
		globalThis.fetch = originalFetch
		await collector.stop()
	}
})

test("CDP collector serializes and bounds asynchronous event work", async () => {
	let releaseFirst
	const firstBlocked = new Promise((resolve) => {
		releaseFirst = resolve
	})
	let calls = 0
	let concurrent = 0
	let maximumConcurrent = 0
	let closeCount = 0
	const collector = new CdpCollector({
		options: { maxQueuedCdpEvents: 2 },
		clock: fakeClock(),
		random: deterministicRandom,
		onRecord: async () => {},
		onCapability: async () => {},
	})
	collector.client = { close: () => (closeCount += 1) }
	collector.handleEvent = async () => {
		calls += 1
		concurrent += 1
		maximumConcurrent = Math.max(maximumConcurrent, concurrent)
		if (calls === 1) await firstBlocked
		concurrent -= 1
	}

	collector.eventHandler({ method: "Runtime.exceptionThrown", params: {} })
	collector.eventHandler({ method: "Runtime.exceptionThrown", params: {} })
	collector.eventHandler({ method: "Runtime.exceptionThrown", params: {} })
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(closeCount, 1)
	assert.equal(calls, 1)

	releaseFirst()
	await collector.eventQueue
	assert.equal(calls, 2)
	assert.equal(maximumConcurrent, 1)
	assert.equal(collector.queuedEventCount, 0)
})

test("CDP collector bounds queued event bytes and applies snapshot listener backpressure", async () => {
	let releaseSnapshot
	const snapshotBlocked = new Promise((resolve) => {
		releaseSnapshot = resolve
	})
	let snapshotCalls = 0
	let closeCount = 0
	const collector = new CdpCollector({
		options: { maxQueuedCdpEvents: 8, maxQueuedCdpEventBytes: 12 },
		clock: fakeClock(),
		random: deterministicRandom,
		onRecord: async () => {},
		onCapability: async () => {},
	})
	collector.client = { close: () => (closeCount += 1) }
	collector.setSnapshotListener(async () => {
		snapshotCalls += 1
		await snapshotBlocked
	})

	collector.eventHandler({
		method: "HeapProfiler.addHeapSnapshotChunk",
		params: { chunk: "first" },
		messageBytes: 8,
	})
	collector.eventHandler({
		method: "HeapProfiler.addHeapSnapshotChunk",
		params: { chunk: "second" },
		messageBytes: 8,
	})
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(snapshotCalls, 1)
	assert.equal(closeCount, 1)
	assert.equal(collector.queuedEventBytes, 8)

	releaseSnapshot()
	await collector.eventQueue
	assert.equal(collector.queuedEventBytes, 0)
})

test("CDP client reports exact assembled message bytes to the bounded event queue", () => {
	const { client } = createConnectedCdpClient()
	let event
	client.on("event", (value) => {
		event = value
	})
	const message = JSON.stringify({ method: "Runtime.exceptionThrown", params: { value: "é" } })
	client.handleMessage(message)
	assert.equal(event.messageBytes, Buffer.byteLength(message))
	client.close()
})

test("CDP collector aborts a pinned snapshot when its target session is lost", async () => {
	const collector = new CdpCollector({
		options: {},
		clock: fakeClock(),
		random: deterministicRandom,
		onRecord: async () => {},
		onCapability: async () => {},
	})
	collector.registry = new TargetRegistry({ client: {}, random: deterministicRandom })
	const target = collector.registry.observe({ targetId: "selected", type: "page" })
	collector.registry.attach(target.rawId, "selected-session")
	target.strongCandidate = true
	collector.renderer = { target, stop: async () => {} }
	let disconnectCode = null
	collector.setSnapshotDisconnectListener((code) => {
		disconnectCode = code
	}, "selected-session")

	await collector.handleEvent({
		method: "Target.detachedFromTarget",
		params: { sessionId: "selected-session" },
		sessionId: null,
	})
	assert.equal(disconnectCode, "targetLost")
})

test("CDP collector distinguishes selected renderer destruction from unrelated target destruction", async () => {
	const records = []
	const collector = new CdpCollector({
		options: {},
		clock: fakeClock(),
		random: deterministicRandom,
		onRecord: async (type, data, context) => records.push({ type, data, context }),
		onCapability: async () => {},
	})
	collector.registry = new TargetRegistry({ client: {}, random: deterministicRandom })
	const selected = collector.registry.observe({ targetId: "selected", type: "page" })
	const unrelated = collector.registry.observe({ targetId: "unrelated", type: "page" })
	collector.registry.attach(selected.rawId, "selected-session")
	collector.registry.attach(unrelated.rawId, "unrelated-session")
	selected.strongCandidate = true
	let rendererStops = 0
	collector.renderer = {
		target: selected,
		stop: async () => {
			rendererStops += 1
		},
	}
	collector.refreshSelection = async () => {}

	await collector.handleEvent({ method: "Target.targetDestroyed", params: { targetId: unrelated.rawId } })
	assert.equal(records.at(-1).context.selectedRenderer, false)
	assert.equal(rendererStops, 0)
	assert.equal(collector.renderer.target, selected)

	await collector.handleEvent({ method: "Target.targetDestroyed", params: { targetId: selected.rawId } })
	assert.equal(records.at(-1).context.selectedRenderer, true)
	assert.equal(rendererStops, 1)
	assert.equal(collector.renderer, null)
})

test("Windows listener inspection accepts only literal loopback bindings", async () => {
	function spawnFixture(output, closeCode = 0) {
		return () => {
			const child = new (class extends EventTarget {})()
			child.stdout = new EventTarget()
			child.stdin = {
				end: () =>
					queueMicrotask(() => {
						child.stdout.dispatchEvent(new MessageEvent("data", { data: Buffer.from(output) }))
						child.dispatchEvent(new Event("close"))
					}),
			}
			child.kill = () => {}
			child.on = (name, listener) =>
				child.addEventListener(name, (event) => listener(name === "close" ? closeCode : event.data))
			child.stdout.on = (name, listener) => child.stdout.addEventListener(name, (event) => listener(event.data))
			return child
		}
	}
	await verifyWindowsLoopbackListener(9333, { force: true, spawn: spawnFixture('["127.0.0.1","::1"]') })
	await assert.rejects(
		verifyWindowsLoopbackListener(9333, { force: true, spawn: spawnFixture('["127.0.0.1","0.0.0.0"]') }),
		(error) => error.code === "nonLoopbackListener",
	)
})
