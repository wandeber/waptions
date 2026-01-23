# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Quality & Export
- **Intelligent Bitrate**: Implemented automatic bitrate deduction based on source quality for re-encoding overhead without wasting space.
- **Native Export Quality**: Fixed a VideoCache bug that could cap export resolution to 720p; now strictly uses native dimensions.
- **Enhanced Cache Memory**: Increased FrameCache limit to 1024MB to handle high-resolution frames without thrashering.
- **Strict Cache Isolation**: Separated preview and export cache targets to prevent visual interference during background tasks.

### Subtitle Improvements
- **MiAlterEdu Preset Update**: Changed the default font to "Inter Tight" Black (900) for a more premium look.
- **Enhanced Font Loading**: Updated the Google Fonts loader to support "Black" (900) weights and added "Inter Tight" to the popular fonts list.

### AI Transcription
- **Model Selection System**: Added a premium modal allowing users to choose between transcription models (e.g., precise OpenAI Whisper vs. faster variants).
- **Word-Level Precision**: The transcription engine now returns raw word-by-word timestamps, delegating sentence grouping to future advanced logic.
- **3-Layer Transcription Architecture**: Implemented strict separation between Raw Transcription (Immutable), Grouper WIP (Mutable), and Timeline Subtitles.
- **Independent Data Flow**: 
    - Initial transcript populates both Timeline and Grouper from Raw words.
    - "Agrupar" in modal resets the WIP layer from Raw words.
    - "Aplicar" in modal overwrites the Timeline layer from the WIP layer.
- **Real-Time persistence**: Every drag, merge, or text edit in the transcription grouper is now persisted to IndexedDB in real-time, preventing data loss across reloads.
- **Auto-Save Fixes**: Added missing save triggers in `setTracks` and `setTranscriptionState` to ensure all changes are committed to storage immediately.
- **Premium UI Refinement**: Standardized modal header and buttons with the application's premium aesthetic (gradients, rings, and backdrop-blur). Improved popover styling for the auto-group configuration. Renamed "Aplicar cambios" to "Aplicar" and ensured popover buttons follow the design system variants.
- **Stability Fix**: Resolved "Maximum update depth exceeded" infinite loop in `TranscriptionViewModal` by stabilizing callbacks with `useCallback`, memoizing subcomponents (`SortableWord`, `DroppableGap`), and adding safety guards to state synchronization effects.
- **Design System Fixes**: Added automatic content centering to the base `Button` component.
- **Backend Architecture**: Updated the `/api/generate-subtitles` endpoint to support model parameters and switched to `verbose_json` with `word` granularity.

### Video Performance & Rendering
- **Triple-Buffering Engine**: Implemented a professional rendering pipeline (Persistent Frame -> Offscreen Composer -> Viewport Blitter) that eliminates all cases of flickering/black flashes during seeks.
- **Dynamic Resolution Cache**: The `ImageBitmap` cache now automatically scales frames to match the visor size, reducing GPU memory usage by up to 80% on high-resolution videos.
- **GoP-Aware Burst Decoding**: Added "Burst Decoding" which pre-fills the cache with 5 frames around any seek target, making backward navigation over cached regions instantaneous.
- **Optimized Caching Structure**: Migrated caching keys from floating-point timestamps to discrete integer frame indices for $O(1)$ lookup and zero-jitter frame alignment.
- **Eviction Protection**: Implemented a protection mechanism to ensure the active frame is never evicted by the LRU policy during composition.
- **Subtle Cache Visibility**: Re-styled and moved the cache indicator to the bottom of the timeline ruler for a less intrusive but informative status view.

### Subtitle Improvements
- **Copy/Paste**: New support for `Cmd+C` (copy) and `Cmd+V` (paste). Preserves relative timing and multi-track distribution. Assets are pasted at the current playhead position.
- **Trimming Shortcuts**: Added `Q` and `W` keys to trim the subtitle under the playhead. 
    - **Gap Filling**: If pressed at a boundary or in a gap, it extends the previous (`Q`) or next (`W`) subtitle to meet the playhead.
    - **Auto-Deletion**: Subtitles are automatically removed if trimmed to less than one frame duration.
- **Performance Tuning**:
    - **Optimized Navigation**: Implemented memoized keypoint calculation for `ArrowUp`/`ArrowDown` jumps, ensuring instant navigation regardless of subtitle count.
    - **Rendering Efficiency**: Applied `React.memo` to all critical timeline components (`SubtitleBlock`, `TimelineTrackOverlay`, `TimelineRuler`, etc.), significantly reducing CPU usage during playback and scrolling.
    - **State Stability**: Stabilized all editor callbacks with `useCallback` to prevent unnecessary re-renders of the entire timeline tree.
- **Edit Shortcuts**:
    - `Enter`: Selects and focuses the subtitle under the playhead for immediate editing. If no subtitle is present, it **automatically creates a new one** on the active track and focuses its text editor.
    - `V`: Selects the subtitle under the playhead without giving focus to the text editor.
    - `Esc`: Removes focus from the subtitle editor to quickly return to timeline navigation.
- **Multi-Selection & Group Interaction (Refined)**:
    - **Precision Fix**: Refined detection logic with a 5ms buffer for `Q`, `W`, and `Enter`, ensuring reliable activation at exact frame boundaries.
    - **Selection**: Supports `Cmd+Click` (toggle) and `Shift+Click` (range) following Mac standards.
    - **Group Dragging**: Selected subtitles move together horizontally and vertically. Optimized history (single snapshot per move).
    - **Bug Fixes**: Resolved duplication issues during track shifts.
    - **Multi-Delete**: Correctly removes selections across tracks with `Backspace`/`Delete`.

- **Improved Font Selector**: Refactored the font selection system with a tabbed interface (App, System, Google Fonts).
- **Google Fonts Integration**: Added dynamic loading for over 1000 Google Fonts with manual search and automatic project-wide font management.
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
- **Independent Drag Preview**: Decoupled video preview from playhead movement during drag/resize events, allowing the playhead to serve as a fixed reference point.
- **Playhead Snapping**: The current playhead position now acts as a magnetic snap point during displacement and resizing operations.
- **Unified Toolbar UI**: Grouped all overlay toggles into a single "Capas y Guías" menu and standardized all toolbar buttons to match a consistent dimensions and icon sizing (18x18px).
- **Smart Toolbar Zoom**: Zoom buttons in the toolbar now anchor to the playhead position for a more intuitive and consistent editing experience.
- **Snapping Refinement**: Adjusted snapping threshold to 15px and optimized visual feedback (transparent lines, hidden for initial positions).

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