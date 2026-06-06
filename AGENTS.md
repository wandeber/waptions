# Waptions Agent Guide

These instructions apply to the whole repository. This file replaces the old Cursor rules and the removed `project-knowledge.md`; do not recreate either one.

## Working Rules

- Keep every change scoped to the current task. Do not format unrelated files, remove unrelated comments, or opportunistically refactor code outside the requested area.
- Use English for all code, comments, documentation, filenames, commit messages, UI copy added to source files, and repository metadata.
- Use PNPM only. Do not use `npm install`, `npm run`, or package-lock files in this repository.
- Prefer `localhost` over `127.0.0.1` when a local URL is needed.
- Do not hardcode credentials, API keys, transcription endpoints, or deployment secrets.
- Leave comments for non-obvious code paths, especially security decisions, WebCodecs resource handling, cache invalidation, and transcription request routing.
- The worktree may already contain unrelated changes. Never revert, delete, or overwrite changes you did not make unless the user explicitly asks.

## Product State

- Waptions is a browser-based subtitle editor built with Next.js App Router, React 19, TypeScript, Tailwind CSS, Zustand, Mediabunny, and WebCodecs.
- The public release is MIT licensed and designed to run without login and without bundled paid transcription providers.
- The default public transcription path is a user-configured OpenAI-compatible `/audio/transcriptions` endpoint selected in the editor.
- The README acknowledges inspiration from OpenCut and the wider open-source web video editing ecosystem.

## Feature Flags

Authentication and paid transcription providers are hidden by default. Restore them only when both the server-side and public client-side flags are intentionally enabled.

```bash
AUTH_ENABLED=false
NEXT_PUBLIC_AUTH_ENABLED=false
SHOW_PAID_TRANSCRIPTION_MODELS=false
NEXT_PUBLIC_SHOW_PAID_TRANSCRIPTION_MODELS=false
```

- When authentication is disabled, `/login` redirects to `/` and `/api/auth/*` returns 404.
- When paid transcription models are hidden, backend subtitle generation must reject built-in paid provider models and accept only the custom OpenAI-compatible transcriber path.
- Production server-mode custom transcription hosts must be allowlisted with `OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS`.

## Transcription Routing

The transcription modal lets users configure an endpoint URL, optional model, optional API key, and request mode.

- Browser mode sends the multipart OpenAI-compatible request directly from the user's browser. It is the best mode for local transcribers because `localhost` resolves on the user's machine, but the transcriber must allow CORS from the Waptions origin.
- Server mode proxies through the Waptions backend. It avoids browser CORS, but `localhost` resolves on the Waptions server, not on the user's computer.
- Keep SSRF protections strict. In production, server-mode hosts must pass the allowlist in `src/lib/ai/openai-compatible-transcription-server.ts`.

## Architecture Notes

- App routes live under `src/app`. The dashboard is `/`; the editor is `/editor/[id]`.
- Client-side project persistence uses IndexedDB through the project and timeline stores.
- Timeline, playback, video, and project state live under `src/stores`.
- Video preview and export depend on frame-aware rendering in `src/lib/video-cache.ts`, `src/lib/frame-cache.ts`, and `src/lib/frame-utils.ts`.
- Preview frames are cached by discrete frame index, not raw timestamps, so playback and scrubbing can reuse warmed frames predictably.
- Always close WebCodecs and Mediabunny samples when code owns them.
- Custom transcription helpers live in `src/lib/ai/openai-compatible-transcription.ts` and `src/lib/ai/openai-compatible-transcription-server.ts`.

## Commands

```bash
corepack enable
pnpm install
pnpm run dev
pnpm run test:unit
pnpm exec tsc --noEmit
pnpm run lint
pnpm run build
pnpm exec playwright test --reporter=line
pnpm audit
pnpm run cf-deploy-production
```

- `pnpm run dev` starts the local Next.js app.
- `pnpm run test:unit` runs Vitest unit coverage.
- `pnpm exec tsc --noEmit` checks TypeScript without writing build output.
- `pnpm run lint` runs ESLint across the repository.
- `pnpm run build` builds the Next.js app.
- `pnpm exec playwright test --reporter=line` runs the E2E suite.
- `pnpm audit` checks dependency advisories through PNPM.
- `pnpm run cf-deploy-production` builds with OpenNext and deploys the production Cloudflare Worker with Wrangler.

## Validation Expectations

- For documentation-only changes, at least verify the touched files and keep the diff minimal.
- For TypeScript, React, auth, transcription, cache, timeline, or deployment changes, run the targeted unit tests plus `pnpm exec tsc --noEmit` and `pnpm run lint`.
- For user-visible editor or dashboard changes, verify the relevant route in a browser and capture screenshots when requested.
- For deployment-sensitive changes, run `pnpm run build` before deployment and use the existing Cloudflare scripts rather than ad hoc deploy commands.
