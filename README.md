# Waptions

Waptions is a browser-based video and subtitle editor for assembling clips, editing linked or independent audio, timing captions, previewing the result, and exporting complete edits.

The public build runs without login and without bundled paid transcription providers. Users can run transcription locally in the browser or bring their own OpenAI-compatible transcription endpoint from the editor.

This project is fully built with AI assistance. It started as an experiment to see how far an AI-led development workflow could take a real browser video editor over time.

Production: [https://waptions.wande.dev](https://waptions.wande.dev)

## Features

- Local project storage in the browser through IndexedDB.
- Gapless multi-source video sequence with clip splitting, trimming, deletion, reordering, and linked audio waveforms inside each clip.
- Independent editable audio tracks for imported audio and audio separated from video clips, including move, trim, split, delete, mute, solo, gain, and fades.
- Resizable, internally scrollable timeline and a collapsible selection-aware media/subtitle inspector.
- Multi-track subtitle rendering on canvas.
- Versioned project import/export through `.waptions` bundles, including v1 and v2 migration to the V3 editor document.
- MP4 and WebM export with rendered subtitles and the same complete audio mix used by preview.
- Browser-local transcription with WebGPU-first execution and optional WASM fallback.
- User-configured OpenAI-compatible transcription endpoints.
- Optional browser-direct or server-proxied transcription requests.

## Public Defaults

The public release is intentionally self-hosting friendly:

- Authentication is disabled by default.
- Built-in paid transcription models are hidden by default.
- The visible transcription paths are browser-local transcription and the custom OpenAI-compatible transcriber.
- The project is licensed under MIT.

## Requirements

- Node.js `22.13.1` or compatible.
- PNPM `11.1.3` through Corepack.

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
pnpm exec tsc --noEmit
pnpm run lint
pnpm run build
pnpm exec playwright test --reporter=line
pnpm audit
```

## Transcription

Waptions supports two public transcription routes: a browser-local model and a user-configured OpenAI-compatible endpoint.

Waptions derives transcription work from the same audible graph used by preview and export. Each linked-video or imported-audio source is transcribed once and its retained words are remapped through every audible crop and placement. Muted and solo-suppressed clips are skipped.

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
- Optional user API keys are stored client-side for the configured transcriber flow; treat that as a convenience for local use, not as shared secret storage.

## Video Timeline and Export

- Imported files remain in typed video and audio source catalogs while timeline clips reference cropped source intervals.
- The video sequence is gapless: deleting, trimming, or reordering a clip ripples later video media and video-ripple subtitle timing.
- A video clip exposes its linked audio waveform inside the clip. **Separate audio** disables that embedded contributor and creates an independent audio clip at the same canonical placement.
- Imported audio creates an independent track at the playhead. Independent clips can be moved between tracks, trimmed, split, deleted, muted, soloed, faded, and mixed with clip/track gain.
- Preview audio is rendered through one 48 kHz `AudioWorklet`; no hidden media element competes with the timeline clock. Export uses the same immutable mix plan and DSP.
- The first imported video locks the project frame rate and canvas size. Sources with a different aspect ratio are contained with letterboxing.
- Content after the final video clip is exported as black video while subtitle or independent-audio tails remain active. Audio-only editing can continue after deleting every video clip, but visual export still requires a video clip.
- MP4 uses AAC audio and WebM uses Opus audio when the browser exposes the required encoders.
- Constant-frame-rate sources use frame-accurate source sampling. Variable-frame-rate sources use their inspected average packet rate as a best-effort seek grid.

The V3 document, timing domains, typed asset keys, migration rules, and audio resource lifecycle are documented in [`docs/editor-document-v3.md`](docs/editor-document-v3.md).

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
- Frame-aware preview caching lives in `src/lib/video-cache.ts`, `src/lib/frame-cache.ts`, and `src/lib/frame-utils.ts`.
- Custom transcription helpers live under `src/lib/ai`.
- Agent instructions live in `AGENTS.md`.

## Acknowledgements

Waptions takes inspiration from the open-source web video editing ecosystem, including [OpenCut](https://github.com/opencut-app/opencut).

## License

MIT. See [LICENSE](LICENSE).
