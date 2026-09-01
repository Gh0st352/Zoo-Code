# Portable ZooCode gray-screen capture: explicit operator guide

This guide starts at the point where you have received the generated portable-kit ZIP or its extracted contents. It explains how to place the kit in a target repository, validate it, start a monitored run, reproduce the problem, inspect status, request a snapshot, stop safely, and collect the evidence.

> **Critical:** the VS Code window that is already open is not monitored. Chromium DevTools Protocol cannot normally be enabled retroactively in an existing VS Code process. The launcher opens a **second, dedicated, isolated VS Code window**. Perform the ZooCode diagnostic task only in that second window.

## 1. Before you begin

Confirm all of the following on the machine where the capture will run:

- Windows 11 is running.
- Windows PowerShell 5.1 or PowerShell 7 or newer is available.
- Node 22 or newer is installed. Node must provide the built-in `WebSocket` API.
- Stable Visual Studio Code 1.100 or newer is installed.
- You have enough free disk space on a local fixed drive. A heap snapshot can be large.
- You are allowed to collect and retain diagnostic evidence from the target repository.

You do **not** need a ZooCode source checkout, `pnpm`, `node_modules`, or build tools. The kit already contains the production ZooCode VSIX and collector.

## 2. Understand the privacy impact before starting

Normal evidence is restricted to diagnostic scalar records. Heap snapshots are different: they can contain prompts, responses, source code, file paths, settings, credentials, tokens, and arbitrary values held in memory. Snapshot capture can pause or destabilize a pressured VS Code renderer.

Automatic snapshots are enabled by default when the measured heap ratio reaches `0.82` for three consecutive valid samples. The collector still applies safety gates, but enabling the feature is not a guarantee that a snapshot will be taken.

Choose one of these policies before proceeding:

1. **Default:** leave automatic snapshots enabled because the evidence is permitted and will be handled privately.
2. **Sensitive environment:** add `-DisableAutoSnapshots` to the Start command in step 8.

The kit never uploads evidence. Do not publish a `.heapsnapshot` file or attach one to a public issue.

## 3. Extract the transport ZIP

Do not run the script from inside the ZIP.

1. In File Explorer, right-click the generated ZIP.
2. Select **Extract All**.
3. Extract it to a private directory on a local fixed drive.
4. Open the extracted versioned directory.

It must contain these two sibling items:

```text
Start-ZooCodeGrayScreenCapture.ps1
ZooCodeGrayScreenCapture.bundle\
```

Do not rename either item. Do not move files out of the bundle. The launcher is cryptographically bound to the adjacent manifest, and the manifest lists every payload file.

## 4. Copy the kit into the target repository

Assume the repository to diagnose is `C:\Work\XXX_REPO`.

1. Open the extracted versioned kit directory.
2. Select both:
    - `Start-ZooCodeGrayScreenCapture.ps1`
    - `ZooCodeGrayScreenCapture.bundle`
3. Copy both items.
4. Paste both directly into `C:\Work\XXX_REPO`.

The resulting repository layout must be:

```text
C:\Work\XXX_REPO\
  Start-ZooCodeGrayScreenCapture.ps1
  ZooCodeGrayScreenCapture.bundle\
  <the repository's existing files and directories>
```

The launcher uses its own parent directory as the workspace unless `-WorkspacePath` is explicitly supplied. Putting the two artifacts at the repository root therefore gives the simplest and safest workflow.

## 5. Open a PowerShell terminal at the repository root

If the repository is already open in VS Code:

1. In the existing VS Code window, select **Terminal → New Terminal**.
2. Confirm that the terminal is PowerShell.
3. Change to the repository root if necessary:

```powershell
Set-Location -LiteralPath 'C:\Work\XXX_REPO'
```

4. Confirm that both kit items are present:

```powershell
Get-Item -LiteralPath '.\Start-ZooCodeGrayScreenCapture.ps1'
Get-Item -LiteralPath '.\ZooCodeGrayScreenCapture.bundle'
```

Keep the first VS Code window open if useful, but remember that it remains unmonitored.

## 6. Validate the copied kit before starting

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Validate
```

Successful validation begins with:

```text
Portable ZooCode gray-screen kit is valid.
```

It also prints the selected Node version, VS Code version, workspace, evidence root, profile mode, CDP port, and automatic-snapshot policy.

Validation does not launch VS Code or start capture. It verifies the launcher/manifest binding, every bundle path, byte count and SHA-256 hash, prerequisites, workspace, evidence location, and runtime compatibility.

If validation fails:

- Do not start the kit.
- Read the error code in `ZooCode portable gray-screen kit failed (<CODE>)`.
- For a manifest, payload, missing-file, unexpected-file, or hash error, delete both copied items and copy a fresh matching pair from the extracted kit.
- For `NODE_NOT_FOUND` or `NODE_UNSUPPORTED`, install Node 22+ or use the explicit Node override shown in step 12.
- For `CODE_NOT_FOUND`, `CODE_VERSION`, or `CODE_TOO_OLD`, install/update stable VS Code or use the explicit VS Code override shown in step 12.

`-ExecutionPolicy Bypass` applies only to this child PowerShell process; it does not change user or machine policy. If organizational policy prohibits it, use the organization's approved script-signing and execution process instead.

## 7. Decide where evidence will be stored

The recommended default is outside the repository:

```text
%LOCALAPPDATA%\ZooCode\GrayScreenCapture\evidence
```

The exact resolved path is printed by Validate and Start. Use this default unless a private alternative is required.

To use another private local fixed-drive directory, add an explicit output path to Start:

```powershell
-OutputPath 'D:\PrivateDiagnostics\ZooCode'
```

Do not choose:

- a network or UNC path;
- removable/non-fixed storage;
- a path inside `.git`;
- a path traversing a junction, symlink, or other reparse point; or
- a repository-local output unless you understand the source-control risk.

## 8. Start the foreground capture

### Default start

Run this from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1
```

### Start without automatic snapshots

Use this instead when snapshot sensitivity is unacceptable:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -DisableAutoSnapshots
```

### Start with a private custom evidence directory

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -OutputPath 'D:\PrivateDiagnostics\ZooCode'
```

Do not close this terminal. The collector intentionally remains in the foreground for the entire capture.

During startup the launcher:

1. Revalidates the complete kit.
2. Selects Node and stable VS Code.
3. Selects the external evidence root.
4. Safely adds exact local-only entries to `.git/info/exclude` for a conventional worktree.
5. Creates unique isolated user-data and extension directories.
6. Installs the exact bundled ZooCode VSIX into that isolated profile.
7. Opens a second VS Code process with loopback CDP enabled.
8. Starts the collector and correlates its exact process identity with the run directory.

For linked worktrees, submodules, `.git` indirection files, or other unusual Git layouts, the launcher warns and does not alter Git metadata. It never edits `.gitignore`, stages files, or commits.

## 9. Wait for monitoring to become active

Do not start the ZooCode task merely because a second window appeared. Wait until the foreground terminal prints:

```text
MONITORING ACTIVE
The VS Code window where this script was started is NOT monitored.
Start the ZooCode task only in the newly launched monitored window.
Active run: <path>
```

Record or copy the `Active run` path. That directory contains this capture's evidence.

If the terminal exits before `MONITORING ACTIVE`, the capture did not become active. Use the printed error code rather than starting the diagnostic task.

## 10. Prepare the second, monitored VS Code window

The second window uses a clean isolated profile. It normally does not contain your usual:

- VS Code settings;
- ZooCode credentials or provider configuration;
- ZooCode task history;
- MCP server configuration;
- unrelated extensions; or
- extension secrets.

In the **second window only**:

1. Confirm that the expected repository is open.
2. Open ZooCode.
3. Sign in or configure the minimum provider/settings required for the reproduction.
4. Recreate only the setup needed for the diagnostic task.
5. Do not assume configuration from the first window was copied.

The first window may remain open, but actions performed there are not part of the monitored CDP capture.

## 11. Reproduce the gray-screen problem

After `MONITORING ACTIVE` is visible:

1. In the second window, start the ZooCode task that is suspected of triggering the problem.
2. Reproduce the same workflow as accurately as possible.
3. Leave the foreground capture terminal running.
4. Note the approximate time of important events, such as task start, severe slowdown, gray screen, recovery, reload, or process exit.
5. Do not reload or close the second window unless that action is part of the reproduction or you are ending the run.

The collector records evidence only; it does not repair or reload ZooCode.

## 12. Check status from a second terminal

Open another PowerShell terminal at the same repository root. Leave the original foreground terminal untouched.

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Status
```

Typical active output includes:

```text
Run: <path>
State: capturing
Auto snapshots: True; threshold: 0.82; consecutive samples: 3
```

After a run has stopped, you can query a known run explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -Action Status `
  -RunPath 'C:\path\printed\as\Active run'
```

If there is no unique active state, supply the exact `Active run` path with `-RunPath`.

## 13. Request a manual heap snapshot only when justified

Manual snapshots require an explicit privacy acknowledgment:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -Action Snapshot `
  -AcknowledgeSnapshotPrivacyRisk
```

Do not request repeated snapshots merely because the first command returns slowly. Snapshot capture has cooldown, count, disk, memory, renderer-health, uniqueness, V8-headroom, and validation gates.

If the command reports multiple sanitized candidate targets, rerun it with the displayed ordinal:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -Action Snapshot `
  -TargetOrdinal 2 `
  -AcknowledgeSnapshotPrivacyRisk
```

A renderer that is already unable to service CDP may not produce a snapshot. That failure is itself recorded as diagnostic evidence where possible.

## 14. Stop the capture cleanly

Use one of the following methods.

### Recommended cross-terminal stop

From the second terminal at the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Stop
```

The default stop waits for in-progress snapshot handling within its bounded policy.

If an in-progress snapshot must be aborted:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -Action Stop `
  -SnapshotPolicy Abort
```

### Foreground-console stop

In the original foreground terminal, press `Ctrl+C` once. Allow graceful cleanup to finish. A second `Ctrl+C` requests the collector's immediate-interruption behavior and should be reserved for a stuck shutdown.

Do not use Task Manager to kill all `Code.exe` or `node.exe` processes. The launcher cleanup is deliberately scoped to the exact owned collector and isolated VS Code process trees.

## 15. Confirm finalization

Wait for the original foreground terminal to print:

```text
Capture ended. Run: <path>
```

It may also print a final classification. The isolated profile is operational state and is removed after graceful dedicated shutdown. The evidence run directory remains.

If the machine or terminal was interrupted, do not delete the run immediately. Preserve the run directory for review; terminal metadata may still explain the interruption.

## 16. Locate and protect the evidence

Use the exact path printed after `Active run:` or `Capture ended. Run:`. With defaults it is below:

```text
%LOCALAPPDATA%\ZooCode\GrayScreenCapture\evidence
```

Treat the entire run directory as private. In particular:

- preserve the directory structure and filenames;
- do not edit JSON/JSONL evidence before analysis;
- do not open and resave a `.heapsnapshot` in an editor;
- do not commit evidence to the target repository;
- do not attach snapshots to public issues;
- use an approved encrypted transfer method if evidence must be shared; and
- delete evidence according to your retention policy after analysis.

If no snapshot exists, do not assume capture failed. Snapshot gates may have rejected capture, automatic thresholds may not have been reached, or the renderer may have become unresponsive before snapshot service was possible.

## 17. Remove the copied kit after evidence is secured

Once the run has stopped and the evidence is secured:

1. Close the isolated second VS Code window if it remains open.
2. Delete these two copied items from the repository root:
    - `Start-ZooCodeGrayScreenCapture.ps1`
    - `ZooCodeGrayScreenCapture.bundle`
3. Check repository status:

```powershell
git status --short
```

4. Confirm that no kit or evidence file is staged.

The launcher may have added exact entries to `.git/info/exclude`. Those entries are worktree-local, untracked Git metadata and may be left in place. They can also be removed manually after the copied artifacts are gone. Do not edit tracked `.gitignore` merely to clean up this run.

## 18. Explicit runtime/path overrides

Use overrides only when normal discovery is unsuitable:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -WorkspacePath 'C:\Work\XXX_REPO' `
  -OutputPath 'D:\PrivateDiagnostics\ZooCode' `
  -CodePath "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" `
  -NodePath 'C:\Program Files\nodejs\node.exe' `
  -CdpPort 9333
```

Requirements:

- `-WorkspacePath` must identify the intended local repository directory.
- `-OutputPath` must be on a private local fixed drive and must not traverse reparse points.
- `-CodePath` must resolve to concrete stable `Code.exe`, not Insiders, Cursor, or a shell wrapper.
- `-NodePath` must resolve to Node 22+ on Windows x64 or arm64 with built-in `WebSocket`.
- `-CdpPort` must be an unused loopback port. Omit it or use `0` for automatic selection when supported.

Do not pass profile, extension, CDP, inspector, JavaScript-engine, or proxy-control flags through `-CodeArgument`; the launcher owns and rejects those arguments.

## 19. Common failure responses

### `UNSTAMPED_LAUNCHER`

You copied the source launcher instead of a generated, stamped launcher. Obtain the generated kit ZIP.

### `MANIFEST_HASH_MISMATCH`, payload hash/size errors, missing files, or unexpected files

The launcher and bundle do not form the exact generated pair, or files changed after packaging. Delete both artifacts and copy both again from the same extracted kit.

### `NODE_NOT_FOUND` or `NODE_UNSUPPORTED`

Install Node 22+ or provide a valid `-NodePath`. Confirm with:

```powershell
node --version
node -e "console.log(process.platform, process.arch, typeof WebSocket)"
```

Expected platform is `win32`, architecture is `x64` or `arm64`, and `WebSocket` type is `function`.

### `CODE_NOT_FOUND`, `CODE_VERSION`, or `CODE_TOO_OLD`

Install/update stable VS Code or provide a concrete `-CodePath` to stable `Code.exe`.

### `CDP_PORT_IN_USE`

Choose another unused port or return to automatic selection:

```powershell
-CdpPort 0
```

### `CAPTURE_ALREADY_ACTIVE` or `CAPTURE_ALREADY_STARTING`

Do not start another capture for the same launcher. Run `-Action Status`, then stop or finish the existing run.

### `RUN_REQUIRED`

No unique active run could be selected. Supply the exact path previously printed after `Active run:`:

```powershell
-RunPath 'C:\exact\run\path'
```

### Git exclusion warning

The repository probably uses a linked or unusual worktree. The launcher intentionally made no Git metadata change. Keep the copied artifacts unstaged and confirm with `git status --short` before and after the run.

### Automatic CDP discovery fails

Rerun with a known unused loopback `-CdpPort`. Electron/VS Code support for browser-selected ports varies by build.

### No heap snapshot was produced

This can be expected. Review scalar evidence and snapshot-rejection records. Do not weaken resource or renderer-health gates solely to force a snapshot from a pressured process.

## 20. Minimal command checklist

From the target repository root:

```powershell
# 1. Validate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Validate

# 2. Start and leave this terminal open
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1

# 3. In another terminal, check status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Status

# 4. Optional and sensitive: request one manual snapshot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Snapshot -AcknowledgeSnapshotPrivacyRisk

# 5. Stop cleanly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Stop
```

Throughout the workflow, perform the diagnostic ZooCode task only in the second window opened by the launcher.
