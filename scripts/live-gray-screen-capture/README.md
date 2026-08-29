# ZooCode live gray-screen capture — standalone MVP

This dependency-minimal Node 22 harness captures privacy-reduced scalar evidence from a live VS Code/ZooCode run. It can distinguish evidence patterns for renderer V8 heap pressure, suspected main-thread blocking, process/native pressure, process exits, CDP loss, navigation/reload, target crashes, and failed or malformed heap snapshots. It records evidence; it does not diagnose a root cause by itself and does not fix or reload ZooCode.

## Prerequisites

- Windows 11 and Node 22 (the repository pins Node 22 in its root manifest).
- PowerShell 5.1 or later with CIM access for process sampling.
- For renderer metrics and snapshots: a VS Code instance launched with loopback remote debugging.
- Write access to the output directory. The default is `plans\diagnostics`.
- Use a private local fixed drive. Network output, reparse-point traversal, and non-loopback CDP are intentionally rejected.

Startup fails with `UNSUPPORTED_RUNTIME` on Node versions before 22 or when the built-in WebSocket implementation is unavailable. The harness does not fall back to an unpinned package or browser global.

Run help first:

```powershell
node .\scripts\live-gray-screen-capture.mjs --help
```

## Privacy and snapshot warning

Non-snapshot evidence is strict allowlist-only. The harness does **not** retain target URL/title, query strings, console arguments, exception text or stacks, DOM text, source, filenames, workspace/profile paths, process command lines, prompts, transcripts, tool arguments, request bodies, clipboard data, environment dumps, or content-derived hashes.

A V8 heap snapshot is different: it can contain private transcript content, source, paths, credentials, or other in-memory values. Snapshots are marked `privateArtifact: true`, never uploaded, written directly to a temporary file, and promoted only after whole-file validation. Protect and delete them according to your local data-handling policy.

Snapshot capture pauses and perturbs the renderer and can increase memory pressure. Automatic snapshots are disabled by default. Manual snapshots require the explicit `--acknowledge-manual-snapshot-risk` flag.

## Recommended isolated launch

The isolated mode avoids VS Code's normal single-instance/profile routing. Supply either an extension development path or a VSIX. The script safely discovers common VS Code install paths when `--code` is omitted; use `--code` when discovery is unsuitable.

```powershell
$Code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
$Output = Join-Path $PWD 'plans\diagnostics'
$Extension = Join-Path $PWD 'src'

node .\scripts\live-gray-screen-capture.mjs launch `
  --code $Code `
  --workspace $PWD.Path `
  --extension-development-path $Extension `
  --output $Output `
  --enable-transport-diagnostics `
  --enable-partial-coalescing
```

`$Extension` must point at the locally built ZooCode extension host project (the repository's `src` directory), not an installed Marketplace build. Build the extension first using the repository's normal development workflow. The two optional transport flags are applied only to the launched child process. They do not change machine/user environment variables. The child receives a minimal environment that excludes proxy variables and Node/Electron injection variables. In standalone Phase 1, the existing extension-host diagnostic snapshot remains internal and is not exported by this harness.

Pass additional VS Code arguments after `--`; they are operational inputs and are never retained:

```powershell
node .\scripts\live-gray-screen-capture.mjs launch `
  --code $Code `
  --extension-development-path $Extension `
  --output $Output `
  -- --new-window
```

Preview the sanitized plan without launching VS Code:

```powershell
node .\scripts\live-gray-screen-capture.mjs launch `
  --code $Code `
  --extension-development-path $Extension `
  --output $Output `
  --dry-run
```

### Runtime flag caveat

VS Code/Electron builds vary in their support for browser-selected remote-debugging ports. The harness first uses the isolated profile's `DevToolsActivePort` advertisement. If that runtime does not produce it, launch fails closed; retry with a known unused loopback port such as `--cdp-port 9333`. The harness never broadens the listener to a non-loopback address.

## Attach to an existing loopback CDP endpoint

The target VS Code instance must already have been launched with remote debugging bound to loopback. An ordinary running instance cannot be upgraded retroactively.

```powershell
$Output = Join-Path $PWD 'plans\diagnostics'

node .\scripts\live-gray-screen-capture.mjs attach `
  --cdp-port 9333 `
  --output $Output
```

Equivalent explicit endpoint form:

```powershell
node .\scripts\live-gray-screen-capture.mjs attach `
  --cdp-endpoint 'http://127.0.0.1:9333/' `
  --expected-root-pid 12345 `
  --output $Output
```

Only literal `127.0.0.0/8` or `::1` hosts are accepted. Credentials, URL queries/fragments, redirects, mismatched advertised WebSocket endpoints, and remote hosts are rejected.

## Process-only fallback

Process-only mode remains useful when CDP is absent or renderer JavaScript hangs. It captures the root and descendant PIDs, parent PIDs, process creation epochs, role confidence, Windows working set, private bytes, paged bytes, CPU time, thread/handle counts, disappearance, and available physical memory.

Select the intended VS Code root explicitly:

```powershell
$RootPid = Get-Process Code |
  Sort-Object StartTime -Descending |
  Select-Object -First 1 -ExpandProperty Id
$Output = Join-Path $PWD 'plans\diagnostics'

node .\scripts\live-gray-screen-capture.mjs process `
  --pid $RootPid `
  --output $Output
```

To prevent even transient command-line role inspection, add `--no-command-line-role-probe`. Raw command lines never leave the constant PowerShell projection and are never retained. Process-only mode does not claim JavaScript heap, heartbeat, target, navigation, or snapshot capability.

## Manual snapshot

The capture process prints only the generated run-directory name, not its absolute path. Join that name to the output root:

```powershell
$Output = Join-Path $PWD 'plans\diagnostics'
$Run = Join-Path $Output 'run-20260828T180000Z-exampleidexampleid12'

node .\scripts\live-gray-screen-capture.mjs snapshot `
  --run-dir $Run `
  --reason manual `
  --acknowledge-manual-snapshot-risk
```

When multiple structural ZooCode candidates exist, select the run-local sanitized ordinal:

```powershell
node .\scripts\live-gray-screen-capture.mjs snapshot `
  --run-dir $Run `
  --reason manual `
  --target-ordinal 2 `
  --acknowledge-manual-snapshot-risk
```

Manual requests bypass only the heap-ratio threshold. Target availability, one-at-a-time lock, snapshot count, disk reserve, physical-memory reserve, V8 headroom, and cooldown remain enforced. `--override-cooldown` bypasses only cooldown. `--allow-unresponsive-attempt` permits a best-effort request after heartbeat loss but does not bypass resource gates.

To opt into conservative automatic pre-cliff snapshots:

```powershell
node .\scripts\live-gray-screen-capture.mjs launch `
  --code $Code `
  --extension-development-path $Extension `
  --output $Output `
  --enable-auto-snapshot `
  --heap-critical-ratio 0.82 `
  --auto-snapshot-samples 3
```

## Graceful stop

```powershell
node .\scripts\live-gray-screen-capture.mjs stop `
  --run-dir $Run `
  --snapshot-policy wait
```

`wait` permits an active snapshot up to the bounded wait; `abort` requests stop without waiting. Control uses per-run files and an ephemeral token under the current user's temporary directory; there is no persistent daemon or network control service. Attach/process mode leaves the observed VS Code instance running. Dedicated launch terminates its isolated child after evidence is durable.

Ctrl+C follows the same graceful finalization path. A second Ctrl+C exits immediately; recovery can finalize a stale partial manifest, while a partial snapshot remains a `.tmp` file and is never promoted.

## Validate an existing snapshot

```powershell
$Snapshot = Join-Path $PWD 'plans\diagnostics\run-example\snapshots\snapshot-20260828T180000Z-001.heapsnapshot'
$ValidationOutput = Join-Path $PWD 'plans\diagnostics\snapshot-validation'

node .\scripts\live-gray-screen-capture.mjs validate `
  --file $Snapshot `
  --output $ValidationOutput
```

Validation streams the file with fixed-size buffers and never calls `JSON.parse` on the complete snapshot. It requires:

1. a nonzero regular file and valid UTF-8;
2. a complete JSON object with bounded nesting and clean EOF;
3. V8 `snapshot.meta.node_fields`, `node_types`, `edge_fields`, and `edge_types`;
4. positive integer `node_count` and `edge_count`;
5. numeric top-level `nodes` and `edges` arrays;
6. exact `nodes.length === node_count * node_fields.length`;
7. exact `edges.length === edge_count * edge_fields.length`; and
8. a complete-file SHA-256 integrity checksum.

JSON validation also rejects malformed UTF-8 and unpaired Unicode surrogate escapes, including pairs split across read buffers.

The command prints only the generated validation result filename. Join it to `$ValidationOutput` to open the scalar result manifest; absolute input and output paths are not printed.

The validation result never records the input path. A zero-byte file returns an `invalid` result with code `zeroByteFile` and exit code 5.

## Output interpretation

Each capture creates:

```text
run-<utc>-<random>/
  manifest.partial.json       # active only
  manifest.json               # terminal authoritative manifest
  summary.json
  events/events-*.ndjson
  metrics/renderer-*.ndjson
  metrics/processes-*.ndjson
  provenance/{processes,targets,capabilities}.json
  snapshots/*.heapsnapshot    # private; only fully validated files
  snapshots/*.json            # integrity/schema sidecars
  failures/snapshot-*.json    # scalar, privacy-safe failures
```

Every NDJSON record contains UTC and monotonic timestamps, a strictly increasing sequence, generated epochs, a capability state, and exact allowlisted data. `unavailable` means unknown/unsupported; it is never replaced by numeric zero.

Evidence interpretation examples:

- Heap ratio rising toward the limit with process memory growth supports V8 pressure evidence; it does not prove OOM.
- Process memory rising while JS heap remains flat supports native/embedder/process pressure evidence.
- A stationary timer heartbeat for the configured failure interval while the renderer process exists produces `rendererBlockedSuspected`.
- `targetCrashed`, target destruction, renderer process exit, browser exit, CDP close/detach, and navigation/context replacement remain distinct events.
- LongTask counters describe browser-reported tasks where supported; hidden animation frames are not treated as timer-heartbeat failure.
- Final `classification` is an evidence combination and deliberately remains `unknown` when signals are insufficient or contradictory.

## Troubleshooting

### CDP endpoint unavailable

- Confirm the target was launched with `--remote-debugging-address=127.0.0.1` and a known `--remote-debugging-port`.
- Prefer isolated `launch`; ordinary already-running VS Code instances are generally not retroactively attachable.
- Do not use `localhost`, a hostname, or a remote interface; the harness requires a literal loopback address.

### No unique ZooCode target

- Keep capture running: process and candidate metrics remain useful.
- Inspect only the sanitized target ordinals/probe booleans in `provenance\targets.json`.
- Supply `--target-ordinal` for a manual snapshot. Automatic snapshots remain disabled under ambiguity.

### Process metrics unavailable

- Confirm PowerShell/CIM access and that the PID still exists.
- Access-denied or missing counters are recorded as unavailable, not zero.
- Three consecutive bounded PowerShell failures mark the sampler degraded but do not imply renderer hang.

### Snapshot rejected

Read the scalar file in `failures\`. Common codes identify target ambiguity, cooldown, disk reserve, physical-memory reserve, V8 headroom, count limit, or concurrent activity. No incomplete bytes are retained after a handled failure.

### Snapshot capture stalls

An already-hung renderer may not answer CDP. First-chunk, inactivity, and absolute deadlines fail without promoting the temporary file. Process sampling continues independently.

## Known Phase 1 limits

- No optional in-extension exporter is implemented, so exact extension-host identity, transport queue snapshots, receipt-to-commit/paint metrics, React Profiler summaries, and exact package/build provenance are unavailable.
- Target-to-process PID mapping can remain ambiguous across Electron versions.
- V8 snapshots do not include all Blink, compositor, decoded-image, GPU, or native allocations.
- A timer heartbeat proves some main-thread progress, not a correct visible frame.
- GPU/process replacement is correlation, not causation.
- Windows fsync and same-volume rename are used, but sudden power loss has weaker directory-entry guarantees than some POSIX filesystems.
- Node's built-in WebSocket implementation enforces protocol framing and the harness rejects assembled messages above 32 MiB, but transport-internal allocation can occur before JavaScript receives and measures a message. CDP event work is additionally bounded by count and retained message bytes.
