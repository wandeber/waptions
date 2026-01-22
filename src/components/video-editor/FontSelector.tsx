'use client';

import { useState, useEffect, useMemo } from 'react';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { POPULAR_GOOGLE_FONTS, loadGoogleFont } from '@/lib/fonts/google-fonts';

interface FontSelectorProps {
  value: string;
  onChange: (font: string) => void;
}

interface FontData {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
}

const APP_FONTS = [
  'Inter',
  'Montserrat',
  'Roboto',
  'Arial',
  'Helvetica',
  'Verdana',
  'Times New Roman',
  'Georgia',
  'Courier New',
  'Impact',
  'Comic Sans MS',
  'Tahoma',
  'Trebuchet MS',
];

type TabType = 'app' | 'system' | 'google';

interface FontItemProps {
  font: FontData;
  isActive: boolean;
  onSelect: (family: string) => void;
  shouldLoadPreview: boolean;
}

function FontItem({ font, isActive, onSelect, shouldLoadPreview }: FontItemProps) {
  const [ref, setRef] = useState<HTMLElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!ref || !shouldLoadPreview) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(ref);
    return () => observer.disconnect();
  }, [ref, shouldLoadPreview]);

  useEffect(() => {
    if (isVisible && shouldLoadPreview) {
      loadGoogleFont(font.family, true);
    }
  }, [isVisible, shouldLoadPreview, font.family]);

  return (
    <button
      ref={(el) => setRef(el)}
      onClick={() => onSelect(font.family)}
      className={`flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-600 text-left transition-colors ${isActive ? 'bg-blue-600/30 text-blue-400' : 'text-gray-200'
        }`}
      style={{ fontFamily: isVisible || !shouldLoadPreview ? font.family : 'inherit' }}
    >
      <span>{font.family}</span>
      {isActive && (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
}

export function FontSelector({ value, onChange }: FontSelectorProps) {
  const [activeTab, setActiveTab] = useState<TabType>('app');
  const [systemFonts, setSystemFonts] = useState<FontData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [hasSystemFonts, setHasSystemFonts] = useState(false);

  // Determine initial tab based on value
  useEffect(() => {
    if (!value) return;

    const determineTab = (): TabType => {
      // 1. App Fonts (standard web-safe + project defaults)
      if (APP_FONTS.includes(value)) return 'app';

      // 2. Popular Google Fonts
      if (POPULAR_GOOGLE_FONTS.includes(value)) return 'google';

      // 3. Check if we have a direct google font link already in the document
      const googleLinkId = `google-font-${value.toLowerCase().replace(/\s+/g, '-')}`;
      const previewLinkId = `google-font-p-${value.toLowerCase().replace(/\s+/g, '-')}`;
      if (typeof document !== 'undefined' && (document.getElementById(googleLinkId) || document.getElementById(previewLinkId))) {
        return 'google';
      }

      // 4. If it's in our already loaded system fonts (if user gave permission before)
      if (systemFonts.some(f => f.family === value)) return 'system';

      // 5. Fallback: If it's not in App/Popular Google, it's either a system font 
      // or a custom Google font. We'll default to 'google' for unrecognized fonts
      // because Google is the primary way users add new specific fonts.
      return 'google';
    };

    const targetTab = determineTab();
    if (targetTab !== activeTab) {
      setActiveTab(targetTab);
      // Auto-load system fonts if that's the determined category
      if (targetTab === 'system' && !hasSystemFonts && !isLoading) {
        loadSystemFonts();
      }
    }

    // If we are on Google tab and the value is not in popular fonts,
    // set search term to value so the "custom" entry appears and is selected.
    if (targetTab === 'google' && value && !POPULAR_GOOGLE_FONTS.includes(value) && !searchTerm) {
      setSearchTerm(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, hasSystemFonts]); // Only run when value or system font availability changes

  // Load Google Font for the current value if it's likely a Google Font
  useEffect(() => {
    if (value && !APP_FONTS.includes(value)) {
      loadGoogleFont(value);
    }
  }, [value]);

  const loadSystemFonts = async () => {
    if (!('queryLocalFonts' in window)) {
      setError('Tu navegador no soporta la carga de fuentes locales');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryLocalFonts = (window as any).queryLocalFonts;
      if (!queryLocalFonts) {
        throw new Error('queryLocalFonts not found');
      }
      const fontList = await queryLocalFonts();

      const uniqueFonts = Array.from(
        new Map(fontList.map((font: FontData) => [font.family, font])).values()
      ).map((font) => ({
        family: (font as FontData).family,
        fullName: (font as FontData).fullName,
        postscriptName: (font as FontData).postscriptName,
        style: (font as FontData).style
      }));

      uniqueFonts.sort((a, b) => a.family.localeCompare(b.family));

      setSystemFonts(uniqueFonts);
      setHasSystemFonts(true);
      setError(null);
    } catch (err) {
      console.error('Error al cargar las fuentes:', err);
      if (err instanceof Error && err.name === 'SecurityError') {
        setError('No se ha permitido el acceso a las fuentes locales');
      } else {
        setError('Error al cargar las fuentes del sistema');
      }
      setHasSystemFonts(false);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredFonts = useMemo(() => {
    let baseList: string[] = [];
    if (activeTab === 'app') {
      baseList = APP_FONTS;
    } else if (activeTab === 'google') {
      baseList = POPULAR_GOOGLE_FONTS;
    } else {
      return systemFonts.filter(f =>
        f.family.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    const filtered = baseList.filter(f =>
      f.toLowerCase().includes(searchTerm.toLowerCase())
    );

    // If on Google tab and no matches, but there is a search term, allow "Custom" entry
    if (activeTab === 'google' && searchTerm && !filtered.some(f => f.toLowerCase() === searchTerm.toLowerCase())) {
      return [searchTerm, ...filtered].map(f => ({ family: f }));
    }

    return filtered.map(f => ({ family: f }));
  }, [activeTab, searchTerm, systemFonts]);

  const handleFontSelect = (fontFamily: string) => {
    if (activeTab === 'google' || (activeTab === 'app' && POPULAR_GOOGLE_FONTS.includes(fontFamily))) {
      loadGoogleFont(fontFamily);
    }
    onChange(fontFamily);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Tabs */}
      <div className="flex bg-gray-800 p-1 rounded-lg">
        <button
          onClick={() => setActiveTab('app')}
          className={`flex-1 py-1 px-2 text-xs font-medium rounded-md transition-colors ${activeTab === 'app' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
            }`}
        >
          App
        </button>
        <button
          onClick={() => {
            setActiveTab('system');
            if (!hasSystemFonts) loadSystemFonts();
          }}
          className={`flex-1 py-1 px-2 text-xs font-medium rounded-md transition-colors ${activeTab === 'system' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
            }`}
        >
          Sistema
        </button>
        <button
          onClick={() => setActiveTab('google')}
          className={`flex-1 py-1 px-2 text-xs font-medium rounded-md transition-colors ${activeTab === 'google' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
            }`}
        >
          Google
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={activeTab === 'google' ? "Buscar o escribir nombre..." : "Buscar fuente..."}
            className="w-full bg-gray-700 text-white rounded px-3 py-2 text-sm border border-gray-600 focus:border-blue-500 outline-none transition-colors"
          />
          {isLoading && (
            <div className="absolute right-3 top-2.5">
              <SpinnerIcon className="w-4 h-4 animate-spin text-gray-400" />
            </div>
          )}
        </div>

        <div className="bg-gray-700 rounded-md overflow-hidden max-h-[200px] overflow-y-auto border border-gray-600">
          {activeTab === 'system' && !hasSystemFonts && !isLoading && (
            <div className="p-4 text-center">
              <button
                onClick={loadSystemFonts}
                className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md transition-colors"
              >
                Permitir acceso a fuentes locales
              </button>
              {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            </div>
          )}

          {activeTab === 'system' && isLoading && (
            <div className="p-8 flex flex-col items-center gap-2 text-gray-400">
              <SpinnerIcon className="w-6 h-6 animate-spin" />
              <span className="text-sm">Escaneando fuentes del sistema...</span>
            </div>
          )}

          <div className="grid grid-cols-1">
            {filteredFonts.map((font) => (
              <FontItem
                key={`${activeTab}-${font.family}`}
                font={font}
                isActive={value === font.family}
                onSelect={handleFontSelect}
                shouldLoadPreview={activeTab === 'google' || (activeTab === 'app' && POPULAR_GOOGLE_FONTS.includes(font.family))}
              />
            ))}

            {filteredFonts.length === 0 && !isLoading && (
              <div className="p-4 text-center text-gray-500 text-sm italic">
                No se encontraron fuentes
              </div>
            )}
          </div>
        </div>
      </div>

      {activeTab === 'google' && searchTerm && !filteredFonts.some(f => f.family.toLowerCase() === searchTerm.toLowerCase()) && (
        <p className="text-[10px] text-gray-500 italic">
          Pulsa en lo que has escrito para intentar cargar &quot;{searchTerm}&quot; desde Google Fonts
        </p>
      )}
    </div>
  );
}