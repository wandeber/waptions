# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Contains reusable UI components
  - `Button.tsx`: Base button component with variants (primary, secondary, danger, ghost) and sizes (xs to lg)
  - **Checkboxes**: Contenedor con `flex items-center gap-2` para alineación consistente
  - **Accordion**: Animación suave usando `grid-template-rows` y `transition-[grid-template-rows]`

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