# Editor Engine Architecture

## Status and scope

This document freezes the Phase 2 boundary for the instance-scoped
`EditorEngine`. It describes the public types currently exported from
`src/lib/editor-engine`, the durability and recovery obligations imposed on
adapters, and the differences that still exist between the approved
architecture and the implementation.

The engine is a browser-independent, per-project semantic editing core. Its
durable graph is an `EditorManifestV4`, not an `EditorDocumentV4`: the latter
contains runtime `File` values and transient selection. The engine must not
import Zustand stores, browser persistence, the project/video store
singletons, filesystem paths, credentials, media bytes, decoded frames, PCM,
or UI state.

Phase 2 covers edits to an already registered V4 graph. Managed sessions,
source registration, import/probe jobs, event retention, path grants, and UI
selection are adapter or coordinator responsibilities.

## Instance ownership and public interface

Every open project receives one engine instance. An instance owns its detached
manifest, project metadata, semantic history, in-memory plans, revision
counters, listener set, event sequence, mutation queue, and close lifecycle.
None of those values may be shared through module-level mutable state.

The frozen interface is:

```ts
interface EditorEngine {
  getSnapshot(): EditorEngineSnapshot;
  plan(request: EditorCommandBatchRequest): EditorCommandPlan;
  dispatch(request: EditorCommandBatchRequest): Promise<EditorCommandResult>;
  undo(request: HistoryMutationRequest): Promise<EditorCommandResult>;
  redo(request: HistoryMutationRequest): Promise<EditorCommandResult>;
  jumpToHistory(request: HistoryJumpRequest): Promise<EditorCommandResult>;
  subscribe(listener: EditorEngineListener): () => void;
  close(): Promise<void>;
}
```

`getSnapshot()` returns a clone. Callers cannot mutate engine state through a
snapshot. `plan()` is synchronous and cannot perform port I/O. All durable
methods are serialized by the instance queue.

The frozen construction options are:

```ts
interface EditorEngineOptions {
  projectId: string;
  sessionEpoch: string;
  initialManifest: EditorManifestV4;
  initialProjectMetadata?: EditorProjectMetadata;
  initialSessionRevision?: number;
  ports: EditorEnginePorts;
  initialHistory?: EditorHistoryState;
  historySummaryLimit?: number;
  planTtlMs?: number;
  initialEventSequence?: number;
  closePorts?: boolean;
}
```

- `projectId` is the durable receipt and event partition.
- `sessionEpoch` is fixed for the lifetime of the instance. A recovered
  coordinator creates a new engine with its new epoch.
- `initialManifest` must pass structural V4 validation.
- `initialProjectMetadata` currently contains only the project name and remains
  outside the portable manifest.
- `initialSessionRevision` restores the authoritative managed-session counter.
- `initialEventSequence` restores the last committed engine event sequence, so
  the next committed event is contiguous.
- `historySummaryLimit` bounds only the summaries exposed in snapshots. It
  does not change the full internal history budget.
- `planTtlMs` defaults to 15 minutes.
- `closePorts` defaults to `true`. Set it to `false` only when an adapter owns
  shared port lifetimes.

### Initial history

`initialHistory` is the full `EditorHistoryState`, including past and future
entries, forward and inverse serializable patches, transcript pin roots, and
optional before/after project metadata. It is not the bounded summary view
returned by `getSnapshot()`.

```ts
interface EditorHistoryState {
  past: EditorHistoryEntry[];
  future: EditorHistoryEntry[];
}
```

Recovery must load `initialManifest`, `initialHistory`,
`initialSessionRevision`, and `initialEventSequence` from the same recovered
durable head. Supplying independently selected values can cross a history
cursor, revision, pin set, or event boundary.

The constructor validates the combined entry/byte budgets, patch roots and
shape, unique entry IDs, transcript-reference shape, project metadata, and
summary revisions before cloning `initialHistory`. The persistence adapter
must additionally verify that the recovered manifest, history cursor, pins,
receipts, WAL, session revision, and event sequence all came from the same
durable managed head; that cross-file recovery proof is outside one engine
constructor argument.

## Snapshot boundary

`EditorEngineSnapshot` contains:

- `projectId` and project metadata;
- a descriptor-only `EditorManifestV4`;
- session, document, audio-graph, and optional narrative revisions;
- bounded past and future `EditorHistorySummary` values plus the current index;
- source and transcript record IDs referenced by the manifest.

It never contains transcript bodies, `File`, `Blob`, canonical paths, verified
handles, capability tokens, endpoint configuration, credentials, decoder
state, or selection/view state.

The engine snapshot is not a complete managed `StateToken`. The coordinator
adds `sessionId` and the opaque `eventCursor`; the engine currently exposes
only the project identity, epoch, revisions, and its numeric event sequence
through committed events.

## Injected ports

The required and optional ports are frozen as follows:

| Port | Required | Responsibility |
| --- | --- | --- |
| `EditorPersistencePort` | Yes | Receipt lookup and the only atomic mutation commit |
| `EditorAssetRepositoryPort` | Yes | Verify and hydrate only requested registered source descriptors |
| `EditorialTranscriptRepositoryPort` | Yes | Resolve immutable transcript bodies from detached references |
| `EditorClock` | Yes | Provide deterministic ISO and epoch time |
| `EditorIdGenerator` | Yes | Produce stable IDs from kind and deterministic scope |
| `EditorEventSink` | Yes | Deliver an already durable ordered engine event |
| `EditorPlaybackPort` | No | Invalidate or update playback after a durable commit |
| `EditorDiagnosticsPort` | No | Record bounded operational diagnostics |

```ts
interface EditorEnginePorts {
  persistence: EditorPersistencePort;
  assets: EditorAssetRepositoryPort;
  transcripts: EditorialTranscriptRepositoryPort<
    ResolvedEditorialTranscriptMapV1
  >;
  clock: EditorClock;
  ids: EditorIdGenerator;
  events: EditorEventSink;
  playback?: EditorPlaybackPort;
  diagnostics?: EditorDiagnosticsPort;
}
```

Ports are injected per instance. They must not infer project identity from a
global store or process cwd. Deterministic test adapters are part of the
contract because planning and application must resolve the same aliases
without consuming a process-global counter.

`EditorEventSink` and `EditorPlaybackPort` are post-commit notification
surfaces, not durability surfaces. Their failure cannot roll back a successful
commit. Recovery and polling therefore read the event persisted by
`EditorPersistencePort`, not an event sink's delivery history.

## One durable mutation pipeline

`dispatch`, `undo`, `redo`, and `jumpToHistory` must use one transaction
pipeline. They differ only in their detached planner:

- `dispatch` applies a canonical semantic operation batch and dependent-link
  transforms;
- `undo` and `redo` apply inverse or forward semantic patches;
- `jumpToHistory` calculates the required patch movement to the requested
  entry boundary.

The invariant ordering is:

1. Enter the per-instance queue.
2. Parse and bound the request, then compute its canonical request digest.
3. Resolve the durable receipt before checking epoch or revisions.
4. For a never-seen receipt, verify session epoch and expected session,
   document, audio, and narrative revisions.
5. Resolve an in-memory plan or canonicalize inline operations.
6. Clone the current manifest, project metadata, and history into a detached
   proposal.
7. Select and hydrate only source identities and transcript bodies required by
   the proposal.
8. Run the semantic planner, including narrative and dependent-link
   transforms, without publishing intermediate state.
9. Run structural V4 validation and hydrated validation on the complete
   detached proposal.
10. Calculate document, audio-graph, narrative, and session revision effects.
11. Create at most one semantic history transition and derive current,
    history, and redo transcript pins.
12. Build one `EditorPersistenceCommit` containing the WAL metadata, previous
    and next snapshots, full history, pins, event, receipt, and session state.
13. Await `EditorPersistencePort.commit`.
14. Only after commit succeeds, install the new in-memory head and event
    sequence.
15. Publish the snapshot once to listeners and deliver the already durable
    event to the event and playback ports.

Any parse, guard, alias, lock, overlap, source identity, transcript hydration,
planner, validation, or persistence failure leaves the manifest, history,
revisions, event sequence, listeners, and playback projection unchanged.

A semantic no-op returns unchanged revisions, no history entry, and no event.
It still performs one receipt-only `EditorPersistencePort.commit` with
identical previous/next snapshots, unchanged history and session state, and
`event: null`. It does not advance the event sequence or publish to listeners,
the event sink, or playback. This durable receipt rule supersedes the earlier
Phase 2 wording that said no-ops perform no persistence work.

### Detached plans

`plan()` accepts inline operations only. A stored plan is instance-local,
short-lived, and bound to the complete engine revision tuple. Applying it
checks expiration and exact base revisions, then runs the durable pipeline.
Plans are cleared on close and are not recovery state.

Planning performs no port I/O. For operations that do not algorithmically
require transcript bodies, it runs the same semantic planner and dependent-link
transforms against a detached descriptor-only projection, performs structural
V4 validation, and returns exact no-op, alias, affected-ID, history, and
revision effects. Operations that require transcript bodies still receive a
deterministic stored plan, but the result sets `requiresHydration` and defers
body-dependent and immutable-source verification to `dispatch`. Apply always
reruns the proposal through verified source hydration and complete hydrated
validation before the one persistence commit.

Plan/apply aliases use the stored plan request hash as their shared allocation
scope. Applying a plan must return the same aliases that planning exposed.
The engine also freezes the canonical operation scope: `plan` accepts only
`waptions_edit_plan`, `dispatch` accepts only `waptions_edit_apply`, and
Undo/Redo/Jump accept only `waptions_history_apply`. These exact names are the
`toolName` component of durable receipt identity; adapters cannot invent
alternate scopes.

## Atomic persistence contract

`EditorPersistencePort.commit` is the engine's only atomic durability
boundary:

```ts
interface EditorPersistencePort {
  getReceipt(
    projectId: string,
    toolName: string,
    idempotencyKey: string,
  ): Promise<EditorIdempotencyReceipt | null>;

  commit(input: EditorPersistenceCommit): Promise<void>;
  close?(): Promise<void>;
}
```

`EditorPersistenceCommit` schema version 1 carries one recoverable transaction:

| Field | Durable meaning |
| --- | --- |
| `projectId`, `toolName`, `commandId` | Transaction and receipt ownership |
| `transaction.walTransactionId` | Stable WAL transaction identity |
| `transaction.preparedAt` | Injected-clock preparation time |
| `transaction.operationIds` | Semantic operations or one history action |
| `transaction.fromDocumentRevision` / `toDocumentRevision` | Document head transition |
| `sessionState` | Epoch and next session/document/audio/narrative revisions |
| `previous` / `next` | Complete immutable engine snapshots around the transition |
| `history` | Full past/future semantic history after the transition |
| `transcriptPins.durableRecordIds` | Transcript records reachable from the next manifest |
| `transcriptPins.historyRecordIds` | Records retained by Undo history |
| `transcriptPins.redoRecordIds` | Records retained by Redo history |
| `event` | The ordered event made visible by this transaction, or `null` for a durable no-op receipt |
| `receipt` | The durable idempotency receipt in the same transaction |

A managed persistence implementation may use several physical writes, but it
must recover them as one old-or-new unit. It must not expose a new snapshot
with old history or pins, an event without its snapshot, or a mutation without
its receipt. An unresolved WAL transaction also prevents eviction of the
corresponding receipt and transcript roots. A receipt-only no-op commit writes
the WAL/receipt transaction without changing the snapshot, history, pins, or
session state and without appending an engine event.

Returning successfully from `commit` is the commit point. The event sink,
playback port, diagnostics, Zustand projection, autosave indicator, and React
rendering happen later and cannot become additional commit points.

### Standalone compatibility timing

There is no synchronous durable compatibility seam. A standalone adapter sends
the semantic command to `dispatch`, waits for the IndexedDB-backed
`EditorPersistencePort.commit`, and projects the one published engine snapshot
into Zustand only after the promise resolves successfully. Existing
synchronous Zustand method signatures may enqueue that asynchronous work and
return for source compatibility, but they must not optimistically dual-write
the durable manifest. Transient drag previews, selection, playhead, hover, and
layout remain synchronous adapter-owned view state. A failed dispatch leaves
the previous authoritative projection intact and is reported through the
adapter's error channel.

## Durable receipts and validation order

Receipt scope is exactly:

```text
(projectId, toolName, idempotencyKey)
```

It deliberately excludes `sessionEpoch`. The canonical request hash includes
the complete original request, including its epoch and expected revisions.
For every durable mutation:

1. Call `getReceipt` using the epoch-independent scope.
2. If the stored hash matches, return the stored semantic result with
   `replayed: true` and the engine's current snapshot.
3. If the stored hash differs, return `IDEMPOTENCY_KEY_CONFLICT`.
4. Only when no receipt exists, validate the current epoch and revisions.
5. Persist the new receipt in the same `commit` as the mutation.

This order makes an exact lost-response retry replayable after coordinator
recovery even though the new engine has a different epoch. A stale, previously
unseen request still fails the epoch guard.

The receipt stores the semantic result without `snapshot` or `replayed`.
Snapshots are current views and must not be frozen inside a receipt.

The earlier Phase 2 statement that no-ops perform no WAL or persistence work
conflicts with the managed protocol's restart-safe idempotency requirement.
The frozen contract resolves that conflict in favor of a receipt-only commit:
no project state or event changes, but the successful semantic result remains
replayable after recovery.

## Session and event recovery

The coordinator, not the engine, owns the durable event log, opaque cursor,
retention, `session.recovered`, snapshots for reconnect, path/source/job
publication, and the managed `StateToken`.

After recovery it constructs a new engine with:

- the recovered V4 manifest and project metadata;
- the recovered full history;
- the persistent `sessionRevision`;
- the last committed engine event sequence;
- the coordinator's new `sessionEpoch`;
- ports backed by the recovered receipt, transcript, asset, WAL, and event
  stores.

The next engine event uses `initialEventSequence + 1`. Failed commits do not
consume a sequence. The persistence adapter maps committed engine events to
its opaque monotonic cursor. If delivery fails, polling or subscription
recovery replays the committed event from that durable log.

`sessionRevision` is private engine state initialized by
`initialSessionRevision`. Every dispatch/history request supplies it in the
expected-revision guard. A state-changing engine commit increments it once; a
receipt-only no-op leaves it unchanged.

The current engine event union contains only `project.mutated` and
`history.changed`. Session recovery, jobs, artifacts, diagnostics, presence,
views, and source invalidation are coordinator-level events and must not be
fabricated by the Phase 2 engine.

The protocol `StateToken` includes `sessionId` and `eventCursor`, but
`EditorEngineSnapshot` does not. Adapters must assemble that token; the engine
must not invent an opaque cursor from its numeric sequence.

An active engine does not adopt a coordinator-only `sessionRevision` advance
caused by a path grant, source registry, playback authority, job, or artifact
publication. After such a coordinator transaction, the coordinator closes and
reconstructs the engine from the same durable project head with the new
`initialSessionRevision` before accepting another project mutation. This keeps
one session counter without adding a second project planner/publisher or
allowing the coordinator to mutate an active engine behind its back.

## Selective asset and transcript hydration

The manifest remains the durable source of descriptor identity. Hydration
provides temporary planning evidence and never changes source registration.

For assets:

- metadata-only edits do not call `EditorAssetRepositoryPort`;
- clip edits request only the referenced video or audio source IDs;
- render/background changes use descriptor-only validation and do not open sources;
- history movement verifies only sources referenced by changed descriptors,
  clips, or narrative blocks;
- the port returns matching descriptors, a path-free verified handle, and
  bounded file metadata;
- the engine checks descriptor equality, byte length, descriptor fingerprint,
  and a valid streamed content digest before planning;
- untouched sources use descriptor-only synthetic planning records and are not
  opened.

The current V4 hydrated validator accepts `EditorDocumentV4`, so the planner
temporarily projects descriptor metadata into a File-shaped field. No actual
`File` or media bytes cross the engine boundary. This cast is an implementation
bridge, not a durable type contract. A descriptor-native hydrated-manifest
validator should eventually remove it.

For transcripts, `EditorTranscriptReference` is detached and request-side
version-neutral:

```ts
interface EditorTranscriptReference {
  recordId: string;
  descriptorVersion: number;
  sourceId: string;
  descriptor: Readonly<Record<string, unknown>>;
}
```

Transcript bodies are hydrated only into the detached planner context. They
never enter snapshots, patches, events, receipts, or the portable manifest.
History and persistence retain only record IDs and pin sets.

The repository port is generic and its references carry the descriptor version
plus the complete detached descriptor record. A V2 coverage descriptor can
therefore route through the port without an engine cast. V2 points at a merged
canonical transcript body, so the current planner consumes that resolved body
through the existing canonical body-map shape; a future body schema can
specialize the generic port without changing descriptor routing.

Final hydrated validation resolves every transcript record referenced by the
active narrative or dependent links. This deliberately favors fail-closed
publication over opening only the record directly named by one operation.

## Semantic patch history and adapter selection

History stores serializable forward and inverse patches over approved durable
manifest roots. Manifest and audio revision fields are transaction metadata,
not semantic patch roots, and are recalculated monotonically when history is
applied. Project-name history is stored separately as before/after project
metadata.

One compound dispatch creates at most one `EditorHistoryEntry`. A new edit
clears Redo. Undo, Redo, and jump move existing entries between past and future
without creating a second semantic entry. Appending a new entry enforces a
budget of 500 past entries and 32 MiB of encoded past history. Recovered
`initialHistory` and history movement are not independently re-budgeted by the
current implementation.

Each entry has a stable `historyEntryId`, which is returned in command results
and ordered events. This ID is the adapter boundary for transient selection:

- selection, focus, playhead, hover, drag previews, and panel state never enter
  engine patches or the V4 manifest;
- a standalone or managed UI may retain its own selection restoration data
  keyed by `historyEntryId`;
- history events provide both the action and boundary entry ID so the adapter
  can choose its own before/after selection;
- a no-op has no history entry and must not create or restore a durable
  selection snapshot.

The current engine exposes the key but does not define a selection adapter,
selection retention budget, or eviction notification. Those are Phase 3A UI
adapter responsibilities and cannot be inferred from `currentIndex`.

`renderBackgroundColor` is an approved semantic history root, so background
changes undo and redo with the rest of the durable V4 graph.

## Close lifecycle

`close()` is idempotent and returns the same promise to every caller. On the
first call the engine:

1. marks itself as closing and rejects new plans, subscriptions, dispatches,
   and history commands;
2. waits for already queued durable work to finish;
3. clears listeners and in-memory plans;
4. when `closePorts` is true, asks every owned port to close;
5. marks the instance closed.

Closing a view is not project deletion. A coordinator may construct another
engine later from durable recovery state.

Port close failures are observational and do not reopen the engine. The engine
closes owned ports concurrently, absorbs synchronous and asynchronous close
failures, and marks the instance closed exactly once. Diagnostics are
best-effort throughout the lifecycle and are never a durability dependency.

## Path-free media identity and capabilities

`ImmutableMediaIdentityV1` is the portable media identity:

- `contentDigest`, the streamed SHA-256 of the immutable source bytes;
- `descriptorFingerprint`, the portable fingerprint stored by the V4 media
  descriptor;
- `byteLength`, the verified immutable byte length;
- immutable version;
- optional stable stat identity;
- content-addressed stream metadata references.

`contentDigest` and `descriptorFingerprint` are distinct identities with
different purposes. Adapters must calculate, retain, compare, and report them
separately. They must never copy one into the other, derive equality from
matching string shape, or use the descriptor fingerprint as a substitute for
the streamed SHA-256.

It contains no filesystem path. `VerifiedMediaHandleV1` adds opaque handle and
capability IDs plus verification/expiry metadata. The engine can compare this
identity with a manifest descriptor, but it cannot reopen a path or read bytes
through the handle.

Descriptor-only synthetic records used for planning unopened sources are not
content-verification evidence. They must not escape the detached planner or be
persisted as verified media identities.

Output adapters receive `StagedOutputDestinationCapabilityV1`, which contains
an opaque destination/grant/staging identity and one safe output filename
component, not a caller path. `SessionPathGrant.canonicalPath` belongs to the
managed authority/tool layer and must never cross into the engine, portable
manifest, semantic history, or engine event.

Browser `File`, filesystem descriptors, signed localhost range sources, and
memory sources are adapter implementations behind media capabilities. They
are not alternative engine graph types.

## Import, source registration, and provenance boundary

Phase 2 semantic operations may reference only source IDs, transcript record
IDs, and provenance records already present in the manifest/catalogue. The
current operation union has clip insertion and narrative activation, but it
has no media probe, source registration, path grant, bundle import, transcript
body creation, or transcription-job publication operation.

The frozen Phase 2 vocabulary also intentionally has no durable operation for
changing `activeSubtitleTrackId`, moving a subtitle between tracks while
preserving its identity, or muting one independent audio clip. Those remain
adapter/managed integration requirements until a typed semantic operation is
approved. `video-clip.set-order` is present for protocol completeness but is a
stable `order-not-meaningful` no-op because same-track video order is derived
from non-overlapping timeline placement, not an independent render stack.

Those workflows remain outside the Phase 2 semantic operation set:

1. A coordinator or standalone adapter obtains explicit authority.
2. It probes bytes and verifies immutable identity.
3. It registers the path-free source descriptor and detached provenance in its
   source/transcript registry.
4. It invokes an approved atomic integration boundary that makes the
   registered descriptor visible before any clip operation references it.

The current engine does not yet expose that integration boundary. Adapters
must not mutate an active engine manifest behind its back or treat
`video-clip.insert`/`audio-clip.insert` as source registration. Managed import
and transcription publication require a later typed coordinator transaction
or an explicitly approved engine command.

## Render background prerequisite

`render.set-background` depends on a durable
`EditorManifestV4.renderBackgroundColor` field. The field is required,
canonicalized to lowercase `#rrggbb`, defaults to `#000000` when older V4
payloads are normalized, and is part of semantic history.

The current worktree contains this prerequisite across:

- document and manifest types;
- strict structural and hydrated validation;
- V1-V4 migration/default behavior and bundle serialization;
- history projection and patches;
- fixtures, parity tests, standalone persistence, and Zustand projection;
- preview and headless render consumption.

The command and engine changes must not be integrated independently from those
prerequisite surfaces. A build in which the operation parser exists but the V4
field, migration default, or renderer consumption is absent does not support
`render.set-background`.

## Public video source-range units

The semantic API names video source ranges explicitly:

```ts
sourceStartSeconds: number;
sourceEndSeconds: number;
```

`video-clip.insert` and `video-clip.trim` use those fields together with
integer project-frame placement. Public requests must not expose the internal
`sourceStart`/`sourceEnd` property names, whose units are otherwise ambiguous.

## Managed-runtime boundaries beyond Phase 2

Phase 2 intentionally stops at the instance-scoped project mutation core:

- the coordinator maps committed numeric event sequences to retained opaque
  cursors and supplies reconnect behavior;
- coordinator-only path-grant, source-registry, playback-authority, job, and
  artifact changes own their session transactions and reconstruct or reattach
  an engine at the resulting durable head;
- source registration and transcription provenance are typed managed or
  standalone setup workflows, not generic manifest-patch operations;
- the descriptor-backed File-shaped projection exists only inside the detached
  planner because the shared V4 hydrated validator currently accepts
  `EditorDocumentV4`; no browser object or path enters the engine contract.

These boundaries must not be replaced by a second coordinator
prepare/publish mutation pipeline. Project edits and history movement always
cross the single `EditorPersistencePort.commit` boundary owned by
`EditorEngine`.
