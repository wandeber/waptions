# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Contains reusable UI components
  - `Button.tsx`: Base button component with variants (primary, secondary, danger, ghost) and sizes (xs to lg)

### Core Components
- `VideoEditor/`: Contains core components for video editing
  - `Timeline.tsx`: Video navigation timeline
  - `VideoViewport.tsx`: Main video viewer
  - `SubtitleEditor.tsx`: Subtitle editor
  - `SubtitleTrack.tsx`: Subtitle track in timeline
  - `FontSelector.tsx`: Subtitle font selector
  - `ExportButton.tsx`: Video export handling with FPS preservation from source video

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
- Maintain existing logs unless otherwise specified
- Document important decisions and acquired knowledge in this file
- Update CHANGELOG.md with each significant change

## Environment Setup
- Recommended Node.js version: v18+
- Use pnpm as package manager
- Required environment variables in `.env.local`

## Important Notes
- Project is in initial development phase
- Subtitle generation requires API key configuration 

## Visual Behaviors
### Timeline Component
- The timeline appears slightly lighter when no video is loaded due to the frame highlight overlay (bg-white/10) extending across the entire timeline when duration is 0.
- Once a video is loaded, the frame highlight positions correctly and the timeline shows its true background color. 

### Scrollbars
- Custom dark theme scrollbars using WebKit and Firefox styles in `globals.css`
- Track color matches panels using bg-gray-800 (#1f2937)
- Thumb color matches interactive elements using bg-gray-700 (#374151)
- Hover state uses bg-gray-600 (#4B5563)
- Slim design with 8px width/height and 4px border radius 

## Technical Details

### Video Processing
- FFmpeg WebAssembly integration for client-side processing
- Metadata extraction before loading:
  - FPS detection from video stream
  - Resolution and bitrate detection
  - Audio track extraction to WAV
- Performance optimizations:
  - Audio pre-extraction to avoid re-processing
  - Buffering management for smooth playback
  - Canvas-based subtitle rendering
- Memory management:
  - URL.revokeObjectURL() after video/audio blob usage
  - Cleanup of FFmpeg temporary files
  - Explicit resource disposal on component unmount

### Subtitle System
- Frame-accurate subtitle timing using detected video FPS
- Subtitle animation system:
  - Fade in/out with configurable durations
  - Scale animation with bounce effect
  - Dynamic font sizing based on video resolution
  - Smart punctuation handling for better readability 

## Gotchas & Key Points

### Video Handling
- FFmpeg puede fallar silenciosamente al procesar ciertos codecs - siempre validar output
- La detección de FPS no es 100% fiable - tener plan B usando tbr o fallback a 30fps
- Algunos navegadores limitan el acceso a SharedArrayBuffer - necesario para FFmpeg
- Safari tiene límites estrictos con WebAssembly - testar específicamente

### State Management
- El estado del vídeo y subtítulos debe mantenerse sincronizado entre Timeline y Viewport
- Los cambios en subtítulos deben esperar al siguiente frame para evitar parpadeos
- Cuidado con las race conditions al cargar/procesar vídeo y fuentes

### Browser Quirks
- Firefox: El evento 'ended' del vídeo a veces no se dispara - usar timeupdate como backup
- Safari: Problemas con drag&drop de archivos grandes - usar input file como fallback
- Chrome: Memory leaks si no se limpia bien SharedArrayBuffer 

### Debugging Tips
- Para problemas de rendimiento en subtítulos: Activar canvas.drawImage debug borders
- Si hay saltos en la línea de tiempo: Comprobar currentTime vs requestAnimationFrame
- Problemas de memoria: Monitorizar heap en Chrome con --enable-precise-memory-info

### Shortcuts & Commands
- Dev mode con debug UI: `?debug=true` en URL
- Forzar modo fallback FFmpeg: `?ffmpeg=fallback`
- Logs detallados: `localStorage.debug = '*'` 