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
