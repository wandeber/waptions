# Deterministic media fixtures

These fixtures are synthetic and released under CC0-1.0. They contain no third-party footage,
recordings, personal data, or network-fetched media:

- `video-red-440hz.webm`: a 320x180 red VP9 video with linked 440 Hz Opus audio.
- `video-blue-660hz.webm`: a 320x180 blue VP9 video with linked 660 Hz Opus audio.
- `standalone-880hz.wav`: a mono 48 kHz PCM track containing an 880 Hz sine wave.

`pnpm run fixtures:media:verify` checks the committed SHA-256 hashes and probes their exact stream
metadata. This is the CI-safe path: it reads the committed fixtures and executes only the
`ffprobe-static` binary packaged inside its integrity-covered dependency tarball. The package has
no `preinstall`, `install`, or `postinstall` lifecycle.

The repository deliberately provides no fixture-generation or update command. Installing project
dependencies must not download an executable outside PNPM's tarball integrity boundary. Replacing
these binaries requires a separate supply-chain review and a reviewed update to `manifest.json`,
including generator provenance, stream metadata, byte lengths, and SHA-256 values.

The committed files were historically generated with `ffmpeg-static` 5.3.0 from the
[`eugeneware/ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) package under
GPL-3.0-or-later; this is provenance only and that package is not installed. `ffprobe-static` 3.1.0
is sourced from
[`joshwnj/ffprobe-static`](https://github.com/joshwnj/ffprobe-static) under its package's MIT
license. The pinned provenance is also recorded in `manifest.json`.
