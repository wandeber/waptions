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
- **Icon Standardization**: All toolbar buttons use `lucide-react` icons (18x18px) for clarity.
- **Unified Sizing**: Toolbar elements (Play, Zoom, Snap, Overlays) use the standard `Button` component with matching `md` size (px-3 py-1).
- **Button Centering**: Added `justify-center` to the base `Button` component to ensure content is always centered, especially when using `flex-1`.
- **Loading State Isolation**: `ProjectStore` separates `isProjectLoading` (user-facing project opening) from `isListLoading` (background database refreshes). The `StatusBar` only reacts to `isProjectLoading`.
- **Navigation Safety**: `EditorPage` uses a `useRef` to track the last loaded ID, preventing redundant `loadProject` calls when a project is closed or renamed.
## [Unreleased]

### Added
- Storage info in Project Dashboard: Displays total app usage and alerts for orphaned data.
- Cleanup utility for orphaned timelines: Allows removing data from deleted projects.
- Database discovery logic in `IndexedDBAdapter`.

### Authentication & Privacy
- **Auth.js (v5)**: Uses Google Provider for authentication.
- **Database-less**: Sessions are JWT-based; no database adapter is used. Propagates profile image through `jwt` and `session` callbacks.
- **Whitelist**: Authorized emails are managed via `AUTHORIZED_EMAILS` environment variable.
- **Privacy**: Entire application is protected by middleware, redirecting unauthenticated users to `/login`.
- **Security**: Cloudflare Turnstile is integrated into the login flow.

### Centralized Shortcuts System
- **Registry**: All shortcuts are defined in `src/config/shortcuts.ts` with metadata (keys, descriptions, categories).
- **Execution Hook**: `useKeyboardShortcuts` implements a global listener that:
    - Automatically ignores events triggered from `input`, `textarea`, or `contenteditable` elements.
    - Prevents default browser actions for registered shortcuts.
    - Standardizes `cmd`/`ctrl` behavior across platforms.

### Core Components
- `VideoViewport.tsx**: Canvas rendering, multi-layer subtitle support, audio sync.
- `Timeline.tsx`: Professional timeline with `TimelineStore` integration.
- `EditorHeader.tsx`: Extracted top bar containing title navigation, undo/redo, and export actions.
- `SubtitleEditor/`: Subtitle management with presets and AI transcription.

### Logic & Utilities
- `lib/timeline-utils.ts`: Contains the "brain" of the timeline (transcription grouping algorithms, subtitle discovery logic). Allows stores to stay reactive and lightweight.
- `lib/export/`: Handle video encoding/muxing logic.

### API Routes
- `/api/generate-subtitles`: Multi-model endpoint returning raw **word-level** timestamps. Grouping logic is delegated to the client or separate processes.

## Technical Details

### Video Processing
- **mediabunny** (WebCodecs) for encoding and frame decoding (Preview & Export).
- **Video Cache**: Managed via `video-cache.ts` for fluid canvas rendering.
- **Audio Sync**: Hidden `<audio>` element synchronized with global `playback-store.ts`.
- **Export**: Hardware accelerated MP4 (H.264) with AAC audio transcoding.
- **Export Naming**: Filenames are dynamically generated from the active project's name, lowercased and slugified (e.g., `mi_proyecto_final.mp4`).

### Timeline System (OpenCut style)
- **State Management**: `timeline-store.ts` (Zustand).
- **Multi-Track**: Supports multiple `SubtitleTrack` with independent `AnimationStyle`.
- **Zoom & Scroll**: Pixel-based positioning (`time * pps * zoom`).
- **Infinite Timeline**: The timeline duration is no longer strictly tied to the video duration. It calculates its width based on the maximum of (video duration, last subtitle end time) + a 60-second buffer to allow for an "infinite" feel and easy item placement beyond current content.
- **Sync**: Linked scroll between Ruler, Sidebar, and Tracks via refs.
- **Ruler Markers (3-Tier Dynamic System)**:
    - **Tier 1 (Dominant)**: Full-height line (`h-full`) with time label. Spaced dynamically (min. 200px) to show 1-2 numbers at once.
    - **Tier 2 (Medium)**: Reduced-height line (`h-4`, `bg-gray-700/60`) for secondary intervals.
    - **Tier 3 (Detail)**: Shortest ticks (`h-1.5`, `bg-gray-800/80`) representing frames or divisions.
    - **Precision**: Sub-second ticks use absolute frame indices (`Math.round(time * fps)`) to ensure perfect alignment without any cumulative floating-point drift.
- **Background Grid**: The horizontal separator lines in the timeline background are only shown when there are multiple tracks (`tracks.length > 1`). The separator is aligned to the bottom of each track (64px) to avoid visual overlap with the ruler's border.

### Subtitle Rendering
- Rendered directly on Canvas for high performance.
- Improved video decoding performance by increasing the frame cache pool size.
- Fixed redundant border in the timeline waveform container for a cleaner visual separation.
- Iterates over all visible tracks in `VideoViewport`.
- Supports animations (fade, scale), positioning (X, Y %), and smart grouping.

### Note on Persistence (IndexedDB)
- **Video Persistence:** Video files are stored in `waptions-timelines-{projectId}` -> `video-file`. `ProjectStore` loads the video into `VideoStore` on project open. `VideoViewport` automatically detects changes in `VideoStore.videoFile` and synchronizes metadata (duration, fps) to `PlaybackStore`.
- **Resource Monitoring (Info Panel & Dashboard)**:
    - **Performance Metrics**: Shows resolution, fps, and bitrate in the editor.
    - **Resource usage**: 
        - **Editor**: Displays current project size, Video Cache memory, and JS Heap.
        - **Dashboard**: Displays total application storage and identifies "orphaned" databases (timelines without a project record) with an option to clean them up.
    - **Optimization**: Stats poll every 5 seconds. Heavy DB size checks are automatically paused during video playback (`isPlaying`) to avoid frame drops.
- **Subtitle Interaction**:
    - **Independent Drag Preview**: During dragging or resizing, the video viewport follows the interaction (`previewTime` in `PlaybackStore`) while the playhead remains fixed as a reference.
    - **Playhead Snapping**: The current playhead position is a mandatory magnetic snap point during move/resize operations.
    - **Multi-Selection**: Centralized in `TimelineStore`. Handles range (`Shift+Click`) and toggle (`Cmd+Click`) selection strictly following Mac standards.
    - **Copy/Paste**: Support for duplicating selections via `Cmd+C/V`. Preserves relative timing and track distribution. Pates starting at the playhead position.
    - **Edit Shortcuts**: `Enter` selects and focuses the subtitle under the playhead. If no subtitle exists at that point, it creates a new one (capped by next sub or 2s) and focuses it. `V` selects without focusing. `Esc` blurs the editor.
    - **Trimming Shortcuts**: `Q` and `W` keys allow fast trimming. If pressed at a sub boundary or in a gap, they **extend** the neighbor (previous for Q, next for W) to fill the space. Automatic deletion occurs if resulting duration < 1 frame.
    - **Group Dragging**: Selected subtitles move together horizontally and vertically, preserving relative positions. Optimized history (single snapshot per operation).
- **Styles and Presets**:
    - Default style ("Predeterminado") now includes a 200ms fade-in/out animation.
    - "Mi Alter Edu" uses **Inter Tight Black (900)** for high-impact cinematic vertical content.
    - Presets are managed via `presetUtils.ts` and synced across the UI and store.
    - **Manual Modification**: Selector automatically switches to "Estilo personalizado (sin guardar)" when a preset is modified, identifying custom styles via deep comparison.
- **Video Selection & Deletion**:
    - Video clips in the timeline are selectable. Clicking them sets `isVideoSelected: true` in `TimelineStore`.
    - Selecting a video clip deselects all subtitles and vice versa.
    - The `DELETE` keyboard shortcut handles video removal if `isVideoSelected` is true, keeping subtitles intact.
    - The waveform in `TimelineWaveform` is reactive and clears if `audioBuffer` is null (e.g., video deleted).
    - The file input in `VideoViewport` is reset after selection to allow re-importing the same file.
- **Font Selection System**:
    - **Tabbed Selector**: Organized into App (curated), System (local), and Google Fonts.
    - **Smart Auto-selection**: Automatically switches to the correct tab (App, Google, or System) based on the current font when opening the style panel.
    - **Dynamic Google Fonts**: Custom `google-fonts.ts` utility handles dynamic `<link>` injection for Google Fonts on demand. It supports weights 400, 700, 800, and **900 (Black)**.
    - **Persistence & Auto-loading**: `GoogleFontManager` automatically scans all tracks and loads required fonts from Google Fonts when a project is opened.
    - **Manual Search**: Supports searching by name; if a font is not in the popular list (~1000 fonts), typing the exact name allows direct loading from Google. Added **Inter Tight** to the popular fonts list.
- **Project Metadata**:
    - Automatic capture of the first frame (thumbnail) and video duration when a video is loaded.
    - Captures the frame respecting the original aspect ratio to avoid deformation.
    - Stored as base64 jpeg and seconds in the project metadata (IndexedDB).
    - Displayed in the `ProjectDashboard` for quick identification.
- **Project Structure**:
    - **Branding**:
        - **Tagline**: "Waptions | Subtítulos sin dolor".
        - **Logo**: Modern icon-only geometric symbol in `public/logo.png`. Used as favicon and app icon.
    - **Dashboard**: Located at the root route (`/`). Completely redesigned with a premium look (glassmorphism, gradient glows, real-time `SearchBar`, and interactive `ProjectCard` components).
    - **Editor**: Located at `/editor/[id]`. Dynamic route that loads a project by its ID from IndexedDB.
- **AI Transcription Engine**:
    - **Model Selection**: User can choose between models (OpenAI Whisper, Deepgram Nova 2, and Premium Whisper + GPT-4o + o4-mini).
    - **Providers**:
        - **OpenAIProvider**: Handles Whisper and GPT models.
        - **DeepgramProvider**: New provider using `@deepgram/sdk` for highly accurate and fast transcription (Nova 2).
    - **Premium Mode**: Uses a three-step flow:
        1. **Whisper**: Provides word-by-word timestamps.
        2. **GPT-4o (Transcribe & Diarize)**: Provides phrase-level text and speaker identification (diarization).
        3. **o4-mini**: Aggregates both inputs to correct Whisper text via GPT-4o context and group words into optimal subtitles (max 80 chars, silence gaps, no speaker mixing).
    - **Integration**: Uses `AIProvider` and `OpenAIProvider` ported from `rocket-project`, extended for audio.
    - **Modal Flow**: Configuration via `TranscriptionModal`.
    - **Audio Extraction**: Audio is extracted and transcoded to AAC/MP4 on the client before upload to minimize bandwidth.
- **Project Storage**: `ProjectStore` uses `storage-service` to save project metadata (`waptions-projects`) and timelines (`waptions-timelines-{projectId}`).
- **Timeline History**: `TimelineStore` implements manual undo/redo stack (`history` + `redoStack`) and auto-saves to IndexedDB on changes.
- **Text Editing Optimization**: Subtitle text changes are debounced (300ms) in `SubtitleEditor`. The first keystroke captures a history snapshot (state before typing), subsequent keystrokes update state with `skipHistory: true`. This groups a continuous typing session into a single undo step.

### Transcription & UX (Subtitle Grouper "Mode Sagrado")
- **Drag & Drop Engine**: Uses `dnd-kit` for high-performance sortable lists.
- **Sacred Order (Orden Sagrado)**: The grouper enforces strict chronological sorting.
    - **Locks**: Middle words are locked and cannot be dragged. Use dragging only to adjust boundaries.
    - **Constraints**: 
        - **First Word**: Can only be dragged **UP** (to join the previous line). Cannot create new lines (cannot drop on gaps).
        - **Last Word**: Can only be dragged **DOWN** (to join the next line or create a new line after by dropping on the gap below).
    - This ensures that time never flows backwards.
    - **Zero-Shift Footprint**: Expanded gaps have an exact height of **108px**, which perfectly accommodates the Gap (24px) + Line (60px) + Gap (24px) resulting stack.
    - **3-Layer Architecture**: Data is split into three strictly independent layers:
        1. **Raw Transcription (Immutable)**: Original word-level data. Never modified.
        2. **Grouper (Mutable WIP)**: Granular word badges. Persists manual merges/splits in real-time to storage. Resets ONLY if the user clicks "Agrupar" (resets from Raw).
        3. **Timeline (Final Subtitles)**: Subtitles on the track. Initialized from Raw on transcript, but overwritten by the Grouper ONLY when "Aplicar" is clicked.
    - **Directional Adjacency**: The **first word** of a group can only move UP. The **last word** can only move DOWN.
    - **Chronological Merging**:
        - Moving **UP** -> word appended to **END** of target.
        - Moving **DOWN** -> word prepended to **START** of target.
    - **Independent Persistence**: The grouper state (`transcriptionGroups`, `transcriptionContainerIds`) is synced in real-time to storage. This ensures WIP edits (merges, text changes) are preserved independently of timeline edits across reloads.
    - **Interaction**: They enforce a **200ms hover delay** before expanding and a **400ms collapse hysteresis**.
    - **Atomic Swap**: To prevent layout jumps during transition, gaps support an `isInstant` prop. When a drop is detected, the gap collapses to 24px in **0ms**, precisely as the new 60px line appears. This creates a mathematically perfect spatial exchange without component overlap.
    - **Drop Reliability**: `handleDragEnd` uses the `expandedGapIndex` state to lock the drop target, ensuring reliability even with pointer jitter.
    - **Stability & Performance**: Component hardened against infinite re-renders ("Maximum update depth exceeded") via strict `useCallback` stabilization of all event handlers, memoization of sortable sub-elements, and recursive update prevention in `useEffect` (deep comparing store state before sync).
- **Auto-Cleanup**: Groups (lines) are automatically deleted when their last word is dragged out. Creating a new group is done by dropping on a Gap.

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
- **Playback Limits**:
  - **`duration`**: Represents the total viewable/scrollable area (content + infinite buffer).
  - **`contentDuration`**: Represents the actual end of content (Max of video end and last subtitle end). Playback automatically stops here.
- **Waveform Rendering**:
    - Extracted as an `AudioBuffer` on video load via `useWaveform` hook.
    - Rendered on a `<canvas>` in `TimelineWaveform` using a unipolar upward style (vertical bars from bottom baseline) for high clarity.
    - **Virtualization**: To handle extreme zoom levels (e.g. 500%+), the rendering is virtualized. It only draws the visible segment to a viewport-sized canvas, avoiding browser limits on absolute canvas width.
    - Status: Automatically scales with `pps` and stays synchronized via a scroll listener on the tracks container. The top border was removed to avoid thickness issues with track separators.
    - **Optimization**: Snap points are collected once at the start of a drag/resize operation (`handleMouseDown`) to ensure performance.
    - **Snap Points**: Include 0, duration, current playhead position, and start/end boundaries of all other subtitles across all tracks.
    - **Threshold**: 15px pixel-based threshold for consistent magnetic feel across zoom levels.
    - **Persistence**: Managed via `snapEnabled` in `TimelineStore`, defaulted to `true`.

## Environment & Testing
- Node.js v13+, pnpm.
- Playwright for E2E testing (`e2e/`).
- GitHub Actions for CI pipeline.

## Browser Compatibility
- **Chrome / Edge**: Full support (primary development environment). Supports `performance.memory` for resource monitoring.
- **Safari**: Supported since version **16.4+** (MacOS Sonoma+ / iOS 16.4+).
  - **WebCodecs**: Required for frame-accurate decoding and encoding.
  - **OffscreenCanvas**: Used for background processing and performance optimization.
  - **ImageBitmap**: Used for GPU-accelerated video frame caching.
  - **Audio**: Safari's strict autoplay policy requires a direct user gesture (e.g., clicking Play) to unmute the internal audio engine.
  - **CSS**: Uses `backdrop-filter` which may require `-webkit-` prefixes in older Safari versions (Tailwind usually handles this if configured).
- **Firefox**: Limited support due to ongoing stabilization of WebCodecs.

## Deployment
- **Platform**: Cloudflare Workers
- **Domain**: `waptions.wande.dev`
- **Build Tool**: `@opennextjs/cloudflare` (OpenNext)
- **Configuration**:
  - `open-next.config.ts`: Configures R2 for incremental cache.
  - `wrangler.jsonc`: Defines worker name, compatibility flags (`nodejs_compat`), and R2 bucket bindings.
- **Workflow**:
  - `npm run cf-build`: Builds the Next.js app and adapts it for Cloudflare.
  - `npm run cf-deploy-production`: Builds and deploys to the production environment.
  - **Dependencies**: Uses `wrangler` for local preview and deployment.
## Performance Engineering

- **Timeline Render Loop**: The main `Timeline` component re-renders at ~60fps during playback because it receives `currentTime` as a prop. To maintain responsiveness, all sub-components (`TimelineRuler`, `TimelineTrackOverlay`, etc.) are wrapped in `React.memo`.
- **Navigation Optimization**: `ArrowUp`/`ArrowDown` navigation calculates "key points" from all tracks. This list is memoized with `useMemo` to ensure O(1) jump calculation during fast keyboard repeats.
- **SubtitleEditor State Sync**: The local `editingText` state in `SubtitleEditor.tsx` is synchronized with the `subtitles` prop to detect and reflect external edits (like merging words into groups in the transcription modal). It avoids overwriting the state while the user is actively typing.
- **Callback Stability**: All handlers passed from `Editor.tsx` to the timeline tree are wrapped in `useCallback` to prevent breaking memoization.

## Video Rendering & Caching Architecture

### Rendering Pipeline: Triple-Buffering
To eliminate flickering and black flashes during seeks or decoding delays:
- **Persistent Frame**: A hidden canvas that stores the last valid video frame. If the decoder is "seeking", the renderer repeats this frame instead of clearing to black.
- **Offscreen Composer**: Composes the final picture (video background + subtitles) in memory.
- **Atomic Blit**: Draws the finished composition to the main viewport in a single operation. This ensures that the user never sees intermediate states (like video without subtitles or a cleared canvas).

### High-Performance Caching
- **GPU-Stored Bitmaps**: Uses `ImageBitmap` (residing in GPU memory).
- **Discrete Frame Indexing**: Keys are generated as `` `${videoId}:${Math.round(timestamp * fps)}` `` for $O(1)$ lookup.
- **Dynamic Resolution**: Supports per-`mediaId` target resolution. The preview cache matches the visor size (capped at 1280px), while the **export process** sets its resolution to native quality immediately upon initialization.
- **Resolution Persistence**: Uses a `pendingResolutions` map to ensure that specific quality targets are applied even if the video sink is initialized asynchronously after the request.
- **Eviction Strategy**: LRU based on memory size (**1024MB** limit). Features a `lastAccessedKey` lock to protect the active frame from being evicted.
- **Intelligent Export Bitrate**: Automatically calculates the optimal export bitrate by deducing the source bitrate and applying multipliers (0.5x to 2.0x) with resolution-aware safety bounds (e.g., 0.5Mbps - 50Mbps for 1080p).
- **Sacred Frames Philosophy**: All time-to-frame calculations are standardized to use `Math.round(time * fps)` for total counts and snapping, while `Math.floor(time * fps + epsilon)` is used for indexing. This eliminates "phantom frames" at video boundaries and ensures perfect visual alignment of the playhead, ruler ticks, and clip edges.
- **Multi-Track Export**: The export process in `export.ts` iterates over all visible tracks and calculates the total duration based on the absolute end of the last subtitle, padding with black frames where the source video has ended.

### Navigation Optimization
- **Burst Decoding**: When a seek occurs, the `VideoCache` decodes a small burst (e.g., 5 frames) to fill the cache around the target. This makes scrubbing feel "sedosa" (silky) as surrounding frames become instant once a region is touched.
- **Backward Scrubbing**: Slow in compressed video (H.264) due to GoP structure. Caching the whole GoP converts inter-frame video into intra-frame performance for the user.
- **Visibility Indicator**: The timeline ruler displays cached segments in real-time using a subtle, translucent green bar at the bottom.
- **Video Cut Detection**:
    - **Architecture**: Modular pipeline matching Core/Detector/Adapter interfaces.
    - **Histogram HSV Grid Detector**: Calculates 3D HSV histograms (16x8x8 bins) across a **3x3 spatial grid**. Measures change via average Bhattacharyya distance across all 9 cells. This detects jump cuts and local motion that global histograms miss.
    - **WebCodecs Adapter (Mediabunny)**: Replaced `HTMLVideoElement` with a direct `mediabunny` decoding pipeline. Uses the `Conversion` API to intercept and analyze every single video sample (frame-accurate) without being limited by the browser's render loop or playback rate.
    - **UI Integration**: `VideoCutPopover` in the toolbar manages parameters and state.
    - **Visualization**: Cuts are rendered in the tracks area as white vertical lines (`z-0`, `opacity-10`) across all tracks, and registered as primary snap points.
- **Project Bundling (.waptions)**:
    - **Logic**: Implemented in `lib/project-bundle.ts` using `jszip`.
    - **Format**: A ZIP archive containing `metadata.json` and the original video file.
    - **Metadata**: Includes project info, timeline tracks, raw transcription state, and custom presets found in `localStorage`.
    - **Versioning**: Uses `PROJECT_BUNDLE_VERSION` (v1.0) to warn users about potential breaking changes when importing files from older/newer versions.
    - **Asset Handling**: Restores the video to IndexedDB during import and merges included presets with the user's local collection (avoiding name duplicates).
