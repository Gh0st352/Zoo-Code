# Transcript transport: ownership and bounded verification

Run the focused checker with **pnpm transcript-transport:model-check**. It also runs as the seventh independent submodel in **pnpm lifecycle:model-check**, wired in [package.json](../../package.json). It does not change persisted task lifecycle reducers or workflow files.

## Production boundary

[TranscriptTransport](../../src/core/webview/transcriptTransport.ts) owns generation, task-scoped sequence allocation, explicit FIFO job descriptors, snapshot progress, and one physical-send barrier. [ClineProvider](../../src/core/webview/ClineProvider.ts) supplies current focus and the webview post callback. The provider's append/update/snapshot signatures and legacy CLI branches are unchanged. Resync additionally accepts optional client sequence diagnostics for metadata-only logging; they never select or modify the authoritative snapshot revision.

The driver and the explorer both call [reduceTranscriptTransport](../../src/core/webview/transcriptTransport.ts) for admission, allocation, invalidation, task-sequence pruning, send initiation, and settlement. They also share the production frame-to-message conversion. This is not a separate queue specification that only resembles production.

Payloads and caller resolvers live in driver-owned maps, outside the pure state. Invalidation synchronously removes all waiting jobs and their payload references, releases the active snapshot's unsent suffix, and resolves discarded waiting callers. There is no retained chain of old-generation closures. A physical post already invoked remains the sole in-flight owner until its Promise settles; its caller settles at that boundary. New-generation jobs may queue but cannot send until that barrier is released. Every later snapshot start, chunk, or end initiation rechecks generation and current focus. Rejection terminates that job, rejects its caller, logs the failure, and permits the next job to run.

The driver intentionally **deep-clones at enqueue time**. Tasks mutate message objects and nested arrays while a post is waiting; shallow copying or cloning at drain time would pair an earlier sequence with later content. A stale-generation guard runs before cloning and before allocating either a sequence or snapshot ID. A second admission check protects the captured payload's ownership.

The provider tests in [ClineProvider.spec.ts](../../src/core/webview/__tests__/ClineProvider.spec.ts) hold real post callbacks rather than injecting a private Promise queue. They retain focus-only and generation-only cancellation, CLI behavior, snapshot/delta ordering, deep snapshot isolation, and exact-boundary checks. The queued append/update regression mutates nested image arrays. The 401-message regression compares all three chunks to the exact corresponding original slices. Repeated-resync tests retain a held start or chunk, discard 26 waiting jobs, assert immediate payload/caller release, and prove one physical send and no stale end.

## Exhaustive bounded state space

The [explorer](../../src/core/webview/__tests__/transcriptTransport.model.ts) uses deterministic breadth-first search with canonical state deduplication. It explores every enabled ordering in four bounded scenarios; this is not randomized scheduling or a hand-selected trace list. A producer and controller retain their own program order, while admission, send initiation, send success/failure, focus change, and invalidation may interleave at every enabled boundary.

| Scenario                          | Producer order             | Controller order                          | Reachable states | Transitions | Maximum shortest depth |
| --------------------------------- | -------------------------- | ----------------------------------------- | ---------------: | ----------: | ---------------------: |
| Queued deltas / repeated resync   | snapshot, append, update   | resync, resync                            |           13,292 |      19,281 |                     33 |
| Task switch / clear               | snapshot, append, snapshot | switch to second task, clear              |            7,523 |      10,334 |                     33 |
| Invalidation / recovery           | snapshot, update, snapshot | invalidate, resync                        |            6,030 |       8,149 |                     31 |
| Focus before sync / stale request | snapshot, append, update   | focus second task, resync, stale snapshot |            5,746 |      10,330 |                     24 |

These totals are diagnostics, not hard-coded ratchets: 32,591 states across independently explored scenarios and 48,094 examined transitions. Bounds are **two task IDs plus no task, up to five admitted jobs, two invalidations, four messages per snapshot, chunk size two, and at most one failed physical send per trace**. Standalone producer snapshots bump the sequence; resync snapshots retain the current sequence. Empty, exact-boundary, and multi-chunk snapshots arise within the bounds. Production uses chunk size 200; the provider regression checks 401 messages at the real chunk size.

Each scenario has a **30,000-state budget and depth limit 40**. The checker fails on the first unseen successor beyond either bound, missing required action/landmark coverage, or any invariant violation. There is no truncated success. Every failure reports its scenario, bounds, shortest action trace, intermediate states, and the violating state. Mutants select the shortest witness across all four scenario graphs with stable tie ordering.

The model exposes a scheduling point between settlement and the next pump, and between enqueue and pump. The production driver performs these synchronously within its continuation. This is a conservative scheduling over-approximation, not a claim that every model event boundary corresponds to an independently schedulable JavaScript callback.

## Invariants and scope

1. Generation increases exactly once per invalidation and never otherwise. Stale-generation admission allocates no job or snapshot ID.
2. No physical send overlaps another, including an old generation's held send. No old-generation or old-focus post/commit is **initiated** after ownership changes.
3. Invalidation retains no obsolete queue or payload. Discarded waiting callers settle immediately. Each settlement must consume a registered caller exactly once. Remaining payloads correspond exactly to active/queued jobs; remaining callers correspond exactly to those jobs plus an already-initiated physical send.
4. Allocated sequences follow enqueue/capture order: deltas and bumping snapshots increment; resync retains the current value. Sent sequence is nondecreasing and never exceeds allocation. Failed snapshots never resume their suffix.
5. The independent receiver oracle stages contiguous, exact snapshot payloads and exposes them only at a matching complete end marker. Start/chunks cannot change visible transcript or applied sequence. Applied sequence cannot decrease within one focused-task scope.
6. Job totals equal captured payload lengths. Only snapshots carry snapshot identities, unique across captures. Non-chunk frame ranges are zero; chunk descriptors have contiguous starts and positive, exact lengths bounded by the captured payload and chunk size. These checks precede wire conversion, whose array slicing can otherwise hide an overlarge final count.

Sequence monotonicity is **not global across task IDs or removed/recreated task lifetimes**. The production provider prunes a task's sequence on stack removal/history deletion; the model exercises the shared pruning action on switch/clear and tags its allocation/sent oracle with a task-lifetime epoch. A no-task snapshot has sequence zero. Receiver applied sequence resets on focus change/clear, as distinct from resync of the same task. The checker does not invent a persisted generation token or silently demand globally increasing sequences after clear.

All 16 action classes are required: snapshot, append, update, resync, invalidate, switch, clear, focus, stale-snapshot, pump, start, chunk, end, settle, fail, discard. All 14 named reachability landmarks are required:

- held-post-with-queued-delta;
- repeated-invalidation-while-held;
- cancelled-active-suffix-released;
- new-generation-waits-for-old-send;
- stale-physical-completion;
- already-initiated-stale-end-can-complete;
- task-switch-with-held-send;
- focus-changed-before-invalidation;
- clear-prunes-task-sequences;
- empty-snapshot-committed;
- multi-chunk-snapshot-committed;
- failed-post-with-queued-recovery;
- snapshot-recovery-after-failure;
- delta-applied-after-snapshot.

## Invariant sensitivity

Twelve test-only reducer wrappers must produce their expected violation class through the same exhaustive explorer. No mutation switch exists in production.

| Mutant                              | Shortest witness, excluding initial state | Detected violation                |
| ----------------------------------- | ----------------------------------------- | --------------------------------- |
| stale-completion-starts-end         | snapshot, pump, resync, settle            | stale commit initiation           |
| admit-stale-generation              | focus, resync, stale-snapshot             | obsolete admission allocates work |
| ignore-focus-at-post                | snapshot, focus, pump                     | stale-focus initiation            |
| legacy-generation-only-invalidation | snapshot, resync                          | retained obsolete jobs/payloads   |
| reset-promise-barrier               | snapshot, pump, resync, pump              | overlapping physical sends        |
| commit-before-chunks                | snapshot, pump, settle, pump, settle      | incomplete atomic snapshot        |
| reuse-delta-sequence                | snapshot, append                          | incorrect allocated sequence      |
| continue-after-rejection            | snapshot, pump, fail, pump                | failed snapshot resumes posting   |
| delta-snapshot-metadata             | snapshot, append                          | delta carries snapshot metadata   |
| non-chunk-payload-range             | snapshot, pump                            | non-chunk payload range           |
| overrun-final-chunk                 | switch, pump, settle, pump                | chunk exceeds captured range      |
| settle-caller-twice                 | snapshot, resync                          | settlement without owned caller   |

[transcriptTransport.spec.ts](../../src/core/webview/__tests__/transcriptTransport.spec.ts) runs the full checker, verifies deterministic shortest witnesses and both fail-closed budget paths, and exercises the actual driver with held/rejected start, chunk, end, and delta sends, plus synchronous rejection/recovery. The [CLI entry point](../../scripts/check-transcript-transport.ts) prints counts, action/landmark names, bounds, and mutant traces.

Focused reducer tests also check canonical descriptors for empty, exact-boundary, and partial-final chunks independently of wire output. Adversarial queued/active states retain obsolete-generation work with unchanged focus to verify the defense-in-depth pre-send guard discards it and permits current work. Such states are deliberately **not claimed reachable** through normal invalidation, which releases that work; no artificial action is added to the reachable-state explorer. A driver regression retains one held caller through two invalidations and checks both successful and failed settlement followed by recovery.

## Limitations: initiation is not delivery revocation

An active physical send cannot be unsent. In particular, **an end marker initiated before invalidation may complete afterward and publish its already-complete snapshot on the same focused task**. The generation is provider-local, not a wire field. The named stale-end-completion landmark deliberately requires this permitted behavior; the stale-completion-starts-end mutant forbids the materially different bug of initiating a new old-generation end after invalidation. The single physical barrier ensures a newer transcript's posts cannot overtake the held old one.

The receiver is an independent protocol oracle, not the React reducer. It assumes ordered, lossless successful physical delivery at settlement and no delivery for a modeled rejection; a real post can deliver before its Promise settles. It deliberately cannot prove browser timer behavior, dropped/delayed messages, resync retry diagnostics, rendering, or restart behavior. Existing UI tests own those concerns. The provider's post wrapper swallows disposed-view failures and ignores the editor's boolean delivery result; model rejection covers errors reaching the transport callback, **not delivery acknowledgement**.

Metadata state posts are outside this transcript FIFO, and a task may become focused before its asynchronous metadata synchronization completes. The focus-before-sync scenario checks the transcript's live-focus guard, not the metadata channel. There is no fairness/liveness claim: a permanently held physical post permanently blocks later physical transcript posts, although obsolete waiting jobs are still released on invalidation. Memory claims concern removal of owned references, not immediate garbage collection or memory retained by the editor's already-initiated post.

This bounded check does not prove arbitrary queue lengths, sequence overflow, arbitrary repeated task-ID reuse, message validation, or all payload values. Driver/provider regressions cover concrete deep-clone behavior and runtime correspondence; the model independently checks ordering and ownership. No persisted lifecycle state is needed for these safety properties, so composition remains at the aggregate command boundary.
