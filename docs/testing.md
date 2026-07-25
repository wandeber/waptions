# Testing

Waptions separates fast unit coverage, an enforceable critical-runtime profile, deterministic
Chromium scenarios, mandatory secure live Text acceptance, and an optional developer-media stress
test.

## Complete verification

```bash
pnpm run test:verify
```

This non-interactive command runs, in order:

1. committed media fixture checksum and stream verification;
2. deterministic tests for the coverage-gate tooling;
3. the complete unit suite under wider coverage and its exact recorded-ratio baseline;
4. critical-runtime coverage and hard thresholds;
5. TypeScript and ESLint;
6. the production Next.js build;
7. the fail-closed browser secret-containment regression; and
8. all configured Chromium E2E tests with the line reporter.

The latest HTML Playwright report is available separately through `pnpm run test:report`; it is not
part of the CI-safe aggregate command. Traces, screenshots, and videos are retained only for failed
tests, avoiding large artifact directories after successful media runs.

## Focused commands

```bash
pnpm run fixtures:media:verify
pnpm run test:tooling
pnpm run test:unit
pnpm run test:coverage
pnpm run test:coverage:critical
pnpm exec tsc --noEmit
pnpm run lint
pnpm run build
pnpm run test:e2e
pnpm run test:e2e:text-editor-live
```

The E2E package scripts ask the operating system for a free localhost port. Every invocation owns
unique `.waptions-next`, `test-results`, and `playwright-report` subdirectories plus an ignored
temporary tsconfig. Two E2E runs can therefore compile and retain failure evidence concurrently
without deleting each other's active files. They never reuse or terminate a listener on the
product's normal port, so browser verification can run while `pnpm run dev` continues serving
`localhost:59940`. `build:verify` uses a unique isolated output tree and temporary tsconfig for the
same reason; concurrent verification builds cannot affect each other, and the normal `build` and
`dev` commands keep their standard `.next` behavior.

Before Playwright fans out, the wrapper compiles the dashboard, editor, and login route families in
sequence. This prevents a lazy Next.js route compilation from rewriting the shared waveform-worker
chunk while another browser worker is starting it; the browser tests themselves remain parallel.

Failed browser artifacts remain under `test-results/<run-id>`, while each HTML run is stored under
`playwright-report/<run-id>`. `pnpm run test:report` opens the newest available HTML report and also
recognizes the legacy root-level report layout.

Use the package scripts rather than invoking `playwright test` directly. The Playwright config
fails fast without the wrapper-provided isolation variables, and deterministic tests use zero
retries in local and CI runs.

The repository intentionally has no fixture-generation command or install-time media downloader.
Replacing a committed fixture requires a separate supply-chain review, explicit provenance, and a
reviewed update to its manifest metadata and SHA-256. The normal verification path only reads the
committed files and executes the integrity-covered `ffprobe-static` binary packaged in its tarball.

## Coverage policy

`vitest.config.ts` measures the wider hooks, libraries, and stores. Its gate compares the precise
covered/total ratio for every metric against the recorded no-regression baseline. This rejects a
single newly uncovered item when the measured source total is unchanged; `pnpm run test:tooling`
locks that behavior down. It is not a claim that every browser adapter is meaningfully unit-testable.

`vitest.critical.config.ts` is the hard gate for deterministic replacement cores:

- pure editor commands;
- immutable export-job planning and cancellation helpers;
- leased frame-cache ownership and adaptive budgeting;
- batched runtime diagnostics;
- the timeline AudioWorklet protocol and queue model;
- waveform repository deduplication, cancellation, validation, and memory LRU; and
- immutable timeline-store snapshots.

The critical profile requires at least 85% statements, lines, and functions and 80% branches. The
last intentionally recorded measurement is stored in `coverage-baseline.json`; it is an audit
snapshot rather than the enforced threshold and may trail a newer local run. Integration-heavy
modules such as `export.ts`, `video-cache.ts`, decoder sessions, browser hooks, and Zustand
orchestration remain in the wider report and have focused error/ownership tests plus real-browser
verification. This keeps difficult behavior visible without replacing browser evidence with
mock-only line coverage.

## Deterministic browser media

The non-skipped E2E suite consumes the committed synthetic files under `e2e/fixtures/media`:

- a two-second red 320x180 VP9 clip with 440 Hz Opus audio;
- a two-second blue 320x180 VP9 clip with 660 Hz Opus audio; and
- a two-second mono 48 kHz WAV with an 880 Hz sine wave.

`manifest.json` records duration, codecs, dimensions, channel metadata, byte length, SHA-256, the
pinned generator versions, and fixture purpose. CI verifies committed bytes and uses no network or
runtime FFmpeg generation.

The media-runtime scenario exercises the real AudioWorklet across the clip boundary, changes the
mix during playback, pauses, seeks, resumes, and rejects page errors or post-prime underruns. The
export round trip downloads a real WebM, probes its video and audio streams, decodes PCM through
Chromium's Web Audio implementation to verify the expected 440, 660, and 880 Hz contributors,
samples known red and blue frames through a browser canvas, reimports it into a new project, waits
for its linked waveform, and plays from its audio clock. The persistence scenario injects one
transaction failure through the native IndexedDB prototype, restores it, retries from the status
bar, and reloads the durably recovered edit.

## Deterministic Text editor E2E

`e2e/text-editor.spec.ts` uses the committed VP9/Opus fixture and intercepts a browser-mode
`/v1/audio/transcriptions` request. It never starts a model and production code has no test route.
The exact response is committed at `e2e/fixtures/editorial/edit-max-v1-32000.json`; its name records
the fixture family, while its current timeline contains the media's exact 32,006-sample ceil-rounded
duration.

Run it alone with:

```bash
pnpm run test:e2e:verify -- e2e/text-editor.spec.ts
```

The scenario splits one 29.97 fps source on an exact native frame, activates both crops with one
full-source request, and asserts the fixed multipart fields, mono PCM16 16 kHz WAV, and exact sample
count. It then verifies source-backed speech/silence rows, word selection, instance correction,
Undo/Redo, document-scope Delete-all-silences, persistence/reload cache reuse, descriptor/body CAS
separation, canonical record hashing, bundle 4.0 sidecar hashing, and absence of the sentinel API
key from browser persistence and the bundle. Separate provider- and parser-failure cases prove no
record/index/narrative publication and reopen the previous project after reload.

Pure and store tests cover the larger combinatorial matrix without hiding browser integration:
V3 migration parity, multi-track overlap-component exclusion, unified cross-track ripple/absolute
placement, split/merge/recover/insert/margins, active-track silence scope, exact bindings and unique
overlap links, cancellation/stale/CAS/quota failures, pin/GC behavior, and bundle corruption/limits.
The deterministic browser test is the committed integration proof for those already-tested
contracts, not a replacement for them.

## Mandatory secure live Text E2E

`e2e/text-editor.live.spec.ts` runs only through the hardened runner and performs real
`qwen-1.7b-edit-max` inference. This is a release-closure gate in addition to every deterministic
command; a mock result does not satisfy it.

The runner accepts two required non-secret inputs:

- `WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_REPO`: absolute path to a clean authorized
  `lazy-whisper-api` checkout; and
- `WAPTIONS_E2E_TEXT_EDITOR_MEDIA`: absolute path to a short spoken video outside both repositories.

Optional platform inputs are
`WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_TEMPLATE` (an absolute tracked public template inside the
reference checkout) and `WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_PYTHON` (an absolute executable). The
default template is `.env.apple.example` and the default interpreter is the checkout's `.venv`
Python. A file named `.env`, an untracked/out-of-checkout template, dirty reference checkout,
in-repository media, or missing runtime fails before service startup.

```bash
WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_REPO="${LOCAL_LAZY_WHISPER_REPOSITORY}" \
WAPTIONS_E2E_TEXT_EDITOR_MEDIA="${LOCAL_SHORT_SPOKEN_VIDEO}" \
pnpm run test:e2e:text-editor-live
```

Do not pass a model, endpoint, API key, Authorization header, or persistent service credential.
`WAPTIONS_E2E_TEXT_EDITOR_MODEL`, `WAPTIONS_E2E_TEXT_EDITOR_ENDPOINT`, and
`WAPTIONS_E2E_TEXT_EDITOR_API_KEY` are rejected. The runner fixes the model, reserves its own
localhost ports, starts `python -m uvicorn whisper_api:app` with `shell: false`, and generates a
256-bit ephemeral credential. It never reads or sources the ignored reference `.env`.

The live browser asserts the exact WAV/multipart request and edit-max response contract, valid
words/regions/boundaries, descriptor-only manifest plus verified CAS hash, one materialized unified
narrative, a second activation with no ASR request, reload and Undo/Redo, short preview, real WebM
export, and bundle sidecar integrity. When `/healthz` advertises a ready diarization runtime, it also
runs a separate speaker-enabled request and validates the returned speaker catalog/segments.

The shared secure runner disables trace, video, screenshots, and Playwright AI copy capture. It
redacts child output chunk-safely, scans every raw and nested-ZIP artifact for the exact ephemeral
key, purges fail-closed on a match or incomplete inspection, stores browser profiles only under the
scanned temporary root, handles signals with bounded cleanup, and stops only its own Playwright,
Next.js, and reference-service processes. It compares both checkout statuses with their invocation
baselines; existing Waptions task changes are allowed, but the runner may add none.

If readiness cannot complete, report the checkout/clean-state result, sanitized startup or
readiness category, missing model/runtime/config/media prerequisite, cleanup result, and the
deterministic commands that passed. The implementation verdict remains blocked until the gate runs
or the user explicitly changes that requirement after seeing the blocker.

## Optional live speaker-diarization E2E

`e2e/transcription-diarization.live.spec.ts` verifies the real public editor workflow against one
fresh, runner-owned reference-service process. Run the containment regression first:

```bash
pnpm run test:e2e:diarization-security
```

This command deliberately produces a generic Playwright assertion failure after placing a random
sentinel in a password input and localStorage. The command itself succeeds only when trace, video
and screenshots are disabled, Playwright's AI copy-prompt capture is disabled, every retained raw
or nested-ZIP artifact is clean, and an independently injected ZIP leak causes complete
fail-closed purge. An exact non-secret completion marker distinguishes that intentional post-storage
failure from an earlier setup/browser failure. Pure sanitizer, streaming-redactor, signal-lifecycle
and artifact-guard tests also run through `pnpm run test:tooling`.

The live runner accepts three required, non-secret inputs:

- `WAPTIONS_E2E_DIARIZATION_REFERENCE_REPO`: an absolute path to a clean
  `lazy-whisper-api` checkout;
- `WAPTIONS_E2E_DIARIZATION_MODEL`: a timestamp-capable alias exposed by that checkout; and
- `WAPTIONS_E2E_DIARIZATION_MEDIA`: an absolute readable two-speaker media path outside both
  repositories.

Then run:

```bash
WAPTIONS_E2E_DIARIZATION_REFERENCE_REPO="${LOCAL_LAZY_WHISPER_REPOSITORY}" \
WAPTIONS_E2E_DIARIZATION_MODEL="${LOCAL_TIMESTAMP_MODEL}" \
WAPTIONS_E2E_DIARIZATION_MEDIA="${LOCAL_TWO_SPEAKER_MEDIA}" \
pnpm run test:e2e:diarization
```

Do not export or pass `WAPTIONS_E2E_DIARIZATION_ENDPOINT`,
`WAPTIONS_E2E_DIARIZATION_API_KEY`, `ASR_API_KEY`, `WHISPER_API_KEY`, an Authorization header or
any persistent credential. The old endpoint/key inputs are rejected. The runner generates a
256-bit base64url credential and its SHA-256 digest in memory, reserves a free localhost port, and
derives the endpoint itself. The raw key is installed only in the fresh API and Playwright child
environments and is absent from both the runner and isolated Next.js process environments. In
server mode, Next.js necessarily receives it transiently inside the editor's multipart proxy
request, parses it with the custom transcriber settings, and forwards it to the upstream service.

By default the runner parses the git-tracked, public `.env.apple.example` template and uses the
reference checkout's `.venv` Python. It never reads, sources, copies or displays the ignored
`.env`. For a documented alternative platform, the optional
`WAPTIONS_E2E_DIARIZATION_REFERENCE_TEMPLATE` may name an absolute git-tracked public template
inside the checkout, and `WAPTIONS_E2E_DIARIZATION_REFERENCE_PYTHON` may name an absolute
interpreter. A template named `.env`, an untracked/out-of-checkout template, an unavailable
interpreter, a dirty reference checkout or media inside either repository fails before spawning.

The runner launches `python -m uvicorn whisper_api:app` directly with `shell: false`. This is
required because the reference shell launcher sources its persistent `.env` after inherited
variables and could replace an ephemeral key. The runner authenticates `/healthz`, requires ready
local diarization runtime/model state, verifies the requested `/v1/models` alias, and never reuses
or stops a pre-existing service.

The editor scenario deliberately uses server mode because the reference local service has no
browser CORS contract. Here localhost resolves on the machine running the isolated Waptions server.
A deployed Waptions server resolves its own localhost instead, and production hosts still have to
pass `OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS`.

The test proves preference reload, stable active/sibling track IDs, chronological non-empty
speaker content, anchored provenance, exact atomic Undo/Redo, rerun reuse without duplicates or
orphans, explicit `stale: false`, and IndexedDB persistence after reload. It reads the durable V3
manifest directly because visible speaker names are editable and cannot prove identity. Preference
key checks hash the browser value with Web Crypto and compare only the runner-provided digest; the
raw key is never an evaluator parameter, assertion expectation, log or complete preference record.

Every live output/report lands first under one operating-system temporary root. The ephemeral key
and absolute, canonical, relative, or separator-normalized spellings of that root are hidden
chunk-safely in child output before inspection. Every raw file and decompressed nested ZIP entry is
then scanned for the exact key. A match, symlink, unreadable file, malformed/over-limit archive or
incomplete scan purges the entire root and fails generically. Clean success also removes the root.
Only the runner may print the real root, once, after a clean failed-run scan retains it for explicit
inspection and caller deletion. The secure isolated Next server also replaces request-handler
exceptions with a generic diagnostic; ordinary E2E runs retain their full Error-object logging.

Cleanup stops only the invocation-owned Playwright, Next.js and fresh reference-service processes,
removes isolated compiler state, waits a bounded time for `active_runs` to reach zero, and rechecks
that the reference checkout stayed clean. Do not immediately retry a `429`. Long projects create an
in-memory encoded mix and multipart upload, so use a small stable external two-speaker fixture for
this acceptance test.

## Optional stress media

`e2e/editor-audio.spec.ts` remains an optional stress test for longer or unusual local media. It is
skipped unless all three paths are present:

```bash
WAPTIONS_E2E_VIDEO_A=/absolute/video-a \
WAPTIONS_E2E_VIDEO_B=/absolute/video-b \
WAPTIONS_E2E_AUDIO=/absolute/audio \
pnpm test:e2e e2e/editor-audio.spec.ts --reporter=line
```

This suite intentionally keeps environment-driven inputs because its purpose is codec, duration,
and file-size stress beyond the small deterministic CI fixtures. Its skip is expected in the
normal full suite; all committed-fixture runtime and export tests must run without skips.
