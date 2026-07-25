# Managed media, review, and export integration

This directory contains the production adapters that keep host filesystem authority outside the
editor model. Public requests and Core snapshots contain immutable identities, verified descriptor
handles, staged destination capabilities, and artifact IDs. They never contain host paths, file
descriptors, internal capability IDs, or bridge URLs.

## Coordinator seams

### Probe and import

1. The coordinator issues a read-root grant and passes explicit relative or granted paths to
   `ManagedMediaToolService.probe`.
2. `PathGrantMediaAdapter` retains immutable private copies and returns path-free
   `VerifiedMediaHandleV1` values plus bounded technical stream/container metadata needed for
   import and review decisions. Probe is synchronous and returns `jobIds: []`.
3. For import, the coordinator implements `CoreMediaImportPort`. Its `importMedia` implementation
   must call the supplied `revalidate` callback inside the same non-replay persistence transaction
   that commits `EditorEngine.importMedia`, then call `commitAuthority` after that durable commit
   succeeds and before returning. Import handles remain pinned across this boundary, so expiry
   cannot invalidate an already-durable import. On failure, no source is marked committed.
4. Only a successful Core import makes a source available through
   `ManagedRenderSourceAdapter`. The integration layer never pre-publishes a separate source
   registry.
5. On coordinator recovery, rebuild each catalog entry from the persisted Core asset registration
   and managed source record with `PathGrantMediaAdapter.restoreCommitted`. Reopened media then
   uses the content-addressed retained copy while still revalidating the original read grant.

The coordinator must not invoke the revalidation callback when replaying an already committed
idempotency receipt. Replays return the stored receipt without reopening source authority.

### Review jobs

`ManagedMediaReviewJobHandler` is a durable job handler. It delegates analysis to `ReviewService`,
uses `NodeBoundedMediaProcessPort` for descriptor-only FFmpeg/FFprobe execution, and stages output
through `ArtifactRegistry.stage`. A successful job result contains `terminalPublication.artifacts`
but does not publish those artifacts.

The coordinator's terminal job transaction must:

1. revalidate the job lease and source descriptors;
2. atomically apply every staged artifact's `registryWrite` with the terminal job state and the
   `job.changed` event;
3. call each staged artifact's `accept()` only after that transaction commits; or `reject()` it on
   rollback.

`transcription-assisted` review is intentionally rejected by this handler. It belongs to the
transcription service because accepting it here without transcript material would create a fake
review result.

Visual review artifacts are inspected before staging: frame grids must be non-empty WebP at the
planned dimensions, and proxies must be temporally exact H.264 MP4 with the requested dimensions
and audio contract. Structured review artifacts are bounded, non-empty, valid JSON.

### Export jobs

The coordinator creates create-only staging with `PathGrantAuthority`, registers the public/private
pair in `PathGrantOutputAuthority`, and calls
`ProductionManagedExportJobService.prepare`. The handler writes and verifies only the private
staging inode. It returns a `ManagedExportTerminalProposal`; it never calls destination commit.
Each admitted export uses the canonical durable job kind `export:<exportKind>`.

For each `ManagedOutputCandidate`, the terminal job transaction must:

1. call `preparePublication` and retain the returned `StagedOutputPublication`;
2. atomically persist the output record, canonical export artifact `registryWrite`, terminal job
   result, then the ordered `artifact.created` and `job.changed` events from the proposal;
3. call `publication.accept()` and artifact `accept()` only after the transaction commits;
4. call `publication.reject()`, artifact `reject()`, and `candidate.abort()` after rollback or
   cancellation.

Every export kind stages an `export:<kind>` artifact containing the exact output bytes and digest,
so artifact list/get/range access works uniformly for rendered media, bundles, snapshots, and proof
records. On startup, call
`PathGrantAuthority.reconcileOutputPublications(sessionId, durableOutputRecords)` once before
loading output jobs. Recovery must scan journals, not only known durable outputs, so orphan
publications are rejected. Reconciliation failure is terminal and must not be hidden with
`Promise.allSettled`.

MP4 rendering consumes one `ResolvedRenderPlan` and verifies H.264/yuv420p video, AAC 48 kHz stereo
audio, duration, and frame count. `ExactRenderRouter` selects Chromium only when visible subtitle
composition requires browser-exact rendering. WebM uses the same MP4 scratch-render seam and a
bounded VP9/Opus transcode. Portable bundles stream generic entries into deterministic ZIP/ZIP64;
reference snapshots and proof records are canonical, digested, path-free projections.
Reference manifests omit provider extension records, and proof evidence records use versioned
closed field allowlists so an innocent-looking extension key cannot carry endpoint or secret data.

### Artifact access

`ManagedArtifactAccessAdapter` exposes metadata and bounded ranges. The HTTP bridge capability
requires an authenticated, live view context supplied by the coordinator; the adapter never
selects a view on the caller's behalf. Capabilities are short-lived and scoped to one session,
project, view, origin, method set, and artifact. Receipts and events contain artifact IDs only.

## Resource ownership

- Every process inherits already-open descriptors and runs with `shell: false`.
- FFmpeg/FFprobe concurrency, resident memory, stderr, stdout, progress, output, and wall time are
  bounded. Failure to verify live-process RSS fails closed.
- Source identity is checked before and after work. Revocation, inode replacement, or mutation
  aborts the operation.
- Staged outputs are create-only. Failure, cancellation, or recovery leaves no visible partial
  destination.
- Streams are consumed in bounded chunks; large media, transcripts, and artifacts are never placed
  inline in receipts or events.
