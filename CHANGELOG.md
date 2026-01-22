# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Timeline Ruler Refactor**: Implemented a 3-tier dynamic system (Dominant, Medium, Detail) that rotates prominence based on zoom level.
- Refined visual hierarchy: Only labeled markers (min. 200px apart) are full-height; frames and sub-intervals are grouped into a subtle "Detail" tier.
- Added frame highlight (shading) to the playhead for high-zoom precision.
- Conditional horizontal track separators: only show when `tracks.length > 1`.
- Aligned timeline background grid to the bottom of tracks to avoid ruler border overlap.
- **Subtitle Visibility Precision**: Standardized boundary logic using a 0.5ms epsilon to ensure start-inclusive and end-exclusive behavior.
- **Improved Keypoint Navigation**: ArrowUp/Down landing points now perfectly align with subtitle visibility boundaries.
- **Rounding Consistency**: Subtitle timings are now consistently rounded to 1ms during editing.
- **Project Previews**: Projects now show a proportional thumbnail of the first frame and the video duration in the dashboard.
- **Inline Name Editing**: Projects and layers can now be renamed directly by clicking on their titles, with support for undo/redo in layer name changes.
- **Virtualized Audio Waveform**: Added a high-performance audio waveform at the bottom of the timeline with support for extreme zoom levels (virtualized rendering).
- **Subtitle Snapping**: Added magnetic snapping to subtitle boundaries and playhead during displacement and resizing.
- **Architecture Cleanup**: Removed redundant `SubtitleTrack.tsx` and standardized the `Subtitle` interface in global types to improve maintainability.
- **Style Refinement**: Added 200ms entry/exit animations to the default style and renamed the "Edu Siverio" preset to "Mi Alter Edu".
- **Snapping Refinement**: Adjusted snapping threshold to 15px and optimized visual feedback (transparent lines, hidden for initial positions).
- **Playhead & Ruler Snapping**: Added "silent" magnetic snapping (no vertical line) to the playhead and ruler for precise navigation.

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
- Optimized playback and audio synchronization by implementing event-based syncing and a more resilient drift threshold (0.5s), resolving audio stuttering issues.
- Improved video decoding performance by increasing the frame cache pool size.
- Fixed redundant border in the timeline waveform container for a cleaner visual separation.

### Technical
- Added dependencies: `mediabunny`, `zustand`.
- Architecture: Migrated to Canvas-only rendering with `VideoCache`.
- Architecture: Decoupled playback, video metadata, and timeline state into stores.

## [0.1.0] - 2024-03-20

### Added
- Initial project setup with Next.js 14 and mediabunny integration.
- Base video editor and subtitle editing system.
- Playwright E2E test suite.