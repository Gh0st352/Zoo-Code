# Zoo Code permanent gray-screen fix

This source patch replaces the unbounded full-transcript webview transport with a dedicated transcript protocol:

- Generic `state` messages are forcibly stripped of `clineMessages` and `clineMessagesSeq` at the provider boundary.
- Appends and edits are sent as task-scoped, monotonically sequenced deltas.
- Initial load, task switches, checkpoint rewinds, edits, deletes, and recovery use a serialized chunked snapshot.
- The webview validates task ID, sequence continuity, snapshot identity, chunk offsets, and final message count.
- A sequence gap or legacy unsequenced update requests an automatic full resynchronization.
- Focus changes invalidate the old transcript transport generation, preventing a background task from updating the foreground transcript.
- A reload no longer requires deserializing the entire transcript as one generic extension-state object.

## Apply

From a clean Zoo Code source checkout:

```powershell
python C:\path\to\apply_zoo_code_incremental_transcript_fix.py .
```

The patcher is deliberately strict. It stops without partially continuing when an expected source block differs from the source lineage it targets. Review the resulting diff:

```powershell
git diff --check
git diff --stat
git diff
```

## Validate

The repository declares Node `22.23.1` and pnpm `10.8.1`.

```powershell
corepack enable
corepack prepare pnpm@10.8.1 --activate
pnpm install --frozen-lockfile
pnpm format
pnpm check-types
pnpm lint
pnpm test
pnpm vsix
```

Install the generated VSIX:

```powershell
$Vsix = Get-ChildItem .\bin\*.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
code --install-extension $Vsix.FullName --force
```

Then fully exit all VS Code processes once and reopen VS Code.

## Required stress acceptance test

Use a copy of a large project and run a task that produces at least 10,000 Zoo transcript messages or tool-status updates.

Pass conditions:

1. The Zoo Code webview remains rendered and interactive throughout the run.
2. Renderer memory does not grow in proportion to `message-count × total-transcript-size`.
3. Normal appends transfer one `ClineMessage`; normal edits transfer one `ClineMessage`.
4. No generic `state` message contains `clineMessages` in Webview Developer Tools.
5. `Developer: Reload Webviews` reconstructs the active transcript through snapshot chunks without stopping the extension-host task.
6. Switching rapidly between parent and delegated child tasks never displays messages from the wrong task.
7. Deliberately dropping one delta causes `requestClineMessagesResync`, followed by a correct chunked snapshot.

## Files changed by the patcher

- `packages/types/src/vscode-extension-host.ts`
- `src/core/webview/ClineProvider.ts`
- `src/core/task/Task.ts`
- `src/core/webview/webviewMessageHandler.ts`
- `webview-ui/src/context/ExtensionStateContext.tsx`



# GPT 5.6 Output:

## Patch output

* [Download the permanent-fix source patch applicator](sandbox:/mnt/data/apply_zoo_code_incremental_transcript_fix.py)
* [Download the implementation notes and validation procedure](sandbox:/mnt/data/ZOO_CODE_GRAY_SCREEN_FIX_README.md)

This is a **source-level architectural fix**, not another output-limiting or task-rotation workaround.

Zoo Code issue #630 remains open and documents the underlying defect: throttling reduces update frequency but still serializes the complete `clineMessages` array, approximately 7 MB at 3,525 messages, on ordinary state pushes. Its required solution is task-scoped incremental delivery with sequencing, focus isolation, and automatic resynchronization. ([GitHub][1])

The v3.80 release notes confirm that the shipped change was specifically a throttling change, rather than replacement of the full-array transport. ([GitHub][2])

## What the patch changes

The patch modifies these files:

```text
packages/types/src/vscode-extension-host.ts
src/core/webview/ClineProvider.ts
src/core/task/Task.ts
src/core/webview/webviewMessageHandler.ts
webview-ui/src/context/ExtensionStateContext.tsx
```

It implements five related changes.

### 1. Removes transcripts from generic extension state

Every generic `{ type: "state" }` message is stripped of:

```text
clineMessages
clineMessagesSeq
```

The stripping occurs at the final `postMessageToWebview()` boundary, not merely in selected callers. This prevents another code path from accidentally reintroducing multi-megabyte state messages.

### 2. Adds task-scoped incremental messages

Normal transcript changes become:

```typescript
{
  type: "clineMessageAppended",
  taskId,
  clineMessage,
  clineMessagesSeq
}
```

or:

```typescript
{
  type: "clineMessageUpdated",
  taskId,
  clineMessage,
  clineMessagesSeq
}
```

An append or edit therefore transfers one `ClineMessage`, not the entire transcript.

### 3. Adds chunked transcript reconstruction

Initial webview loading, task switching, checkpoint restoration, message deletion, message editing, and explicit recovery use:

```text
clineMessagesSnapshotStart
clineMessagesSnapshotChunk
clineMessagesSnapshotEnd
```

The default chunk size is 200 messages.

This extends the proposal in issue #630: the retained full synchronization path is itself chunked, so reloading the webview does not require deserializing the complete history in one large message.

### 4. Adds automatic sequence-gap recovery

The webview validates:

* Focused task ID
* Monotonic sequence number
* Snapshot ID
* Chunk start offset
* Expected message count
* Final received message count

When an append or update is skipped, reordered, or cannot be applied, the webview sends:

```typescript
{
  type: "requestClineMessagesResync",
  taskId,
  expectedSeq,
  receivedSeq
}
```

The extension then sends a fresh chunked snapshot.

### 5. Isolates foreground and background tasks

Each task has its own message sequence. Focus transitions invalidate the previous transport generation.

Consequently, a delegated child task or an old asynchronous callback cannot append messages to whichever task happens to be visible when the callback completes.

## Apply the patch

Use a clean Zoo Code source checkout:

```powershell
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
Set-Location .\Zoo-Code

python C:\Path\To\apply_zoo_code_incremental_transcript_fix.py .
```

The applicator is deliberately strict. It checks that each expected source block exists exactly once. If the source differs materially, it exits rather than partially modifying the repository.

Review the changes:

```powershell
git diff --check
git diff --stat
git diff
```

## Build and validate

The current repository specifies Node `22.23.1`, pnpm `10.8.1`, and provides `check-types`, `lint`, `test`, and `vsix` scripts. 

```powershell
corepack enable
corepack prepare pnpm@10.8.1 --activate

pnpm install --frozen-lockfile
pnpm check-types
pnpm lint
pnpm test
pnpm vsix
```

Install the generated package:

```powershell
$Vsix = Get-ChildItem .\bin\*.vsix |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

code --install-extension $Vsix.FullName --force
```

Zoo Code’s repository documents `pnpm vsix`, `pnpm install:vsix`, and manual installation from the generated `bin` directory. ([GitHub][3])

After installation, fully close all VS Code processes once and reopen VS Code. Prevent the Marketplace build from automatically replacing the custom version while it is being evaluated.

## Required acceptance test

Run a long task that produces at least 10,000 transcript/tool-status messages.

The fix passes when all of the following are true:

1. Zoo Code remains rendered and interactive.
2. Normal appends and edits transfer one message each.
3. No generic `state` event contains `clineMessages`.
4. Renderer memory does not scale with `message count × entire transcript size`.
5. `Developer: Reload Webviews` reconstructs the active transcript through chunks.
6. The extension-host task continues while the replacement webview hydrates.
7. Rapid parent/child task switching never shows messages from the wrong task.
8. A deliberately dropped delta causes an automatic resync and restores an exact transcript.

## Validation status

The patch applicator itself passed Python syntax compilation with `python -m py_compile`.

I inspected the current official source structure and issue specification while constructing it, but could not run Zoo Code’s TypeScript build or test suite in this execution environment because the repository could not be cloned into the local container. The patch is therefore a **source patch candidate**, not an upstream-reviewed release. Issue #630 currently shows no associated branch or pull request. ([GitHub][1])

SHA-256:

```text
apply_zoo_code_incremental_transcript_fix.py
8f89677c1e4fbec5ab9982495e0396a2e086d59d9a89fc90a6ae904b450fa5b1

ZOO_CODE_GRAY_SCREEN_FIX_README.md
9d4db5a0d87f9726d5234d5884907977cc00664d93e9a8a0e17bd50b4530de2d
```

[1]: https://github.com/Zoo-Code-Org/Zoo-Code/issues/630 "feat(webview): incremental clineMessages delivery for focused task · Issue #630 · Zoo-Code-Org/Zoo-Code · GitHub"
[2]: https://github.com/Zoo-Code-Org/Zoo-Code/releases "Releases · Zoo-Code-Org/Zoo-Code · GitHub"
[3]: https://github.com/Zoo-Code-Org/Zoo-Code "GitHub - Zoo-Code-Org/Zoo-Code: Zoo Code gives you a whole dev team of AI agents in your code editor. · GitHub"
