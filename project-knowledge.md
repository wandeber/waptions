# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Reusable UI components (Button, DraggableNumberInput, Accordion)
- **Icons**: Custom icons in `components/icons/` supporting `className` for Tailwind styling.

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