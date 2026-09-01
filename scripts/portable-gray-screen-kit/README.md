# ZooCode portable gray-screen diagnostic kit

This directory contains the source launcher and maintainer packager for an offline, copyable Windows diagnostic kit. The generated kit records evidence for ZooCode/VS Code gray-screen investigation; it does not diagnose, repair, reload, or upload anything.

The most important operational fact is:

> The VS Code window in which you start the script remains **unmonitored**. Chromium DevTools Protocol (CDP) generally cannot be enabled retroactively in an already-running VS Code process. The launcher opens a **second, dedicated, isolated VS Code window**. Start the ZooCode task only in that new window.

## Generated layout

The transport ZIP contains one versioned root with exactly this operating layout:

```text
ZooCodeGrayScreenCapture-<extension-version>-kit<format-version>\
  Start-ZooCodeGrayScreenCapture.ps1
  ZooCodeGrayScreenCapture.bundle\
    kit-manifest.json
    README.md
    OPERATOR-GUIDE.md
    collector\
      live-gray-screen-capture.mjs
      live-gray-screen-capture\*.mjs
    extension\
      zoo-code-<extension-version>.vsix
    notices\
      Zoo-Code-LICENSE.txt
```

The ZIP is a delivery envelope only. Extract it before use; do not try to run the launcher from inside the archive. The launcher and adjacent bundle must remain siblings.

For a complete click-by-click and command-by-command workflow beginning with copying the generated artifacts into a target repository, see [`OPERATOR-GUIDE.md`](OPERATOR-GUIDE.md).

## Operator prerequisites

- Windows 11.
- Windows PowerShell 5.1 or PowerShell 7 or newer.
- Node 22 or newer with built-in `WebSocket`; the tested release is Node 22.23.1.
- Stable Visual Studio Code compatible with the VSIX's declared engine floor; the current floor is VS Code 1.100.
- PowerShell access to `Get-CimInstance` and `Get-NetTCPConnection`.
- A private local fixed drive with enough free memory and disk for evidence and any heap snapshot.
- Normal user rights are sufficient for a user-profile VS Code installation.

No ZooCode source checkout, `pnpm`, package installation, `node_modules`, or extension build is required on the operator machine. The production ZooCode VSIX and collector module tree are included and checksum-validated.

## Privacy warning

Ordinary evidence is allowlist-only scalar diagnostic data. V8 heap snapshots are fundamentally different: they can contain prompts, responses, source code, file paths, credentials, tokens, settings, and arbitrary in-memory values. Snapshot capture can also pause or destabilize an already pressured renderer.

Automatic heap snapshots are enabled by default at a heap ratio of `0.82` for three consecutive valid samples. Existing uniqueness, health, cooldown, count, disk, physical-memory, V8-headroom, and validation gates still fail closed. Disable automatic snapshots when policy or sensitivity requires it:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -DisableAutoSnapshots
```

The kit never uploads evidence. Keep evidence private, do not attach a heap snapshot to a public issue, and delete it according to your organization's retention policy after analysis.

## Prepare an arbitrary repository

1. Extract the generated ZIP to a private local directory.
2. Copy these two siblings from the extracted versioned root into the target repository root:
    - `Start-ZooCodeGrayScreenCapture.ps1`
    - `ZooCodeGrayScreenCapture.bundle`
3. Keep the repository open in its existing VS Code window.
4. Run validation or Start from a PowerShell terminal.

For a conventional worktree, the launcher appends exact root-anchored entries only to the worktree-local `.git/info/exclude`. It never edits `.gitignore`, stages files, commits, or changes global Git configuration. For linked, indirection, submodule, malformed, or otherwise unusual worktrees it warns and does not mutate Git metadata. Local exclusions reduce accidental commit risk but do not prevent force-adding files.

Evidence defaults outside the repository under:

```text
%LOCALAPPDATA%\ZooCode\GrayScreenCapture\evidence
```

If you deliberately select repository-local evidence and the launcher cannot install and verify a safe local exclusion, Start refuses unless `-AcknowledgeRepositoryOutputRisk` is present. Network, UNC, `.git`, reparse, and non-fixed-drive output remains prohibited regardless of acknowledgment.

## Validate without launching

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Validate
```

Validation checks launcher-to-manifest binding, the exact payload inventory, byte counts and SHA-256 hashes, path safety, supported PowerShell capabilities, Node, stable VS Code compatibility, workspace, output root, and an explicit CDP port. It does not start the collector or VS Code.

`-ExecutionPolicy Bypass` is scoped to that process and does not change machine or user policy. Environments that prohibit it must use their approved signing and execution process.

## Recommended one-command capture

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1
```

The default flow:

1. Validates the complete kit before executing its collector or VSIX.
2. Uses the launcher directory as the monitored workspace.
3. Chooses the external private evidence root.
4. Applies safe worktree-local Git exclusions when possible.
5. Prints the snapshot and second-window warnings.
6. Installs the bundled production VSIX into unique isolated user-data and extensions directories.
7. Launches a distinct VS Code process with loopback CDP.
8. Keeps the collector in the foreground for the full capture.
9. Prints `MONITORING ACTIVE` only after it identifies the run by collector PID and process creation time.

Do not start the diagnostic ZooCode task in the first window. Configure or sign in to ZooCode if needed in the new isolated window, then start the task there. Normal settings, credentials, secrets, history, MCP configuration, and extension inventory are not copied into the isolated profile.

## Status, snapshot, and stop

Run these from another terminal beside the same launcher.

Status:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Status
```

Manual snapshot, with required explicit privacy acknowledgment:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -Action Snapshot `
  -AcknowledgeSnapshotPrivacyRisk
```

When sanitized target identity is ambiguous, select its displayed ordinal:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -Action Snapshot `
  -TargetOrdinal 2 `
  -AcknowledgeSnapshotPrivacyRisk
```

Graceful stop:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 -Action Stop
```

An explicit stop can request snapshot abort rather than the default bounded wait:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -Action Stop `
  -SnapshotPolicy Abort
```

You may instead press Ctrl+C once in the original foreground console. A second Ctrl+C retains the collector's immediate-interruption semantics. Dedicated cleanup targets only the exact collector and isolated VS Code child process trees; it never kills every process by image name.

## Common Start overrides

Explicit workspace, private output, stable VS Code, Node, and known CDP port:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ZooCodeGrayScreenCapture.ps1 `
  -WorkspacePath 'C:\Work\XXX_REPO' `
  -OutputPath 'D:\PrivateDiagnostics\ZooCode' `
  -CodePath "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" `
  -NodePath 'C:\Program Files\nodejs\node.exe' `
  -CdpPort 9333
```

Ordinary VS Code arguments can be repeated through `-CodeArgument`. Debugging, profile, extension, JavaScript-inspector, and proxy flags are protected and rejected because the harness owns them.

`-ProfileMode Normal` is an expert escape hatch, not the portable default. It requires `-AcknowledgeProfileReuseRisk`, an explicit unused CDP port, an external PowerShell console, every VS Code process closed, and the matching ZooCode ID/version already installed in the normal profile. Matching version text does not prove byte-for-byte package provenance. Use isolated mode for exact bundled-VSIX provenance.

## Maintainer packaging

The maintainer command is independent of the caller's current directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\portable-gray-screen-kit\Build-PortableGrayScreenKit.ps1
```

The repository's pinned dependencies must already be installed. A default build:

- resolves the repository from the packager location;
- requires a clean Git worktree;
- discovers Node 22+ and a concrete stable `Code.exe` for generated-kit validation;
- runs the existing root `pnpm vsix` task;
- locates the exact versioned VSIX from `src/package.json` metadata;
- inspects the VSIX ZIP for safe unique paths, exact identity/version/engine/main metadata, production extension output, and webview assets;
- copies only the collector entry and top-level runtime `.mjs` modules, excluding tests;
- copies the VSIX, license, and this offline documentation;
- writes a sorted compact UTF-8 manifest with exact payload sizes and SHA-256 hashes;
- stamps the manifest hash into a copied launcher exactly once;
- runs generated-launcher validation and bundled collector help outside the source tree;
- creates a sorted deterministic one-root ZIP with a fixed timestamp;
- reopens, hashes, extracts, and validates that ZIP from a path containing spaces and Unicode; and
- promotes outputs only after all checks pass.

Default generated paths are ignored under:

```text
bin\portable-gray-screen-kit\
  ZooCodeGrayScreenCapture-<version>-kit1\
  ZooCodeGrayScreenCapture-<version>-kit1.zip
```

Maintenance switches:

- `-OutputRoot <path>` selects another local fixed build destination.
- `-SkipVsixBuild -VsixPath <path>` inspects and packages an already-built or deterministic fixture VSIX.
- `-AllowDirtySource` permits a private build and marks `source.dirty` in the manifest.
- `-SourceDateEpoch <seconds>` selects a reproducible ZIP timestamp; otherwise `SOURCE_DATE_EPOCH` or the source commit time is used.
- `-Force` atomically replaces only the exact same versioned output after a fresh staged build validates completely.

The packager does not modify package manifests, lockfiles, product source, changelogs, changesets, ignore files, Git index state, or commits. Generated kits, VSIX files, ZIPs, manifests, evidence, profiles, and test repositories must not be committed.

## Integrity boundary

The launcher binds to the exact adjacent manifest, and the manifest binds to every bundle payload by normalized path, byte count, and SHA-256. Validation rejects missing, extra, changed, unsafe, reparse, duplicate, and case-colliding files. This detects corruption, partial copies, and launcher/bundle mismatch.

These checks do **not** authenticate a maliciously replaced launcher and bundle. Publisher authenticity requires a separately trusted signature or distribution channel.

## Interpretation and limits

- The collector records evidence; it does not determine a root cause on its own.
- The first VS Code window and tasks started there are outside CDP monitoring.
- A renderer already unable to service CDP may not produce a heap snapshot.
- Browser-selected CDP port support varies by Electron build; pass a known unused `-CdpPort` if automatic discovery fails closed.
- The temporary isolated profile is operational state, not evidence, and is removed after graceful dedicated shutdown.
- Protect the final evidence run directory, especially any `.heapsnapshot` files, as highly sensitive data.
