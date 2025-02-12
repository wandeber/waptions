# Waptions - Project Knowledge

## Architecture

### Frontend
- **Framework**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Typing**: Strict TypeScript

### Design System
- `design-system/`: Contains reusable UI components
  - `Button.tsx`: Base button component with variants (primary, secondary, danger) and sizes (sm, md, lg)

### Core Components
- `VideoEditor/`: Contains core components for video editing
  - `Timeline.tsx`: Video navigation timeline
  - `VideoViewport.tsx`: Main video viewer
  - `SubtitleEditor.tsx`: Subtitle editor
  - `SubtitleTrack.tsx`: Subtitle track in timeline
  - `FontSelector.tsx`: Subtitle font selector
  - `ExportButton.tsx`: Video export handling

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