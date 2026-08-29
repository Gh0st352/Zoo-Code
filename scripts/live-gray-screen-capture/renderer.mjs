import { FIXED_EXPRESSIONS, PERFORMANCE_METRIC_MAP } from "./constants.mjs"

function finiteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function extractEvaluation(result) {
	if (!result || typeof result !== "object" || result.exceptionDetails) return null
	return result.result?.value ?? null
}

function sanitizeProbe(value) {
	if (!value || value.available !== true) return null
	const output = {
		longTaskAvailable: value.longTaskAvailable === true,
		documentVisibility: ["visible", "hidden"].includes(value.documentVisibility)
			? value.documentVisibility
			: "unavailable",
		documentReady: ["loading", "interactive", "complete"].includes(value.documentReady)
			? value.documentReady
			: "unavailable",
		rootPresent: value.rootPresent === true,
	}
	for (const key of ["timerSequence", "animationFrameSequence", "longTaskCount", "errorCount", "rejectionCount"]) {
		if (Number.isSafeInteger(value[key]) && value[key] >= 0) output[key] = value[key]
	}
	if (Number.isSafeInteger(value.domNodeCount) && value.domNodeCount >= 0) {
		output.domNodeCount = Math.min(1_000_000, value.domNodeCount)
	}
	for (const key of ["lastTimerMonotonicMs", "lastFrameMonotonicMs", "longTaskTotalMs", "longTaskMaxMs"]) {
		if (finiteNonNegative(value[key])) output[key] = value[key]
	}
	return output
}

function sanitizeMemory(performanceMemory, heapUsage, performanceMetrics) {
	const output = {}
	if (performanceMemory?.available === true) {
		for (const [source, target] of [
			["usedJsHeapBytes", "usedJsHeapBytes"],
			["totalJsHeapBytes", "totalJsHeapBytes"],
			["jsHeapLimitBytes", "jsHeapLimitBytes"],
		]) {
			if (finiteNonNegative(performanceMemory[source])) output[target] = performanceMemory[source]
		}
	}
	for (const [source, target] of [
		["usedSize", "runtimeUsedHeapBytes"],
		["totalSize", "runtimeTotalHeapBytes"],
		["embedderHeapUsedSize", "embedderHeapUsedBytes"],
		["backingStorageSize", "backingStorageBytes"],
	]) {
		if (finiteNonNegative(heapUsage?.[source])) output[target] = heapUsage[source]
	}
	if (Array.isArray(performanceMetrics?.metrics)) {
		for (const metric of performanceMetrics.metrics) {
			const outputName = PERFORMANCE_METRIC_MAP[metric?.name]
			if (outputName && finiteNonNegative(metric.value)) output[outputName] = metric.value
		}
	}
	const used = output.usedJsHeapBytes ?? output.runtimeUsedHeapBytes
	if (finiteNonNegative(used) && finiteNonNegative(output.jsHeapLimitBytes) && output.jsHeapLimitBytes > 0) {
		output.heapRatio = Math.min(1, used / output.jsHeapLimitBytes)
	}
	return output
}

export class RendererCollector {
	constructor({ client, options, clock, onMemory, onProbe, onEvent, onCriticalSamples = async () => {} }) {
		this.client = client
		this.options = options
		this.clock = clock
		this.onMemory = onMemory
		this.onProbe = onProbe
		this.onEvent = onEvent
		this.onCriticalSamples = onCriticalSamples
		this.target = null
		this.timer = null
		this.polling = false
		this.previousProbe = null
		this.delayed = false
		this.blocked = false
		this.recoverySamples = 0
		this.heapSamples = []
		this.lastMemory = null
		this.thresholdState = { warning: false, critical: false, criticalSamples: 0 }
		this.criticalSamplesNotified = false
		this.diagnosticPause = false
	}

	async enable(target) {
		this.target = target
		const unavailable = []
		for (const method of [
			"Runtime.enable",
			"Performance.enable",
			"Page.enable",
			"Page.setLifecycleEventsEnabled",
			"HeapProfiler.enable",
		]) {
			try {
				const params = method === "Page.setLifecycleEventsEnabled" ? { enabled: true } : {}
				await this.client.command(method, params, { sessionId: target.sessionId })
			} catch (error) {
				if (error.code === "methodUnavailable") unavailable.push(method)
				else throw error
			}
		}
		try {
			await this.evaluate(FIXED_EXPRESSIONS.installProbe)
		} catch {
			unavailable.push("rendererProbe")
		}
		return unavailable
	}

	evaluate(expression) {
		if (!Object.values(FIXED_EXPRESSIONS).includes(expression)) {
			return Promise.reject(new TypeError("Renderer expression is not allowlisted"))
		}
		return this.client.command(
			"Runtime.evaluate",
			{ expression, returnByValue: true, silent: true, awaitPromise: false },
			{ sessionId: this.target.sessionId, timeoutMs: this.options.metricTimeoutMs },
		)
	}

	start() {
		if (this.timer) return
		this.timer = setInterval(() => void this.poll().catch(() => {}), this.options.rendererIntervalMs)
		this.timer.unref?.()
		void this.poll().catch(() => {})
	}

	async poll() {
		if (this.polling || !this.target?.sessionId) return
		this.polling = true
		try {
			const results = await Promise.allSettled([
				this.evaluate(FIXED_EXPRESSIONS.performanceMemory),
				this.client.command(
					"Runtime.getHeapUsage",
					{},
					{ sessionId: this.target.sessionId, timeoutMs: this.options.metricTimeoutMs },
				),
				this.client.command(
					"Performance.getMetrics",
					{},
					{ sessionId: this.target.sessionId, timeoutMs: this.options.metricTimeoutMs },
				),
				this.evaluate(FIXED_EXPRESSIONS.probeSample),
			])
			const performanceMemory = results[0].status === "fulfilled" ? extractEvaluation(results[0].value) : null
			const heapUsage = results[1].status === "fulfilled" ? results[1].value : null
			const performanceMetrics = results[2].status === "fulfilled" ? results[2].value : null
			const memory = sanitizeMemory(performanceMemory, heapUsage, performanceMetrics)
			const unavailable = []
			if (!Object.hasOwn(memory, "usedJsHeapBytes") && !Object.hasOwn(memory, "runtimeUsedHeapBytes"))
				unavailable.push("unsupported")
			await this.onMemory({ ...memory, ...(unavailable.length ? { unavailable } : {}) })
			await this.updateHeapState(memory)

			const probe = results[3].status === "fulfilled" ? sanitizeProbe(extractEvaluation(results[3].value)) : null
			if (probe) {
				await this.onProbe(probe)
				await this.updateHeartbeat(probe)
			} else {
				await this.onProbe({ unavailable: ["timedOut"] })
				await this.updateHeartbeat(null)
			}
		} finally {
			this.polling = false
		}
	}

	async updateHeapState(memory) {
		this.lastMemory = { ...memory }
		const used = memory.usedJsHeapBytes ?? memory.runtimeUsedHeapBytes
		const ratio = memory.heapRatio
		if (finiteNonNegative(used)) {
			this.heapSamples.push({ timeMs: this.clock.monotonicMs(), used })
			if (this.heapSamples.length > 5) this.heapSamples.shift()
			if (this.heapSamples.length >= 2) {
				const first = this.heapSamples[0]
				const last = this.heapSamples.at(-1)
				const seconds = Math.max(0.001, (last.timeMs - first.timeMs) / 1_000)
				memory.heapSlopeBytesPerSecond = Math.max(0, (last.used - first.used) / seconds)
				if (first.used > 0 && last.used <= first.used * 0.8) {
					await this.onEvent("heapDecreaseObserved", {
						reason: "collectionConsistentDecrease",
						usedJsHeapBytes: last.used,
						durationMs: Math.max(0, last.timeMs - first.timeMs),
					})
				}
			}
		}
		if (!finiteNonNegative(ratio)) return
		if (ratio >= this.options.heapWarningRatio && !this.thresholdState.warning) {
			this.thresholdState.warning = true
			await this.onEvent("heapThresholdCrossed", { threshold: "warning", heapRatio: ratio, sampleCount: 1 })
		}
		if (ratio >= this.options.heapCriticalRatio) {
			this.thresholdState.criticalSamples += 1
			if (!this.thresholdState.critical) {
				this.thresholdState.critical = true
				await this.onEvent("heapThresholdCrossed", {
					threshold: "critical",
					heapRatio: ratio,
					sampleCount: this.thresholdState.criticalSamples,
				})
			}
			if (
				!this.criticalSamplesNotified &&
				this.thresholdState.criticalSamples >= this.options.autoSnapshotSamples
			) {
				this.criticalSamplesNotified = true
				await this.onCriticalSamples(this.thresholdState.criticalSamples)
			}
		} else {
			this.thresholdState.criticalSamples = 0
			if (ratio < this.options.heapWarningRatio * 0.95) this.thresholdState.warning = false
			if (ratio < this.options.heapCriticalRatio * 0.95) this.thresholdState.critical = false
		}
	}

	async updateHeartbeat(probe) {
		const now = this.clock.monotonicMs()
		const progressed = probe && (!this.previousProbe || probe.timerSequence > this.previousProbe.timerSequence)
		if (progressed) {
			this.previousProbe = { timerSequence: probe.timerSequence, observedMs: now }
			if (this.delayed)
				await this.onEvent("heartbeatRecovered", { heartbeatDelayMs: 0, sampleCount: ++this.recoverySamples })
			if (this.recoverySamples >= 2) {
				this.delayed = false
				this.blocked = false
				this.recoverySamples = 0
			}
			return
		}
		if (!this.previousProbe) {
			if (!probe || !Number.isSafeInteger(probe.timerSequence)) return
			this.previousProbe = { timerSequence: probe.timerSequence, observedMs: now }
		}
		const delay = Math.max(0, now - this.previousProbe.observedMs)
		this.recoverySamples = 0
		if (!this.delayed && delay >= this.options.heartbeatWarningMs) {
			this.delayed = true
			await this.onEvent("heartbeatDelayed", { heartbeatDelayMs: delay, diagnosticPause: this.diagnosticPause })
		}
		if (!this.blocked && !this.diagnosticPause && delay >= this.options.heartbeatFailureMs) {
			this.blocked = true
			await this.onEvent("rendererBlockedSuspected", {
				heartbeatDelayMs: delay,
				diagnosticPause: false,
			})
		}
	}

	latestHeap() {
		const latest = this.heapSamples.at(-1)
		return latest ? latest.used : null
	}

	latestMemory() {
		return this.lastMemory ? { ...this.lastMemory } : null
	}

	criticalSampleCount() {
		return this.thresholdState.criticalSamples
	}

	setDiagnosticPause(value) {
		this.diagnosticPause = value === true
	}

	async stop() {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		while (this.polling) await new Promise((resolve) => setImmediate(resolve))
	}
}
