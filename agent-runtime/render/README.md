# Headless render and export contract

This package is the WCE-PLAN-2 parity boundary for managed export. It deliberately separates
timeline interpretation from codec and process integration:

1. `createResolvedRenderPlan` synchronously clones, validates, and freezes a descriptor-only V4
   snapshot plus path-free immutable media identities.
2. Both backends consume the same `ResolvedRenderPlanV1`. Track ordering, exact frame boundaries,
   compositor geometry, subtitles, audio contributors, mute/solo, linked/detached audio, gain,
   fades, rational frame-rate conversion, and the content boundary are already resolved.
3. Chromium is the primary subtitle-composition backend. `CanonicalResolvedRenderStreamProducer`
   resolves every frame and bounded DSP window; `BoundedChromiumWebCodecsWorker` feeds only raw
   RGBA/PCM to the isolated encoder worker and owns cancellation plus forced termination. On Node,
   `NodeBoundedChromiumWorkerHostPort` selects deterministic FFmpeg raw-descriptor encoding because
   the packaged Chromium/WebCodecs surface cannot robustly write directly to a Node descriptor.
   Chromium remains authoritative for subtitle layout: subtitle pixels are already present in RGBA,
   so FFmpeg does not parse text, load fonts, or approximate captions.
4. FFmpeg is a fixed codec/mux fallback. `NodeFfmpegResolvedPlanExecutor` materializes canonical
   48 kHz stereo PCM to private bounded scratch first, then sends the encoder only raw RGBA plus
   seekable PCM/output descriptors. Source decoders receive one immutable seekable descriptor at
   a time; no process receives a manifest, path, subtitle text, or render plan.
5. `HeadlessExportService` verifies H.264/AAC MP4 duration, syncs, publishes create-only, and hashes
   the exact committed bytes through an owned staged-destination handle.

## Shared standalone parity seam

`src/lib/render-plan` is intentionally runtime-neutral. The standalone browser adapter and managed
headless renderer must both use:

- `createResolvedRenderPlan` for descriptor-first planning;
- `renderResolvedPlanFrame` for durable background, compositor, and subtitle paint order;
- the canonical `audioMixPlan` embedded in the resolved plan and the existing shared DSP helpers;
- `RenderMediaByteSourcePort` plus `acquireVerifiedRenderMediaSources` for bounded reads and
  immutable identity verification.

The standalone adapter may implement `RenderMediaByteSourcePort` with bounded `Blob.slice` reads.
It must not construct Mediabunny `BlobSource(file)` inside export. Managed adapters implement the
same port with descriptor/range capabilities. Neither adapter adds paths or browser `File` objects
to the render plan. This contract is the migration point for P3A to remove `src/lib/export.ts`'s
current independent timeline and `BlobSource(file)` interpretation.

The canonical V4 manifest field consumed here is:

```ts
renderBackgroundColor: string;
```

`renderBackgroundColor` is a lowercase six-digit hexadecimal color. Only legacy manifests where
the field is absent default to black (`#000000`); an explicitly invalid, undefined, or noncanonical
value fails closed. This isolated baseline predates the Core field, so headless temporarily reads
and validates it structurally without defining a second durable manifest extension.

## Capabilities and resource authority

An export request accepts only:

```ts
interface HeadlessExportTargetReference {
  version: 1;
  capabilityId: string;
  grantId: string;
}
```

The coordinator resolves that reference to `NodeStagedDestinationHandle`, an already-open,
descriptor-bound create-only destination. Reset, sync, inspection, publication, hashing, and sizing
stay on that handle. The adapter never receives a temporary path and never reopens a final path.
The grant authority must revalidate the parent and target immediately before create-only
publication and hash the exact committed object through the capability.

Every backend receives one injected `HeadlessRenderResourceBudgetPort` whose authority is
`process-wide-decoded-memory-v1`. This package does not instantiate a budget manager. Preview,
review, caches, Chromium, and FFmpeg must share the coordinator's single decoder/pixel authority.
The authority issues explicit reservation evidence covering source-resolution current/handoff
frames, output canvases, DSP buffers, and decoded contributor PCM. Platform decoders receive that
same evidence and their exact remaining byte cap before allocation. Worker/process limits and
diagnostics are checked before and after execution; cleanup has a bounded graceful deadline and a
forced worker/process termination path.

## Required integration dependencies

The following owners must provide concrete host bindings; this package defines narrow ports because
those runtime components are not present at this baseline:

- Core: merge its coordinated `renderBackgroundColor: string` field into this isolated baseline's
  `EditorDocumentV4`/`EditorManifestV4` types and validator. Headless can then use the typed field
  directly without changing its read-boundary semantics.
- Coordinator/media: issue path-free source identities and implement `RenderMediaByteSourcePort`
  over the shared verified media registry/range source.
- Coordinator/resources: inject its one global decoded-memory/decoder budget into both backends.
- Coordinator/paths: resolve grant/capability IDs to an already-open `NodeStagedDestinationHandle`
  and perform descriptor-bound create-only publication with parent/target revalidation.
- Shared contracts: replace the local media-identity and staged-destination imports with the final
  Core/Runtime-owned types when those integration commits land; do not create parallel adapters.
- Chromium host: bind the platform frame renderer used by
  `CanonicalResolvedRenderStreamProducer` to `renderResolvedPlanFrame` and load deterministic fonts
  by verified identity. Node uses `NodeBoundedChromiumWorkerHostPort`: it accepts only pre-composed
  RGBA and canonical PCM, sends them through fixed `pipe:` descriptors to a single bounded FFmpeg
  H.264/AAC MP4 encoder, and receives no manifest, subtitle text, source/output paths, or network
  protocol. The capability probe exposes this choice as
  `deterministic-ffmpeg-raw-descriptor`; direct Chromium/WebCodecs descriptor output remains
  unavailable with the packaged dependency set.
- Coordinator handles: bind `ImmutableSourceHandleResolverPort` and
  `NodeStagedOutputHandleResolverPort` to already-validated source/staged-output capabilities.
  These bindings issue fresh seekable descriptors and implement `assertCurrent`; they never expose
  paths to the backend.
- FFmpeg packaging: select packaged/versioned FFmpeg and FFprobe executables. The concrete Node
  runner fixes H.264/AAC arguments, bounds processes/RSS/stderr/progress, escalates TERM to KILL,
  and removes 0600 audio scratch on every terminal path. Licensing and platform packaging remain
  coordinator/release concerns.
- Verifier: use `NodeFfprobeMp4Verifier` with the same staged-output resolver. It reads the exact
  owned descriptor and reports H.264/AAC, yuv420p, 48 kHz stereo, frame count, and durations before
  create-only publication.
- Standalone P3A: adapt browser media to `RenderMediaByteSourcePort` and route standalone export
  through the same resolved plan and frame/audio producer instead of maintaining dual semantics.

No package or lockfile change is required for these contracts. Runtime executable selection,
font assets, coordinator grants, the shared media registry, and the global budget must be supplied
by their owning packages rather than recreated here.

The Node FFmpeg backend deliberately reports `CODEC_UNAVAILABLE` for any nonempty subtitle plan.
The current toolchain has no verified font bytes or libass compositor; Chromium remains the
canonical subtitle backend and FFmpeg never approximates subtitle layout.
