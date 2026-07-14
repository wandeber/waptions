# Testing

Waptions separates fast unit coverage, an enforceable critical-runtime profile, deterministic
Chromium scenarios, and an optional developer-media stress test.

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
6. the production Next.js build; and
7. all configured Chromium E2E tests with the line reporter.

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
```

The E2E package scripts ask the operating system for a free localhost port. Every invocation owns
unique `.waptions-next`, `test-results`, and `playwright-report` subdirectories plus an ignored
temporary tsconfig. Two E2E runs can therefore compile and retain failure evidence concurrently
without deleting each other's active files. They never reuse or terminate a listener on the
product's normal port, so browser verification can run while `pnpm run dev` continues serving
`localhost:59940`. `build:verify` uses a unique isolated output tree and temporary tsconfig for the
same reason; concurrent verification builds cannot affect each other, and the normal `build` and
`dev` commands keep their standard `.next` behavior.

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
