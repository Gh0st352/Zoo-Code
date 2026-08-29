import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"

export function minimalSnapshot(overrides = {}) {
	const nodeFields = overrides.nodeFields ?? ["type", "name"]
	const edgeFields = overrides.edgeFields ?? ["type", "name_or_index", "to_node"]
	const nodeCount = overrides.nodeCount ?? 1
	const edgeCount = overrides.edgeCount ?? 1
	const nodes = overrides.nodes ?? Array.from({ length: nodeCount * nodeFields.length }, () => 0)
	const edges = overrides.edges ?? Array.from({ length: edgeCount * edgeFields.length }, () => 0)
	const snapshot = {
		snapshot: {
			meta: {
				node_fields: nodeFields,
				node_types: [["hidden"], "string"],
				edge_fields: edgeFields,
				edge_types: [["context"], "string_or_number", "node"],
			},
			node_count: nodeCount,
			edge_count: edgeCount,
		},
		nodes,
		edges,
		strings: overrides.strings ?? ["PRIVATE_POISON_TRANSCRIPT"],
	}
	if (overrides.remove) {
		let value = snapshot
		const parts = overrides.remove.split(".")
		for (const part of parts.slice(0, -1)) value = value[part]
		delete value[parts.at(-1)]
	}
	return JSON.stringify(snapshot)
}

export async function writeSnapshot(filePath, options = {}) {
	const text = options.text ?? minimalSnapshot(options)
	await fs.writeFile(filePath, text)
	return { text, sha256: createHash("sha256").update(text).digest("hex") }
}

function acceptWebSocket(request, socket, head, onMessage) {
	const key = request.headers["sec-websocket-key"]
	const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	)
	let buffer = Buffer.from(head)
	const parse = () => {
		while (buffer.length >= 2) {
			const first = buffer[0]
			const second = buffer[1]
			const opcode = first & 0x0f
			const masked = (second & 0x80) !== 0
			let length = second & 0x7f
			let offset = 2
			if (length === 126) {
				if (buffer.length < 4) return
				length = buffer.readUInt16BE(2)
				offset = 4
			} else if (length === 127) return socket.destroy()
			if (!masked || buffer.length < offset + 4 + length) return
			const mask = buffer.subarray(offset, offset + 4)
			offset += 4
			const payload = Buffer.from(buffer.subarray(offset, offset + length))
			for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
			buffer = buffer.subarray(offset + length)
			if (opcode === 8) return socket.end(Buffer.from([0x88, 0x00]))
			if (opcode === 1)
				onMessage(JSON.parse(payload.toString("utf8")), (message) => sendServerText(socket, message))
		}
	}
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk])
		parse()
	})
	parse()
}

function sendServerText(socket, value) {
	const payload = Buffer.from(JSON.stringify(value), "utf8")
	let header
	if (payload.length < 126) header = Buffer.from([0x81, payload.length])
	else {
		header = Buffer.alloc(4)
		header[0] = 0x81
		header[1] = 126
		header.writeUInt16BE(payload.length, 2)
	}
	socket.write(Buffer.concat([header, payload]))
}

export async function createSyntheticCdpServer(options = {}) {
	const poisonTitle = options.poisonTitle ?? "PRIVATE_TITLE_POISON"
	const poisonUrl = options.poisonUrl ?? "https://private.invalid/?secret=URL_POISON"
	const targetId = "target-fixture"
	const sessionId = "session-fixture"
	let port
	let websocketSocket
	let connectionCount = 0
	const connectionWaiters = []
	const requests = []
	const server = http.createServer((request, response) => {
		if (request.url === "/json/version") {
			response.setHeader("Content-Type", "application/json")
			response.end(
				JSON.stringify({
					Browser: "Chrome/fixture",
					"Protocol-Version": "1.3",
					webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fixture`,
				}),
			)
			return
		}
		if (request.url === "/json/list") {
			response.setHeader("Content-Type", "application/json")
			response.end(JSON.stringify([{ id: targetId, type: "page", title: poisonTitle, url: poisonUrl }]))
			return
		}
		response.statusCode = 404
		response.end()
	})
	server.on("upgrade", (request, socket, head) => {
		websocketSocket = socket
		connectionCount += 1
		for (let index = connectionWaiters.length - 1; index >= 0; index -= 1) {
			if (connectionCount >= connectionWaiters[index].count) connectionWaiters.splice(index, 1)[0].resolve()
		}
		acceptWebSocket(request, socket, head, (message, send) => {
			requests.push(message)
			const session = message.sessionId ? { sessionId: message.sessionId } : {}
			const result = (() => {
				switch (message.method) {
					case "SystemInfo.getProcessInfo":
						return { processInfo: [{ type: "browser", id: options.browserPid ?? 42 }] }
					case "Target.getTargets":
						return { targetInfos: [{ targetId, type: "page", title: poisonTitle, url: poisonUrl }] }
					case "Target.attachToTarget":
						return { sessionId }
					case "Runtime.evaluate": {
						if (message.params.expression.includes("bootstrapGlobalsCount")) {
							return {
								result: {
									value: {
										schemaVersion: 1,
										rootPresent: true,
										acquireApiPresent: true,
										bootstrapGlobalsCount: 3,
										vscodeWebviewTrait: true,
										documentReady: "complete",
										domNodeCount: 12,
									},
								},
							}
						}
						if (message.params.expression.includes("performance.memory")) {
							return {
								result: {
									value: {
										available: true,
										usedJsHeapBytes: 100,
										totalJsHeapBytes: 200,
										jsHeapLimitBytes: 1000,
									},
								},
							}
						}
						if (message.params.expression.includes("probeSample"))
							return { result: { value: { available: false } } }
						return { result: { value: { installed: true, longTaskAvailable: true } } }
					}
					case "Runtime.getHeapUsage":
						return { usedSize: 110, totalSize: 210 }
					case "Performance.getMetrics":
						return {
							metrics: [
								{ name: "JSHeapUsedSize", value: 110 },
								{ name: "ForbiddenMetric", value: 999 },
							],
						}
					default:
						return {}
				}
			})()
			if (message.method === "HeapProfiler.takeHeapSnapshot") {
				const text = minimalSnapshot()
				send({ method: "HeapProfiler.addHeapSnapshotChunk", sessionId, params: { chunk: text.slice(0, 10) } })
				send({ method: "HeapProfiler.addHeapSnapshotChunk", sessionId, params: { chunk: text.slice(10) } })
			}
			send({ id: message.id, result, ...session })
		})
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	port = server.address().port
	return {
		port,
		requests,
		disconnect() {
			websocketSocket?.destroy()
		},
		waitForConnectionCount(count) {
			if (connectionCount >= count) return Promise.resolve()
			return new Promise((resolve) => connectionWaiters.push({ count, resolve }))
		},
		send(message) {
			if (!websocketSocket) throw new Error("WebSocket is not connected")
			sendServerText(websocketSocket, message)
		},
		async close() {
			websocketSocket?.destroy()
			await new Promise((resolve) => server.close(resolve))
		},
	}
}

export function fakeClock(start = "2026-08-28T18:00:00.000Z") {
	let utcMs = Date.parse(start)
	let monotonicMs = 0
	return {
		utc: () => new Date(utcMs).toISOString(),
		monotonicNs: () => BigInt(monotonicMs) * 1_000_000n,
		monotonicMs: () => monotonicMs,
		advance(ms) {
			utcMs += ms
			monotonicMs += ms
		},
	}
}

export function deterministicRandom(size) {
	return Buffer.alloc(size, 7)
}
