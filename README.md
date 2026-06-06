# Waptions

Waptions is a browser-based subtitle editor for creating, timing, grouping, previewing, and exporting captioned videos.

The public build runs without login and without bundled paid transcription providers. Users bring their own OpenAI-compatible transcription endpoint from the editor.

This project is fully built with AI assistance. It started as an experiment to see how far an AI-led development workflow could take a real browser video editor over time.

Production: [https://waptions.wande.dev](https://waptions.wande.dev)

## Features

- Local project storage in the browser through IndexedDB.
- Timeline-based subtitle editing with frame-aware playback and preview rendering.
- Multi-track subtitle rendering on canvas.
- Project import/export through `.waptions` bundles.
- MP4 export with rendered subtitles.
- User-configured OpenAI-compatible transcription endpoints.
- Optional browser-direct or server-proxied transcription requests.

## Public Defaults

The public release is intentionally self-hosting friendly:

- Authentication is disabled by default.
- Built-in paid transcription models are hidden by default.
- The visible transcription path is the custom OpenAI-compatible transcriber.
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

Open [http://localhost:3000](http://localhost:3000).

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
