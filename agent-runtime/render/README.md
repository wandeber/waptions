# Headless render and export contract

This package is the WCE-PLAN-2 parity boundary for managed export. It deliberately separates
timeline interpretation from codec and process integration:

1. `createResolvedRenderPlan` synchronously clones, validates, and freezes a descriptor-only V4
   snapshot plus path-free immutable media identities.
2. Both backends consume the same `ResolvedRenderPlanV1`. Track ordering, exact frame boundaries,
   compositor geometry, subtitles, audio contributors, mute/solo, linked/detached audio, gain,
   fades, rational frame-rate conversion, and the content boundary are already resolved.
3. Chromium is the primary H.264/AAC MP4 backend. `CanonicalResolvedRenderStreamProducer` resolves
   every frame and bounded DSP window; `BoundedChromiumWebCodecsWorker` feeds only raw RGBA/PCM to
   the isolated encoder worker and owns cancellation plus forced termination.
4. FFmpeg is a fixed codec/mux fallback. `BoundedFfmpegResolvedPlanExecutor` sends FFmpeg only raw
   composed RGBA frames and canonical 48 kHz stereo PCM; the FFmpeg process never receives a
   manifest or render plan.
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
  `CanonicalResolvedRenderStreamProducer` to `renderResolvedPlanFrame`, load deterministic fonts by
  verified identity, and launch the fixed raw H.264/AAC encoder worker behind
  `BoundedChromiumWorkerHostPort`.
- FFmpeg host: bind `BoundedFfmpegProcessHostPort` to the packaged/versioned FFmpeg binary. Supply
  the platform frame renderer and contributor decoder to `CanonicalResolvedRenderStreamProducer`;
  it owns frame order, shared audio DSP, bounded PCM windows, and explicit silence tails. Licensing
  and platform packaging remain coordinator/release concerns.
- Verifier: implement `HeadlessMp4VerifierPort` with the packaged/versioned FFprobe integration.
- Standalone P3A: adapt browser media to `RenderMediaByteSourcePort` and route standalone export
  through the same resolved plan and frame/audio producer instead of maintaining dual semantics.

No package or lockfile change is required for these contracts. Runtime executable selection,
font assets, coordinator grants, the shared media registry, and the global budget must be supplied
by their owning packages rather than recreated here.
