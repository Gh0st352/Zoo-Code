#!/usr/bin/env python3
"""Apply a permanent Zoo Code webview transcript transport fix.

Target: Zoo-Code-Org/Zoo-Code current main lineage (including 3.81-era builds).
Run from the repository root, then inspect `git diff` and build a VSIX.

The patch removes clineMessages from generic state broadcasts, sends focused-task
message changes as sequenced deltas, and restores/reloads transcripts through a
serialized chunked snapshot protocol with automatic sequence-gap resync.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

MARKER = "clineMessagesSnapshotStart"


def die(message: str) -> "NoReturn":
    raise SystemExit(f"ERROR: {message}")


def read(path: Path) -> str:
    if not path.is_file():
        die(f"missing expected source file: {path}")
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        die(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def sub_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        die(f"{label}: expected exactly one regex match, found {count}")
    return result


def patch_types(root: Path) -> None:
    path = root / "packages/types/src/vscode-extension-host.ts"
    text = read(path)

    text = replace_once(
        text,
        '\t\t| "invoke"\n\t\t| "messageUpdated"\n\t\t| "mcpServers"',
        '\t\t| "invoke"\n'
        '\t\t| "clineMessageAppended"\n'
        '\t\t| "clineMessageUpdated"\n'
        '\t\t| "clineMessagesSnapshotStart"\n'
        '\t\t| "clineMessagesSnapshotChunk"\n'
        '\t\t| "clineMessagesSnapshotEnd"\n'
        '\t\t| "messageUpdated" // Legacy: a patched webview requests a full resync instead of applying this.\n'
        '\t\t| "mcpServers"',
        "ExtensionMessage transcript message types",
    )

    text = replace_once(
        text,
        '\tclineMessage?: ClineMessage\n\trouterModels?: RouterModels',
        '\ttaskId?: string\n'
        '\tclineMessage?: ClineMessage\n'
        '\tclineMessages?: ClineMessage[]\n'
        '\tclineMessagesSeq?: number\n'
        '\tsnapshotId?: string\n'
        '\tsnapshotStartIndex?: number\n'
        '\tsnapshotTotal?: number\n'
        '\trouterModels?: RouterModels',
        "ExtensionMessage transcript fields",
    )

    text = replace_once(
        text,
        '\t\t| "openRulesDirectory"\n\t\t| "themeFixtureProbeResponse"\n\ttext?: string\n\ttaskId?: string',
        '\t\t| "openRulesDirectory"\n'
        '\t\t| "themeFixtureProbeResponse"\n'
        '\t\t| "requestClineMessagesResync"\n'
        '\ttext?: string\n'
        '\ttaskId?: string\n'
        '\texpectedSeq?: number\n'
        '\treceivedSeq?: number',
        "WebviewMessage resync request",
    )

    write(path, text)


def patch_provider(root: Path) -> None:
    path = root / "src/core/webview/ClineProvider.ts"
    text = read(path)

    text = replace_once(
        text,
        "\tprivate _disposed = false\n\tprivate readonly _postStateToWebviewThrottled = debounce(",
        "\tprivate _disposed = false\n"
        "\tprivate static readonly CLINE_MESSAGES_SNAPSHOT_CHUNK_SIZE = 200\n"
        "\tprivate readonly clineMessagesSeqByTaskId = new Map<string, number>()\n"
        "\tprivate clineMessagesPostQueue: Promise<void> = Promise.resolve()\n"
        "\tprivate clineMessagesTransportGeneration = 0\n"
        "\tprivate nextClineMessagesSnapshotId = 0\n"
        "\tprivate suppressClineMessagesDeltas = false\n"
        "\tprivate readonly _postStateToWebviewThrottled = debounce(",
        "provider transport fields",
    )

    text = replace_once(
        text,
        "\t\t\t\tawait this.postStateToWebviewWithoutTaskHistory()",
        "\t\t\t\tawait this.postStateToWebviewWithoutClineMessages()",
        "debounced state must omit transcript",
    )

    text = sub_once(
        text,
        r"\n\t/\*\*\n\t \* Monotonically increasing sequence number for clineMessages state pushes\.\n"
        r"\t \* Used by the frontend to reject stale state that arrives out-of-order\.\n\t \*/\n"
        r"\tprivate clineMessagesSeq = 0\n",
        "\n",
        "remove global clineMessages sequence",
    )

    text = replace_once(
        text,
        "\t\tif (!state || typeof state.mode !== \"string\") {\n"
        "\t\t\tthrow new Error(t(\"common:errors.retrieve_current_mode\"))\n"
        "\t\t}\n"
        "\t}",
        "\t\tif (!state || typeof state.mode !== \"string\") {\n"
        "\t\t\tthrow new Error(t(\"common:errors.retrieve_current_mode\"))\n"
        "\t\t}\n\n"
        "\t\tawait this.syncFocusedTaskToWebview()\n"
        "\t}",
        "focus sync after stack push",
    )

    text = replace_once(
        text,
        "\t\t\ttask = undefined\n\t\t}\n\t}\n\t/**\n\t * Evicts the current task",
        "\t\t\ttask = undefined\n\t\t}\n\n"
        "\t\tawait this.syncFocusedTaskToWebview()\n"
        "\t}\n\t/**\n\t * Evicts the current task",
        "focus sync after stack pop",
    )

    text = replace_once(
        text,
        "\t\t\t// Perform preparation tasks and set up event listeners\n"
        "\t\t\tawait this.performPreparationTasks(task)\n\n"
        "\t\t\tthis.log(",
        "\t\t\t// Perform preparation tasks and set up event listeners\n"
        "\t\t\tawait this.performPreparationTasks(task)\n"
        "\t\t\tawait this.syncFocusedTaskToWebview()\n\n"
        "\t\t\tthis.log(",
        "rehydrated task focus sync",
    )

    old_post = '''\tpublic async postMessageToWebview(message: ExtensionMessage) {
\t\tif (this._disposed) {
\t\t\treturn
\t\t}
\t\ttry {
\t\t\tawait this.view?.webview.postMessage(message)
\t\t} catch {
\t\t\t// View disposed, drop message silently
\t\t}
\t}
'''

    new_post = '''\tpublic async postMessageToWebview(message: ExtensionMessage) {
\t\tif (this._disposed) {
\t\t\treturn
\t\t}

\t\t// Hard transport boundary: generic state broadcasts must never carry the
\t\t// unbounded chat transcript. This also protects direct callers that build
\t\t// and post state without going through postStateToWebview().
\t\tif (message.type === "state" && message.state) {
\t\t\tconst {
\t\t\t\tclineMessages: _omitMessages,
\t\t\t\tclineMessagesSeq: _omitMessagesSeq,
\t\t\t\t...metadataState
\t\t\t} = message.state
\t\t\tmessage = { ...message, state: metadataState }
\t\t}

\t\ttry {
\t\t\tawait this.view?.webview.postMessage(message)
\t\t} catch {
\t\t\t// View disposed, drop message silently
\t\t}
\t}

\tprivate getClineMessagesSeq(taskId: string): number {
\t\treturn this.clineMessagesSeqByTaskId.get(taskId) ?? 0
\t}

\tprivate bumpClineMessagesSeq(taskId: string): number {
\t\tconst next = this.getClineMessagesSeq(taskId) + 1
\t\tthis.clineMessagesSeqByTaskId.set(taskId, next)
\t\treturn next
\t}

\tprivate enqueueClineMessagesPost(operation: () => Promise<void>): Promise<void> {
\t\tconst run = this.clineMessagesPostQueue.then(operation, operation)
\t\tthis.clineMessagesPostQueue = run.catch((error) => {
\t\t\tthis.log(
\t\t\t\t`[clineMessages] transport failure: ${error instanceof Error ? error.message : String(error)}`,
\t\t\t)
\t\t})
\t\treturn run
\t}

\tpublic resetClineMessagesTransport(): number {
\t\tthis.clineMessagesTransportGeneration++
\t\tthis.clineMessagesPostQueue = Promise.resolve()
\t\treturn this.clineMessagesTransportGeneration
\t}

\tpublic postClineMessageAppended(taskId: string, message: ClineMessage): Promise<void> {
\t\tconst seq = this.bumpClineMessagesSeq(taskId)
\t\tif (this.suppressClineMessagesDeltas || this.getCurrentTask()?.taskId !== taskId) {
\t\t\treturn Promise.resolve()
\t\t}

\t\tconst generation = this.clineMessagesTransportGeneration
\t\tconst clonedMessage = structuredClone(message)
\t\treturn this.enqueueClineMessagesPost(async () => {
\t\t\tif (
\t\t\t\tgeneration !== this.clineMessagesTransportGeneration ||
\t\t\t\tthis.getCurrentTask()?.taskId !== taskId
\t\t\t) {
\t\t\t\treturn
\t\t\t}
\t\t\tawait this.postMessageToWebview({
\t\t\t\ttype: "clineMessageAppended",
\t\t\t\ttaskId,
\t\t\t\tclineMessage: clonedMessage,
\t\t\t\tclineMessagesSeq: seq,
\t\t\t})
\t\t})
\t}

\tpublic postClineMessageUpdated(taskId: string, message: ClineMessage): Promise<void> {
\t\tconst seq = this.bumpClineMessagesSeq(taskId)
\t\tif (this.suppressClineMessagesDeltas || this.getCurrentTask()?.taskId !== taskId) {
\t\t\treturn Promise.resolve()
\t\t}

\t\tconst generation = this.clineMessagesTransportGeneration
\t\tconst clonedMessage = structuredClone(message)
\t\treturn this.enqueueClineMessagesPost(async () => {
\t\t\tif (
\t\t\t\tgeneration !== this.clineMessagesTransportGeneration ||
\t\t\t\tthis.getCurrentTask()?.taskId !== taskId
\t\t\t) {
\t\t\t\treturn
\t\t\t}
\t\t\tawait this.postMessageToWebview({
\t\t\t\ttype: "clineMessageUpdated",
\t\t\t\ttaskId,
\t\t\t\tclineMessage: clonedMessage,
\t\t\t\tclineMessagesSeq: seq,
\t\t\t})
\t\t})
\t}

\tpublic postClineMessagesSnapshot(
\t\ttaskId: string | undefined = this.getCurrentTask()?.taskId,
\t\toptions: { bumpSeq?: boolean } = {},
\t): Promise<void> {
\t\tconst currentTask = this.getCurrentTask()
\t\tif ((currentTask?.taskId ?? undefined) !== taskId) {
\t\t\treturn Promise.resolve()
\t\t}

\t\tconst seq = taskId
\t\t\t? options.bumpSeq
\t\t\t\t? this.bumpClineMessagesSeq(taskId)
\t\t\t\t: this.getClineMessagesSeq(taskId)
\t\t\t: 0
\t\tconst messages = structuredClone(currentTask?.clineMessages ?? [])
\t\tconst snapshotId = `${taskId ?? "none"}:${++this.nextClineMessagesSnapshotId}`
\t\tconst generation = this.clineMessagesTransportGeneration

\t\treturn this.enqueueClineMessagesPost(async () => {
\t\t\tif (
\t\t\t\tgeneration !== this.clineMessagesTransportGeneration ||
\t\t\t\t(this.getCurrentTask()?.taskId ?? undefined) !== taskId
\t\t\t) {
\t\t\t\treturn
\t\t\t}

\t\t\tawait this.postMessageToWebview({
\t\t\t\ttype: "clineMessagesSnapshotStart",
\t\t\t\ttaskId,
\t\t\t\tclineMessagesSeq: seq,
\t\t\t\tsnapshotId,
\t\t\t\tsnapshotTotal: messages.length,
\t\t\t})

\t\t\tfor (
\t\t\t\tlet start = 0;
\t\t\t\tstart < messages.length;
\t\t\t\tstart += ClineProvider.CLINE_MESSAGES_SNAPSHOT_CHUNK_SIZE
\t\t\t) {
\t\t\t\tif (
\t\t\t\t\tgeneration !== this.clineMessagesTransportGeneration ||
\t\t\t\t\t(this.getCurrentTask()?.taskId ?? undefined) !== taskId
\t\t\t\t) {
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tawait this.postMessageToWebview({
\t\t\t\t\ttype: "clineMessagesSnapshotChunk",
\t\t\t\t\ttaskId,
\t\t\t\t\tclineMessagesSeq: seq,
\t\t\t\t\tsnapshotId,
\t\t\t\t\tsnapshotStartIndex: start,
\t\t\t\t\tclineMessages: messages.slice(
\t\t\t\t\t\tstart,
\t\t\t\t\t\tstart + ClineProvider.CLINE_MESSAGES_SNAPSHOT_CHUNK_SIZE,
\t\t\t\t\t),
\t\t\t\t})
\t\t\t}

\t\t\tawait this.postMessageToWebview({
\t\t\t\ttype: "clineMessagesSnapshotEnd",
\t\t\t\ttaskId,
\t\t\t\tclineMessagesSeq: seq,
\t\t\t\tsnapshotId,
\t\t\t\tsnapshotTotal: messages.length,
\t\t\t})
\t\t})
\t}

\tpublic async resyncClineMessagesToWebview(taskId?: string): Promise<void> {
\t\tif ((this.getCurrentTask()?.taskId ?? undefined) !== taskId) {
\t\t\treturn
\t\t}
\t\tthis.resetClineMessagesTransport()
\t\tthis.suppressClineMessagesDeltas = true
\t\ttry {
\t\t\tconst snapshot = this.postClineMessagesSnapshot(taskId)
\t\t\tthis.suppressClineMessagesDeltas = false
\t\t\tawait snapshot
\t\t} finally {
\t\t\tthis.suppressClineMessagesDeltas = false
\t\t}
\t}

\tpublic async syncFocusedTaskToWebview(
\t\toptions: { includeTaskHistory?: boolean } = {},
\t): Promise<void> {
\t\tconst generation = this.resetClineMessagesTransport()
\t\tthis.suppressClineMessagesDeltas = true
\t\ttry {
\t\t\tif (options.includeTaskHistory) {
\t\t\t\tawait this.postStateToWebview()
\t\t\t} else {
\t\t\t\tawait this.postStateToWebviewWithoutTaskHistory()
\t\t\t}
\t\t\tif (generation !== this.clineMessagesTransportGeneration) {
\t\t\t\treturn
\t\t\t}
\t\t\tconst snapshot = this.postClineMessagesSnapshot()
\t\t\tthis.suppressClineMessagesDeltas = false
\t\t\tawait snapshot
\t\t} finally {
\t\t\tthis.suppressClineMessagesDeltas = false
\t\t}
\t}
'''
    text = replace_once(text, old_post, new_post, "provider transcript transport methods")

    old_state = '''\tasync postStateToWebview() {
\t\tconst state = await this.getStateToPostToWebview()
\t\tthis.clineMessagesSeq++
\t\tstate.clineMessagesSeq = this.clineMessagesSeq
\t\tawait this.postMessageToWebview({ type: "state", state })
\t}
'''
    new_state = '''\tasync postStateToWebview() {
\t\tconst state = await this.getStateToPostToWebview()
\t\tconst { clineMessages: _omitMessages, clineMessagesSeq: _omitMessagesSeq, ...metadataState } = state
\t\tawait this.postMessageToWebview({ type: "state", state: metadataState })
\t}
'''
    text = replace_once(text, old_state, new_state, "postState transcript omission")

    old_no_history = '''\tasync postStateToWebviewWithoutTaskHistory(): Promise<void> {
\t\tconst state = await this.getStateToPostToWebview({ includeTaskHistory: false })
\t\tthis.clineMessagesSeq++
\t\tstate.clineMessagesSeq = this.clineMessagesSeq
\t\tconst { taskHistory: _omit, ...rest } = state
\t\tawait this.postMessageToWebview({ type: "state", state: rest })
\t}
'''
    new_no_history = '''\tasync postStateToWebviewWithoutTaskHistory(): Promise<void> {
\t\tconst state = await this.getStateToPostToWebview({ includeTaskHistory: false })
\t\tconst {
\t\t\tclineMessages: _omitMessages,
\t\t\tclineMessagesSeq: _omitMessagesSeq,
\t\t\ttaskHistory: _omitHistory,
\t\t\t...metadataState
\t\t} = state
\t\tawait this.postMessageToWebview({ type: "state", state: metadataState })
\t}
'''
    text = replace_once(text, old_no_history, new_no_history, "postStateWithoutTaskHistory transcript omission")

    text = replace_once(
        text,
        "\t\tconst { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state",
        "\t\tconst {\n"
        "\t\t\tclineMessages: _omitMessages,\n"
        "\t\t\tclineMessagesSeq: _omitMessagesSeq,\n"
        "\t\t\ttaskHistory: _omitHistory,\n"
        "\t\t\t...rest\n"
        "\t\t} = state",
        "postStateWithoutClineMessages sequence omission",
    )

    write(path, text)


def patch_task(root: Path) -> None:
    path = root / "src/core/task/Task.ts"
    text = read(path)

    text = sub_once(
        text,
        r'''\tprivate async addToClineMessages\(message: ClineMessage\) \{\n'''
        r'''\t\tthis\.clineMessages\.push\(message\)\n'''
        r'''\t\tconst provider = this\.providerRef\.deref\(\)\n'''
        r'''\t\t// Unanswered asks must reach the webview before Message listeners can respond against its state\.\n'''
        r'''\t\tconst requiresImmediateState =\n'''
        r'''\t\t\tmessage\.partial === true \|\| \(message\.type === "ask" && message\.isAnswered !== true\)\n'''
        r'''\t\ttry \{\n'''
        r'''\t\t\tawait provider\?\.postStateToWebviewThrottled\(\)\n'''
        r'''\t\t\} catch \(error\) \{\n'''
        r'''\t\t\tconsole\.error\("\[Task#addToClineMessages\] postStateToWebviewThrottled failed:", error\)\n'''
        r'''\t\t\}\n'''
        r'''\t\tif \(requiresImmediateState\) \{\n'''
        r'''\t\t\ttry \{\n'''
        r'''\t\t\t\tawait provider\?\.flushPostStateToWebviewThrottled\(\)\n'''
        r'''\t\t\t\} catch \(error\) \{\n'''
        r'''\t\t\t\tconsole\.error\("\[Task#addToClineMessages\] flushPostStateToWebviewThrottled failed:", error\)\n'''
        r'''\t\t\t\}\n'''
        r'''\t\t\}\n''',
        '''\tprivate async addToClineMessages(message: ClineMessage) {
\t\tthis.clineMessages.push(message)
\t\tconst provider = this.providerRef.deref()
\t\ttry {
\t\t\tawait provider?.postClineMessageAppended(this.taskId, message)
\t\t} catch (error) {
\t\t\tconsole.error("[Task#addToClineMessages] incremental post failed:", error)
\t\t}
''',
        "Task append delta",
    )

    text = replace_once(
        text,
        "\t\tfor (const msg of newMessages) {\n"
        "\t\t\tif (msg.partial !== true) {\n"
        "\t\t\t\tthis.cloudSyncedMessageTimestamps.add(msg.ts)\n"
        "\t\t\t}\n"
        "\t\t}\n"
        "\t}\n"
        "\tprivate async updateClineMessage(message: ClineMessage) {\n"
        "\t\tconst provider = this.providerRef.deref()\n"
        "\t\tawait provider?.postMessageToWebview({ type: \"messageUpdated\", clineMessage: message })",
        "\t\tfor (const msg of newMessages) {\n"
        "\t\t\tif (msg.partial !== true) {\n"
        "\t\t\t\tthis.cloudSyncedMessageTimestamps.add(msg.ts)\n"
        "\t\t\t}\n"
        "\t\t}\n"
        "\t\tawait this.providerRef.deref()?.postClineMessagesSnapshot(this.taskId, { bumpSeq: true })\n"
        "\t}\n"
        "\tprivate async updateClineMessage(message: ClineMessage) {\n"
        "\t\tconst provider = this.providerRef.deref()\n"
        "\t\tawait provider?.postClineMessageUpdated(this.taskId, message)",
        "Task overwrite/update transport",
    )

    text = replace_once(
        text,
        "\t\t\t\tthis.clineMessages[lastFollowUpIndex].isAnswered = true\n\t\t\t\t// Save the updated messages",
        "\t\t\t\tthis.clineMessages[lastFollowUpIndex].isAnswered = true\n"
        "\t\t\t\tvoid this.updateClineMessage(this.clineMessages[lastFollowUpIndex]).catch((error) => {\n"
        "\t\t\t\t\tconsole.error(\"[Task#handleWebviewAskResponse] follow-up delta failed:\", error)\n"
        "\t\t\t\t})\n"
        "\t\t\t\t// Save the updated messages",
        "follow-up answer update delta",
    )

    text = replace_once(
        text,
        "\t\t\tawait this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()\n\n\t\t\tawait this.say(\"text\", task, images)",
        "\t\t\tawait this.providerRef.deref()?.postClineMessagesSnapshot(this.taskId, { bumpSeq: true })\n\n"
        "\t\t\tawait this.say(\"text\", task, images)",
        "new task empty snapshot",
    )

    text = replace_once(
        text,
        "\t\t\tawait this.saveClineMessages()\n\t\t\tawait this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()\n\n\t\t\ttry {",
        "\t\t\tawait this.saveClineMessages()\n"
        "\t\t\tawait this.updateClineMessage(this.clineMessages[lastApiReqIndex])\n\n"
        "\t\t\ttry {",
        "api request placeholder update delta",
    )

    text = replace_once(
        text,
        "\t\t\t\t\tif (lastMessage && lastMessage.partial) {\n"
        "\t\t\t\t\t\t// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list\n"
        "\t\t\t\t\t\tlastMessage.partial = false\n"
        "\t\t\t\t\t\t// instead of streaming partialMessage events, we do a save and post like normal to persist to disk\n"
        "\t\t\t\t\t}\n"
        "\t\t\t\t\t// Update `api_req_started` to have cancelled and cost, so that\n"
        "\t\t\t\t\t// we can display the cost of the partial stream and the cancellation reason\n"
        "\t\t\t\t\tupdateApiReqMsg(cancelReason, streamingFailedMessage)\n"
        "\t\t\t\t\tawait this.saveClineMessages()",
        "\t\t\t\t\tif (lastMessage && lastMessage.partial) {\n"
        "\t\t\t\t\t\t// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list\n"
        "\t\t\t\t\t\tlastMessage.partial = false\n"
        "\t\t\t\t\t\tawait this.updateClineMessage(lastMessage)\n"
        "\t\t\t\t\t}\n"
        "\t\t\t\t\t// Update `api_req_started` to have cancelled and cost, so that\n"
        "\t\t\t\t\t// we can display the cost of the partial stream and the cancellation reason\n"
        "\t\t\t\t\tupdateApiReqMsg(cancelReason, streamingFailedMessage)\n"
        "\t\t\t\t\tconst apiRequestMessage = this.clineMessages[lastApiReqIndex]\n"
        "\t\t\t\t\tif (apiRequestMessage) {\n"
        "\t\t\t\t\t\tawait this.updateClineMessage(apiRequestMessage)\n"
        "\t\t\t\t\t}\n"
        "\t\t\t\t\tawait this.saveClineMessages()",
        "abort stream final deltas",
    )

    text = replace_once(
        text,
        "\t\t\t\tawait this.saveClineMessages()\n\t\t\t\tawait this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()\n\n"
        "\t\t\t\t// No legacy text-stream tool parser state to reset.",
        "\t\t\t\tawait this.saveClineMessages()\n\n"
        "\t\t\t\t// No legacy text-stream tool parser state to reset.",
        "remove response-end full transcript broadcast",
    )

    write(path, text)


def patch_handler(root: Path) -> None:
    path = root / "src/core/webview/webviewMessageHandler.ts"
    text = read(path)

    text = replace_once(
        text,
        "\t\tcase \"webviewDidLaunch\":\n\t\t\t// Load custom modes first",
        "\t\tcase \"requestClineMessagesResync\":\n"
        "\t\t\tawait provider.resyncClineMessagesToWebview(message.taskId)\n"
        "\t\t\tbreak\n"
        "\t\tcase \"webviewDidLaunch\":\n"
        "\t\t\t// Load custom modes first",
        "handler resync case",
    )

    text = replace_once(
        text,
        "\t\t\tawait updateGlobalState(\"customModes\", customModes)\n\t\t\tawait provider.postStateToWebview()",
        "\t\t\tawait updateGlobalState(\"customModes\", customModes)\n"
        "\t\t\tawait provider.syncFocusedTaskToWebview({ includeTaskHistory: true })",
        "launch state plus chunked snapshot",
    )

    text = replace_once(
        text,
        "\t\t\tawait provider.clearTask()\n\t\t\tawait provider.postStateToWebview()",
        "\t\t\tawait provider.clearTask()\n"
        "\t\t\tawait provider.syncFocusedTaskToWebview({ includeTaskHistory: true })",
        "clear task sync",
    )

    text = replace_once(
        text,
        "\t\t\t\t// Update the UI to reflect the deletion\n\t\t\t\tawait provider.postStateToWebview()",
        "\t\t\t\t// Update the UI to reflect the deletion\n"
        "\t\t\t\tawait provider.postClineMessagesSnapshot(currentCline.taskId, { bumpSeq: true })",
        "delete operation snapshot",
    )

    text = replace_once(
        text,
        "\t\t\t// Update the UI to reflect the deletion\n\t\t\tawait provider.postStateToWebview()\n\t\t\tawait currentCline.submitUserMessage",
        "\t\t\t// Update the UI to reflect the edit\n"
        "\t\t\tawait provider.postClineMessagesSnapshot(currentCline.taskId, { bumpSeq: true })\n"
        "\t\t\tawait currentCline.submitUserMessage",
        "edit operation snapshot",
    )

    # The updatePrompt handler posts a hand-built state directly. The provider now
    # strips transcripts centrally, but use the explicit metadata-safe path too.
    text = replace_once(
        text,
        "\t\t\t\tconst currentState = await provider.getStateToPostToWebview()\n"
        "\t\t\t\tconst stateWithPrompts = {\n"
        "\t\t\t\t\t...currentState,\n"
        "\t\t\t\t\tcustomModePrompts: updatedPrompts,\n"
        "\t\t\t\t\thasOpenedModeSelector: currentState.hasOpenedModeSelector ?? false,\n"
        "\t\t\t\t}\n"
        "\t\t\t\tawait provider.postMessageToWebview({ type: \"state\", state: stateWithPrompts })",
        "\t\t\t\tawait provider.postStateToWebviewWithoutClineMessages()",
        "updatePrompt metadata-only state",
    )

    write(path, text)


def patch_webview(root: Path) -> None:
    path = root / "webview-ui/src/context/ExtensionStateContext.tsx"
    text = read(path)

    text = replace_once(
        text,
        'import React, { createContext, useCallback, useEffect, useState } from "react"',
        'import React, { createContext, useCallback, useEffect, useRef, useState } from "react"',
        "webview useRef import",
    )
    text = replace_once(
        text,
        "\ttype ExtensionState,\n\ttype MarketplaceInstalledMetadata,",
        "\ttype ExtensionState,\n\ttype ClineMessage,\n\ttype MarketplaceInstalledMetadata,",
        "webview ClineMessage import",
    )

    text = sub_once(
        text,
        r'''\t// Protect clineMessages from stale state pushes using sequence numbering\.\n'''
        r'''(?:\t//.*\n){4}'''
        r'''\tif \(\n'''
        r'''\t\tnewState\.clineMessagesSeq !== undefined &&\n'''
        r'''\t\tprevState\.clineMessagesSeq !== undefined &&\n'''
        r'''\t\tnewState\.clineMessagesSeq <= prevState\.clineMessagesSeq &&\n'''
        r'''\t\tnewState\.clineMessages !== undefined\n'''
        r'''\t\) \{\n'''
        r'''\t\trest\.clineMessages = prevState\.clineMessages\n'''
        r'''\t\trest\.clineMessagesSeq = prevState\.clineMessagesSeq\n'''
        r'''\t\}\n''',
        "",
        "remove old full-state sequence guard",
    )

    text = replace_once(
        text,
        "export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)\n\n",
        "export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)\n\n"
        "type ClineMessagesSnapshotBuffer = {\n"
        "\tsnapshotId: string\n"
        "\ttaskId?: string\n"
        "\tseq: number\n"
        "\ttotal: number\n"
        "\tmessages: ClineMessage[]\n"
        "}\n\n",
        "snapshot buffer type",
    )

    text = replace_once(
        text,
        "\tconst [state, setState] = useState<ExtensionState>(() =>\n"
        "\t\tmergeExtensionState(createInitialExtensionState(), initialState ?? {}),\n"
        "\t)\n"
        "\tconst [didHydrateState, setDidHydrateState] = useState(false)",
        "\tconst [state, setState] = useState<ExtensionState>(() =>\n"
        "\t\tmergeExtensionState(createInitialExtensionState(), initialState ?? {}),\n"
        "\t)\n"
        "\tconst activeTaskIdRef = useRef<string | undefined>(state.currentTaskId)\n"
        "\tconst clineMessagesSeqRef = useRef(state.clineMessagesSeq ?? 0)\n"
        "\tconst clineMessagesRef = useRef<ClineMessage[]>(state.clineMessages)\n"
        "\tconst activeSnapshotRef = useRef<ClineMessagesSnapshotBuffer | null>(null)\n"
        "\tconst resyncPendingRef = useRef(false)\n"
        "\tconst [didHydrateState, setDidHydrateState] = useState(false)",
        "webview transcript refs",
    )

    callback_anchor = '''\tconst setApiConfiguration = useCallback((value: ProviderSettings) => {
\t\tsetState((prevState) => ({
\t\t\t...prevState,
\t\t\tapiConfiguration: {
\t\t\t\t...prevState.apiConfiguration,
\t\t\t\t...value,
\t\t\t},
\t\t}))
\t}, [])
'''
    callback_add = callback_anchor + '''
\tconst requestClineMessagesResync = useCallback((receivedSeq?: number) => {
\t\tif (resyncPendingRef.current) {
\t\t\treturn
\t\t}
\t\tresyncPendingRef.current = true
\t\tvscode.postMessage({
\t\t\ttype: "requestClineMessagesResync",
\t\t\ttaskId: activeTaskIdRef.current,
\t\t\texpectedSeq: clineMessagesSeqRef.current + 1,
\t\t\treceivedSeq,
\t\t})
\t}, [])

\tconst applyClineMessagesDelta = useCallback(
\t\t(message: ExtensionMessage, operation: "append" | "update") => {
\t\t\tconst seq = message.clineMessagesSeq
\t\t\tconst clineMessage = message.clineMessage
\t\t\tif (
\t\t\t\ttypeof seq !== "number" ||
\t\t\t\t!clineMessage ||
\t\t\t\tmessage.taskId !== activeTaskIdRef.current
\t\t\t) {
\t\t\t\treturn
\t\t\t}
\t\t\tif (activeSnapshotRef.current) {
\t\t\t\trequestClineMessagesResync(seq)
\t\t\t\treturn
\t\t\t}
\t\t\tif (seq <= clineMessagesSeqRef.current) {
\t\t\t\treturn
\t\t\t}
\t\t\tif (seq !== clineMessagesSeqRef.current + 1) {
\t\t\t\trequestClineMessagesResync(seq)
\t\t\t\treturn
\t\t\t}

\t\t\tlet nextMessages: ClineMessage[]
\t\t\tif (operation === "append") {
\t\t\t\tnextMessages = [...clineMessagesRef.current, clineMessage]
\t\t\t} else {
\t\t\t\tconst index = findLastIndex(clineMessagesRef.current, (item) => item.ts === clineMessage.ts)
\t\t\t\tif (index === -1) {
\t\t\t\t\trequestClineMessagesResync(seq)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tnextMessages = [...clineMessagesRef.current]
\t\t\t\tnextMessages[index] = clineMessage
\t\t\t}

\t\t\tclineMessagesRef.current = nextMessages
\t\t\tclineMessagesSeqRef.current = seq
\t\t\tsetState((prevState) => ({
\t\t\t\t...prevState,
\t\t\t\tclineMessages: nextMessages,
\t\t\t\tclineMessagesSeq: seq,
\t\t\t}))
\t\t},
\t\t[requestClineMessagesResync],
\t)
'''
    text = replace_once(text, callback_anchor, callback_add, "webview transcript callbacks")

    text = replace_once(
        text,
        "\t\t\t\tcase \"state\": {\n"
        "\t\t\t\t\tconst newState = message.state ?? {}\n"
        "\t\t\t\t\tsetState((prevState) => mergeExtensionState(prevState, newState))",
        "\t\t\t\tcase \"state\": {\n"
        "\t\t\t\t\tconst {\n"
        "\t\t\t\t\t\tclineMessages: _ignoredMessages,\n"
        "\t\t\t\t\t\tclineMessagesSeq: _ignoredMessagesSeq,\n"
        "\t\t\t\t\t\t...newState\n"
        "\t\t\t\t\t} = message.state ?? {}\n"
        "\t\t\t\t\tconst hasCurrentTaskId = Object.prototype.hasOwnProperty.call(newState, \"currentTaskId\")\n"
        "\t\t\t\t\tconst nextTaskId = hasCurrentTaskId ? newState.currentTaskId : activeTaskIdRef.current\n"
        "\t\t\t\t\tconst taskChanged = hasCurrentTaskId && nextTaskId !== activeTaskIdRef.current\n"
        "\t\t\t\t\tif (taskChanged) {\n"
        "\t\t\t\t\t\tactiveTaskIdRef.current = nextTaskId\n"
        "\t\t\t\t\t\tclineMessagesSeqRef.current = 0\n"
        "\t\t\t\t\t\tclineMessagesRef.current = []\n"
        "\t\t\t\t\t\tactiveSnapshotRef.current = null\n"
        "\t\t\t\t\t\tresyncPendingRef.current = false\n"
        "\t\t\t\t\t}\n"
        "\t\t\t\t\tsetState((prevState) => {\n"
        "\t\t\t\t\t\tconst merged = mergeExtensionState(prevState, newState)\n"
        "\t\t\t\t\t\treturn taskChanged ? { ...merged, clineMessages: [], clineMessagesSeq: 0 } : merged\n"
        "\t\t\t\t\t})",
        "metadata state task switch handling",
    )

    old_message_case = re.compile(
        r'''\t\t\t\tcase "messageUpdated": \{\n.*?\t\t\t\t\}\n\t\t\t\tcase "skills": \{''',
        re.S,
    )
    new_message_case = '''\t\t\t\tcase "clineMessagesSnapshotStart": {
\t\t\t\t\tif (
\t\t\t\t\t\t!message.snapshotId ||
\t\t\t\t\t\ttypeof message.clineMessagesSeq !== "number" ||
\t\t\t\t\t\ttypeof message.snapshotTotal !== "number" ||
\t\t\t\t\t\tmessage.taskId !== activeTaskIdRef.current ||
\t\t\t\t\t\tmessage.clineMessagesSeq < clineMessagesSeqRef.current
\t\t\t\t\t) {
\t\t\t\t\t\tbreak
\t\t\t\t\t}
\t\t\t\t\tactiveSnapshotRef.current = {
\t\t\t\t\t\tsnapshotId: message.snapshotId,
\t\t\t\t\t\ttaskId: message.taskId,
\t\t\t\t\t\tseq: message.clineMessagesSeq,
\t\t\t\t\t\ttotal: message.snapshotTotal,
\t\t\t\t\t\tmessages: [],
\t\t\t\t\t}
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t\tcase "clineMessagesSnapshotChunk": {
\t\t\t\t\tconst snapshot = activeSnapshotRef.current
\t\t\t\t\tif (
\t\t\t\t\t\t!snapshot ||
\t\t\t\t\t\tmessage.snapshotId !== snapshot.snapshotId ||
\t\t\t\t\t\tmessage.taskId !== snapshot.taskId ||
\t\t\t\t\t\tmessage.clineMessagesSeq !== snapshot.seq
\t\t\t\t\t) {
\t\t\t\t\t\tbreak
\t\t\t\t\t}
\t\t\t\t\tconst chunk = message.clineMessages ?? []
\t\t\t\t\tif (
\t\t\t\t\t\tmessage.snapshotStartIndex !== snapshot.messages.length ||
\t\t\t\t\t\tsnapshot.messages.length + chunk.length > snapshot.total
\t\t\t\t\t) {
\t\t\t\t\t\tactiveSnapshotRef.current = null
\t\t\t\t\t\trequestClineMessagesResync(message.clineMessagesSeq)
\t\t\t\t\t\tbreak
\t\t\t\t\t}
\t\t\t\t\tsnapshot.messages.push(...chunk)
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t\tcase "clineMessagesSnapshotEnd": {
\t\t\t\t\tconst snapshot = activeSnapshotRef.current
\t\t\t\t\tif (
\t\t\t\t\t\t!snapshot ||
\t\t\t\t\t\tmessage.snapshotId !== snapshot.snapshotId ||
\t\t\t\t\t\tmessage.taskId !== snapshot.taskId ||
\t\t\t\t\t\tmessage.clineMessagesSeq !== snapshot.seq ||
\t\t\t\t\t\tsnapshot.messages.length !== snapshot.total ||
\t\t\t\t\t\tmessage.snapshotTotal !== snapshot.total
\t\t\t\t\t) {
\t\t\t\t\t\tactiveSnapshotRef.current = null
\t\t\t\t\t\trequestClineMessagesResync(message.clineMessagesSeq)
\t\t\t\t\t\tbreak
\t\t\t\t\t}
\t\t\t\t\tactiveSnapshotRef.current = null
\t\t\t\t\tresyncPendingRef.current = false
\t\t\t\t\tclineMessagesRef.current = snapshot.messages
\t\t\t\t\tclineMessagesSeqRef.current = snapshot.seq
\t\t\t\t\tsetState((prevState) => ({
\t\t\t\t\t\t...prevState,
\t\t\t\t\t\tclineMessages: snapshot.messages,
\t\t\t\t\t\tclineMessagesSeq: snapshot.seq,
\t\t\t\t\t}))
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t\tcase "clineMessageAppended": {
\t\t\t\t\tapplyClineMessagesDelta(message, "append")
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t\tcase "clineMessageUpdated": {
\t\t\t\t\tapplyClineMessagesDelta(message, "update")
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t\tcase "messageUpdated": {
\t\t\t\t\t// An unsequenced legacy update cannot be applied safely.
\t\t\t\t\trequestClineMessagesResync(message.clineMessagesSeq)
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t\tcase "skills": {'''
    text, count = old_message_case.subn(new_message_case, text, count=1)
    if count != 1:
        die(f"webview transcript switch: expected exactly one match, found {count}")

    text = replace_once(
        text,
        "\t\t[setListApiConfigMeta],",
        "\t\t[applyClineMessagesDelta, requestClineMessagesResync, setListApiConfigMeta],",
        "webview handler dependencies",
    )

    write(path, text)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo", nargs="?", default=".", help="Zoo Code repository root")
    parser.add_argument("--no-diff", action="store_true", help="do not print git diff after applying")
    args = parser.parse_args()

    root = Path(args.repo).resolve()
    sentinel = root / "src/core/webview/ClineProvider.ts"
    if not sentinel.is_file():
        die(f"{root} does not look like the Zoo Code repository root")

    if MARKER in read(sentinel):
        print("Patch marker already present; no changes made.")
        return 0

    patch_types(root)
    patch_provider(root)
    patch_task(root)
    patch_handler(root)
    patch_webview(root)

    files = [
        "packages/types/src/vscode-extension-host.ts",
        "src/core/webview/ClineProvider.ts",
        "src/core/task/Task.ts",
        "src/core/webview/webviewMessageHandler.ts",
        "webview-ui/src/context/ExtensionStateContext.tsx",
    ]
    print("Applied incremental, sequenced, chunked transcript transport patch.")
    print("Changed files:")
    for file in files:
        print(f"  {file}")

    if not args.no_diff:
        try:
            subprocess.run(["git", "diff", "--", *files], cwd=root, check=False)
        except FileNotFoundError:
            print("git not found; skipping diff", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
