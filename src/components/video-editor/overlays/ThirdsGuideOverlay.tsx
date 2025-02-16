interface ThirdsGuideOverlayProps {
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export function ThirdsGuideOverlay({ rect }: ThirdsGuideOverlayProps) {
  return (
    <div 
      className="absolute pointer-events-none"
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      }}
    >
      {/* Líneas verticales */}
      <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
      <div className="absolute right-1/3 top-0 bottom-0 w-px bg-white/30" />
      {/* Líneas horizontales */}
      <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
      <div className="absolute bottom-1/3 left-0 right-0 h-px bg-white/30" />
    </div>
  );
} 