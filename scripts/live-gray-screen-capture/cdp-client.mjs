import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import http from "node:http"
import net from "node:net"

import { CDP_METHODS, DEFAULTS } from "./constants.mjs"
import { sanitizeVersion } from "./records.mjs"

export class CdpError extends Error {
	constructor(code, message, retryable = false) {
		super(message)
		this.name = "CdpError"
		this.code = code
		this.retryable = retryable
	}
}

function isLiteralLoopback(hostname) {
	const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
	if (normalized === "::1") return true
	if (net.isIP(normalized) !== 4) return false
	const octets = normalized.split(".").map(Number)
	return octets[0] === 127
}

const WINDOWS_LISTENER_PROJECTION = String.raw`
$ErrorActionPreference = 'Stop'
$port = [int]([Console]::In.ReadToEnd())
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -ExpandProperty LocalAddress -Unique)
if ($listeners.Count -eq 0) { throw 'listener-not-found' }
[Console]::Out.Write(($listeners | ConvertTo-Json -Compress))
`

export function verifyWindowsLoopbackListener(port, options = {}) {
	if (process.platform !== "win32" && !options.force) return Promise.resolve()
	const spawnImpl = options.spawn ?? spawn
	const timeoutMs = options.timeoutMs ?? DEFAULTS.httpTimeoutMs
	return new Promise((resolve, reject) => {
		const child = spawnImpl(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				WINDOWS_LISTENER_PROJECTION,
			],
			{ stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false },
		)
		const chunks = []
		let bytes = 0
		let settled = false
		const fail = (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.kill()
			reject(new CdpError(code, "CDP listener binding could not be verified"))
		}
		const timer = setTimeout(() => fail("listenerInspectionFailed"), timeoutMs)
		child.stdout.on("data", (chunk) => {
			bytes += chunk.length
			if (bytes > 4096) return fail("listenerInspectionFailed")
			chunks.push(chunk)
		})
		child.on("error", () => fail("listenerInspectionFailed"))
		child.on("close", (code) => {
			if (settled) return
			if (code !== 0) return fail("listenerInspectionFailed")
			try {
				const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
				const addresses = Array.isArray(value) ? value : [value]
				if (
					addresses.length === 0 ||
					addresses.some((address) => typeof address !== "string" || !isLiteralLoopback(address))
				) {
					return fail("nonLoopbackListener")
				}
				settled = true
				clearTimeout(timer)
				resolve()
			} catch {
				fail("listenerInspectionFailed")
			}
		})
		child.stdin.end(String(port))
	})
}

export function validateLoopbackEndpoint(input, { allowPath = false } = {}) {
	let endpoint
	try {
		endpoint = input instanceof URL ? new URL(input.href) : new URL(input)
	} catch {
		throw new CdpError("nonLoopbackEndpoint", "CDP endpoint must be an HTTP loopback URL")
	}
	if (
		endpoint.protocol !== "http:" ||
		!isLiteralLoopback(endpoint.hostname) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		(!allowPath && endpoint.pathname !== "/")
	) {
		throw new CdpError(
			"nonLoopbackEndpoint",
			"CDP endpoint must be literal loopback HTTP without credentials or query data",
		)
	}
	const port = Number(endpoint.port)
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new CdpError("nonLoopbackEndpoint", "CDP endpoint requires an explicit valid port")
	}
	endpoint.hostname = endpoint.hostname.includes(":") ? "[::1]" : endpoint.hostname
	endpoint.pathname = allowPath ? endpoint.pathname : "/"
	return endpoint
}

export function endpointFromOptions(options) {
	if (options.cdpEndpoint) return validateLoopbackEndpoint(options.cdpEndpoint)
	if (!Number.isInteger(options.cdpPort) || options.cdpPort < 1 || options.cdpPort > 65_535) {
		throw new CdpError("nonLoopbackEndpoint", "A valid loopback CDP port is required")
	}
	return validateLoopbackEndpoint(`http://127.0.0.1:${options.cdpPort}/`)
}

export async function fetchJsonBounded(endpoint, route, options = {}) {
	const base = validateLoopbackEndpoint(endpoint)
	if (!["/json/version", "/json/list"].includes(route))
		throw new CdpError("httpFailed", "CDP discovery route is not allowlisted")
	const timeoutMs = options.timeoutMs ?? DEFAULTS.httpTimeoutMs
	const maxBytes = options.maxBytes ?? DEFAULTS.maxHttpBytes
	const requestUrl = new URL(route, base)
	return new Promise((resolve, reject) => {
		let settled = false
		const fail = (error) => {
			if (settled) return
			settled = true
			reject(error)
		}
		const request = http.request(
			requestUrl,
			{
				method: "GET",
				agent: false,
				setHost: true,
				headers: { Accept: "application/json", Connection: "close" },
			},
			(response) => {
				if (response.statusCode !== 200) {
					response.resume()
					fail(new CdpError("httpFailed", "CDP discovery returned a non-success status", true))
					return
				}
				if (response.headers.location) {
					response.resume()
					fail(new CdpError("httpFailed", "CDP discovery redirects are forbidden"))
					return
				}
				const chunks = []
				let bytes = 0
				response.on("data", (chunk) => {
					bytes += chunk.length
					if (bytes > maxBytes) {
						request.destroy()
						fail(new CdpError("httpTooLarge", "CDP discovery response exceeded the fixed bound"))
						return
					}
					chunks.push(chunk)
				})
				response.on("end", () => {
					if (settled) return
					try {
						const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
						settled = true
						resolve(value)
					} catch {
						fail(new CdpError("httpFailed", "CDP discovery returned malformed JSON"))
					}
				})
			},
		)
		request.setTimeout(timeoutMs, () => {
			request.destroy()
			fail(new CdpError("httpTimedOut", "CDP discovery timed out", true))
		})
		request.on("error", () => fail(new CdpError("httpFailed", "CDP discovery connection failed", true)))
		request.end()
	})
}

function validateAdvertisedWebSocket(webSocketUrl, endpoint) {
	let url
	try {
		url = new URL(webSocketUrl)
	} catch {
		throw new CdpError("endpointMismatch", "CDP advertised an invalid websocket endpoint")
	}
	const base = validateLoopbackEndpoint(endpoint)
	if (
		url.protocol !== "ws:" ||
		url.hostname !== base.hostname ||
		Number(url.port) !== Number(base.port) ||
		!isLiteralLoopback(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!/^\/devtools\/browser\/[A-Za-z0-9._-]{1,256}$/.test(url.pathname)
	) {
		throw new CdpError("endpointMismatch", "CDP websocket endpoint does not match the requested loopback listener")
	}
	return url.href
}

export async function discoverCdp(endpoint, options = {}) {
	const version = await fetchJsonBounded(endpoint, "/json/version", options)
	const targets = await fetchJsonBounded(endpoint, "/json/list", options)
	if (!Array.isArray(targets) || targets.length > 256)
		throw new CdpError("httpFailed", "CDP target list is malformed")
	const webSocketUrl = validateAdvertisedWebSocket(version.webSocketDebuggerUrl, endpoint)
	await (options.verifyListener ?? verifyWindowsLoopbackListener)(
		Number(validateLoopbackEndpoint(endpoint).port),
		options,
	)
	return {
		webSocketUrl,
		version: sanitizeVersion(version),
		initialTargetCount: targets.length,
	}
}

export class CdpClient extends EventEmitter {
	constructor({
		webSocketUrl,
		WebSocketImpl = globalThis.WebSocket,
		commandTimeoutMs = DEFAULTS.commandTimeoutMs,
		maxPendingCommands = DEFAULTS.maxPendingCdpCommands,
	}) {
		super()
		if (typeof WebSocketImpl !== "function")
			throw new CdpError("webSocketUnavailable", "Node WebSocket support is unavailable")
		validateAdvertisedWebSocket(
			webSocketUrl,
			new URL(webSocketUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/[^/]+$/, "/")),
		)
		if (!Number.isSafeInteger(maxPendingCommands) || maxPendingCommands < 1)
			throw new CdpError("cdpProtocolError", "CDP pending-command bound is invalid")
		this.webSocketUrl = webSocketUrl
		this.WebSocketImpl = WebSocketImpl
		this.commandTimeoutMs = commandTimeoutMs
		this.maxPendingCommands = maxPendingCommands
		this.socket = null
		this.pending = new Map()
		this.nextRequestId = 1
		this.connected = false
		this.closedByUser = false
	}

	async connect(timeoutMs = DEFAULTS.httpTimeoutMs) {
		if (this.connected) return
		this.closedByUser = false
		await new Promise((resolve, reject) => {
			let settled = false
			const socket = new this.WebSocketImpl(this.webSocketUrl, [], { perMessageDeflate: false })
			this.socket = socket
			socket.binaryType = "arraybuffer"
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				socket.close()
				reject(new CdpError("httpTimedOut", "CDP websocket connection timed out", true))
			}, timeoutMs)
			socket.addEventListener("open", () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				this.connected = true
				resolve()
			})
			socket.addEventListener("message", (event) => this.handleMessage(event.data))
			socket.addEventListener("close", (event) => {
				clearTimeout(timer)
				const wasConnected = this.connected
				this.connected = false
				this.rejectPending(new CdpError("webSocketClosed", "CDP websocket closed", !this.closedByUser))
				if (!settled) {
					settled = true
					reject(new CdpError("webSocketClosed", "CDP websocket closed before connection", true))
				} else if (wasConnected) {
					this.emit("close", { code: event.code, retryable: !this.closedByUser })
				}
			})
			socket.addEventListener("error", () => {
				if (!settled) {
					settled = true
					clearTimeout(timer)
					reject(new CdpError("webSocketClosed", "CDP websocket failed", true))
				}
			})
		})
	}

	handleMessage(raw) {
		let text
		if (typeof raw === "string") text = raw
		else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8")
		else return
		if (Buffer.byteLength(text) > DEFAULTS.maxWebSocketMessageBytes) {
			this.emit("protocolError", new CdpError("cdpMalformedMessage", "CDP message exceeded the fixed bound"))
			this.close()
			return
		}
		let message
		try {
			message = JSON.parse(text)
		} catch {
			this.emit("protocolError", new CdpError("cdpMalformedMessage", "CDP message was malformed"))
			return
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) return
		if (Number.isSafeInteger(message.id)) {
			const pending = this.pending.get(message.id)
			if (!pending) return
			this.pending.delete(message.id)
			clearTimeout(pending.timer)
			if (message.error) {
				const unavailable = message.error.code === -32601
				pending.reject(
					new CdpError(unavailable ? "methodUnavailable" : "cdpProtocolError", "CDP command failed"),
				)
			} else {
				pending.resolve(message.result ?? {})
			}
			return
		}
		if (typeof message.method === "string") {
			this.emit("event", {
				method: message.method,
				params: message.params ?? {},
				sessionId: message.sessionId ?? null,
				messageBytes: Buffer.byteLength(text),
			})
		}
	}

	allocateId() {
		if (this.nextRequestId > 2_147_483_647)
			throw new CdpError("cdpProtocolError", "CDP request ID space is exhausted")
		return this.nextRequestId++
	}

	command(method, params = {}, { sessionId = null, timeoutMs = this.commandTimeoutMs } = {}) {
		if (!CDP_METHODS.has(method))
			return Promise.reject(new CdpError("cdpProtocolError", "CDP method is not allowlisted"))
		if (!this.connected || !this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
			return Promise.reject(new CdpError("webSocketClosed", "CDP websocket is not connected", true))
		}
		if (this.pending.size >= this.maxPendingCommands)
			return Promise.reject(new CdpError("cdpProtocolError", "CDP pending-command bound was reached", true))
		let id
		try {
			id = this.allocateId()
		} catch (error) {
			return Promise.reject(error)
		}
		const message = { id, method, params }
		if (sessionId) message.sessionId = sessionId
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				const error = new CdpError("cdpTimedOut", "CDP command timed out", true)
				this.emit("commandTimeout", { method })
				reject(error)
			}, timeoutMs)
			this.pending.set(id, { resolve, reject, timer })
			try {
				this.socket.send(JSON.stringify(message))
			} catch {
				clearTimeout(timer)
				this.pending.delete(id)
				reject(new CdpError("webSocketClosed", "CDP websocket send failed", true))
			}
		})
	}

	rejectPending(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer)
			pending.reject(error)
		}
		this.pending.clear()
	}

	close() {
		this.closedByUser = true
		this.connected = false
		this.rejectPending(new CdpError("webSocketClosed", "CDP client closed"))
		this.socket?.close()
		this.socket = null
	}
}
