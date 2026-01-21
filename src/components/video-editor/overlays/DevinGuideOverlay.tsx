interface DevinGuideOverlayProps {
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export function DevinGuideOverlay({ rect }: DevinGuideOverlayProps) {
  return (
    <div className="absolute inset-0 animate-fade-in z-30 pointer-events-none">
      <div
        className="absolute"
        style={{
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`
        }}
      >
        <img
          src="/overlays/devin-zone.png"
          alt="Devin Zone Guide"
          className="w-full h-full object-cover opacity-10"
        />
      </div>
      <div
        className="absolute bg-black/50 px-2 py-1 rounded cursor-pointer transition-all duration-200 hover:bg-black/70 pointer-events-auto"
        style={{
          left: `${rect.left + (rect.width / 2)}px`,
          top: `${rect.top + rect.height - 48}px`,
          transform: 'translateX(-50%)'
        }}
      >
        <a
          href="https://www.instagram.com/devinjatho"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-white hover:text-blue-300 transition-colors"
        >
          @devinjatho
        </a>
      </div>
    </div>
  );
} 