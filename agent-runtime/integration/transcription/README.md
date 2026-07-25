# Managed transcription integration

This package is the headless transcription adapter between durable managed jobs and the
authoritative editor Core. It does not publish editor state itself.

## Runtime construction

The runtime owner creates one endpoint authority, one credential authority, one private
`FilesystemManagedTranscriptionCas`, and one injected `CoreTranscriptionPublisher`. It then calls
`await cas.initialize()`, followed by
`registerManagedTranscriptionJobHandlers(scheduler, dependencies)` **before**
`scheduler.recover(projectIds)`. Both registered job kinds share the module-level
`managedTranscriptionGlobalSemaphore`, so editorial and subtitle provider work has a combined
concurrency of one.

`managed-local-endpoint` without an `endpointCapabilityId` mints a process-local capability for
`DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT`. That constant is also the editor preference default,
so the tool-only runtime cannot drift to a different Lazy Whisper port. The URL is never copied
into a job, checkpoint, result, receipt, event, artifact, or terminal proposal.

Browser-local transcription is rejected in this headless runtime. It must not be relabelled as
managed until a bounded managed browser worker exists.

## Canonical tool start seam

`createManagedTranscriptionIntegration()` is the installable seam for the canonical
`waptions_transcription_start` handler. Runtime composition supplies its `handler` as the
delegated tool implementation and calls `bundle.install(scheduler)` from the existing
`registerJobHandlers` construction hook, before `scheduler.recover(projectIds)`.

The mapper accepts only the already schema-validated canonical request and independently checks
its relevant closed fields. It maps `editorial`/`subtitle` to the durable job kinds, preserves
normalized language and diarization mode, and groups half-open `startSample16k`/`endSample16k`
ranges by Core-authorized source. With no ranges it requests the full canonical 16 kHz duration
of every authorized source. Model overrides and browser-local execution are rejected because the
headless worker has one fixed editorial provider contract.

Composition must provide these narrow authorities:

- **Core start planner**: authorizes canonical target IDs and returns only the immutable source
  ID, fingerprint, and canonical sample count. It owns target/source relationship checks.
- **Coordinator enqueue boundary**: the existing receipt-first `enqueueJob` boundary owns state
  guards, the durable idempotency receipt, job/event WAL writes, and recovery. The mapper does
  not create a second receipt store.
- **Media and freshness ports**: `ManagedRetainedTranscriptionSourcePort` and
  `ManagedTranscriptionFreshnessPort` provide retained verified reads and stale-state guards.
- **CAS and publication ports**: `ManagedTranscriptionCasPort` and
  `CoreTranscriptionPublisher` preserve the private transcript/Coverage CAS and final Core
  publication transaction.
- **Endpoint and credential authorities**: process-local endpoint and credential capability
  authorities plus an optional configuration resolver. Raw URLs and secrets never cross the
  durable mapper result.

For `managed-local-endpoint`, the durable input deliberately carries only
`{ kind: 'managed-local-endpoint' }`. The worker mints the exact default
`http://localhost:43556/v1/audio/transcriptions` capability while it runs, so recovery can mint
a fresh local capability without storing the URL. A supplied local credential is converted to an
opaque in-memory credential capability; it cannot be recovered after a process restart and fails
closed as `CAPABILITY_EXPIRED` rather than persisting a secret. `openai-compatible` configuration
is likewise read in memory, immediately converted to opaque capability IDs, and never written to
jobs, checkpoints, receipts, events, artifacts, or WAL values.

## Core and coordinator seam

`CoreTranscriptionPublisher` deliberately has two independent methods:

- `prepareEditorialPublication`
- `prepareSubtitlePublication`

Each method consumes descriptor-only source results. The Core adapter receives the CAS reader
separately and may hydrate `ManagedTranscriptManifestV1` plus `iterateMergedWords()` while
preparing its authoritative publication. The manifest is a detached, content-addressed stream
descriptor; no full transcript body is placed in the handler result.

The returned `PreparedManagedCommitCapability` is process-local. The handler evaluates and seals
its bounded descriptor-only write set exactly once; the coordinator later consumes that immutable
snapshot at its transaction boundary. The job handler returns a
`ManagedTranscriptionTerminalPublication` containing:

- one prepared Core capability;
- one prepared coverage compare-and-swap capability per source;
- opaque record and source IDs only.

The owning coordinator must extend its terminal job path as follows:

1. Accept a transcription-only terminal publication even when there are no ordinary artifacts.
2. Under the project's existing serialized transaction owner, recheck every coverage capability's
   exact sorted `expectedCoverageRecordIds`. A conflict must requeue/replan up to the bounded job
   policy; it must not partially commit another source.
3. Combine `managedTranscriptionTerminalWrites(publication)` with the authoritative Core writes,
   coverage heads, pins, terminal job record, and canonical events in one WAL transaction.
4. Call `acceptManagedTranscriptionTerminalPublication()` only after the store commit marker is
   durable.
5. On cancellation, stale state, conflict, or transaction failure, call
   `rejectManagedTranscriptionTerminalPublication()`.

The authoritative Core source commit exposes `EditorPersistenceCommit.transcriptionPublication`
and `EditorTranscriptionPublicationCommitV1`. The central adapter must preserve that typed intent:
editorial record bodies are promoted only into the private transcript repository, while the
editor snapshot/history/pins/event/receipt and the coverage-head CAS share the same terminal WAL
transaction. A Core `StaleTranscriptionPublicationError` maps to the same non-cancelled stale path
as `ManagedTranscriptionStaleError`; it must never be flattened into a generic failure.

The current base `DurableJobScheduler` validates only artifact/output publications and its generic
rejection path does not know about transcription capabilities. The coordinator integration must
add this narrow branch; the handler intentionally does not perform a second publication.

Source, document, or target drift is represented by `ManagedTranscriptionStaleError`, which maps
to a stable non-`AbortError` runtime conflict. The scheduler/coordinator adapter must project that
typed error to its public `stale` terminal state (and preserve its `SOURCE_CHANGED` or
`REVISION_CONFLICT` code); it must not enter the generic `AbortError`/cancelled branch. Only the
job's own `AbortSignal` becomes cancelled.

## Storage and memory boundaries

Endpoint URLs and credentials live only in process-local authorities and expire. Local endpoint
capabilities require exact `http://localhost:<explicit-port>/v1/audio/transcriptions`, reject
userinfo/query/fragment/redirects, and pin one loopback address in Undici. General server
capabilities retain the existing production HTTPS allowlist and DNS pinning policy.

The retained source adapter wraps an already-open verified handle and exposes a path-free
`MediaByteSource`; it never reopens by path. The PCM decoder uses a fixed native ring and the
canonical source-zero 16 kHz phase. It never allocates a complete 44.1/48 kHz window.

The decoder and provider share one 8 MiB `MediaBudgetManager`. Reservations conservatively cover
both 512 KiB Mediabunny workers, two cache extents and their staging overlap, decoded samples,
ring/coefficient/mix scratch, two overlapping WAV copies, and a thirty-two-times response
allowance for stream bytes, UTF-16 text, parsed provider objects, canonical parser working data,
and the one-window projection. Individual retained-source reads are therefore capped at 512 KiB
rather than inheriting the general byte-source 8 MiB maximum.

Transcript chunks and merged word streams live in a private immutable CAS, not in durable job or
artifact namespaces. The external-memory merger loads one at-most-30-second chunk at a time,
performs bounded fan-in merge runs, reconciles overlap/diarization evidence, and streams the final
content-addressed NDJSON. Recovery verifies every referenced digest before reuse.
