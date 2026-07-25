# Waptions Agent Protocol

This document freezes the host-neutral contract used by the Waptions editor engine and the planned
managed MCP runtime. The protocol API version is `2026-07-25`; it is independent of the V4 document
version.

The current implementation boundary is important:

- **P2 engine-backed:** the instance-scoped `EditorEngine`, its semantic operations, plans, apply,
  history, revisions, events, injected ports, and deterministic IDs.
- **Landed P2/P3A prerequisite:** durable render-background state is the canonical
  `EditorManifestV4.renderBackgroundColor`, shared by the engine and standalone adapter.
- **Staged managed capability:** MCP tool entrypoints, the durable coordinator, path grants, jobs,
  artifacts, event retention, media byte sources, and the MCP App. Their external names and
  envelopes are frozen here, but P2 alone does not expose an MCP server.

## JSON and result rules

All tool inputs and outputs are JSON Schema objects. Protocol objects are closed by default:
unknown fields are rejected with `INVALID_REQUEST` at the request envelope, expected-revision
object, operation envelope, operation payload, and nested discriminated objects. Clients must not
use undeclared fields as an extension mechanism. A future field requires a versioned schema
change. A schema may explicitly declare an extension record only where the contract names one.

The same rule applies to engine command and history requests. One edit request is limited to 256
operations and 512 KiB of canonical JSON. Operation IDs must be unique within the request.

Successful MCP results have this shape:

```ts
interface WaptionsToolSuccess<T> {
  ok: true;
  data: T;
  state: StateToken;
  warnings: ToolWarning[];
}
```

Domain failures have this shape:

```ts
interface WaptionsToolFailure {
  ok: false;
  error: {
    code: WaptionsStableErrorCode;
    message: string;
    retryable: boolean;
    details?: BoundedErrorDetails;
  };
  state?: StateToken;
}
```

`structuredContent` is authoritative. Every MCP response also supplies a concise textual fallback
in `content`. Error details are bounded and never include stacks, credentials, authorization
headers, signed media URLs, arbitrary provider bodies, or filesystem secrets.

## Session identity and state tokens

Every managed response carries:

```ts
interface StateToken {
  sessionId: string;
  projectId: string;
  sessionEpoch: string;
  sessionRevision: number;
  documentRevision: number;
  audioGraphRevision: number;
  narrativeRevision?: number;
  eventCursor: string;
}
```

All IDs and cursors are opaque. `sessionId` identifies an attachment to a managed project;
`projectId` identifies the durable project. Neither is a bearer credential.

`sessionEpoch` identifies one coordinator incarnation and changes after recovery.
`sessionRevision` is durable, owned exclusively by the Core editor engine, and monotonically
orders semantic project-head and history publication. A source registration advances it only
when Core imports that source in the same atomic editor commit. Path grants, jobs, artifacts,
views, playback, and presenter state use their own durable revisions or sequences; they neither
advance nor rebase Core. `documentRevision`, `audioGraphRevision`, and optional
`narrativeRevision` guard their respective V4 domains.

The P2 engine owns `sessionRevision` as independent instance state, initializes it from
`EditorEngineOptions.initialSessionRevision`, and compares it with every mutation's
`expected.sessionRevision`. It is not inferred from `documentRevision`.

A state token is a concurrency and recovery token, not an authorization token. Verified media
handles, output capabilities, path grants, and short-lived UI/view capabilities carry authority
separately.

Core mutations send the current `sessionEpoch`, expected `sessionRevision`, expected
`documentRevision`, and the audio or narrative revision when the operation depends on that
domain. Auxiliary mutations additionally use their explicit domain guard where the canonical
schema defines one, such as `expectedViewRevision` or `expectedPlaybackRevision`. One project
queue establishes a total order without coupling auxiliary changes to the editor head. Read
tools observe one consistent captured state.

## Durable receipts and mutation order

The durable idempotency scope is exactly:

```text
(projectId, toolName, idempotencyKey)
```

It deliberately excludes `sessionEpoch`. The canonical request hash includes the complete original
request, including its epoch and expected revisions. A mutating call is processed in this order:

1. Load the receipt by the epoch-independent scope before checking the live epoch or revisions.
2. If the stored request hash matches, return the stored semantic result with `replayed: true` and
   the current state token.
3. If the key exists with another request hash, return `IDEMPOTENCY_KEY_CONFLICT`, also before
   epoch and revision checks.
4. For a new key, validate the epoch, `sessionRevision`, and relevant document-domain revisions.
5. Plan and validate the complete mutation on detached state.
6. Persist the resulting state, history and transcript pins, ordered event, and receipt through one
   recoverable atomic commit before publishing the new snapshot.

Receipts survive coordinator, MCP, and UI restarts and are retained while a matching recovery
transaction is unresolved. Retrying a lost response therefore cannot duplicate an edit. A
successful semantic no-op records its receipt through `EditorPersistencePort.commit` with the
snapshot, history, and session state unchanged and `event: null`. It does not advance revisions or
the event sequence, publish a snapshot, create history, or emit a project/history event.

## Tool catalog

These are the complete frozen MCP tool names. They are staged managed-runtime entrypoints, even
where P2 already supplies the underlying engine primitive.

| Tool | Contract |
| --- | --- |
| `waptions_session_list` | Page managed projects, sessions, and recovery state. |
| `waptions_session_open` | Create a blank managed V4 project, attach to an existing project, or recover by opaque ID. |
| `waptions_session_manage` | Rename, detach, archive, restore, or explicitly delete a managed project; destructive actions require confirmation. |
| `waptions_path_grant` | Add, inspect, or revoke session-scoped read roots and output grants; overwrite is a distinct exact-file grant. |
| `waptions_project_get` | Read a bounded project summary, revisions, render settings, counts, active jobs, and paged graph references. |
| `waptions_project_import` | Start bounded import of a V1-V4 bundle or a descriptor-only managed manifest. |
| `waptions_project_validate` | Validate structure, hydration, source identity, history/recovery state, transcript pins, and renderability; deep validation may become a job. |
| `waptions_media_probe` | Probe explicit authorized files or a bounded, naturally ordered selection from an authorized directory without editing the project. |
| `waptions_media_import` | Register immutable source references and optionally place initial video/audio clips atomically. |
| `waptions_media_review` | Start contact-sheet, thumbnail, waveform, audio/silence, scene, transcript-assisted, or proxy review work. |
| `waptions_media_release` | Dry-run or apply runtime release and reachability-safe durable source garbage collection. |
| `waptions_timeline_query` | Page tracks, clips, subtitles, narrative content, links, intervals, adapter-owned selection, or the content boundary at one revision. |
| `waptions_edit_plan` | Normalize a bounded semantic batch and return predicted effects, aliases, warnings, and a short-lived `planId`. |
| `waptions_edit_apply` | Atomically apply a valid plan or inline semantic batch with guards, idempotency, history, links, validation, and persistence. |
| `waptions_history_get` | Page semantic Undo/Redo summaries and the current index without loading complete snapshots. |
| `waptions_history_apply` | Undo, redo, or jump with guards, idempotency, and exact transcript-pin semantics. |
| `waptions_transcription_start` | Start subtitle or independent editorial transcription with explicit tracks, ranges, language, speaker mode, and provider policy. |
| `waptions_job_list` | Page jobs by project, kind, or state. |
| `waptions_job_get` | Read one job and bounded progress/result metadata. |
| `waptions_job_cancel` | Idempotently cancel a cancellable job. |
| `waptions_export_start` | Start MP4, WebM, portable-bundle, reference-snapshot, or proof export to an authorized destination. |
| `waptions_artifact_list` | Page project artifacts and hashes. |
| `waptions_artifact_get` | Return bounded artifact metadata, an authorized canonical local path, or a short-lived signed range URL; never large inline bytes. |
| `waptions_events_read` | Read ordered events after an opaque cursor and report retention gaps. |
| `waptions_view_get` | Read one view/presence snapshot. |
| `waptions_view_update` | Update selection, playhead, zoom, scroll, row heights, layout, focus, or presentation without project history. |
| `waptions_playback_control` | Control play, pause, seek, rate, master volume/mute, presenter ownership, and follow state in the session/view domain. |
| `waptions_diagnostics_get` | Read bounded memory, cache, decoder, job, coordinator, and resource-leak diagnostics. |
| `waptions_editor_render` | Attach or open the versioned MCP App for a session/view and issue only short-lived UI capabilities. |

Path-authority expansion, overwrite authorization, project deletion, and durable source removal are
important/destructive actions and require explicit confirmation fields. Playback and view tools do
not create project history or alter the V4 audio graph.

`waptions_media_release` has only two modes: `release-runtime`, which closes unused runtime
resources without changing durable identity, and `garbage-collect`, which removes only sources
unreachable from the current document, Undo, Redo, unresolved recovery state, active/resumable
jobs, transcript pins, staging records, and retained receipts. Apply repeats reachability under the
project mutation lock.

## P2 semantic edit operations

P2 accepts typed semantic commands only. It does not expose arbitrary document-path mutation or a
generic structural-edit vocabulary. A compound apply is all-or-nothing and produces at most one
semantic history entry, one document transition, and one ordered mutation event.

The following 65 operations are currently executable by the P2 engine:

**Project and render**

- `project.set-name` updates `EditorEngine` project metadata. It is not a field in
  `EditorManifestV4`; the operation advances session authority and participates in semantic
  history without pretending to be media graph state.
- `render.set-profile`
- `render.set-background`

**Tracks**

- `track.add`
- `track.rename`
- `track.set-state`
- `audio-track.set-gain`
- `subtitle-track.set-unlinked-video-policy`
- `track.reorder`
- `track.reorder-clips`
- `track.delete`

**Video clips**

- `video-clip.insert`
- `video-clip.move`
- `video-clip.trim`
- `video-clip.split`
- `video-clip.delete`
- `video-clip.duplicate`
- `video-clip.set-order` (a stable `order-not-meaningful` no-op because same-track video order is
  canonical by non-overlapping time)
- `video-clip.set-audio`
- `video-clip.detach-audio`
- `video-clip.relink-audio`

**Independent audio**

- `audio-clip.insert`
- `audio-clip.move`
- `audio-clip.trim`
- `audio-clip.split`
- `audio-clip.delete`
- `audio-clip.duplicate`
- `audio-clip.set-order`
- `audio-clip.set-gain`
- `audio-clip.set-fades`

**Subtitles**

- `subtitle.insert`
- `subtitle.update`
- `subtitle.move`
- `subtitle.trim`
- `subtitle.split`
- `subtitle.delete`
- `subtitle.set-order`
- `subtitle.bulk-replace`
- `subtitle.set-track-style`

**Narrative**

- `narrative.activate`
- `narrative.release-tracks`
- `narrative.set-editing-mode`
- `narrative.split-block`
- `narrative.merge-blocks`
- `narrative.delete-words`
- `narrative.delete-range`
- `narrative.trim-block`
- `narrative.reorder-blocks`
- `narrative.insert-source-range`
- `narrative.recover-source-range`
- `narrative.extend-block`
- `narrative.set-word-text`
- `narrative.set-word-speaker`
- `narrative.set-speaker-visibility`
- `narrative.change-block-margin`
- `narrative.change-global-margins`
- `narrative.refine-boundary`
- `narrative.delete-all-silences`

**Dependent links**

- `link.discover-overlaps`
- `link.create-overlap`
- `link.bind-target`
- `link.unlink-target`
- `link.unbind-target`
- `link.reanchor`
- `link.set-follow-policy`

The public `subtitle-track.set-unlinked-video-policy` values are exactly `preserve-absolute`,
`ripple-with-video-edit`, and `remove-with-deleted-video-range`. At the P2 adapter boundary,
`preserve-absolute` maps to the legacy V4 internal value `stay-absolute`, while
`ripple-with-video-edit` maps to `follow-project-ripple`.
`remove-with-deleted-video-range` persists unchanged as the third V4 value: an uncontrolled video
delete or resize-shrink removes unlinked cues whose half-open interval overlaps the deleted range;
other cues remain absolute, and inserts or moves do not affect them. This policy is only the
fallback for unlinked subtitles; a dependent link's policy takes precedence.

`render.set-background` writes `EditorManifestV4.renderBackgroundColor: string`. The engine stores
canonical lowercase `#rrggbb`, while migration supplies `#000000` when legacy V4 data omits the
field. The validator, migration, snapshot, history, renderer, and standalone adapter share this
one field; there is no adapter-only shadow value.

Source registration/import is not an edit operation. `video-clip.insert` and audio insertion
reference sources already registered in the manifest and verified by the asset repository.
Likewise, transcription acquisition and provenance setup are outside the P2 operation surface.
`narrative.activate`, insertion, and recovery consume existing transcript record IDs, descriptors,
and repository-hydrated bodies; they do not call a provider or invent provenance. Managed source
registration and transcript jobs enter through `waptions_media_import` and
`waptions_transcription_start`.

The P2 vocabulary intentionally does not include active-subtitle-track selection, a
semantics-preserving cross-track subtitle move, or independent audio-clip mute. All three require
explicit semantic operations before they can move behind the engine. Adapters must not emulate any
of them with generic manifest patches or optimistic durable dual-write.
`activeSubtitleTrackId` remains durable V4 state, but changing it is an existing standalone setup
action rather than a P2 semantic operation. `video-clip.set-order` is the declared stable no-op
described above, not a hidden bridge to the standalone legacy reorder affordance.

## Time domains

Time fields are explicit and must not be inferred from an unsuffixed value in another domain:

| Domain | Unit and interval rule | Representative fields |
| --- | --- | --- |
| Project video placement | Non-negative integer frames at the render profile frame rate | `timelineStartFrame`, `atFrame`, `currentPlayheadFrame`, `targetStartFrame` |
| Video source crops | Finite source-media seconds; start inclusive, end exclusive | public `sourceStartSeconds`, `sourceEndSeconds`; durable V4 `sourceStart`, `sourceEnd`; detached video-audio source ranges |
| Audio/subtitle output | Integer samples at fixed 48 kHz; half-open ranges | `startOutputSample`, `endOutputSample`, `atOutputSample` |
| Imported-audio source | Integer native samples with an explicit positive `nativeSampleRateHz`; half-open ranges | `startNativeSample`, `endNativeSample` |
| Narrative/transcript source | Integer canonical samples at 16 kHz; half-open ranges | `sample16k`, `startSample16k`, `endSample16k`, `activeStartSample16k`, `activeEndSample16k`, margin samples |
| Byte source | Zero-based bytes; start inclusive, `endExclusive` exclusive | `MediaByteSource.read` and range streams |

`audio-clip.trim` uses a discriminated source range: `native-samples` for an imported audio source,
or `seconds` for detached video-source audio. Audio fades enter the semantic API as 48 kHz output
samples and are normalized to the clip's durable domain. Subtitle semantic timing also enters as
48 kHz samples and is normalized for the existing renderer. Timestamps such as `createdAt`,
`occurredAt`, `verifiedAt`, and `expiresAt` are ISO 8601 strings.

The default plan lifetime is 15 minutes. Managed event retention is the smaller of 10,000 events
or 30 days.

## Plans, apply, and aliases

`EditorEngine.plan` accepts inline operations, validates the closed request envelope and current
revision guards, deterministically preallocates aliases, records the base engine revisions, and
returns predicted revision domains, affected IDs, history metadata, warnings, and expiration.
When no operation algorithmically needs transcript bodies, it runs the semantic planners and
dependent-link transforms on a detached descriptor-only projection and structurally validates the
proposal. Plans that need body or source verification set `requiresHydration`; apply performs that
verification and complete hydrated validation. Planning never opens sources, publishes state, or
creates history.

`EditorEngine.dispatch` accepts either inline operations or exactly one `planId`. A stored plan is
rejected with `PLAN_NOT_FOUND`, `PLAN_EXPIRED`, or `PLAN_INPUT_CHANGED` when it is absent, expired,
or no longer based on the exact epoch and revisions. Apply resolves later-operation aliases, opens
only required verified assets and transcript bodies, runs the semantic planners and dependent-link
transforms on detached state, validates the hydrated V4 proposal, computes revision effects, and
commits before publication. Invalid guards, IDs, aliases, locks, overlap, hydration, or validation
abort the whole batch.

Generated identities are returned as opaque alias values, for example
`$splitA.rightClipId`. Callers may reference a previously returned alias later in the same batch;
they must not predict the generated ID.

## History and adapter-owned selection

P2 semantic history stores bounded summaries and reversible manifest/project-metadata transitions.
The engine retains at most 500 entries and 32 MiB across history state; snapshots expose the most
recent 200 summaries by default. Undo, redo, and jump use the same guards, idempotency, validation,
atomic persistence, transcript-pin accounting, and ordered publication as edits. A jump targets a
history entry by opaque ID and chooses its `before` or `after` position.

Selection, playhead, zoom, scroll, focus, and layout are not durable engine or manifest state.
Standalone and managed UI adapters own them. When an adapter wants selection restoration during
Undo/Redo, it stores the selection context keyed by the engine-provided `historyEntryId`; it does
not place selection in the engine history payload or address it by array index. Managed view
selection is updated through `waptions_view_update` and remains outside project history.

## Events and recovery

The canonical session resource/subscription URI is:

```text
waptions://session/{sessionId}/editor
```

P2 emits ordered `project.mutated` and `history.changed` engine events only after the corresponding
atomic commit. Failed commits and semantic no-ops do not consume event sequence numbers. The
managed coordinator expands the event stream with:

- `session.recovered`
- `project.snapshot`
- `project.mutated`
- `history.changed`
- `job.changed`
- `artifact.created`
- `diagnostics.changed`
- `presence.changed`
- `view.changed`
- `source.invalidated`

Subscribers resume after the opaque `eventCursor`. `waptions_events_read` is the polling and
recovery fallback. If the cursor predates retention, the server returns `EVENT_CURSOR_EXPIRED`
with the current state token; the caller must fetch a paged current snapshot and must not infer or
replay missing edits.

Durable job states are exactly `queued`, `running`, `succeeded`, `failed`, `cancelled`, `stale`,
and `interrupted`. Each `WaptionsJobRecordV1` carries a frozen job kind, input digest, captured
state token, independent job sequence, stage/fraction/message progress, cancellation state,
optional content-addressed checkpoint, result artifact IDs, timestamps, and an optional bounded
stable error. Restart recovery may move an interrupted job back to `queued` when its checkpoint is
resumable; “resumable” is a transition decision, not an additional durable state.

## Path-free media identity and capabilities

Portable manifests and engine snapshots contain descriptors and immutable identity, never local
paths, open files, credentials, endpoints, decoded frames, or PCM. Canonical filesystem paths stay
in the managed source registry and session path-grant subsystem.

`ImmutableMediaIdentityV1` contains:

- `schemaVersion: 1`;
- `contentDigest`, the `sha256:` digest computed from the streamed source bytes;
- `descriptorFingerprint`, the distinct portable V4 descriptor identity;
- `byteLength` and immutable version;
- optional stable device/file/modified-nanoseconds identity; and
- bounded probe/video/audio/subtitle stream metadata references.

Adapters must verify and preserve all three source facts independently. They must never treat
`descriptorFingerprint` as a byte digest, derive `contentDigest` from descriptor metadata, or
conflate either value with `byteLength`.

`VerifiedMediaHandleV1` is opaque authority returned only after an adapter has verified the
registered source identity. It binds `handleId`, `capabilityId`, immutable identity,
`verifiedAt`, and optional expiry. The engine requests only the handles needed by a proposal and
fails if the hydrated descriptor fingerprint, byte length, or streamed content digest no longer
agrees with the verified source identity.

`SessionPathGrant` is staged managed authority for one `read-root`, `write-destination`, or exact
`overwrite-file`. Read authority never implies output authority. A create-only output grant never
implies overwrite.

`StagedOutputDestinationCapabilityV1` is the only output authority passed to an output adapter. It
contains an opaque destination/grant/staging handle, `create-only` or `overwrite-file` mode, one
safe final `outputName`, verified parent identity, expiry, and the required overwrite confirmation
when applicable. It does not contain an absolute or relative path for the adapter to reopen.

Capabilities are session-scoped, bounded, and revocable. Expired authority returns
`CAPABILITY_EXPIRED`; changed media or path identity fails closed instead of silently reading or
publishing different bytes.

## Frozen stable errors

The complete stable protocol error set is:

- `INVALID_REQUEST`
- `UNSUPPORTED_API_VERSION`
- `PAYLOAD_TOO_LARGE`
- `SESSION_NOT_FOUND`
- `SESSION_EPOCH_MISMATCH`
- `SESSION_REVISION_CONFLICT`
- `REVISION_CONFLICT`
- `NARRATIVE_REVISION_CONFLICT`
- `AUDIO_REVISION_CONFLICT`
- `IDEMPOTENCY_KEY_CONFLICT`
- `PLAN_NOT_FOUND`
- `PLAN_EXPIRED`
- `PLAN_INPUT_CHANGED`
- `NOT_FOUND`
- `INVALID_DOCUMENT`
- `INVALID_OPERATION`
- `OVERLAP_CONFLICT`
- `LOCKED_TARGET`
- `ORDER_NOT_MEANINGFUL`
- `SOURCE_CHANGED`
- `SOURCE_UNREADABLE`
- `PATH_NOT_GRANTED`
- `WRITE_DESTINATION_NOT_GRANTED`
- `OVERWRITE_NOT_AUTHORIZED`
- `PATH_IDENTITY_CHANGED`
- `UNSUPPORTED_MEDIA`
- `NO_AUDIO`
- `CODEC_UNAVAILABLE`
- `TRANSCRIPTION_POLICY_REJECTED`
- `TRANSCRIPTION_ENDPOINT_UNREACHABLE`
- `SSRF_POLICY_REJECTED`
- `JOB_NOT_CANCELLABLE`
- `EVENT_CURSOR_EXPIRED`
- `ARTIFACT_EXPIRED`
- `CAPABILITY_EXPIRED`
- `COORDINATOR_UNAVAILABLE`
- `INTERNAL_ERROR`

Callers branch on `code`, not on the human message. Conflict and expiry failures should include the
current state token when a session remains available so the caller can refresh or replan. A
destructive edit is never silently rebased.
