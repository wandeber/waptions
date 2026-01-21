# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Professional Timeline UI with zoom (Ctrl+Wheel) and horizontal scrolling.
- Multi-track subtitle support with independent styles per track.
- `TimelineStore` for centralized state management (zoom, scroll, tracks).
- Normalized Icon library with `className` support for consistent styling.
- Native Audio support in both preview and export projects (AAC transcoding).
- Optimized AI transcription flow (audio-only extraction for Whisper).
- Frame-rate detection and stabilization for smoother canvas rendering.
- Export options UI with format/quality selection (positioned below header button).

### Fixed
- Fixed high-speed audio extraction and transcoding to AAC/MP4 on the client.
- Fixed `AudioSample` resource leak in transcoding processes.
- Fixed Preview speed issues by unifiying timer loops in `playback-store`.
- Fixed Audio `AbortError` and race conditions in sync logic.
- Improved DraggableNumberInput focus management and keyboard controls.
- Improved subtitle grouping logic and dynamic textarea height adjustments.

### Technical
- Added dependencies: `mediabunny`, `zustand`.
- Architecture: Migrated to Canvas-only rendering with `VideoCache`.
- Architecture: Decoupled playback, video metadata, and timeline state into stores.

## [0.1.0] - 2024-03-20

### Added
- Initial project setup with Next.js 14 and mediabunny integration.
- Base video editor and subtitle editing system.
- Playwright E2E test suite.