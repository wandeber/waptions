# Managed Runtime Integration Contract

This package is the P3B/P4A durable authority for Codex-managed Waptions projects. It deliberately
does not import the editor engine, MCP schemas, UI stores, media implementation, or package
entrypoints owned by other plan phases.

## Editor engine mapping

The integration owner supplies one `ManagedEditorPort` per project:

- `snapshot()` maps to the instance-scoped `EditorEngine` snapshot.
- `dispatch()` maps directly to Core's only validate/plan/apply pipeline.
- `hydrate()` maps the recovered managed snapshot into a newly constructed engine instance.
- `close()` releases project-scoped engine resources.

The coordinator injects and implements `ManagedEditorPersistencePort`, which maps one-to-one onto
Core's `EditorPersistencePort`. The coordinator performs durable receipt lookup before epoch and
revision guards and then invokes `dispatch()`. Core performs its pure planning and validation,
calls the persistence port exactly once, waits for the redo WAL transaction, and publishes its
prepared head once. The coordinator never plans or publishes a second time. The engine remains
the document-domain authority; the coordinator is the session, persistence, jobs, events,
artifact, grant, and process-lifecycle authority.

The MCP boundary computes `canonicalRequestHash` from the complete validated protocol request
before translating it into an engine command or runtime arguments. It passes that exact digest in
`ManagedMutationEnvelope`; the coordinator validates its shape but never reconstructs it from
transformed values. Durable receipt identity is `(projectId, toolName, idempotencyKey)`, and a
matching receipt compares this supplied digest before epoch/revision guards, path resolution, ID
allocation, staging, or any other side effect.

## Jobs, artifacts, and events

Protocol-facing job creation calls `ManagedCoordinator.enqueueJob()`, not
`DurableJobScheduler.enqueue()` directly. The coordinator prepares the job only after receipt
resolution and commits the queued job record, receipt, session/job/event revisions, and
`job.changed` event in one transaction. The scheduler adopts the already committed job
idempotently, including after a lost response.

A handler that produces artifacts stages them through `ArtifactRegistry` and returns both the
ordered `artifactIds` and `terminalPublication`. The scheduler's coordinator hook then commits the
artifact registry writes, terminal job record, session/job/artifact/event revisions, and typed
terminal event in one transaction. Any pre-commit rejection reaps staged blobs; recovery preserves
only blobs owned by committed registry records. A scheduler without that coordinator hook rejects
terminal artifact publication.

Persisted events use the `EventRecordV1` transport shape: `cursor`, `type`, `occurredAt`, complete
canonical `state`, `sequence`, and bounded typed `data`. The event cursor is authenticated and
must equal the cursor in its state token. Runtime-only event types remain explicitly mapped by the
protocol owner; `job.changed`, `artifact.created`, and `session.recovered` already retain the
canonical protocol data fields rather than lossy summaries.

## Service integration

`runManagedCoordinatorService()` is the executable service contract for the packaging owner. Its
bootstrap callback creates the coordinator and a bounded method dispatcher. The service:

- owns a single authenticated Unix socket, or a named pipe on Windows, for private control IPC;
- publishes a mode-`0600` discovery record without publishing its secret;
- remains alive when the MCP stdio client and every UI disconnect;
- permits another process to attach through `attachManagedCoordinator()`;
- refuses a second live discovery record;
- changes `sessionEpoch` only when the coordinator process restarts; and
- performs optional idle shutdown only when there are no clients and
  `canGracefullyShutdown()` confirms no active jobs, pending mutations, or recovery-required
  project.

The integration/MCP owner is responsible for spawning this service when discovery is absent and
for mapping protocol methods to the coordinator. It must not run a second in-process project
authority.

Port `59941` is reserved exclusively for the coordinator-owned HTTP media/UI bridge. The private
control IPC never binds that port. Discovery exposes `controlEndpoint` separately from the
optional `httpBridgeEndpoint`.

## Durability and recovery matrix

| Boundary | Durable evidence | Restart result |
| --- | --- | --- |
| Before WAL rename | No WAL | Old complete revision |
| WAL durable, before commit marker rename | Uncommitted WAL | Old complete revision; WAL discarded |
| Commit marker durable | WAL plus matching commit digest | Replay all namespace writes and state |
| Receipt/event published, state not published | Committed WAL | Complete replay to new revision |
| State published, cleanup incomplete | New snapshot plus committed WAL | Idempotent replay, then cleanup |
| WAL cleanup complete, response lost | New snapshot and receipt | Exact retry replays receipt under current epoch |
| Coordinator restart with running resumable job | Durable job checkpoint | Requeue and resume checkpoint |
| Coordinator restart with non-resumable job | Durable running record | Stable interrupted failure |
| Client/UI/stdio disconnect | Coordinator lock, socket, snapshot | Authority continues headlessly |

The commit marker is the transaction linearization point. Once any write boundary throws, the
live project is marked unavailable until WAL recovery has selected the old or new complete state.
An exact receipt retry may perform that repair in-process before any mutation guard; otherwise a
coordinator restart repairs it. The coordinator never continues from a potentially mixed
in-memory view.

Durable JSON limits are explicit and preflighted before WAL creation: project snapshots are
limited to 64 MiB, WAL records to 80 MiB, receipts to 1 MiB, jobs to 2 MiB, events to 64 KiB,
and grant/artifact metadata to 256 KiB. The WAL ceiling leaves headroom above the 32 MiB history
budget. Artifacts and media bytes are never base64 encoded into WAL; they are streamed to hashed
files before bounded metadata publication.

## Security and boundedness

Path grants are issuer-authenticated records, but clients and media code consume only opaque grant
identifiers bound to one session and coordinator epoch. Read paths are opened before canonical
containment is accepted, special files are rejected before a blocking open, and accepted bytes are
materialized into a private content-addressed immutable copy. Media code receives only the open
`VerifiedReadHandle` for that copy; it never reopens the caller's source path.

Create-only output initially returns an owned private mode-`0600` `O_RDWR` staging handle and
coordinator-private inspection path. Render code writes, ffprobes, hashes, and syncs that private
inode; it never opens the display/final path for inspection. Terminal `commit()` revalidates the
granted parent and absence, atomically creates the final name as a hard link to the fully synced
private inode, syncs the directory, and revalidates parent and target identity before success.
Staging must therefore share the destination filesystem; cross-device publication fails before
rendering. A crash exposes either no final target or all synced bytes, never a partially copied
target. A private durable publication journal binds the final inode, digest, grant, and session:
`recoverOutputPublication()` reconstructs the terminal capability after a kill/lost response, and
the coordinator writes its path-free `outputs/<publicationId>.json` record in the same transaction
as the terminal job and event before acknowledging the journal. Rejection removes the still-bound
target. Canonical final paths and the private inspection path stay inside coordinator process
boundaries.

The staging capability is a managed handle rather than a raw Node `FileHandle`: positional writes,
full replacement writes, reads, hashing, sync, and trusted read-only inspection are available while
per-output/session/global byte and count quotas are enforced. Concurrent stages and their maximum
lifetime are also bounded. Tool clients never receive the staging pathname or descriptor.

Node does not expose descriptor-relative `openat`/`renameat2` replacement on macOS, so exact
overwrite cannot preserve an exact-file capability across the final syscall. `exact-overwrite` is
therefore deliberately disabled; callers must choose a new create-only destination and perform any
replacement as a separate explicit user operation outside the managed authority.

Immutable source copies have per-source, per-session, global byte/count, and concurrent-copy hard
quotas. Session directory names are hashes rather than caller-controlled identifiers. Source
release removes copies that no remaining source record owns, and coordinator recovery removes
partials, abandoned render staging, and source copies absent from the recovered source registry.
`ManagedCoordinator.openRetainedSource(projectId, sourceId)` reopens a path-free immutable copy by
the recovered source registry digest, so restart never depends on the expired epoch of its original
read grant or on the caller's original path.

Node filesystem calls are not kernel-preemptible. The runtime exposes
`filesystemDeadlineMode: "cooperative-node-filesystem"` in diagnostics: deadlines and aborts are
hard at stream, chunk, queue, and publication boundaries, but an individual stalled `read`,
`write`, `sync`, or `stat` syscall must return before JavaScript can release its reservation.
Production media roots and destinations must therefore be local regular filesystems; FUSE and
network mounts require a killable worker/process boundary owned by the future render integration.
Capacity remains charged until such an operation actually settles.

Event cursors and artifact capabilities are HMAC authenticated. Event subscriptions, pending
long-polls, IPC connections and in-flight requests, queued response bytes, artifact count and
bytes, concurrent artifact streams, streaming duration, ranges, hashing buffers, diagnostics,
messages, and persisted errors have hard authority-level limits. Disconnect and deadline
cancellation propagate through `AbortSignal`. Rejected artifact publication is recovered against
WAL state and reaped when it has no committed registry owner.

Coordinator ownership uses an exclusive lock plus an exclusive reclamation token. Stale-lock and
release paths open and identify the record before quarantine, verify the moved inode and token, and
use create-only hard-link restoration rather than a rename that could overwrite a successor lock.
The persistence root remains mode `0700`; attacks requiring direct mutation inside that private
root by another process running as the same OS user remain outside this boundary. Secrets are
stored only in that namespace and never appear in events, receipts, discovery, or project state.
