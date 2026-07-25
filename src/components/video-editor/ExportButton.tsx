'use client';

import { useRef, useState } from 'react';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { Button } from '../design-system/Button';
import { Select } from '../design-system/Select';
import { Download } from 'lucide-react';
import {
  exportProject,
  getExportMimeType,
  getExportFileExtension,
  DEFAULT_EXPORT_OPTIONS,
  createExportDocumentSnapshot,
  estimateExportOutputBytes,
} from '@/lib/export';
import { acquireExportDestination } from '@/lib/export-destination';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { ExportFormat, ExportQuality } from '@/types/export';

export function ExportButton() {
  const activeProject = useProjectStore((state) => state.activeProject);
  const videoClips = useTimelineStore((state) => state.videoClips);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [showOptions, setShowOptions] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Export options
  const [format, setFormat] = useState<ExportFormat>(DEFAULT_EXPORT_OPTIONS.format);
  const [quality, setQuality] = useState<ExportQuality>(DEFAULT_EXPORT_OPTIONS.quality);
  const [includeAudio, setIncludeAudio] = useState(DEFAULT_EXPORT_OPTIONS.includeAudio ?? true);

  const handleExport = async () => {
    if (videoClips.length === 0) return;

    // Capture the graph before opening the asynchronous save picker. The export worker clones it
    // defensively again at its API boundary, but this first freeze fixes user-visible job identity
    // to the exact click even if the timeline changes while the destination prompt is open.
    const documentSnapshot = createExportDocumentSnapshot(
      useTimelineStore.getState().buildEditorDocumentV4(),
    );
    const projectName = activeProject?.name || 'video';
    const safeName = projectName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_');
    const extension = getExportFileExtension(format);
    const estimatedBytes = estimateExportOutputBytes(documentSnapshot, { quality, includeAudio });

    // Invocation, rather than the later await, must stay directly in the click call stack. The
    // browser's save picker consumes transient user activation synchronously; React state updates
    // or unrelated asynchronous setup before this line can make the permission prompt fail.
    const destinationPromise = acquireExportDestination({
      format,
      suggestedName: `${safeName}${extension}`,
      estimatedBytes,
    });
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      setIsExporting(true);
      setProgress(0);
      setCurrentStep('Preparing export…');
      setShowOptions(false);
      const destination = await destinationPromise;

      const result = await exportProject({
        document: documentSnapshot,
        destination,
        options: {
          format,
          quality,
          includeAudio,
          onProgress: (p) => {
            setProgress(p * 100);
            if (p < 0.1) {
              setCurrentStep('Initializing…');
            } else if (p < 0.9) {
              setCurrentStep(`Rendering frames… ${Math.round(p * 100)}%`);
            } else {
              setCurrentStep('Finalizing…');
            }
          },
          signal: abortController.signal,
        },
      });

      if (result.success && result.delivery === 'memory') {
        // Browsers without the File System Access API receive the explicitly bounded memory
        // fallback and still use the conventional object-URL download flow.
        const mimeType = getExportMimeType(format);
        const blob = new Blob([result.buffer], { type: mimeType });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeName}${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (!result.success && !result.cancelled) {
        console.error('Export failed:', result.error);
        alert(`Export failed: ${result.error}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('Unexpected export error:', error);
      alert(error instanceof Error ? error.message : 'Unexpected export error');
    } finally {
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
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
          <Button
            variant="danger"
            size="sm"
            onClick={() => abortControllerRef.current?.abort()}
            className="h-7 px-2 text-xs"
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Options dropdown */}
      {showOptions && !isExporting && (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-[280px] rounded border border-slate-700 bg-slate-900 p-4 shadow-2xl">
          <h3 className="mb-3 text-sm font-medium text-white">Export settings</h3>

          {/* Format */}
          <div className="mb-3">
            <label className="mb-1 block text-xs text-slate-400">Format</label>
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
            <label className="mb-1 block text-xs text-slate-400">Quality</label>
            <Select
              value={quality}
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
              controlSize="xs"
            >
              <option value="low">Low — smaller file</option>
              <option value="medium">Medium — balanced</option>
              <option value="high">High — recommended</option>
              <option value="very_high">Very high — larger file</option>
            </Select>
          </div>

          {/* Include audio */}
          <div className="mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeAudio}
                onChange={(e) => setIncludeAudio(e.target.checked)}
                className="rounded bg-gray-700 border-gray-600"
              />
              <span className="text-xs text-gray-300">Include timeline audio</span>
            </label>
          </div>

          {/* Export button */}
          <Button
            variant="primary"
            onClick={handleExport}
            disabled={!canExport}
            className="w-full text-sm font-medium h-9"
          >
            <Download className="w-4 h-4" />
            <span>Export</span>
          </Button>
        </div>
      )}

      <Button
        variant="primary"
        onClick={() => {
          if (!isExporting) setShowOptions((isOpen) => !isOpen);
        }}
        disabled={videoClips.length === 0}
        className="h-8 border border-blue-400/20 px-4 text-sm font-semibold shadow-[0_1px_0_rgba(255,255,255,0.08)]"
        title={
          videoClips.length === 0
            ? 'Import at least one video clip first'
            : isExporting
                ? 'Exporting…'
                : 'Export video with timeline audio and subtitles'
        }
      >
        {isExporting ? (
          <>
            <SpinnerIcon className="w-4 h-4" />
            <span>Exporting…</span>
          </>
        ) : (
          <>
            <Download className="w-4 h-4" />
            <span>Export</span>
          </>
        )}
      </Button>
    </div>
  );
}
