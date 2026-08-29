import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"

import { DEFAULTS, VALIDATOR_VERSION } from "./constants.mjs"

export class SnapshotValidationError extends Error {
	constructor(code) {
		super("Heap snapshot validation failed")
		this.name = "SnapshotValidationError"
		this.code = code
	}
}

function fail(code) {
	throw new SnapshotValidationError(code)
}

class SchemaTracker {
	constructor() {
		this.nodeFields = null
		this.nodeTypes = null
		this.edgeFields = null
		this.edgeTypes = null
		this.nodeCount = null
		this.edgeCount = null
		this.nodesElements = null
		this.edgesElements = null
		this.arrays = new Map()
		this.objects = new Set()
		this.rootObject = false
	}

	key(path) {
		return path.join(".")
	}

	onBeginObject(path) {
		if (path.length === 0) {
			this.rootObject = true
			return
		}
		const key = this.key(path)
		const parent = this.arrays.get(this.key(path.slice(0, -1)))
		if (
			parent?.kind === "nodes" ||
			parent?.kind === "edges" ||
			parent?.kind === "nodeFields" ||
			parent?.kind === "edgeFields" ||
			parent?.kind === "nodeTypes" ||
			parent?.kind === "edgeTypes"
		) {
			fail("invalidSchemaArrayElement")
		}
		if (key !== "snapshot" && key !== "snapshot.meta") return
		if (this.objects.has(key)) fail("duplicateSchemaField")
		this.objects.add(key)
	}

	onBeginArray(path) {
		const key = this.key(path)
		if (this.arrays.has(key)) fail("duplicateSchemaField")
		if (key === "snapshot.meta.node_fields") this.arrays.set(key, { kind: "nodeFields", count: 0 })
		else if (key === "snapshot.meta.node_types") {
			this.arrays.set(key, { kind: "nodeTypes", count: 0 })
		} else if (key === "snapshot.meta.edge_fields") this.arrays.set(key, { kind: "edgeFields", count: 0 })
		else if (key === "snapshot.meta.edge_types") {
			this.arrays.set(key, { kind: "edgeTypes", count: 0 })
		} else if (key === "nodes") this.arrays.set(key, { kind: "nodes", count: 0 })
		else if (key === "edges") this.arrays.set(key, { kind: "edges", count: 0 })

		const parentKey = this.key(path.slice(0, -1))
		const parent = this.arrays.get(parentKey)
		if (
			parent?.kind === "nodes" ||
			parent?.kind === "edges" ||
			parent?.kind === "nodeFields" ||
			parent?.kind === "edgeFields"
		) {
			fail("invalidSchemaArrayElement")
		}
		if (parent?.kind === "nodeTypes" || parent?.kind === "edgeTypes") parent.count += 1
	}

	onEndArray(path) {
		const state = this.arrays.get(this.key(path))
		if (!state) return
		if (state.kind === "nodeFields") this.nodeFields = state.count
		else if (state.kind === "edgeFields") this.edgeFields = state.count
		else if (state.kind === "nodeTypes") this.nodeTypes = state.count
		else if (state.kind === "edgeTypes") this.edgeTypes = state.count
		else if (state.kind === "nodes") this.nodesElements = state.count
		else if (state.kind === "edges") this.edgesElements = state.count
		else if ((state.kind === "nodeTypes" || state.kind === "edgeTypes") && state.count === 0)
			fail("emptySchemaTypes")
	}

	onScalar(path, token, containerPath) {
		const pathKey = this.key(path)
		if (pathKey === "snapshot.node_count") {
			if (this.nodeCount !== null) fail("duplicateSchemaField")
			this.nodeCount = this.positiveInteger(token, "invalidNodeCount")
			return
		}
		if (pathKey === "snapshot.edge_count") {
			if (this.edgeCount !== null) fail("duplicateSchemaField")
			this.edgeCount = this.positiveInteger(token, "invalidEdgeCount")
			return
		}
		const state = this.arrays.get(this.key(containerPath))
		if (!state) return
		if (state.kind === "nodeFields" || state.kind === "edgeFields") {
			if (token.kind !== "string" || token.overflow) fail("invalidSchemaFieldName")
			state.count += 1
			return
		}
		if (state.kind === "nodeTypes" || state.kind === "edgeTypes") {
			if (token.kind !== "string" || token.overflow) fail("invalidSchemaType")
			state.count += 1
			return
		}
		if (state.kind === "nodes" || state.kind === "edges") {
			if (token.kind !== "number") fail("invalidHeapArrayElement")
			state.count += 1
			if (!Number.isSafeInteger(state.count)) fail("countOverflow")
		}
	}

	positiveInteger(token, code) {
		if (token.kind !== "number" || !/^\d+$/.test(token.raw)) fail(code)
		const value = Number(token.raw)
		if (!Number.isSafeInteger(value) || value <= 0) fail(code)
		return value
	}

	finish() {
		if (!this.rootObject) fail("rootNotObject")
		if (!Number.isSafeInteger(this.nodeFields) || this.nodeFields <= 0) fail("missingNodeFields")
		if (!Number.isSafeInteger(this.nodeTypes) || this.nodeTypes <= 0) fail("missingNodeTypes")
		if (!Number.isSafeInteger(this.edgeFields) || this.edgeFields <= 0) fail("missingEdgeFields")
		if (!Number.isSafeInteger(this.edgeTypes) || this.edgeTypes <= 0) fail("missingEdgeTypes")
		if (this.nodeTypes !== this.nodeFields) fail("nodeSchemaLengthMismatch")
		if (this.edgeTypes !== this.edgeFields) fail("edgeSchemaLengthMismatch")
		if (!Number.isSafeInteger(this.nodeCount) || this.nodeCount <= 0) fail("invalidNodeCount")
		if (!Number.isSafeInteger(this.edgeCount) || this.edgeCount <= 0) fail("invalidEdgeCount")
		if (!Number.isSafeInteger(this.nodesElements)) fail("missingNodesArray")
		if (!Number.isSafeInteger(this.edgesElements)) fail("missingEdgesArray")
		const expectedNodes = this.nodeCount * this.nodeFields
		const expectedEdges = this.edgeCount * this.edgeFields
		if (!Number.isSafeInteger(expectedNodes) || !Number.isSafeInteger(expectedEdges)) fail("countOverflow")
		if (this.nodesElements !== expectedNodes) fail("nodeArrayCountMismatch")
		if (this.edgesElements !== expectedEdges) fail("edgeArrayCountMismatch")
		return {
			nodeCount: this.nodeCount,
			edgeCount: this.edgeCount,
			nodeFieldCount: this.nodeFields,
			edgeFieldCount: this.edgeFields,
			nodeArrayElementCount: this.nodesElements,
			edgeArrayElementCount: this.edgesElements,
		}
	}
}

class JsonSyntaxParser {
	constructor({ maxDepth = DEFAULTS.maxJsonDepth, tracker }) {
		this.maxDepth = maxDepth
		this.tracker = tracker
		this.stack = []
		this.rootState = "value"
	}

	current() {
		return this.stack.at(-1) ?? null
	}

	nextPath() {
		const parent = this.current()
		if (!parent) return []
		if (parent.type === "object") return [...parent.path, parent.key]
		return [...parent.path, "*"]
	}

	startValue(token) {
		const parent = this.current()
		if (!parent) {
			if (this.rootState !== "value") fail("invalidJsonGrammar")
			this.rootState = "awaiting"
		} else if (parent.type === "object") {
			if (parent.state !== "value") fail("invalidJsonGrammar")
			parent.state = "awaiting"
		} else {
			if (!new Set(["valueOrEnd", "valueOnly"]).has(parent.state)) fail("invalidJsonGrammar")
			parent.state = "awaiting"
		}
		const path = this.nextPath()
		if (token.kind === "{") {
			if (this.stack.length >= this.maxDepth) fail("maximumDepthExceeded")
			this.tracker.onBeginObject(path)
			this.stack.push({ type: "object", state: "keyOrEnd", key: null, path })
			return
		}
		if (token.kind === "[") {
			if (this.stack.length >= this.maxDepth) fail("maximumDepthExceeded")
			this.tracker.onBeginArray(path)
			this.stack.push({ type: "array", state: "valueOrEnd", path })
			return
		}
		this.tracker.onScalar(path, token, parent?.path ?? [])
		this.completeValue()
	}

	completeValue() {
		const parent = this.current()
		if (!parent) {
			if (this.rootState !== "awaiting") fail("invalidJsonGrammar")
			this.rootState = "done"
			return
		}
		if (parent.state !== "awaiting") fail("invalidJsonGrammar")
		parent.state = "commaOrEnd"
		if (parent.type === "object") parent.key = null
	}

	consume(token) {
		const context = this.current()
		if (!context) {
			if (this.rootState !== "value") fail("trailingJsonData")
			this.startValue(token)
			return
		}
		if (context.type === "object") this.consumeObject(context, token)
		else this.consumeArray(context, token)
	}

	consumeObject(context, token) {
		if (context.state === "keyOrEnd") {
			if (token.kind === "}") return this.closeContainer(context)
			if (token.kind !== "string" || token.overflow) fail("invalidObjectKey")
			context.key = token.value
			context.state = "colon"
			return
		}
		if (context.state === "keyOnly") {
			if (token.kind !== "string" || token.overflow) fail("invalidObjectKey")
			context.key = token.value
			context.state = "colon"
			return
		}
		if (context.state === "colon") {
			if (token.kind !== ":") fail("invalidJsonGrammar")
			context.state = "value"
			return
		}
		if (context.state === "value") return this.startValue(token)
		if (context.state === "commaOrEnd") {
			if (token.kind === ",") context.state = "keyOnly"
			else if (token.kind === "}") this.closeContainer(context)
			else fail("invalidJsonGrammar")
			return
		}
		fail("invalidJsonGrammar")
	}

	consumeArray(context, token) {
		if (context.state === "valueOrEnd") {
			if (token.kind === "]") return this.closeContainer(context)
			return this.startValue(token)
		}
		if (context.state === "valueOnly") return this.startValue(token)
		if (context.state === "commaOrEnd") {
			if (token.kind === ",") context.state = "valueOnly"
			else if (token.kind === "]") this.closeContainer(context)
			else fail("invalidJsonGrammar")
			return
		}
		fail("invalidJsonGrammar")
	}

	closeContainer(context) {
		if (this.current() !== context) fail("invalidJsonGrammar")
		if (context.type === "array") this.tracker.onEndArray(context.path)
		this.stack.pop()
		this.completeValue()
	}

	finish() {
		if (this.stack.length !== 0 || this.rootState !== "done") fail("truncatedJson")
	}
}

class JsonTokenizer {
	constructor(parser) {
		this.parser = parser
		this.state = "default"
		this.stringValue = ""
		this.stringOverflow = false
		this.unicodeDigits = ""
		this.numberValue = ""
		this.literalTarget = ""
		this.literalIndex = 0
		this.pendingHighSurrogate = false
	}

	emit(token) {
		this.parser.consume(token)
	}

	appendString(character) {
		if (!this.stringOverflow) {
			this.stringValue += character
			if (this.stringValue.length > 128) {
				this.stringValue = ""
				this.stringOverflow = true
			}
		}
	}

	appendUnicodeCodeUnit(codeUnit) {
		const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff
		const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
		if (this.pendingHighSurrogate) {
			if (!isLowSurrogate) fail("invalidUnicodeSurrogate")
			this.pendingHighSurrogate = false
		} else if (isLowSurrogate) fail("invalidUnicodeSurrogate")
		else if (isHighSurrogate) this.pendingHighSurrogate = true
		this.appendString(String.fromCharCode(codeUnit))
	}

	push(text) {
		for (let index = 0; index < text.length; index += 1) {
			const character = text[index]
			if (this.state === "string") {
				if (character === '"') {
					if (this.pendingHighSurrogate) fail("invalidUnicodeSurrogate")
					this.emit({
						kind: "string",
						value: this.stringOverflow ? null : this.stringValue,
						overflow: this.stringOverflow,
					})
					this.state = "default"
				} else if (character === "\\") this.state = "escape"
				else {
					if (this.pendingHighSurrogate) fail("invalidUnicodeSurrogate")
					if (character.charCodeAt(0) < 0x20) fail("invalidStringCharacter")
					this.appendString(character)
				}
				continue
			}
			if (this.state === "escape") {
				const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }
				if (Object.hasOwn(escapes, character)) {
					this.appendString(escapes[character])
					this.state = "string"
				} else if (character === "u") {
					this.unicodeDigits = ""
					this.state = "unicode"
				} else fail("invalidStringEscape")
				continue
			}
			if (this.state === "unicode") {
				if (!/[0-9a-fA-F]/.test(character)) fail("invalidUnicodeEscape")
				this.unicodeDigits += character
				if (this.unicodeDigits.length === 4) {
					this.appendUnicodeCodeUnit(Number.parseInt(this.unicodeDigits, 16))
					this.state = "string"
				}
				continue
			}
			if (this.state === "number") {
				if (/[0-9eE+.-]/.test(character)) {
					this.numberValue += character
					if (this.numberValue.length > 128) fail("numberTokenTooLong")
					continue
				}
				this.finishNumber()
				index -= 1
				continue
			}
			if (this.state === "literal") {
				if (character !== this.literalTarget[this.literalIndex]) fail("invalidLiteral")
				this.literalIndex += 1
				if (this.literalIndex === this.literalTarget.length) {
					this.emit({ kind: "literal", value: this.literalTarget })
					this.state = "default"
				}
				continue
			}

			if (character === " " || character === "\t" || character === "\r" || character === "\n") continue
			if ("{}[],:".includes(character)) {
				this.emit({ kind: character })
				continue
			}
			if (character === '"') {
				this.state = "string"
				this.stringValue = ""
				this.stringOverflow = false
				this.pendingHighSurrogate = false
				continue
			}
			if (character === "-" || /[0-9]/.test(character)) {
				this.state = "number"
				this.numberValue = character
				continue
			}
			const literal = character === "t" ? "true" : character === "f" ? "false" : character === "n" ? "null" : null
			if (!literal) fail("invalidJsonToken")
			this.state = "literal"
			this.literalTarget = literal
			this.literalIndex = 1
		}
	}

	finishNumber() {
		if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.numberValue)) fail("invalidNumber")
		this.emit({ kind: "number", raw: this.numberValue })
		this.numberValue = ""
		this.state = "default"
	}

	finish() {
		if (this.state === "number") this.finishNumber()
		else if (this.state !== "default") fail("truncatedJsonToken")
		this.parser.finish()
	}
}

export async function validateHeapSnapshot(filePath, options = {}) {
	let stat
	try {
		stat = await fsp.stat(filePath)
	} catch {
		fail("fileUnavailable")
	}
	if (!stat.isFile()) fail("notRegularFile")
	if (stat.size === 0) fail("zeroByteFile")

	const tracker = new SchemaTracker()
	const parser = new JsonSyntaxParser({ maxDepth: options.maxDepth ?? DEFAULTS.maxJsonDepth, tracker })
	const tokenizer = new JsonTokenizer(parser)
	const hash = createHash("sha256")
	const decoder = new TextDecoder("utf-8", { fatal: true })
	const stream = fs.createReadStream(filePath, { highWaterMark: options.bufferBytes ?? 64 * 1024 })
	let byteCount = 0
	let timedOut = false
	const timeout = setTimeout(() => {
		timedOut = true
		stream.destroy(new SnapshotValidationError("validationTimedOut"))
	}, options.timeoutMs ?? DEFAULTS.validationTimeoutMs)
	try {
		for await (const chunk of stream) {
			byteCount += chunk.length
			hash.update(chunk)
			let text
			try {
				text = decoder.decode(chunk, { stream: true })
			} catch {
				fail("invalidUtf8")
			}
			tokenizer.push(text)
		}
		if (timedOut) fail("validationTimedOut")
		try {
			tokenizer.push(decoder.decode())
		} catch {
			fail("invalidUtf8")
		}
		tokenizer.finish()
		const schema = tracker.finish()
		const sha256 = hash.digest("hex")
		if (options.expectedSha256 && sha256 !== options.expectedSha256) fail("checksumMismatch")
		return { valid: true, validatorVersion: VALIDATOR_VERSION, byteCount, sha256, ...schema }
	} catch (error) {
		if (error instanceof SnapshotValidationError) throw error
		fail(timedOut ? "validationTimedOut" : "readFailed")
	} finally {
		clearTimeout(timeout)
		stream.destroy()
	}
}
