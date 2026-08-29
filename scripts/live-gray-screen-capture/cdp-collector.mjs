import { CdpClient, discoverCdp, endpointFromOptions } from "./cdp-client.mjs"
import { DEFAULTS } from "./constants.mjs"
import { generateEpochId } from "./records.mjs"
import { RendererCollector } from "./renderer.mjs"
import { TargetRegistry } from "./targets.mjs"

const ALLOWED_EVENTS = new Set([
	"Target.targetCreated",
	"Target.targetInfoChanged",
	"Target.attachedToTarget",
	"Target.detachedFromTarget",
	"Target.targetDestroyed",
	"Runtime.executionContextsCleared",
	"Runtime.exceptionThrown",
	"Page.frameNavigated",
	"Inspector.targetCrashed",
	"HeapProfiler.addHeapSnapshotChunk",
	"HeapProfiler.reportHeapSnapshotProgress",
])

export class CdpCollector {
	constructor({ options, clock, random, onRecord, onCapability, clientFactory, onAutoSnapshot }) {
		this.options = options
		this.clock = clock
		this.random = random
		this.onRecord = onRecord
		this.onCapability = onCapability
		this.clientFactory = clientFactory
		this.onAutoSnapshot = onAutoSnapshot
		this.endpoint = null
		this.discovery = null
		this.client = null
		this.registry = null
		this.renderer = null
		this.connectionEpoch = null
		this.browserPid = null
		this.stopping = false
		this.snapshotListener = null
		this.snapshotDisconnectListener = null
		this.snapshotSessionId = null
		this.maxQueuedEvents = options.maxQueuedCdpEvents ?? DEFAULTS.maxQueuedCdpEvents
		this.maxQueuedEventBytes = options.maxQueuedCdpEventBytes ?? DEFAULTS.maxQueuedCdpEventBytes
		this.queuedEventCount = 0
		this.queuedEventBytes = 0
		this.eventQueue = Promise.resolve()
		this.eventQueueFailed = false
		this.eventHandler = (event) => this.enqueueEvent(event)
		this.commandTimeoutHandler = () => {
			void this.onRecord(
				"cdpCommandTimedOut",
				{ code: "cdpTimedOut", retryable: true },
				{ capabilityState: "degraded" },
			).catch(() => this.failAsyncWork())
		}
		this.closeHandler = ({ retryable }) => void this.handleClose(retryable).catch(() => this.failAsyncWork())
		this.reconnectPromise = null
		this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
	}

	failAsyncWork() {
		if (this.eventQueueFailed) return
		this.eventQueueFailed = true
		this.snapshotDisconnectListener?.("cdpConnectionLost")
		this.client?.close()
	}

	enqueueEvent(event) {
		if (this.stopping || this.eventQueueFailed) return
		const eventBytes = Number.isSafeInteger(event?.messageBytes) && event.messageBytes > 0 ? event.messageBytes : 0
		if (
			this.queuedEventCount >= this.maxQueuedEvents ||
			eventBytes > this.maxQueuedEventBytes ||
			this.queuedEventBytes > this.maxQueuedEventBytes - eventBytes
		) {
			this.failAsyncWork()
			return
		}
		this.queuedEventCount += 1
		this.queuedEventBytes += eventBytes
		this.eventQueue = this.eventQueue
			.then(() => this.handleEvent(event))
			.catch(() => {
				this.failAsyncWork()
			})
			.finally(() => {
				this.queuedEventCount -= 1
				this.queuedEventBytes -= eventBytes
			})
	}

	async connect(endpointOverride = null) {
		this.endpoint = endpointOverride ?? endpointFromOptions(this.options)
		return this.connectOnce()
	}

	async connectOnce() {
		const previousClient = this.client
		this.detachClientListeners(previousClient)
		if (previousClient) previousClient.close()
		await this.eventQueue
		this.eventQueueFailed = false
		this.browserPid = null
		this.discovery = await discoverCdp(this.endpoint, {
			timeoutMs: this.options.httpTimeoutMs ?? DEFAULTS.httpTimeoutMs,
			verifyListener: this.options.verifyListener,
		})
		this.client = this.clientFactory
			? this.clientFactory(this.discovery.webSocketUrl)
			: new CdpClient({
					webSocketUrl: this.discovery.webSocketUrl,
					commandTimeoutMs: this.options.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
				})
		this.connectionEpoch = generateEpochId(this.random)
		this.registry = new TargetRegistry({ client: this.client, random: this.random })
		this.client.on("event", this.eventHandler)
		this.client.on("commandTimeout", this.commandTimeoutHandler)
		this.client.on("close", this.closeHandler)
		await this.client.connect()
		await this.onRecord("cdpConnectionOpened", { status: "available" })
		await this.client.command("Target.setDiscoverTargets", { discover: true })
		await this.client.command("Target.setAutoAttach", {
			autoAttach: true,
			flatten: true,
			waitForDebuggerOnStart: false,
		})
		const processInfo = await this.client.command("SystemInfo.getProcessInfo").catch(() => null)
		if (Array.isArray(processInfo?.processInfo)) {
			const browser = processInfo.processInfo.find((entry) => entry.type === "browser")
			if (Number.isSafeInteger(browser?.id) && browser.id > 0) this.browserPid = browser.id
		}
		const targets = await this.client.command("Target.getTargets")
		for (const info of targets.targetInfos ?? []) await this.observeAndAttach(info)
		await this.refreshSelection()
		return {
			browserPid: this.browserPid,
			version: this.discovery.version,
			connectionEpoch: this.connectionEpoch,
			initialTargetCount: this.discovery.initialTargetCount,
		}
	}

	detachClientListeners(client) {
		client?.off("event", this.eventHandler)
		client?.off("commandTimeout", this.commandTimeoutHandler)
		client?.off("close", this.closeHandler)
	}

	async handleClose(retryable) {
		await this.onRecord(
			"cdpConnectionClosed",
			{ reason: "webSocketClose", retryable },
			{ capabilityState: "degraded" },
		)
		if (!retryable || this.stopping || this.reconnectPromise) return
		this.reconnectPromise = this.reconnect()
		try {
			await this.reconnectPromise
		} finally {
			this.reconnectPromise = null
		}
	}

	async reconnect() {
		await this.renderer?.stop()
		this.renderer = null
		this.snapshotDisconnectListener?.("cdpConnectionLost")
		this.snapshotListener = null
		const backoff = this.options.reconnectBackoffMs ?? [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
		for (const delayMs of backoff) {
			if (this.stopping) return
			await this.wait(delayMs)
			if (this.stopping) return
			try {
				await this.connectOnce()
				return
			} catch {}
		}
		await this.onCapability("rendererMetrics", "unavailable", "notConnected")
	}

	async observeAndAttach(info) {
		const target = this.registry.observe(info)
		if (!target) return
		await this.onRecord("targetCreated", { targetOrdinal: target.ordinal, targetType: target.type }, { target })
		if (!["page", "iframe", "webview", "other"].includes(target.type)) return
		if (!target.sessionId) {
			try {
				const attached = await this.client.command("Target.attachToTarget", {
					targetId: target.rawId,
					flatten: true,
				})
				if (attached.sessionId) {
					this.registry.attach(target.rawId, attached.sessionId)
					await this.onRecord("targetAttached", { targetOrdinal: target.ordinal }, { target })
				}
			} catch {
				return
			}
		}
		await this.enableTarget(target)
	}

	async enableTarget(target) {
		if (!target.sessionId) return
		try {
			await this.client.command("Runtime.enable", {}, { sessionId: target.sessionId })
			await this.registry.probe(target)
		} catch {}
		await this.refreshSelection()
	}

	async refreshSelection() {
		const selection = this.registry.selection()
		await this.onCapability(
			"targetIdentity",
			selection.state === "strongCandidate" ? "available" : "degraded",
			selection.state,
		)
		for (const target of selection.candidates) {
			await this.onRecord(
				"targetIdentity",
				{
					targetOrdinal: target.ordinal,
					targetType: target.type,
					...target.probe,
					strongCandidate: target.strongCandidate,
					identityState: selection.state,
				},
				{ target },
			)
		}
		if (selection.selected && (!this.renderer || this.renderer.target !== selection.selected)) {
			await this.renderer?.stop()
			this.renderer = new RendererCollector({
				client: this.client,
				options: {
					...this.options,
					metricTimeoutMs: this.options.metricTimeoutMs ?? DEFAULTS.metricTimeoutMs,
				},
				clock: this.clock,
				onMemory: (data) => this.onRecord("rendererMemory", data, { target: selection.selected }),
				onProbe: (data) => this.onRecord("rendererProbe", data, { target: selection.selected }),
				onEvent: async (recordType, data) => {
					await this.onRecord(
						recordType,
						{ targetOrdinal: selection.selected.ordinal, ...data },
						{ target: selection.selected },
					)
				},
				onCriticalSamples: async () => {
					if (this.options.autoSnapshotEnabled) await this.onAutoSnapshot?.()
				},
			})
			const unavailable = await this.renderer.enable(selection.selected)
			await this.onCapability(
				"rendererMetrics",
				unavailable.length === 0 ? "available" : "degraded",
				unavailable.length ? "unsupported" : null,
			)
			this.renderer.start()
		}
	}

	async handleEvent(event) {
		if (!ALLOWED_EVENTS.has(event.method)) return
		if (this.snapshotListener && event.method.startsWith("HeapProfiler.")) await this.snapshotListener(event)
		switch (event.method) {
			case "Target.targetCreated":
				await this.observeAndAttach(event.params.targetInfo)
				break
			case "Target.targetInfoChanged": {
				const target = this.registry.observe(event.params.targetInfo)
				if (target) await this.enableTarget(target)
				break
			}
			case "Target.attachedToTarget": {
				const target = this.registry.observe(event.params.targetInfo)
				if (target) {
					this.registry.attach(target.rawId, event.params.sessionId)
					await this.onRecord("targetAttached", { targetOrdinal: target.ordinal }, { target })
					await this.enableTarget(target)
				}
				break
			}
			case "Target.detachedFromTarget": {
				const target = this.registry.detach(event.params.sessionId)
				if (target) {
					this.notifySnapshotTargetLost(event.params.sessionId)
					if (this.renderer?.target === target) {
						await this.renderer.stop()
						this.renderer = null
					}
					await this.onRecord(
						"targetDetached",
						{ targetOrdinal: target.ordinal, reason: "sessionDetached" },
						{ target },
					)
					await this.refreshSelection()
				}
				break
			}
			case "Target.targetDestroyed": {
				const previousSessionId = this.registry.byRawId.get(event.params.targetId)?.sessionId ?? null
				const target = this.registry.destroy(event.params.targetId)
				if (target) {
					const wasSelectedRenderer = this.renderer?.target === target
					this.notifySnapshotTargetLost(previousSessionId)
					if (wasSelectedRenderer) {
						await this.renderer.stop()
						this.renderer = null
					}
					await this.onRecord(
						"targetDestroyed",
						{ targetOrdinal: target.ordinal, reason: "targetDestroyed" },
						{ target, selectedRenderer: wasSelectedRenderer },
					)
				}
				await this.refreshSelection()
				break
			}
			case "Runtime.executionContextsCleared": {
				const target = this.registry.bySessionId.get(event.sessionId)
				if (target) {
					const generation = this.registry.navigate(target)
					await this.onRecord(
						"executionContextReplaced",
						{
							targetOrdinal: target.ordinal,
							reason: "executionContextReset",
							navigationGeneration: generation,
						},
						{ target },
					)
					await this.enableTarget(target)
				}
				break
			}
			case "Runtime.exceptionThrown": {
				const target = this.registry.bySessionId.get(event.sessionId)
				if (target) {
					await this.onRecord(
						"runtimeException",
						{ targetOrdinal: target.ordinal, category: "exception", uncaught: true },
						{ target },
					)
				}
				break
			}
			case "Page.frameNavigated": {
				const target = this.registry.bySessionId.get(event.sessionId)
				if (target && !event.params.frame?.parentId) {
					const generation = this.registry.navigate(target)
					await this.onRecord(
						"mainFrameNavigated",
						{ targetOrdinal: target.ordinal, reason: "navigation", navigationGeneration: generation },
						{ target },
					)
					await this.enableTarget(target)
				}
				break
			}
			case "Inspector.targetCrashed": {
				const target = this.registry.bySessionId.get(event.sessionId)
				if (target)
					await this.onRecord(
						"targetCrashed",
						{ targetOrdinal: target.ordinal, reason: "targetCrash" },
						{ target },
					)
				break
			}
		}
	}

	setSnapshotListener(listener) {
		this.snapshotListener = listener
	}

	setSnapshotDisconnectListener(listener, sessionId = null) {
		this.snapshotDisconnectListener = listener
		this.snapshotSessionId = listener ? sessionId : null
	}

	notifySnapshotTargetLost(sessionId) {
		if (sessionId && sessionId === this.snapshotSessionId) this.snapshotDisconnectListener?.("targetLost")
	}

	resolveSnapshotTarget(ordinal) {
		return this.registry.resolveSnapshotTarget(ordinal)
	}

	latestUsedHeap() {
		return this.renderer?.latestHeap() ?? null
	}

	latestMemory() {
		return this.renderer?.latestMemory() ?? null
	}

	setDiagnosticPause(value) {
		this.renderer?.setDiagnosticPause(value)
	}

	abortSnapshot() {
		this.snapshotDisconnectListener?.("stopping")
		const target = (() => {
			try {
				return this.resolveSnapshotTarget()
			} catch {
				return null
			}
		})()
		if (target?.sessionId) {
			void this.client
				.command("Target.detachFromTarget", { sessionId: target.sessionId })
				.catch(() => this.client?.close())
		} else {
			this.client?.close()
		}
	}

	sanitizedTargets() {
		return this.registry?.sanitizedTargets() ?? []
	}

	async stop() {
		this.stopping = true
		await this.renderer?.stop()
		this.detachClientListeners(this.client)
		this.client?.close()
		await this.reconnectPromise?.catch(() => {})
		await this.eventQueue
	}
}
