# Standalone Editor Engine Adapter

The standalone browser editor uses the same instance-scoped `EditorEngine` ports as other
coordinators while retaining its existing Next.js, IndexedDB, Zustand, browser `File`, and
transcript-CAS runtime. This adapter is a compatibility boundary, not a second mutation engine.

## Project ownership and lifecycle

Each loaded project owns exactly one `StandaloneEditorEngineAdapter` and one `EditorEngine`
instance. The adapter is created after the project's V4 document, browser files, transcript
records, and retained history have been loaded. A project switch closes the previous adapter
before its project-owned resources are released; engine state, receipts, history, files, and
selection sidecars must never be shared across project IDs.

The active standalone bridge is only a routing convenience for the mounted editor. Durable state
remains instance-scoped inside the project engine and its ports. When an engine head already
exists, the adapter projects that recovered authoritative snapshot during attachment; it never
leaves an independently loaded public manifest visible as a competing head.

Newly created projects attach the engine immediately after their empty V4 document becomes
durable. They therefore use the same authority as reopened projects from their first edit and
media import; there is no setup-session mutation head beside Core.

## Commit and projection ordering

A standalone durable mutation follows one ordering:

1. A compatibility wrapper translates the existing editor action into approved semantic
   operations for `EditorEngine.dispatch`, or maps inspected browser media to the internal
   `EditorEngine.importMedia` boundary.
2. The engine plans and validates the complete mutation.
3. `StandaloneEditorPersistencePort.commit` durably writes the IndexedDB engine head, receipt,
   history, session state, transaction metadata, transcript/source pins, selection sidecars, and
   only the newly registered browser `File` records.
4. After the commit promise resolves, the adapter hydrates browser files and transcript bodies,
   validates the resulting V4 runtime document, and publishes exactly one Zustand projection.

The IndexedDB/CAS commit is the only durable commit point. Zustand, React, playback, and autosave
indicators observe the committed snapshot afterward. A rejected or failed commit restores the
previous authoritative projection, including clearing any adapter-owned drag or input preview.

Existing synchronous store methods keep their public return shape by using compatibility wrappers
that enqueue engine work. They do not optimistically write the durable graph before the engine
finishes. Call sites that require the authoritative result use the awaited adapter method.
Selection, playhead, hover, drag previews, focus, and layout remain synchronous adapter-owned view
state.

Manual Save and export preparation flush the adapter queue and never enqueue the engine-owned
snapshot through the legacy timeline persistence registry. A failed commit retains the exact
idempotent request for Retry and blocks later durable commands or history navigation until that
request succeeds. A successful projection updates the existing dirty/status channel.

Project names commit to the engine head before the dashboard project index is updated. Attachment
reconciles an interrupted index write from the authoritative head, so a crash between those two
browser transactions cannot reverse semantic rename history.

## Browser storage ports

`StandaloneEditorAssetRepositoryPort` retains the project-owned browser `File` objects outside the
portable manifest. It resolves descriptor IDs to the matching video or audio source, verifies the
descriptor fingerprint, metadata, byte length, and content digest, and exposes only a verified
opaque media handle to the engine. Import candidates remain provisional until the authoritative
IndexedDB transaction commits; failure or receipt replay releases that provisional ownership.
Files needed only by Redo are loaded lazily from their pinned IndexedDB records after reopen.
Hydrating a committed snapshot reattaches the same project-owned files; no file bytes, object
URLs, or local paths enter engine history or receipts.

`StandaloneEditorialTranscriptRepositoryPort` resolves descriptor record IDs through the existing
content-addressed transcript repository. V4 manifests and engine history retain descriptors and
CAS record IDs only. Transcript bodies remain detached and are hydrated before the single Zustand
publication.

`StandaloneEditorPersistencePort` stores the engine head, idempotency receipt, and new source
Files in the project's IndexedDB transaction boundary. Precise source pins protect current,
history, and Redo roots; transcript pin generations protect the equivalent CAS roots. Publishing
the final CAS pins happens after the durable head commit; a post-commit pin publication failure is
reported without falsely rolling back an already committed engine result.

## History and selection sidecars

Transient selection is not part of `EditorManifestV4` or semantic patches. For each material
history entry, the standalone persistence port stores the before/after selection context in a
sidecar keyed by the engine-provided `historyEntryId`. Undo, Redo, and history jumps use that stable
ID to restore the appropriate selection. Sidecars are pruned when their history entries are no
longer retained, and a no-op creates no history or selection entry.

When no standalone engine head exists yet, the adapter converts retained legacy Zustand history
once, preserving its stable entry IDs and deriving matching selection sidecars. After that
bootstrap, engine history is authoritative.

## Explicit compatibility boundaries

The frozen semantic vocabulary does not yet provide typed operations for these durable standalone
workflows:

- publishing transcription provenance or a newly acquired transcript record;
- changing `activeSubtitleTrackId`;
- moving an existing subtitle across tracks while preserving its identity;
- muting one independent audio clip separately from its audio track.

These are explicit unsupported adapter boundaries. Transcription setup may prepare project-owned
CAS bodies and provenance before engine creation, but an active engine must not be patched behind
its back. Callers must not emulate missing semantics with a generic manifest patch, a nearby
operation, or an optimistic Zustand dual-write. Browser video/audio import is not part of this
list: inspected descriptors and verified `File` hydration route through the internal atomic media
import boundary and Core owns ordering, placement, history, replay, guards, pins, and publication.

The adapter also fails closed when the legacy ripple planner requires cross-media sibling shifts
that Core cannot yet express in one semantic command. It never applies only the target operation
and silently drops the rest of the planned cascade. Adding a second subtitle track fails closed
until Core can durably activate it, and deleting a transcribed track fails closed until provenance
removal can share the track transaction.

`video-clip.set-order` is intentionally supported as the stable `order-not-meaningful` no-op.
Same-track video order is canonical from non-overlapping timeline placement, so the adapter must
not reinterpret this operation as the legacy reorder affordance.

## Render background parity

`render.set-background` writes the shared durable `EditorManifestV4.renderBackgroundColor` field.
The command boundary canonicalizes valid `#RRGGBB` input to lowercase, and legacy V4 payloads
without the field load as `#000000`. The field participates in semantic history, standalone
IndexedDB persistence, Zustand projection, project bundle round trips, preview painting, and
export frame clearing. Preview and export therefore consume the same committed color; there is no
adapter-only background shadow state.

## Integration dependencies

This integration combines the host-neutral editor surface through `bb55096`, Core's authoritative
atomic `EditorEngine.importMedia` boundary from `83ddd5f`, and the standalone adapter source change
from `a92cabf`. Browser imports route to that internal API without adding a semantic operation or
a second registration planner.
