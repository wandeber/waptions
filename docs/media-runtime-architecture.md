# Media runtime architecture

This document describes the implemented preview, waveform, export, editorial PCM, and persistence
runtime. The canonical project format is `EditorDocumentV4`; caches, decoder sessions, hydrated
transcript bodies, PCM, and diagnostics are runtime-only state and are never serialized into a
project manifest or `.waptions` bundle.

## Runtime ownership

Every expensive browser resource has one explicit owner:

- `MediaByteSourceRegistry` owns immutable byte sources. Consumers receive range grants and
  reference-counted leases; a replacement invalidates old leases immediately and closes the
  retired source after its last lease releases.
- `TimelineAudioEngine` owns the preview `AudioContext`, `AudioWorkletNode`, queued mix blocks, and
  the preview audio decoder catalog. `destroy()` invalidates pending setup and releases those
  resources exactly once.
- `MediabunnyAudioDecoder` owns source sessions keyed by source kind, source ID, and immutable file
  fingerprint. A transport seek aborts obsolete requests but does not discard unchanged sessions.
- `VideoCache` owns the preview `FrameCache` and project-source `VideoFrameSession` instances.
  Callers receive leases and must call `release()` after drawing a preview bitmap.
- `VideoFrameSession` owns its Mediabunny `Input`, video track, `CanvasSink`, iterator, scheduler,
  and current pooled canvas. Disposal closes the input first, then awaits iterator cleanup.
- Export owns an immutable document snapshot, a separate sequential video session, audio renderer,
  encoders, and destination. It never inserts frames into the preview cache.
- Editorial full-source PCM preparation owns a dedicated Mediabunny input/track/sink and module
  worker. Quiet-boundary refinement owns a separate bounded decoder invocation and never decodes a
  whole source merely to inspect one window.
- Whole-project diarization owns a detached frozen document snapshot, a bounded timeline audio
  renderer, one audio encoder/output, and the resulting compact in-memory Blob until its single
  transcription request settles.
- `WaveformRepository` owns extraction deduplication, subscriber cancellation, the memory LRU, and
  the best-effort derived IndexedDB cache.

Late decoder or bitmap results carry a generation. A result from a cleared, replaced, aborted, or
disposed generation is rejected; any newly owned bitmap is closed before rejection.

## Explicit V4 video placement

Video clips carry a durable track and project start. Same-track clips cannot overlap, while clips
on different tracks may overlap and every track may contain gaps. At a project frame, preview and
export choose the first visible track containing a clip. With no visible clip, the compositor emits
black while subtitles and audio continue through the shared content boundary.

Moving a clip does not change its source/frame cache identity. Trimming or rematerializing changes
only the affected source mapping. Native-frame crops remain authoritative, including Text partition
seams and ordinary splits at fractional source rates.

## Editorial source-zero PCM

The Text workflow acquires exactly one full-source canonical WAV per request profile, independent
of the number of retained crops or occurrences. Mediabunny selects the declared primary audio
track, falling back to the first stable audio-track order only when no primary track exists. A
source without audio produces a local no-audio transcript record and no provider request.

Decoded timestamps are mapped to native sample indices, channel-mixed to mono, and resampled to
16 kHz PCM16 from source-zero global phase. Timestamp gaps become zero samples; overlaps discard
the repeated prefix. Output length is exactly `ceil(source duration * 16000)`, with zero padding or
tail truncation as required. WAV encoding is deterministic and owns no detached/mixed timeline
audio.

Production resampling supports native 44.1 kHz and 48 kHz inputs through checked-in immutable
polyphase coefficient tables. An unsupported native rate fails closed rather than generating a
machine/runtime-dependent table. The current Mediabunny duration API exposes a JavaScript seconds
value; Waptions converts that value's exact decimal representation to a rational before the final
ceil operation instead of applying a floating epsilon.

Quiet-assisted boundary refinement uses the same immutable coefficient tables and source-zero
phase. The bounded decoder requests only the requested interval, caller padding, and the 64-tap
filter support required to reproduce the corresponding slice of full-source output. It closes every
owned sample and input on success, failure, or abort. Project attachment resolves files by immutable
source fingerprint, so a stale or replaced source cannot satisfy a window request.

## Audio clock and semantic invalidation

Preview time uses an integer, half-open 48 kHz project sample domain. The worklet converts that
project cursor to the audio device sample rate and publishes the only playback clock while audible
contributors exist. The animation-frame fallback does not compete with it.

The editor projects the V4 document into three audio identities:

- `sourceCatalogKey`: source kind, ID, fingerprint, and whether a video actually exposes audio.
- `audibleMixKey`: linked, detached, and imported contributor placement plus mute, solo, gain, and
  fades, including the referenced source fingerprints.
- `contentEndSample`: the exact exclusive end boundary shared with export.

`applySnapshot()` compares those identities atomically:

- Selection, track names, project metadata, and subtitle-text-only edits do not reset audio.
- A content-end-only change updates the worklet boundary without clearing queued audio.
- A mix change clears and re-primes the queue once while retaining unchanged decoder sessions.
- A changed source fingerprint disposes only the corresponding source session.
- Seek clears the queue once but retains the source catalog.

The worklet protocol is versioned. Pause is acknowledged before the `AudioContext` is suspended;
no clock events are accepted after that acknowledgement. Natural EOF emits `ended`, not a false
underrun. The processing loop uses scalar channel reads and a bounded queue rather than allocating
sample arrays or filtering contributor lists for every render quantum.

Preview and export call the same audio mix-plan and DSP modules. This preserves linked-video audio,
detached video audio, imported audio, mute/solo, clip and track gain, fades, silence tails, and exact
exclusive sample boundaries.

## Whole-project diarization mix

Custom OpenAI-compatible diarization also consumes `buildAudioMixPlan()`, but it renders a bounded
audio-only artifact rather than a video export. A detached recursively frozen document snapshot is
captured before asynchronous work. Rendering begins at project sample zero and ends at the last
exclusive sample of an audible contributor, preserving leading and internal silence while omitting
silent or muted tails. A project with no audible contributors makes no network request.

The renderer feeds a Mediabunny audio sample source and prefers AAC in MP4, falling back to Opus in
WebM only when AAC cannot be encoded. It never creates a whole-project WAV. Samples, decoder
sessions, source and output are closed exactly once; cancellation crosses rendering, encoding and
upload, and a failed finalization cancels the output instead of exposing a partial Blob.

Browser mode uploads the Blob directly and therefore needs endpoint CORS. Server mode posts it once
through Waptions, so localhost resolves on the Waptions server and production endpoints remain
subject to the existing allowlist. Both modes request non-streaming verbose JSON with diarization
enabled. Response validation uses only readable `diarization.speaker_segments`; empty speech is a
no-op, while malformed timing or speaker data fails before any editor mutation.

The complete compressed artifact and multipart request live in memory. Large projects may exhaust
browser codec/memory capacity or server upload limits. There is no separate diarization duration
cap; stage-specific errors release owned resources and leave tracks/history/persistence untouched.

## Video preview and cache budgets

Media inputs enter decoders through `MediaByteSource`. Browser `Blob`/`File`, managed filesystem,
and HTTP range adapters expose the same half-open random-read contract. A single read is limited to
8 MiB; HTTP responses stage at most 4 MiB and propagate stream backpressure. Managed filesystem
sources adopt an already-authorized, already-verified regular-file handle and never reopen its
path. Every range checks the descriptor's device, inode, size, mtime, and ctime token. Path
replacement or in-place mutation therefore invalidates the active source rather than silently
redirecting reads. Full SHA-256 runs at registration and explicit final verification, not for
ordinary thumbnails or range reads. Hashing is incremental with one globally budgeted 8 MiB
buffer. Logical source size therefore does not determine resident memory.

The shared runtime budget manager separates reservations made before allocation from leases for
live resources. It uses strict FIFO backpressure, abortable waiters, idempotent release, and
current/peak diagnostics. Compressed read staging is capped at 32 MiB and canonical PCM windows at
8 MiB. Each production Mediabunny `StreamSource` reserves its complete 8 MiB cache from that
compressed budget until `Input.dispose()`. A separate admission cap permits at most three such
caches, preserving one 8 MiB read slot so cache admission cannot deadlock range staging; the
synchronous compatibility adapter has a zero-byte cache. The global decoded-pixel budget includes
source-resolution `CanvasSink` pools, preview
bitmaps, and thumbnail source/canvas surfaces:

| Reported device memory | Global decoded-pixel budget |
| --- | ---: |
| 2 GiB or less | 96 MiB |
| Unknown or between 2 and 8 GiB | 192 MiB |
| 8 GiB or more | 384 MiB |

`VideoFrameSession` reserves its complete source-resolution pool before constructing `CanvasSink`.
The preferred pool contains five frames; it shrinks before construction when the global cap cannot
hold five, and rejects a source when even one frame cannot fit. Session disposal retains that lease
until the input and iterator have physically unwound.

`FrameCache` is a strict resident-memory LRU. Its production budget derives from
`navigator.deviceMemory`:

| Reported device memory | Preview bitmap budget |
| --- | ---: |
| 2 GiB or less | 64 MiB |
| Unknown or between 2 and 8 GiB | 128 MiB |
| 8 GiB or more | 256 MiB |

The cache reserves global pixels before calling `createImageBitmap`, then commits only the actual
bitmap dimensions. Backend alignment receives a conservative reservation while local admission
uses the requested output size. An oversized bitmap is rejected before allocation where possible
and closed if an already-owned result must be rejected. Eviction removes lookup access immediately; a leased
bitmap remains resident until its last lease releases, and those deferred bytes continue counting
toward both the local and global hard caps. The cache therefore never admits a frame that would
exceed owned GPU memory.

Thumbnail generation uses the same global budget and owns its Mediabunny input and decoded sample.
Success, unsupported media, missing frames, draw/serialization errors, cancellation, and late
results all close the sample and input exactly once and release every reservation.

Preview decodes once at source aspect, downsizes the long edge to at most 1280 pixels in 32-pixel
buckets, and applies letterboxing in the shared compositor. Export uses the same contain geometry
at the final canvas size.

Visible requests take priority over speculative warmup. Each source session has at most one decode
in flight. Warmup is planned in project-frame space, can cross adjacent clip boundaries, and then
maps each frame to the owning source. While paused, the viewport renders only after playhead,
document, visibility, or resize invalidation; it does not maintain a perpetual animation loop.

## Derived waveform cache

Waveform keys contain source kind, immutable source fingerprint, peak-algorithm version, and bucket
resolution. Identical requests share one extraction. Each subscriber can leave independently; the
worker is aborted only when its final subscriber leaves.

The repository publishes transferable progressive snapshots without detaching the worker's live
accumulator. Completed peaks enter:

- a strict 32 MiB memory LRU; and
- a separate, best-effort 64 MiB IndexedDB database named `waptions-derived-waveforms`.

Blocked IndexedDB, private-mode restrictions, corrupt records, quota failures, and transaction
errors degrade to an in-memory miss. They never block project loading or make project data
nondurable. Derived peaks are not included in editor manifests or bundle exports.

## Export destinations and cancellation

The export button captures the File System Access picker in the direct user-gesture call stack. It
passes an already-authorized destination to `exportProject`; codec checks, fonts, decoders, and
encoders never attempt to open a permission prompt later.

On Chromium with the File System Access API, Mediabunny writes to a `StreamTarget`. Four MiB chunks,
one queued stream write, and the target's bounded staging keep application buffering below the
16 MiB design ceiling while propagating disk backpressure.

Other browsers use a Mediabunny `StreamTarget` backed by `BoundedMemoryExportFile`, a sparse
positional chunk store, only after conservative output-size preflight. The total allocation budget
is the lower of 512 MiB and the device-aware allowance:

| Reported device memory | Total memory budget | Maximum encoded file |
| --- | ---: | ---: |
| Unknown | 256 MiB | 128 MiB |
| 2 GiB or less | 96 MiB | 48 MiB |
| 4 GiB or less | 192 MiB | 96 MiB |
| 8 GiB or less | 384 MiB | 192 MiB |
| More than 8 GiB | 512 MiB | 256 MiB |

Half of the total budget is reserved for final `ArrayBuffer` and `Blob` creation, so the maximum
encoded-file size is half the reported allowance. Unsafe exports are rejected before allocating
the bounded store, with guidance to use direct-to-disk streaming, lower quality, or shorten the
edit. One `AbortSignal` crosses font loading, video decode, video/audio encoding, destination
writes, and finalization. Cleanup closes sources, sessions, output, and the destination
idempotently. A direct-to-disk streamed export does not allocate a downloadable artifact in memory.

## Persistence recovery

Durable timeline mutations pass through one finalizer that owns no-op detection, history,
revision/audio impact, and persistence enqueue. Transient drag previews do not consume durable
history or write IndexedDB.

A diarized speaker set uses one such durable mutation and therefore one history entry, revision and
persistence enqueue. Before applying a late network result, its guard compares the audible graph
and the exact anchored target-set projection, including relative member order, track signatures,
provenance and extension metadata. It deliberately ignores unrelated tracks and the global document
revision, but rejects audio edits or any mutation of a generated member. A stale result never
publishes a partial set.

The persistence coordinator keeps the newest failed V4 manifest and the exact typed `File` assets
needed by it. The status bar keeps `Changes not saved` visible after a transaction error. `Retry`
replays that retained request; the error clears only after a confirmed `saved` event. Manifest and
new source assets commit in one project-specific IndexedDB transaction, so a failed write leaves
the previous durable project reopenable.

## Diagnostics

`runtimeDiagnostics` stores local counters, gauges, and bounded timing aggregates for audio, video,
waveforms, and export. Media budget and source registries additionally publish frozen current/peak
byte, reservation, lease, queue, cancellation, invalidation, and close snapshots and expose
leak assertions for deterministic teardown tests. Hot paths batch updates and consumers pull
snapshots. Diagnostics do not send network telemetry, persist samples, or publish per-frame React
state.

## Decoder seam inventory

This inventory prevents direct whole-file decoder construction from reappearing unnoticed:

| Seam | Status and owner |
| --- | --- |
| Preview `VideoFrameSession` / `CanvasSink` | Migrated to `MediaByteSource`; source-resolution pool reserves the process-wide decoded-pixel budget before construction. |
| Preview `createImageBitmap` / `FrameCache` | Migrated; cache admission reserves globally before allocation and every owned bitmap closes exactly once. |
| Track inspection and audio extraction | Migrated through the bounded Mediabunny byte-source adapter; existing sample/output close-once terminals are preserved. |
| Thumbnail `VideoSampleSink` | Migrated and globally pixel-bounded; input, sample, and reservations close on every terminal. |
| Timeline audio decoder | Migrated; retained copied PCM reserves the shared PCM budget and oversized decoded samples fail before allocation. |
| Waveform `AudioSampleSink` | Migrated; decoding remains streaming, samples close per iteration, and mix chunks reserve shared PCM staging. |
| Editorial bounded PCM-window decoder | Migrated; verified byte sources are accepted, native support and channel-mix buffers reserve shared PCM staging, and no-audio returns zero PCM. |
| Export `BlobSource` / `CanvasSink` | Deliberately owned by the P5C render/export package, which must adopt the same process-wide decoded budget rather than a private cap. |
| Editorial full-source PCM `BlobSource` | Deliberately owned by the transcription package; the bounded refinement decoder in this package is already migrated. |
| Legacy video-cut WebCodecs frame source | Owned by the video-cut compatibility package and excluded from the preview/review runtime. It must be removed or adapted before that path is exposed to managed jobs. |

## Verification

The runtime contracts are covered by deterministic unit tests, direct execution of the shipped
AudioWorklet and waveform-worker entrypoints, committed-media Chromium tests, and an exported-WebM
round trip. Text adds an intercepted deterministic edit-max browser suite and a mandatory secure
live reference-service gate. See [testing.md](testing.md) for commands, fixtures, coverage
thresholds, and the optional developer-media stress suite.
