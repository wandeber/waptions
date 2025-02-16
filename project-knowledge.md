# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Contains reusable UI components
  - `Button.tsx`: Base button component with variants (primary, secondary, danger, ghost) and sizes (xs to lg)
  - **Checkboxes**: Container with `flex items-center gap-2` for consistent alignment
  - **Accordion**: Smooth animation using `grid-template-rows` and `transition-[grid-template-rows]`
  - **Text Controls**: Icon-based buttons for text transformations and alignment, consistent style with `p-2 rounded` and hover states

### Core Components
- `VideoEditor/`: Contains core components for video editing
  - `Timeline.tsx`: Video navigation timeline
  - `VideoViewport.tsx`: Main video viewer
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

### SubtitleEditor
Características principales:
- Edición de texto con división/unión de subtítulos
- Configuración de estilos y animaciones
- Generación automática con IA
- Gestión inteligente del foco

Atajos de teclado:
- `Enter`: Dividir subtítulo y mover foco
- `Ctrl+Enter`: Salto de línea
- `Backspace` al inicio: Unir con anterior
- `Delete`: Eliminar subtítulo

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