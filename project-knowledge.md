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

## Environment & Testing
- Node.js v18+, pnpm.
- Playwright for E2E testing (`e2e/`).
- GitHub Actions for CI pipeline.