# Editor Document V4

Editor Document V4 is the canonical graph for current Waptions projects. It keeps explicit media
placement, subtitles, the unified Text narrative, transcript provenance, and dependent links in one
validated document. Runtime documents contain source `File` objects; durable manifests contain only
source descriptors and stable IDs.

V4 does not embed editorial transcript bodies. Those immutable bodies live in a separate
content-addressed IndexedDB repository and in verified `.waptions` bundle sidecars.

## Root graph

`EditorDocumentV4` contains:

- a locked render profile with rational project frame rate, canvas dimensions, and 48 kHz output
  audio rate;
- a canonical `#RRGGBB` project background used by preview gaps, letterboxing, media tails, and
  export;
- typed video and audio source catalogs;
- explicit video clips with `trackId`, `timelineStartFrame`, and source crops;
- visible/locked video tracks, independent audio tracks, and subtitle tracks;
- `globalEditingMode`, either `ripple` or `absolute`;
- descriptor-only editorial transcript provenance;
- at most one unified `NarrativeDocumentV1` across every controlled video track;
- generalized dependent links and exact transcript-fragment bindings;
- document and audible-graph revisions; and
- one discriminated transient selection in runtime documents only.

Video placement is no longer inferred from array order. A track may contain gaps, and clips on
different tracks may overlap. Clips on the same video track cannot overlap. Preview and export pick
the first visible track containing the requested frame, using durable video-track order as the
compositing order. Every audible contributor is mixed independently through the shared audio graph.

## Unified Text narrative

The narrative has one globally ordered `blockIds` sequence. It can own clips from one or many video
tracks, and every block retains its exact `trackId`, `sourceId`, transcript record, clip, occurrence,
and source-interval identities. Track membership alone does not imply Text ownership; ownership is
the exact one-to-one block/clip relationship.

A block is either:

- `speech`, with immutable `sourceWordIds` and optional instance-local text/speaker overrides; or
- `silence`, covering a source-backed no-word range with `quiet`, `no-audio`, `acoustic-only`, or
  `unknown` evidence.

Timeline gaps are not silence blocks. **Delete all silences** removes only source-backed narrative
silence/untranscribed blocks. It never removes an arbitrary project gap, speech, subtitle, ordinary
media target, or an uncontrolled clip.

The narrative sequence is global, but every row exposes its source-track badge and controlled-track
identity. Secondary commands can use document scope or the selected controlled-track scope.

## Transcript descriptors and immutable CAS bodies

An `EditorialTranscriptDescriptorV1` is safe project/history provenance. It records hashes,
algorithm/schema versions, source identity, exact 16 kHz sample count, language, speaker mode,
provider model identity, endpoint identity digest, acquisition kind, and creation time. It contains
no words, regions, speaker catalog, raw endpoint, or credential.

The body is canonical JSON stored under `sha256:<digest>` in the
`waptions-editorial-transcripts` database. The repository verifies stable inner IDs, canonical
bytes, outer record hash, descriptor/body agreement, and request-key agreement before returning a
referenced record. Existing bytes under a record ID are immutable. Request-index publication uses
compare-and-swap; a concurrent winner is rehydrated and verified instead of being overwritten.

The request key covers source fingerprint, exact output sample count, normalized language, speaker
mode, endpoint identity, and frozen algorithm versions. Cropped or repeated occurrences of the same
source therefore share one full-source PCM/provider acquisition. **Regenerate** bypasses the current
request-index winner but still publishes through compare-and-swap.

## Core samples, materialized frames, margins, and seams

Each block separates semantic and rendered authority:

- `[coreStartSample, coreEndSample)` is the immutable 16 kHz semantic range;
- `[sourceStartFrame, sourceEndFrame)` is the exact native source-frame crop;
- `timelineStartFrame` is the explicit project placement; and
- the owned clip supplies the duration derived from its crop and render profile.

A margin boundary is `inherit-global` or `explicit`. Starts round outward to the native frame at or
before the requested sample; ends round outward to the frame at or after it, clamped to the
deterministic source tail. The final canonical PCM sample count uses `ceil(duration * 16000)`, so a
source-tail block may semantically own less than one padded sample after the exact container end.

An internal partition uses the same `seamId` on the adjacent post/pre sides. The seam retains one
exact native-frame cut and adds no margin. A semantic sample boundary can fall inside that frame;
the two children cannot both contain that fractional boundary without overlapping media, so the
validator applies outward containment only to margin sides. Deleting a neighbor does not silently
turn a surviving seam into a margin.

Ordinary video splits also resolve an exact native-frame seam whose two project-frame durations
match the requested split. A non-representable split fails atomically instead of creating a crop
that later Text activation would reject.

## Activation and overlap exclusion

Activation first captures a revision/mode/session guard and classifies every candidate interval.
Any connected component containing an overlap is excluded as a whole; no filename, top-track,
duration, or ID tie-breaker chooses a winner. Accepted isolated clips are partitioned into readable
speech and source-backed silence occurrences while preserving their original total rendered
interval and audio settings. All accepted tracks enter one narrative in one history command.

Acquisition can populate immutable cache bytes before a caller becomes stale, but stale guards
prevent session pins and document publication. Provider, parser, CAS, hydration, planning,
validation, persistence, quota, cancellation, and stale failures never publish a partial narrative.

## Ripple and absolute commands

Every structural command captures the expected document revision, narrative revision, and editing
mode. Pure planners return a complete proposal, typed no-op, or typed error before the Zustand store
creates one history/persistence transaction.

- Ripple closes or opens the exact materialized duration across the unified narrative.
- Absolute preserves unrelated starts and can create explicit gaps.
- Cross-track moves preserve the block's source-track identity unless the command explicitly
  targets another valid controlled track.
- Collision, locked-target, stale-guard, invalid binding, or non-representable frame operations
  reject the whole command.

Split, merge, delete, trim, reorder, recover, insert, extend, margin, refinement, text correction,
speaker override, and Delete-all-silences commands update selection/playhead and dependent links in
the same proposal. Text correction changes only an instance override and never media duration.

## Dependent links and fragment bindings

`EditorialDependentLinkV1` can target ordinary video, independent audio, or a subtitle cue.
Association is either:

- exact transcript binding, which stores record, lineage, source interval, and active sample range;
  or
- unique temporal overlap, established only when exactly one valid anchor exists.

Ties remain unlinked. Follow behavior is explicit and can be toggled without changing binding
identity. Anchor transforms retarget, trim, split, move, or remove links only when the complete
proposal remains valid. Lock/collision failures are atomic.

## History, persistence, and pins

Current, Undo, Redo, WAL, and durable projections contain descriptors and stable IDs only. The
transcript repository maintains separate session, pending-generation, durable, history, redo, and
WAL pin sets. Project persistence commits the V4 manifest and typed source assets first, then
publishes the corresponding durable CAS pins. A failed generation retains the previous reopenable
project and cannot collect a body still referenced by history or recovery.

Releasing a controlled track keeps its current clips, crops, track IDs, and timeline starts as
ordinary V4 media. Releasing the final controlled track sets `narrative` to `null`; retained history
and recovery references continue owning their required descriptor pins.

## Migration and legacy tombstone

V3-to-V4 migration is one pure validated transform. It projects the old gapless sequence into
explicit `timelineStartFrame` values, creates the initial video-track catalog, maps subtitle timing
policy, initializes the project background to black, and initializes empty editorial fields. V4
manifests written before the background field existed are normalized to the same black default only
at version-aware IndexedDB and bundle read boundaries; present malformed colors still fail closed.
Before Text activation, migrated preview, audio, subtitle, and export behavior is semantically
identical to V3.

Each V4 subtitle track stores one visible fallback policy for cues without a durable dependent
link. `stay-absolute` preserves their project times, `follow-project-ripple` applies the
uncontrolled video ripple, and `remove-with-deleted-video-range` removes an unlinked cue when its
half-open time interval overlaps a deleted video range while leaving all other cues at absolute
times. Video insertions and moves do not remove cues under the third policy. Explicit dependent
links always take precedence. The V3 compatibility projection maps the removal policy to
`absolute`, because V3 cannot encode its delete-range semantics.

V4 becomes the durable authority after a successful save. The legacy V3 record is then a tombstone
candidate; readers do not merge V3 and V4 or silently fall back from a corrupt V4 record. Failed
migration or persistence leaves the old project data intact.

## Bundle 4.0

Bundle 4.0 contains:

- `metadata.json` with a descriptor-only `EditorManifestV4`;
- typed source-file entries;
- one declared `editorial-transcripts/sha256-<digest>.json` sidecar per referenced record; and
- user presets.

Each sidecar is the exact canonical JSON byte domain for its declared record ID. Import bounds file
counts and aggregate sizes, rejects missing/extra/duplicate paths, verifies every hash and
descriptor/body/source relationship, and prepares the complete project before publishing it.
Bundles never contain PCM, request indexes, pin sets, local history/WAL, endpoint preferences, or
API keys.

## Credential boundary

Text preferences may persist endpoint, browser/server request mode, language, and speaker-analysis
choice in browser-global local storage. The API key is component-local session state: it is not
written to preferences, the project graph, history, CAS, request index, bundle, URL, or application
logs.

Browser mode sends the multipart request directly from the user's browser and requires endpoint
CORS. `localhost` resolves on the user's machine. Server mode sends the same transient settings
through Waptions; `localhost` then resolves on the Waptions server, and production hosts must pass
the server allowlist.
