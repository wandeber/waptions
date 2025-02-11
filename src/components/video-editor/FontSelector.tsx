'use client';

import { useState } from 'react';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { ChevronDownIcon } from '../icons/ChevronDownIcon';
import { WarningIcon } from '../icons/WarningIcon';

interface FontSelectorProps {
  value: string;
  onChange: (font: string) => void;
}

// Fuentes de respaldo en caso de que la API no esté disponible
const fallbackFonts = [
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
  'Inter',
];

export function FontSelector({ value, onChange }: FontSelectorProps) {
  const [fonts, setFonts] = useState<FontData[]>(fallbackFonts.map(family => ({
    family,
    fullName: family,
    postscriptName: family,
    style: 'Regular'
  })));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [hasSystemFonts, setHasSystemFonts] = useState(false);

  const loadFonts = async () => {
    if (!('queryLocalFonts' in window)) {
      setError('Tu navegador no soporta la carga de fuentes locales');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const fontList = await window.queryLocalFonts();
      
      // Eliminar duplicados basados en el nombre de la familia
      const uniqueFonts = Array.from(
        new Map(fontList.map(font => [font.family, font])).values()
      );
      
      // Ordenar alfabéticamente
      uniqueFonts.sort((a, b) => a.family.localeCompare(b.family));
      
      setFonts(uniqueFonts);
      setHasSystemFonts(true);
      setError(null);
    } catch (err) {
      console.error('Error al cargar las fuentes:', err);
      // Volver a las fuentes de respaldo si falla la carga
      setFonts(fallbackFonts.map(family => ({
        family,
        fullName: family,
        postscriptName: family,
        style: 'Regular'
      })));
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

  // Filtrar fuentes basadas en el término de búsqueda
  const filteredFonts = fonts.filter(font => 
    font.family.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Buscar fuente..."
          className="flex-1 bg-gray-700 text-white rounded px-2 py-1.5 text-sm"
        />
      </div>

      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-gray-700 text-white rounded px-2 py-1.5 text-sm appearance-none"
          style={{ fontFamily: value }}
          disabled={isLoading}
        >
          {isLoading ? (
            <option>Cargando fuentes...</option>
          ) : filteredFonts.length === 0 ? (
            // Si no hay coincidencias en la búsqueda o no hay fuentes cargadas,
            // mostramos las fuentes de respaldo
            fallbackFonts.map(family => (
              <option 
                key={family}
                value={family}
                style={{ fontFamily: family }}
              >
                {family}
              </option>
            ))
          ) : (
            filteredFonts.map(font => (
              <option 
                key={font.postscriptName} 
                value={font.family}
                style={{ fontFamily: font.family }}
              >
                {font.family}
              </option>
            ))
          )}
        </select>
        <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
          {isLoading ? (
            <SpinnerIcon />
          ) : (
            <ChevronDownIcon />
          )}
        </div>
      </div>

      {'queryLocalFonts' in window && !hasSystemFonts && (
        <div className="flex flex-col gap-2">
          <button
            onClick={loadFonts}
            disabled={isLoading}
            className={`w-full bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1.5 text-sm transition-colors flex items-center justify-center gap-2 ${
              isLoading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {isLoading ? (
              <>
                <SpinnerIcon />
                <span>Cargando fuentes...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>Cargar fuentes del sistema</span>
              </>
            )}
          </button>

          {error && (
            <div className="text-yellow-500 text-sm flex items-center gap-2 bg-yellow-500/10 px-3 py-2 rounded">
              <WarningIcon className="flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
} 