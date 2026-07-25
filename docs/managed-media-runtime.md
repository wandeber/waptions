# Managed media runtime

The managed media package is a host-neutral foundation for coordinator jobs. It does not depend on
the MCP server, UI, project coordinator, or render implementation. Those packages inject
capabilities and consume its bounded descriptors and artifact references.

## Capability and identity boundary

`VerifiedMediaAccessPort` is the only import boundary. It lists opaque candidates inside an
existing read grant and returns an already-open, verified regular-file handle. Hashing, ffprobe,
the immutable source registry, and review jobs retain that handle; none of them resolve or reopen
the canonical path. The registry alone owns the canonical path, while the portable
`CoreMediaIdentity` contains only SHA-256 fingerprint and byte size.

Import reads the source in positional chunks of at most 8 MiB, reserves the process compressed-byte
budget before allocating its hash buffer, compares device/inode/size/mtime/ctime before and after,
and then probes the same descriptor. Candidate order uses NFC-normalized numeric natural sorting
with deterministic exact-name and opaque-ID tie breakers. Collection input is capped at 500
entries. Unsupported candidates do not consume the requested result count, and a failed concurrent
probe closes every prepared handle before the immutable registry publishes anything. Successful
imports swap the complete descriptor batch synchronously.

Replacing a stable source ID aborts active review signals immediately. Its old descriptor remains
open only until the final lease closes; new work sees only the new immutable identity. Ordinary
review acquisition rechecks the stat token and does not repeat a full-source hash.

## Review jobs and artifacts

`ManagedMediaReviewService` supports:

- contact sheets;
- thumbnail strips;
- waveform images;
- downsampled audio maps;
- silence/speech maps;
- scene-cut candidates; and
- selected-range H.264/AAC review proxies.

Every request contains explicit non-overlapping source ranges. One source descriptor is processed
sequentially through an abortable per-source queue because inherited file descriptors share an
open-file position. Probe and review services require the same injected process-wide limiter, so
different jobs can run concurrently without creating independent caps. FFmpeg receives `/dev/fd/3`; a source
path never appears in its arguments. Commands disable standard input, use one codec/filter thread,
cap frame counts and mux queues, limit captured stdout/stderr, enforce timeouts, and terminate on
cancellation or source replacement.

Audio-derived work on a source without audio returns `NO_AUDIO` and creates no fake waveform or
empty artifact. Visual work reserves estimated source frames and output surfaces from the same
process-wide decoded-pixel manager used by preview and render. Audio analysis reserves the shared
PCM manager. These managers are constructor dependencies rather than private per-job caps. They
provide a hard admission cap for application-owned decoded surfaces; they do not measure an
external FFmpeg process's resident set. Production hosts must pair the injected process port with
their worker, cgroup, or sandbox memory limit when untrusted media requires a hard RSS boundary.

Artifacts are content-addressed by source digest, normalized range, parameters, kind, managed
algorithm version, and the injected FFmpeg/toolchain version. `ReviewArtifactPort` supplies a
staged path and publishes only after success. The provided
filesystem implementation requires an already-authorized staging-grant capability, revalidates it
before staging and publication, and requires a private coordinator-owned root. Hostile writers with
access to that root are outside this path-based adapter's trust boundary; a multi-tenant host must
supply an openat-style `ReviewArtifactPort`. The adapter uses create-only hard-link publication,
streamed hashing with an 8 MiB compressed-budget lease, maximum file-size checks, and
cleanup on failure or abort. FFmpeg also receives the artifact limit before writing, and an existing
content-addressed object must match both the staged size and digest before reuse. External copying
or export remains the responsibility of a separate write-grant package.

## Diagnostics and ownership

The runtime exposes current and peak budget bytes, reservations, leases, queues, cancellations,
probe/review concurrency, streamed hash bytes, imports, replacements, active source leases,
published artifacts, `NO_AUDIO` results, and cleanup counts. `assertManagedMediaBudgetsDrained`
checks the shared managers, while `assertManagedMediaRuntimeDrained` also rejects retained sources,
leases, probe/import handles, and failed owned handles after tests or coordinator shutdown. A close
failure stays owned by its registry or probe/import service and makes that lifecycle gate fail; it
is never dropped merely because it was counted.

The caller owns each access capability until it transfers successfully into the source registry.
Probe-only and rejected candidates close immediately. The registry owns imported handles.
`Input.dispose()`, review completion, cancellation, source replacement, artifact publication, and
runtime shutdown each have one explicit terminal owner.
