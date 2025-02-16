# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Contains reusable UI components
  - `Button.tsx`: Base button component with variants (primary, secondary, danger, ghost) and sizes (xs to lg)
  - `DraggableNumberInput.tsx`: Numeric input inspired by Blender's UI
    - Horizontal drag to change value (normal and fine control with Shift)
    - Arrow keys for value adjustment (normal and fine control with Shift)
    - Visual progress bar when min/max are defined
    - Double-click label or reset button to restore default
  - **Checkboxes**: Container with `flex items-center gap-2` for consistent alignment
  - **Accordion**: Smooth animation using `grid-template-rows` and `transition-[grid-template-rows]`
  - **Text Controls**: Icon-based buttons for text transformations and alignment, consistent style with `p-2 rounded` and hover states

### Core Components
- `VideoEditor/`: Contains core components for video editing
  - `Timeline.tsx`: Video navigation timeline
  - `VideoViewport.tsx`: Main video viewer
    - Subtitle rendering with useCallback requires all dependencies for proper updates
    - Careful management of dependencies in renderSubtitles to avoid stale state
    - Includes subtitles array in dependencies to update groups on add/remove
  - `SubtitleEditor/`: Subtitle editor module
  - `SubtitleTrack.tsx`: Subtitle track in timeline
  - `FontSelector.tsx`: Subtitle font selector
  - `ExportButton.tsx`: Video export with FPS preservation

### API Routes
- `/api/generate-subtitles`: Endpoint for automatic subtitle generation

## Development Guidelines

### Code Style
- Following C++ Core Guidelines and Bjarne Stroustrup's style
- Maximum 100 characters per line (aim for 80)
- Operators at the beginning of new lines in long expressions
- Comments always in English
- TypeScript in strict mode

### Best Practices
- Do not remove existing comments unrelated to current task
- Document decisions in this file
- Update CHANGELOG.md with each significant change
- Include all necessary dependencies in useCallback hooks to avoid stale state
- Pay special attention to array dependencies in useCallback to ensure proper updates

### React Hooks
- useCallback dependencies must include all variables used in the callback
- Arrays passed as props must be included in dependencies to detect changes
- When rendering depends on array content, include both array and array.length
- Avoid unnecessary re-renders by carefully managing dependencies

## Environment Setup
- Node.js v18+, pnpm, `.env.local` required

## Technical Details

### Video Processing
- FFmpeg WebAssembly for client-side processing
- Metadata extraction: FPS, resolution, bitrate, audio
- Performance optimizations and memory management
- Canvas-based subtitle rendering

### Subtitle System
- Frame-accurate timing using detected video FPS
- Configurable animations with fade and scale effects
- Smart text handling and dynamic font sizing
- Real-time grouping with proper state updates

### SubtitleEditor
Main features:
- Text editing with subtitle splitting/merging
- Style and animation configuration
- AI-powered subtitle generation
- Smart focus management
- Dynamic height textareas that adjust to content
- Style presets system with local storage
  - Non-removable "Edu Siverio" default preset
  - Save and load custom presets
  - Preset management (create, delete)
  - Local storage persistence
  - Handling of isDefault presets to avoid duplicates
  - Separated effects for preset loading and selection to prevent infinite loops

Keyboard shortcuts:
- `Enter`: Split subtitle and move focus
- `Ctrl+Enter`: Line break
- `Backspace` at start: Merge with previous
- `Delete`: Remove subtitle

## Gotchas & Key Points

### Video Handling
- FFmpeg: Validar output y tener fallbacks para FPS
- Limitaciones de SharedArrayBuffer en navegadores
- Safari: Límites con WebAssembly

### State & Browser Issues
- Sincronización entre Timeline y Viewport
- Firefox: Backup para evento 'ended'
- Safari: Fallback para archivos grandes
- Chrome: Limpieza de SharedArrayBuffer
- useCallback: Incluir todas las dependencias necesarias para evitar estado obsoleto

### Debugging
- Canvas debug borders para rendimiento
- Timeline: `currentTime` vs `requestAnimationFrame`
- Heap monitoring: `--enable-precise-memory-info`
- Dev mode: `?debug=true` en URL
- FFmpeg fallback: `?ffmpeg=fallback`
- Logs: `localStorage.debug = '*'`

## Testing E2E

The project uses Playwright for end-to-end testing. Main configuration:

- Tests are located in the `e2e/` directory
- Testing on three browsers: Chrome, Firefox and Safari
- Configuration in `playwright.config.ts`
- Automatic screenshots and videos on failure
- Detailed HTML reports

### Testing Commands

- `npm run test:e2e`: Run all tests
- `npm run test:e2e:ui`: Open Playwright's visual interface
- `npm run test:e2e:debug`: Run tests in debug mode

### Best Practices

1. Use data-testid for important elements
2. Keep tests independent
3. Verify critical components on each page
4. Test complete user flows
5. Document complex test cases

## Subtitles

### Positioning
- Subtitles can be positioned anywhere on screen using X and Y percentage coordinates
- Default position is X=50, Y=90 (center-bottom)
- Coordinates are relative to canvas size, where:
  - X=0 is left edge, X=100 is right edge
  - Y=0 is top edge, Y=100 is bottom edge

### Alignment
- Supports three alignment types: left, center, and right
- Alignment affects both text and its background
- Background automatically adjusts according to alignment to keep text contained
- X,Y position acts as anchor point for alignment:
  - Left alignment: text and background extend to the right
  - Center alignment: text and background are centered on the point
  - Right alignment: text and background extend to the left

### Multiple Lines Display
- Supports showing up to 3 subtitles simultaneously
- Subtitles are grouped deterministically based on line count and timing
- Empty handling:
  - Empty subtitles (only whitespace) are completely ignored
  - Empty lines within subtitles are skipped
  - Line count only considers non-empty lines
  - No rendering occurs if all lines are empty
- Group formation algorithm:
  1. Sort all subtitles by start time
  2. Process subtitles sequentially to form groups:
     - If subtitle exceeds max lines, it forms its own group
     - If adding subtitle would exceed group limit, start new group
     - Add subtitle to current group if space allows
  3. Find active group based on current time:
     - Group is active if current time is within its time range
     - Time range is from first subtitle start to last subtitle end
     - If no active group, show next upcoming group
- Groups appear and disappear together with synchronized animations
- Each group starts with the first subtitle and ends with the last one
- Transitions between groups are smooth with fade in/out effects
- Background adapts to accommodate all visible lines
- Vertical spacing between lines is 120% of font size for readability
- Group membership changes when:
  - Adding/removing subtitles
  - Changing numberOfLines setting
  - Modifying subtitle text content
  - Splitting or merging subtitles
- Group consistency:
  - Groups remain stable until content or settings change
  - Each subtitle belongs to exactly one group
  - Groups never overlap in time
  - Empty space at end of group is not filled with next subtitle
- Implementation details:
  - getSubtitlesGroup is memoized with useCallback
  - Dependencies include subtitles array and numberOfLines setting
  - renderSubtitles uses getSubtitlesGroup for consistent updates
  - State updates trigger proper group recalculation
  - Proper dependency management ensures groups update correctly 