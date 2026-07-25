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
live project is marked unavailable and must restart; it cannot continue from a potentially mixed
in-memory view.

Durable JSON limits are explicit and preflighted before WAL creation: project snapshots are
limited to 64 MiB, WAL records to 80 MiB, receipts to 1 MiB, jobs to 2 MiB, events to 64 KiB,
and grant/artifact metadata to 256 KiB. The WAL ceiling leaves headroom above the 32 MiB history
budget. Artifacts and media bytes are never base64 encoded into WAL; they are streamed to hashed
files before bounded metadata publication.

## Security and boundedness

Path grants distinguish read roots, create-only destinations, and confirmed exact-file
overwrites. Filesystem access canonicalizes paths, checks containment, rejects special files,
symlinks and hardlinks, retains open descriptors, and rechecks identity at operation boundaries.
Create-only publication uses a no-replace hard-link step. Destination grants capture the parent
device/inode and retain an open parent descriptor through staging, publication, and directory
sync. Media code receives only `VerifiedReadHandle`; export code receives only
`StagedDestination`, including its `grantId`, open handle, commit, and abort methods.

Node does not expose `openat`/`renameat2` on macOS. Exact overwrite therefore retains and checks
the original target descriptor plus parent descriptor immediately before atomic `rename`, and
checks the parent again after publication/fsync. This closes ordinary path-replacement attacks,
but cannot make the final userspace check-to-rename interval kernel-atomic. Create-only output has
the stronger portable no-replace guarantee and is the default export mode.

Event cursors and artifact capabilities are HMAC authenticated. Event pages, subscriptions,
transport frames, artifact ranges, hashing buffers, diagnostics, messages, and persisted errors
are bounded. Secrets are stored only in the private coordinator namespace and never appear in
events, receipts, discovery, or project state.
