export function assertSupportedRuntime(options = {}) {
	const nodeVersion = options.nodeVersion ?? process.versions.node
	const WebSocketImpl = Object.hasOwn(options, "WebSocketImpl") ? options.WebSocketImpl : globalThis.WebSocket
	const nodeMajor = Number(nodeVersion.split(".", 1)[0])
	if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22 || typeof WebSocketImpl !== "function") {
		throw Object.assign(new Error("Node 22 or newer with built-in WebSocket support is required"), {
			code: "UNSUPPORTED_RUNTIME",
		})
	}
}
