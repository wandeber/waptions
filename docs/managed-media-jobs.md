# Managed media jobs

This package implements the WCE-PLAN-2 media import, probe, and review
algorithms without owning filesystem grants, coordinator persistence, editor
commands, subprocess spawning, or artifact paths.

## Security and ownership boundary

Media jobs never accept or reopen a path. The path-grant owner supplies an
opaque `sourceCapabilityId`, and `VerifiedMediaGrantPort.openSource()` returns
an already-open `VerifiedOpenMediaHandle`. The handle exposes only:

- an opaque handle ID;
- the durable source capability ID;
- a display name;
- a path-free immutable snapshot;
- an opaque process-input capability;
- an idempotent close operation.

The path owner must validate the read grant, canonical containment, descriptor
identity, file type, symlink/rename races, and grant revocation before returning
that handle. `revalidateOpenSource()` checks the same open descriptor; media
jobs never turn a display name or registry value back into a path.

`ImmutableMediaIdentity` is path-free. New probes begin with byte length and an
opaque stat identity, then add the streamed SHA-256 digest.
`RegisteredImmutableMediaIdentity` always includes that digest. Portable V4
documents should reference the resulting source ID/fingerprint only; the
managed source registry retains the capability binding.

Artifacts follow the same rule. `DurableArtifactPublicationPort.stageCreateOnly()`
returns an opaque `StagedArtifactCapability`. Processes receive its output
capability, not a path. The artifact owner enforces create-only grants,
temporary-file placement, fsync/rename publication, hashing, and partial-file
cleanup.

## Public integration ports

The package exports the following boundaries from `agent-runtime/media`,
`agent-runtime/review`, and `agent-runtime/source-registry`:

- `VerifiedMediaGrantPort`: lists granted directory capabilities, opens one
  verified handle, and revalidates that open handle.
- `MediaByteSourceFactoryPort` and `MediaByteSource`: supply bounded
  backpressured byte streams for hashing. The process-wide bounded-media owner
  may structurally bind its shared byte-source implementation.
- `BoundedMediaProcessPort`: runs the semantic `probe`, `frame-grid`,
  `audio-analysis`, `scene-analysis`, and `review-proxy` operations.
- `DecodedMemoryBudgetPort`: reserves decoded pixel residency from the one
  process-wide budget shared with preview, caches, render, and export.
- `ImmutableSourceRegistryPort<TPlacementRequest, TPlacementResult>`:
  revalidates every capability binding inside the registry/placement
  transaction, atomically registers the complete immutable source batch, and
  passes an optional typed placement request through unchanged.
- `DurableMediaJobPort`: persists bounded job transitions.
- `DurableArtifactPublicationPort`: finds cached content-addressed artifacts,
  stages create-only outputs, writes structured streams with backpressure, and
  commits one artifact batch atomically.
- `MediaDiagnosticsPort`: receives bounded queue, hash, read, cancellation,
  cleanup, invalidation, memory, and completion observations.

The engine/coordinator owner defines `TPlacementRequest` and its result.
`ManagedMediaImportService` does not import an engine schema and cannot publish
partial source registration before every selected source has passed hash,
probe, and identity checks.

## Process adapter contract

An adapter may use ffprobe and ffmpeg only behind `BoundedMediaProcessPort`.
The adapter must:

1. resolve only the supplied input and output capabilities;
2. spawn an argument vector with no shell;
3. enforce timeout, kill grace, input bytes, output bytes, stdout, stderr,
   buffered bytes, and peak resident-memory limits;
4. propagate stream backpressure and cancellation;
5. report physical byte ranges and decoded media-time ranges;
6. resolve or reject only after the child, pipes, decoder, and output handles
   are fully closed.

`executeBoundedMediaProcess()` aborts a timed-out adapter, validates every
reported gauge, rejects physical ranges outside the open source size, and
rejects decoded ranges outside the normalized used-range request. Tool and job
results contain descriptors and accounting only, never stdout, image bytes,
audio samples, proxy bytes, or local paths.

## Probe and import flow

`ManagedMediaProbeService` permits at most two full probes. One probe:

1. opens the verified source capability;
2. verifies the byte source and open-handle identity;
3. hashes the complete source sequentially with an 8 MiB maximum chunk;
4. invokes bounded ffprobe semantics through the process port;
5. parses only bounded container, video, and audio metadata;
6. revalidates the still-open source;
7. closes the byte source and open handle exactly once.

Source size, stat identity, or an available digest mismatch returns
`SOURCE_CHANGED` or `PATH_IDENTITY_CHANGED`. A valid video without audio still
probes and imports successfully.

Directory import filters unsafe names and known video-container extensions,
sorts by canonical NFC/case-folded natural tokens, then verifies actual video
streams through probing. Numeric chunks compare by significant digit length
and value, followed by leading-zero, canonical case, and capability-ID tie
breakers. Multi-source registration and the optional placement request cross
one atomic registry boundary.

## Review planning and publication

A review request must contain either explicit half-open integer microsecond
used ranges or a deliberate `{ kind: "full-source", confirmed: true }` scope.
Ranges are validated, sorted, merged, constrained to duration, and limited to 64
ranges and two hours of total reviewed duration. No algorithm invents edit
decisions or fixed cut timestamps.

Supported review artifacts are:

- bounded sequential WebP contact sheets;
- bounded WebP thumbnail strips;
- downsampled waveform and audio maps;
- thresholded silence and speech maps;
- deterministic local-maxima scene-cut candidates;
- selected-range MP4 review proxies.

Audio-dependent reviews return `NO_AUDIO` before staging when the source has no
audio. Scene candidates are review evidence only. Every artifact key hashes the
source SHA-256, normalized ranges and parameters, and
`managed-media-review-v1`. Artifact bytes and commit metadata intentionally omit
the registry source ID, so cache identity and cached content remain aligned
when two source records identify the same immutable bytes.

The runner stages all uncached artifacts, executes one bounded operation at a
time per job, revalidates the open source, and atomically commits the batch.
Failure or cancellation discards every uncommitted stage. Safe committed
content-addressed bytes are never deleted because a later descriptor check
fails. JSON analyses are streamed into the artifact port rather than returned
as job payloads.

At most two review jobs run concurrently. Before any video decode, the runner
reserves two source-resolution RGBA frames from the injected global decoded
memory budget. Frame-grid operations also reserve the complete uncompressed
output raster and reject excessive dimensions or raster bytes before staging.
The runner passes the lease ID to the process adapter and releases it after
every success, error, abort, replacement, and late result.

## Limits and tests

Hard defaults live in `MEDIA_JOB_LIMITS`. Important bounds include:

- 8 MiB streamed hash chunks;
- 4 MiB process/artifact backpressure buffers;
- two concurrent full probes;
- two concurrent review jobs;
- 64 contact-sheet frames;
- 120 thumbnail frames;
- 10,000 audio buckets;
- 5,000 scene samples and 200 returned candidates;
- 32 MiB image artifacts;
- 4 MiB structured analysis artifacts;
- 512 MiB and 15 minutes for review proxies.

Run the focused suite without changing the repository package scripts:

```bash
pnpm exec vitest run --config agent-runtime/vitest.config.ts
```

This package intentionally does not edit the root package manifest, which is
owned outside WCE-PLAN-2. Before integration, that owner must add the focused
configuration to the canonical test command (or invoke an equivalent dedicated
agent-runtime test script) so CI cannot skip these tests.

The suite covers adversarial filenames and natural sorting, streamed hashes,
audio-less video, atomic import, used-range normalization, every review type,
abort and timeout cleanup, source replacement, bounded process accounting,
global decoded-memory lease release, concurrency queues, and high-offset reads
from a logical 16 GiB sparse source without source-size-linear allocation.
