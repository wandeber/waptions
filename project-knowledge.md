# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Contains reusable UI components
  - `Button.tsx`: Base button component with variants (primary, secondary, danger, ghost) and sizes (xs to lg)
  - **Checkboxes**: Deben estar dentro de un contenedor con las clases `flex items-center gap-2` para mantener la alineación consistente con el label
  - **Accordion**: 
    - Usa `grid-template-rows` con valores `[0fr]` y `[1fr]` para animar el colapso/expansión
    - La transición se aplica con `transition-[grid-template-rows]`
    - Estructura anidada: grid > overflow-hidden > contenido
    - No requiere JavaScript para calcular alturas
    - Importante: El contenido debe estar envuelto en un div con padding para evitar saltos visuales

### Core Components
- `VideoEditor/`: Contains core components for video editing
  - `Timeline.tsx`: Video navigation timeline
  - `VideoViewport.tsx`: Main video viewer
  - `SubtitleEditor/`: Subtitle editor module
    - `index.tsx`: Main component that orchestrates the editor
    - `types.ts`: Types and constants
    - `TextStyleSection.tsx`: Text style configuration
    - `BackgroundSection.tsx`: Background style configuration
    - `AnimationSection.tsx`: Entry/exit animation configuration
    - `SubtitleList.tsx`: List of subtitles with editing capabilities
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

## Componentes del sistema de diseño

### Tabs
Componente reutilizable para crear pestañas en la interfaz. Se encuentra en `src/components/design-system/Tabs.tsx`.

Propiedades:
- `tabs`: Array de objetos con la siguiente estructura:
  - `id`: Identificador único de la pestaña
  - `label`: Texto a mostrar en la pestaña
  - `content`: Contenido JSX a mostrar cuando la pestaña está activa
- `activeTab`: ID de la pestaña actualmente activa
- `onTabChange`: Función que se llama cuando se cambia de pestaña
- `className`: Clases CSS adicionales para el contenedor principal

Ejemplo de uso:
```tsx
const tabs = [
  {
    id: 'tab1',
    label: 'Primera pestaña',
    content: <div>Contenido de la primera pestaña</div>
  },
  {
    id: 'tab2',
    label: 'Segunda pestaña',
    content: <div>Contenido de la segunda pestaña</div>
  }
];

<Tabs
  tabs={tabs}
  activeTab={activeTab}
  onTabChange={setActiveTab}
/>
```

### Accordion
Componente reutilizable para crear secciones colapsables. Implementa el patrón de diseño "Disclosure" permitiendo que solo una sección esté abierta a la vez.

Propiedades:
- `sections`: Array de objetos con la siguiente estructura:
  - `id`: Identificador único de la sección
  - `title`: Título de la sección
  - `content`: Contenido JSX a mostrar cuando la sección está expandida
- `expandedSection`: ID de la sección actualmente expandida (o null si ninguna lo está)
- `onSectionChange`: Función que se llama cuando se cambia la sección expandida
- `className`: Clases CSS adicionales (opcional)

Internamente usa un componente `AccordionItem` para renderizar cada sección.

Ejemplo de uso:
```tsx
const [expandedSection, setExpandedSection] = useState<string | null>(null);

<Accordion
  sections={[
    {
      id: 'section1',
      title: 'Primera sección',
      content: <div>Contenido de la primera sección</div>
    },
    {
      id: 'section2',
      title: 'Segunda sección',
      content: <div>Contenido de la segunda sección</div>
    }
  ]}
  expandedSection={expandedSection}
  onSectionChange={setExpandedSection}
/>
```

### SubtitleEditor
Módulo para la edición de subtítulos. Se encuentra en `src/components/video-editor/subtitle-editor/`.

Estructura:
- `index.tsx`: Componente principal que orquesta el editor
- `types.ts`: Tipos y constantes
- `TextStyleSection.tsx`: Configuración de estilo de texto
- `BackgroundSection.tsx`: Configuración de estilo de fondo
- `AnimationSection.tsx`: Configuración de animaciones de entrada/salida
- `SubtitleList.tsx`: Lista de subtítulos con capacidades de edición

Características principales:
- Edición de texto con soporte para división y unión de subtítulos
- Configuración completa de estilos visuales
- Animaciones de entrada y salida configurables
- Generación automática de subtítulos con IA
- Atajos de teclado para operaciones comunes

Atajos de teclado:
- `Enter`: Dividir subtítulo en la posición del cursor
- `Ctrl+Enter`: Insertar salto de línea
- `Backspace` al inicio: Unir con subtítulo anterior
- `Delete`: Eliminar subtítulo seleccionado 