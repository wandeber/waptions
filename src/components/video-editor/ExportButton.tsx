'use client';

import { useState } from 'react';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { Button } from '../design-system/Button';
import { Select } from '../design-system/Select';
import { Share } from 'lucide-react';
import {
  exportProject,
  getExportMimeType,
  getExportFileExtension,
  DEFAULT_EXPORT_OPTIONS,
} from '@/lib/export';
import { SubtitleTrack } from '@/types/timeline';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { ExportFormat, ExportQuality } from '@/types/export';

interface ExportButtonProps {
  tracks: SubtitleTrack[];
  fps: number;
}

export function ExportButton(props: ExportButtonProps) {
  // EditorHeader keeps these transitional props until its wider toolbar contract is migrated.
  // Export itself always reads one atomic V3 document so independent audio cannot be omitted.
  void props;
  const { activeProject } = useProjectStore();
  const { videoClips } = useTimelineStore();
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [showOptions, setShowOptions] = useState(false);

  // Export options
  const [format, setFormat] = useState<ExportFormat>(DEFAULT_EXPORT_OPTIONS.format);
  const [quality, setQuality] = useState<ExportQuality>(DEFAULT_EXPORT_OPTIONS.quality);
  const [includeAudio] = useState(DEFAULT_EXPORT_OPTIONS.includeAudio ?? true);

  const handleExport = async () => {
    if (videoClips.length === 0) return;

    try {
      setIsExporting(true);
      setProgress(0);
      setCurrentStep('Preparando exportación...');
      setShowOptions(false);

      const result = await exportProject({
        document: useTimelineStore.getState().buildEditorDocument(),
        options: {
          format,
          quality,
          includeAudio,
          onProgress: (p) => {
            setProgress(p * 100);
            if (p < 0.1) {
              setCurrentStep('Inicializando...');
            } else if (p < 0.9) {
              setCurrentStep(`Renderizando frames... ${Math.round(p * 100)}%`);
            } else {
              setCurrentStep('Finalizando...');
            }
          },
          onCancel: () => false,
        },
      });

      if (result.success && result.buffer) {
        // Download the file
        const mimeType = getExportMimeType(format);
        const extension = getExportFileExtension(format);
        const blob = new Blob([result.buffer], { type: mimeType });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;

        // Use project name or fallback
        const projectName = activeProject?.name || 'video';
        const safeName = projectName
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_');

        a.download = `${safeName}${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (result.error) {
        console.error('Export failed:', result.error);
        alert(`Error al exportar: ${result.error}`);
      }
    } catch (error) {
      console.error('Unexpected export error:', error);
      alert('Error inesperado durante la exportación');
    } finally {
      setIsExporting(false);
      setProgress(0);
      setCurrentStep('');
    }
  };

  const canExport = videoClips.length > 0 && !isExporting;

  return (
    <div className="flex items-center gap-2 relative">
      {isExporting && (
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1">
            <div className="w-32 h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs text-gray-400">{currentStep}</div>
          </div>
          <span className="text-sm text-gray-300">{Math.round(progress)}%</span>
        </div>
      )}

      {/* Options dropdown */}
      {showOptions && !isExporting && (
        <div className="absolute top-full right-0 mt-2 bg-gray-800 border border-gray-700 rounded-lg p-4 shadow-xl z-50 min-w-[280px]">
          <h3 className="text-sm font-medium text-white mb-3">Opciones de exportación</h3>

          {/* Format */}
          <div className="mb-3">
            <label className="text-xs text-gray-400 block mb-1">Formato</label>
            <div className="flex gap-2">
              <button
                onClick={() => setFormat('mp4')}
                className={`px-3 py-1.5 text-xs rounded ${format === 'mp4'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
              >
                MP4 (H.264)
              </button>
              <button
                onClick={() => setFormat('webm')}
                className={`px-3 py-1.5 text-xs rounded ${format === 'webm'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
              >
                WebM (VP9)
              </button>
            </div>
          </div>

          {/* Quality */}
          <div className="mb-3">
            <label className="text-xs text-gray-400 block mb-1">Calidad</label>
            <Select
              value={quality}
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
              controlSize="xs"
            >
              <option value="low">Baja - Archivo pequeño</option>
              <option value="medium">Media - Balanceado</option>
              <option value="high">Alta - Recomendado</option>
              <option value="very_high">Muy alta - Archivo grande</option>
            </Select>
          </div>

          {/* Include audio 
          <div className="mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeAudio}
                onChange={(e) => setIncludeAudio(e.target.checked)}
                className="rounded bg-gray-700 border-gray-600"
              />
              <span className="text-xs text-gray-300">Incluir audio</span>
            </label>
          </div>
          */}

          {/* Export button */}
          <Button
            variant="primary"
            onClick={handleExport}
            disabled={!canExport}
            className="w-full text-sm font-medium h-9"
          >
            <Share className="w-4 h-4" />
            <span>Exportar</span>
          </Button>
        </div>
      )}

      <Button
        variant="primary"
        onClick={() => {
          if (!isExporting) setShowOptions((isOpen) => !isOpen);
        }}
        disabled={videoClips.length === 0}
        className="text-sm font-medium h-8 px-4"
        title={
          videoClips.length === 0
            ? 'Import at least one video clip first'
            : isExporting
                ? 'Exportando...'
                : 'Exportar video con subtítulos'
        }
      >
        {isExporting ? (
          <>
            <SpinnerIcon className="w-4 h-4" />
            <span>Exportando...</span>
          </>
        ) : (
          <>
            <Share className="w-4 h-4" />
            <span>Exportar</span>
          </>
        )}
      </Button>
    </div>
  );
}
