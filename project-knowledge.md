# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Reusable UI components (Button, DraggableNumberInput, Accordion, ConfirmDialog)
- **Icons**: Custom icons in `components/icons/` supporting `className` for Tailwind styling.
- **Dialogs**: Use `ConfirmDialog` for destructive actions (Delete, Exit Unsaved) instead of `window.confirm`.
- **Architecture Cleanup**: Removed redundant `SubtitleTrack.tsx` and standardized the `Subtitle` interface in global types.
- **Icon Standardization**: Replaced custom timeline icons with `lucide-react` counterparts for better visual clarity.

### Core Components
- `VideoViewport.tsx**: Canvas rendering, multi-layer subtitle support, audio sync.
- `Timeline.tsx`: Professional timeline with `TimelineStore` integration.
- `SubtitleEditor/`: Subtitle management with presets and AI transcription.

### API Routes
- `/api/generate-subtitles`: OpenAI Whisper integration via audio extraction.

## Technical Details

### Video Processing
- **mediabunny** (WebCodecs) for encoding and frame decoding (Preview & Export).
- **Video Cache**: Managed via `video-cache.ts` for fluid canvas rendering.
- **Audio Sync**: Hidden `<audio>` element synchronized with global `playback-store.ts`.
- **Export**: Hardware accelerated MP4 (H.264) with AAC audio transcoding.

### Timeline System (OpenCut style)
- **State Management**: `timeline-store.ts` (Zustand).
- **Multi-Track**: Supports multiple `SubtitleTrack` with independent `AnimationStyle`.
- **Zoom & Scroll**: Pixel-based positioning (`time * pps * zoom`).
- **Sync**: Linked scroll between Ruler, Sidebar, and Tracks via refs.
- **Ruler Markers (3-Tier Dynamic System)**:
    - **Tier 1 (Dominant)**: Full-height line (`h-full`) with time label. Spaced dynamically (min. 200px) to show 1-2 numbers at once.
    - **Tier 2 (Medium)**: Reduced-height line (`h-4`, `bg-gray-700/60`) for secondary intervals.
    - **Tier 3 (Detail)**: Shortest ticks (`h-1.5`, `bg-gray-800/80`) representing frames or divisions.
    - **Precision**: Sub-second ticks use floating point precision to ensure inclusion of the last frame before a Tier 2/1 marker.
- **Background Grid**: The horizontal separator lines in the timeline background are only shown when there are multiple tracks (`tracks.length > 1`). The separator is aligned to the bottom of each track (64px) to avoid visual overlap with the ruler's border.

### Subtitle Rendering
- Rendered directly on Canvas for high performance.
- Iterates over all visible tracks in `VideoViewport`.
- Supports animations (fade, scale), positioning (X, Y %), and smart grouping.

### Note on Persistence (IndexedDB)
- **Video Persistence:** Video files are stored in `waptions-timelines-{projectId}` -> `video-file`. `ProjectStore` loads the video into `VideoStore` on project open. `VideoViewport` automatically detects changes in `VideoStore.videoFile` and synchronizes metadata (duration, fps) to `PlaybackStore`.
- **Project Storage**: `ProjectStore` uses `storage-service` to save project metadata (`waptions-projects`) and timelines (`waptions-timelines-{projectId}`).
- **Timeline History**: `TimelineStore` implements manual undo/redo stack (`history` + `redoStack`) and auto-saves to IndexedDB on changes.
- **Text Editing Optimization**: Subtitle text changes are debounced (300ms) in `SubtitleEditor`. The first keystroke captures a history snapshot (state before typing), subsequent keystrokes update state with `skipHistory: true`. This groups a continuous typing session into a single undo step.

## Development Guidelines

### Best Practices
- **Strict Typing**: Avoid `any` except where absolutely necessary for legacy sync.
- **Resource Management**: Always call `sample.close()` on WebCodecs samples.
- **Hook Dependencies**: Ensure complete dependency arrays in `useCallback` to avoid stale state.
- **C++ Core Guidelines**: Apply Stroustrup's style for C++ flavored JS/TS code.

### Subtitle Visibility & Precision
- **Epsilon Strategy**: Comparison logic uses an epsilon of `0.0005` (0.5ms) to handle floating point precision issues.
- **Inclusive Start / Exclusive End**: Subtitles are visible if `currentTime >= start - epsilon` and `currentTime < end - epsilon`. This ensures the start of a subtitle is visible when landed on exactly, while the end is exclusive.
- **Keypoint Navigation**: `ArrowUp/Down` navigation in `Timeline.tsx` uses the same epsilon to identify boundaries, ensuring the playhead lands exactly on a frame where the subtitle state is predictable.
- **Rounding**: Subtitle timings are internally rounded to 3 decimal places (1ms) during editing (`TimelineTrackOverlay.tsx`) to maintain a clean timeline state.
- **Architecture Cleanup**: Deleted redundant `SubtitleTrack.tsx`. Centralized `Subtitle` interface in `@/types/timeline.ts`.
- **UI Standardization**: Replaced custom icons in the timeline components with standard `lucide-react` icons for better clarity and consistency.
- **Playhead Interaction**:
    - **Event Pass-through**: The playhead line uses `pointer-events: none` to allow users to interact with subtitles directly underneath it.
    - **Scrubbing**: Clicking the ruler or the track background (through the line) updates the time normally.
    - **Snapping**: Both playhead and ruler support magnetic snapping (15px threshold) to subtitle boundaries and video limits. This snapping is "silent" (no visual blue line) for navigation.
- **Subtitle Snapping**:
    - **Optimization**: Snap points are collected once at the start of a drag/resize operation (`handleMouseDown`) to ensure performance.
    - **Snap Points**: Include 0, duration, current playhead position, and start/end boundaries of all other subtitles across all tracks.
    - **Threshold**: 15px pixel-based threshold for consistent magnetic feel across zoom levels.
    - **Persistence**: Managed via `snapEnabled` in `TimelineStore`, defaulted to `true`.

## Environment & Testing
- Node.js v18+, pnpm.
- Playwright for E2E testing (`e2e/`).
- GitHub Actions for CI pipeline.