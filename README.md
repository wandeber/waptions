# Waptions

Waptions is a browser-based video and subtitle editor for assembling clips, editing linked or independent audio, timing captions, previewing the result, and exporting complete edits.

The public build runs without login and without bundled paid transcription providers. Users can run transcription locally in the browser or bring their own OpenAI-compatible transcription endpoint from the editor.

This project is fully built with AI assistance. It started as an experiment to see how far an AI-led development workflow could take a real browser video editor over time.

Production: [https://waptions.wande.dev](https://waptions.wande.dev)

## Features

- Local project storage in the browser through IndexedDB.
- Explicit multi-track video placement with gaps, cross-track overlaps, splitting, trimming, deletion, reordering, and linked audio waveforms inside each clip.
- Independent editable audio tracks for imported audio and audio separated from video clips, including move, trim, split, delete, mute, solo, gain, and fades.
- Resizable, internally scrollable timeline and a collapsible selection-aware media/subtitle inspector.
- Multi-track subtitle rendering on canvas.
- Unified source-backed Text editing across selected video tracks, with word correction, speaker overrides, ripple/absolute structure, margins, recovery, and silence removal independent from subtitles.
- Versioned project import/export through `.waptions` bundles, including legacy migration to the V4 editor document and content-addressed transcript sidecars.
- MP4 and WebM export with rendered subtitles and the same complete audio mix used by preview.
- Browser-local transcription with WebGPU-first execution and optional WASM fallback.
- User-configured OpenAI-compatible transcription endpoints.
- Optional browser-direct or server-proxied transcription requests.
- Optional whole-project speaker diarization with one reusable subtitle track per detected speaker.

## Public Defaults

The public release is intentionally self-hosting friendly:

- Authentication is disabled by default.
- Built-in paid transcription models are hidden by default.
- The visible transcription paths are browser-local transcription and the custom OpenAI-compatible transcriber.
- The project is licensed under MIT.

## Requirements

- Node.js `22.13.1` or compatible.
- PNPM `11.17.0` through Corepack.

```bash
corepack enable
pnpm install
```

Do not use NPM for this repository.

## Development

```bash
pnpm run dev
```

Open [http://localhost:59940](http://localhost:59940).

Useful checks:

```bash
pnpm run test:unit
pnpm run test:coverage
pnpm run test:coverage:critical
pnpm run fixtures:media:verify
pnpm exec tsc --noEmit
pnpm run lint
pnpm run build
pnpm run test:e2e
pnpm run test:e2e:text-editor-live
pnpm audit
```

`pnpm run test:verify` runs the complete CI-safe verification sequence: committed-fixture
validation, unit tests, both coverage gates, TypeScript, lint, production build, and Chromium E2E.
Its build and browser stages use per-invocation compiler and artifact directories, so the gate can
run alongside the normal development server and other verification processes. See
[`docs/testing.md`](docs/testing.md) for the exact test matrix and optional stress suite.

## Text-based video editing

The lower **Text** workspace edits source-backed video; it is separate from subtitle generation and
never creates or rewrites subtitle cues. Activation can select one or many unlocked video tracks.
Intervals connected to an overlap are reported and left as ordinary media, while every isolated
accepted clip enters one unified ordered narrative with its source-track badge intact.

Waptions prepares one canonical full-source mono PCM16 16 kHz request for every distinct source
profile. Cropped and repeated occurrences reuse that transcript through a verified request index
and immutable content-addressed body. The fixed production request uses
`qwen-1.7b-edit-max`, `verbose_json`, `stream=false`, and the `edit-max-v1` response contract.

Speech words and source-backed silence are independently selectable. Corrections are instance-local
and do not change timing. Structural commands support split, compatible merge, deletion, recovery,
insertion, cross-track reorder, explicit/global margins, optional quiet-assisted refinement, and
speaker display/overrides. Ripple mode closes or opens exact materialized duration; absolute mode
preserves unrelated starts and can leave project gaps. **Delete all silences** removes only
source-backed silence or untranscribed blocks, either across the document or on the selected
controlled track; arbitrary gaps and speech remain.

Video, independent audio, and subtitle targets can bind to exact transcript fragments. A separate
unbound target is auto-linked only when its temporal overlap identifies one unique anchor; ties stay
unlinked. Follow behavior is explicit and every lock/collision/stale failure is atomic.

Text preferences may remember endpoint, Browser/Server mode, language, and speaker-analysis choice.
Its API key exists only in the mounted setup component and is never stored in preferences, project
IndexedDB, history, transcript CAS/request index, bundles, URLs, or logs. **Regenerate** bypasses a
cache winner deliberately; normal reactivation and reload reuse the verified record.

## Transcription

Waptions supports two public transcription routes: a browser-local model and a user-configured OpenAI-compatible endpoint.

Waptions derives transcription work from the same audible graph used by preview and export. For
ordinary transcription, each linked-video or imported-audio source is transcribed once and its
retained words are remapped through every audible crop and placement. Muted and solo-suppressed
clips are skipped.

The subtitle-transcription modal remembers the selected route and every route-specific choice in browser-global
`localStorage`: custom enabled state, endpoint, model, request mode, API key and diarization toggle,
plus the local browser model, runtime, language and WASM-fallback choice. The additive records keep
the keys `waptions-custom-openai-compatible-transcription` and
`waptions-local-browser-transcription` for compatibility. These preferences do not enter project
IndexedDB manifests, history or `.waptions` bundles. Persisting an API key is convenient for a
local transcriber, but it is not secret storage: scripts on the same Waptions origin and browser
extensions may read it. If browser policy blocks preference storage, the current session remains
usable and the modal displays a generic warning without exposing the stored values.

This differs from the Text workflow above: its API key is session-only and never enters local
storage.

### Local Browser Mode

Local browser mode runs the ASR model on the user's device through `@huggingface/transformers`.

- Audio stays in the browser and is not uploaded to Waptions.
- WebGPU is preferred for usable performance.
- WASM fallback can be enabled from the modal for compatibility, but it can be much slower on long videos.
- The first run downloads the selected model into the browser cache.
- The stable public default is the local Whisper manifest.

The experimental Qwen/Mega-ASR validation path is hidden unless `NEXT_PUBLIC_ENABLE_EXPERIMENTAL_QWEN_BROWSER_ASR=true`. It tracks the forced-aligner candidate for future validation, but the public default remains local Whisper because the Qwen route is much larger and WASM execution may be impractical for normal users.

Waptions expects an OpenAI-compatible audio transcription endpoint, usually an endpoint shaped like `/audio/transcriptions`.

The editor lets users configure:

- Endpoint URL.
- Optional model name.
- Optional API key.
- Request mode: browser or server.
- Optional speaker diarization.

The custom endpoint has its own `custom-openai-compatible` route identity. It is distinct from the
built-in `whisper-1` identifier, including when paid providers are enabled.

### Speaker Diarization

Diarization is available only for the custom OpenAI-compatible route. When enabled, Waptions
renders one compact audio-only file from project time zero through the last audible contributor and
sends exactly one non-streaming request. This preserves leading and internal silence, so returned
speaker timestamps already use project time. Muted and solo-suppressed media does not contribute.

Speakers are ordered by their first chronological appearance. The first speaker reuses the active
subtitle track; later speakers reuse or create adjacent tracks. Running diarization again replaces
that anchored generated set, preserving track IDs where possible, adding only missing members and
removing only surplus generated members. The complete replacement is one Undo/Redo action. Empty
speech results leave existing tracks untouched; malformed responses, cancellation, network or
encoding failures, and edits to the audible graph or generated target set while the request is in
flight are rejected without partially applying tracks.

The mixed encoded file is held in browser memory and uploaded as multipart data. Long projects can
therefore hit browser codec, memory, upload or server-body limits; Waptions reports the failing
stage and does not impose a separate arbitrary duration limit.

### Browser Mode

Browser mode sends the multipart transcription request directly from the user's browser to the configured endpoint.

This is the best mode for local transcribers because `localhost` resolves on the user's own machine. The transcriber must allow CORS from the Waptions origin, otherwise the browser will block the request before Waptions can read the response.

### Server Mode

Server mode proxies the transcription request through the Waptions backend.

This avoids browser CORS, but `localhost` resolves on the Waptions server, not on the user's computer. In production, server-mode hosts must be explicitly allowlisted with `OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS` to reduce SSRF risk.

## Environment Flags

```bash
AUTH_ENABLED=false
NEXT_PUBLIC_AUTH_ENABLED=false
SHOW_PAID_TRANSCRIPTION_MODELS=false
NEXT_PUBLIC_SHOW_PAID_TRANSCRIPTION_MODELS=false
NEXT_PUBLIC_ENABLE_EXPERIMENTAL_QWEN_BROWSER_ASR=false
OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS=
```

Set both server and `NEXT_PUBLIC_` variants to `true` only when you intentionally want to restore login or built-in paid transcription models.

`OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS` accepts the production server-mode transcription hosts that the backend is allowed to contact. Keep it narrow.

When authentication is enabled, store `AUTHORIZED_EMAILS` as a Cloudflare secret instead of a plain Wrangler variable.

## Security Notes

- Do not commit API keys or transcription credentials.
- User-provided transcription hosts are a potential server-side request forgery vector when proxied by the backend.
- Browser mode keeps the request in the user's browser and relies on the transcriber's CORS configuration.
- Server mode must keep host allowlisting strict in production.
- Optional user API keys are stored in browser `localStorage` for the configured transcriber flow;
  treat that as a convenience for local use, not as shared secret storage. They are excluded from
  project manifests, history, bundles and application logs.
- Text-editor API keys are stricter session-only values. Only the configured endpoint, request mode,
  language, and speaker-analysis choice may persist; the Text key is excluded from browser storage,
  manifest/history, CAS/indexes, bundles, URLs, and logs.

## Video Timeline and Export

- Imported files remain in typed video and audio source catalogs while timeline clips reference cropped source intervals.
- V4 video clips have explicit track/start placement. Ripple commands compact affected intervals;
  absolute commands preserve unrelated starts and may leave gaps. Same-track clips cannot overlap.
- A video clip exposes its linked audio waveform inside the clip. **Separate audio** disables that embedded contributor and creates an independent audio clip at the same canonical placement.
- Imported audio creates an independent track at the playhead. Independent clips can be moved between tracks, trimmed, split, deleted, muted, soloed, faded, and mixed with clip/track gain.
- Preview audio is rendered through one 48 kHz `AudioWorklet`; no hidden media element competes with the timeline clock. Export uses the same immutable mix plan and DSP.
- The first imported video locks the project frame rate and canvas size. Sources with a different aspect ratio are contained with letterboxing.
- Content after the final video clip is exported as black video while subtitle or independent-audio tails remain active. Audio-only editing can continue after deleting every video clip, but visual export still requires a video clip.
- MP4 uses AAC audio and WebM uses Opus audio when the browser exposes the required encoders.
- Constant-frame-rate sources use frame-accurate source sampling. Variable-frame-rate sources use their inspected average packet rate as a best-effort seek grid.

The V4 graph, unified narrative, transcript CAS, links, bundle sidecars, and migration rules are
documented in [`docs/editor-document-v4.md`](docs/editor-document-v4.md). The legacy V3 contract is
retained in [`docs/editor-document-v3.md`](docs/editor-document-v3.md). Media runtime ownership, semantic
invalidation, cache budgets, export destinations, and persistence recovery are documented in
[`docs/media-runtime-architecture.md`](docs/media-runtime-architecture.md).

## Deployment

Cloudflare production deployment is configured through OpenNext and Wrangler.

```bash
pnpm run cf-deploy-production
```

The command builds the Next.js app for Cloudflare Workers and deploys the production environment defined in `wrangler.jsonc`.

## Project Notes

- Next.js App Router routes live under `src/app`.
- The dashboard is `/`; the editor is `/editor/[id]`.
- Timeline, playback, project, and video state live under `src/stores`.
- Frame-aware preview caching uses strict adaptive budgets and explicit bitmap leases in
  `src/lib/video-cache.ts` and `src/lib/frame-cache.ts`.
- Waveforms are versioned derived data stored outside project manifests and bundles.
- Export owns isolated decode sessions and streams directly to disk when the browser exposes the
  File System Access API; the download fallback is preflighted against a device-aware memory cap.
- Custom transcription helpers live under `src/lib/ai`.
- Agent instructions live in `AGENTS.md`.

## Acknowledgements

Waptions takes inspiration from the open-source web video editing ecosystem, including [OpenCut](https://github.com/opencut-app/opencut).

## License

MIT. See [LICENSE](LICENSE).
