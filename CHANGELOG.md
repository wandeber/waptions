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
- **Project Dashboard**: New entry point to manage, load, and create projects.
- **Auto-Save & Dirty State**: Optimized "unsaved changes" warnings; timeline auto-saves to local DB.
- **Undo/Redo Support**: Full history stack implementation for Timeline (Ctrl+Z / Ctrl+Shift+Z).
- **Project Management**: Save/Load projects functionality with IndexedDB persistence.

### Fixed
- Fixed high-speed audio extraction and transcoding to AAC/MP4 on the client.
- Fixed `AudioSample` resource leak in transcoding processes.
- Fixed Preview speed issues by unifiying timer loops in `playback-store`.
- Fixed save button state race condition where auto-save would overwrite clean state.
- Improved "dirty state" detection with deep comparison to prevent false positives in UI warnings.
- Added Undo/Redo buttons to the Editor header for easier access.
- Optimized drag & drop history: dragging/resizing subtitles now creates a single history entry instead of one per frame.
- Added automatic video persistence: imported videos are now saved with the project and restored upon reloading.
- Fixed timeline duration persistence issue where new projects inherited the previous project's duration.
- Fixed infinite loop in video loading logic.
- Integrated video loading into Undo/Redo history: checking/unchecking videos is now a reversible action.
- Video loading now triggers "Unsaved Changes" state.
- Fixed stale video frame issue when importing a new video after undoing.
- Fixed audio missing when loading a saved project.
- Fixed history tracking for manually added subtitles (Undo/Redo now works for "+" button).
- Fixed Audio `AbortError` and race conditions in sync logic.
- Improved DraggableNumberInput focus management and keyboard controls.
- Improved subtitle grouping logic and dynamic textarea height adjustments.
- Standardized timeline layer buttons and icons using design system standards for consistency across the UI.
- Implemented debounced history for subtitle text edits: Typing now creates a single history entry per session, preventing undo stack flooding.
- Replaced native `confirm()` dialogs with custom `ConfirmDialog` for project exit and deletion, unifying the UI experience.
- Removed redundant global "Show/Hide Subtitles" button from timeline toolbar in favor of individual track visibility toggles.
- Refined timeline toolbar UI: Standardized play button size, consolidated time display format (current / total), and removed redundant FPS counter.
- Implemented dedicated timeline zoom controls: Zoom In/Out buttons and a Reset Zoom button to fit the entire video duration within the view.
- Enhanced Video Info Panel: Now displays video resolution and bitrate, alongside FPS and current time.
- Fixed positioning and visibility of "Devin" and "Thirds" guide overlays by correcting z-index stacking and layout context.
- Fixed timeline track misalignment by standardizing track height to 64px, perfectly matching the background grid and preventing cumulative vertical drift.

### Technical
- Added dependencies: `mediabunny`, `zustand`.
- Architecture: Migrated to Canvas-only rendering with `VideoCache`.
- Architecture: Decoupled playback, video metadata, and timeline state into stores.

## [0.1.0] - 2024-03-20

### Added
- Initial project setup with Next.js 14 and mediabunny integration.
- Base video editor and subtitle editing system.
- Playwright E2E test suite.