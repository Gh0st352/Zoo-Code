import { FIXED_EXPRESSIONS } from "./constants.mjs"
import { generateEpochId } from "./records.mjs"

const RENDERER_TARGET_TYPES = new Set(["page", "iframe", "webview", "other"])
const MAX_RETAINED_TARGETS = 64

function targetType(type) {
	return ["page", "iframe", "webview", "worker"].includes(type) ? type : "other"
}

function sanitizeProbe(value) {
	if (!value || typeof value !== "object" || value.schemaVersion !== 1) return null
	const documentReady = ["loading", "interactive", "complete"].includes(value.documentReady)
		? value.documentReady
		: "unavailable"
	const bootstrapGlobalsCount = Number.isSafeInteger(value.bootstrapGlobalsCount)
		? Math.max(0, Math.min(3, value.bootstrapGlobalsCount))
		: 0
	return {
		rootPresent: value.rootPresent === true,
		acquireApiPresent: value.acquireApiPresent === true,
		bootstrapGlobalsCount,
		vscodeWebviewTrait: value.vscodeWebviewTrait === true,
		documentReady,
		domNodeCount: Number.isSafeInteger(value.domNodeCount)
			? Math.max(0, Math.min(1_000_000, value.domNodeCount))
			: 0,
	}
}

export class TargetRegistry {
	constructor({ client, random, onRecord = async () => {} }) {
		this.client = client
		this.random = random
		this.onRecord = onRecord
		this.byRawId = new Map()
		this.bySessionId = new Map()
		this.nextOrdinal = 1
		this.navigationGeneration = 0
	}

	observe(info) {
		if (!info || typeof info.targetId !== "string" || info.targetId.length > 512) return null
		let target = this.byRawId.get(info.targetId)
		if (!target) {
			target = {
				rawId: info.targetId,
				ordinal: this.nextOrdinal++,
				epoch: generateEpochId(this.random),
				rendererEpoch: null,
				type: targetType(info.type),
				sessionId: null,
				probe: null,
				strongCandidate: false,
				destroyed: false,
			}
			this.byRawId.set(info.targetId, target)
			this.pruneDestroyedTargets()
		}
		return target
	}

	pruneDestroyedTargets() {
		if (this.byRawId.size <= MAX_RETAINED_TARGETS) return
		for (const [targetId, target] of this.byRawId) {
			if (!target.destroyed) continue
			this.byRawId.delete(targetId)
			if (this.byRawId.size <= MAX_RETAINED_TARGETS) break
		}
	}

	attach(targetId, sessionId) {
		const target = this.byRawId.get(targetId)
		if (!target || typeof sessionId !== "string" || sessionId.length > 512) return null
		if (target.sessionId && target.sessionId !== sessionId) this.bySessionId.delete(target.sessionId)
		const previousTarget = this.bySessionId.get(sessionId)
		if (previousTarget && previousTarget !== target && previousTarget.sessionId === sessionId) {
			previousTarget.sessionId = null
		}
		target.sessionId = sessionId
		target.rendererEpoch = generateEpochId(this.random)
		this.bySessionId.set(sessionId, target)
		return target
	}

	detach(sessionId) {
		const target = this.bySessionId.get(sessionId)
		if (!target) return null
		this.bySessionId.delete(sessionId)
		if (target.sessionId !== sessionId) return null
		target.sessionId = null
		return target
	}

	destroy(targetId) {
		const target = this.byRawId.get(targetId)
		if (!target) return null
		target.destroyed = true
		if (target.sessionId) this.bySessionId.delete(target.sessionId)
		target.sessionId = null
		this.pruneDestroyedTargets()
		return target
	}

	async probe(target) {
		if (!target.sessionId || !RENDERER_TARGET_TYPES.has(target.type)) return null
		let result
		try {
			result = await this.client.command(
				"Runtime.evaluate",
				{
					expression: FIXED_EXPRESSIONS.structuralProbe,
					returnByValue: true,
					silent: true,
					awaitPromise: false,
				},
				{ sessionId: target.sessionId },
			)
		} catch {
			return null
		}
		const probe = sanitizeProbe(result?.result?.value)
		if (!probe) return null
		target.probe = probe
		target.strongCandidate = probe.rootPresent && probe.acquireApiPresent && probe.bootstrapGlobalsCount >= 2
		return probe
	}

	selection() {
		const candidates = [...this.byRawId.values()].filter(
			(target) => !target.destroyed && target.strongCandidate && target.sessionId,
		)
		if (candidates.length === 1) return { state: "strongCandidate", candidates, selected: candidates[0] }
		if (candidates.length > 1) return { state: "ambiguous", candidates, selected: null }
		return { state: "unresolved", candidates: [], selected: null }
	}

	resolveSnapshotTarget(ordinal = null) {
		const selection = this.selection()
		if (ordinal !== null) {
			const target = [...this.byRawId.values()].find(
				(candidate) =>
					candidate.ordinal === ordinal &&
					!candidate.destroyed &&
					candidate.strongCandidate &&
					candidate.sessionId,
			)
			if (!target) throw Object.assign(new Error("Target ordinal is unavailable"), { code: "targetUnavailable" })
			return target
		}
		if (selection.state === "ambiguous")
			throw Object.assign(new Error("Target identity is ambiguous"), { code: "targetAmbiguous" })
		if (!selection.selected?.sessionId)
			throw Object.assign(new Error("Target identity is unavailable"), { code: "targetUnavailable" })
		return selection.selected
	}

	navigate(target) {
		this.navigationGeneration += 1
		target.rendererEpoch = generateEpochId(this.random)
		return this.navigationGeneration
	}

	sanitizedTargets() {
		return [...this.byRawId.values()].slice(0, MAX_RETAINED_TARGETS).map((target) => ({
			targetOrdinal: target.ordinal,
			targetEpoch: target.epoch,
			rendererEpoch: target.rendererEpoch,
			targetType: target.type,
			attached: Boolean(target.sessionId),
			destroyed: target.destroyed,
			strongCandidate: target.strongCandidate,
			probe: target.probe,
		}))
	}
}
