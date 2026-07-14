'use client';

import { useState } from 'react';
import { Scissors, ChevronDown, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../design-system/Button';
import { useTimelineStore } from '@/stores/timeline-store';
import { Popover } from '../design-system/Popover';
import {
    CutDetectionPipeline,
    HistogramHsvDetector,
    WebCodecsFrameSource
} from '@/lib/video-cut';
import { buildClipPlacements } from '@/lib/video-timeline';
import { useShallow } from 'zustand/react/shallow';

export function VideoCutPopover() {
    const [isOpen, setIsOpen] = useState(false);
    const [minScore, setMinScore] = useState(0.35);

    const {
        cuts,
        setCuts,
        clearCuts,
        isDetecting,
        setIsDetecting,
        detectionProgress,
        setDetectionProgress,
        videoSources,
        videoClips,
        selectedClipId,
        projectFps,
    } = useTimelineStore(useShallow((state) => ({
        cuts: state.cuts,
        setCuts: state.setCuts,
        clearCuts: state.clearCuts,
        isDetecting: state.isDetecting,
        setIsDetecting: state.setIsDetecting,
        detectionProgress: state.detectionProgress,
        setDetectionProgress: state.setDetectionProgress,
        videoSources: state.videoSources,
        videoClips: state.videoClips,
        selectedClipId: state.selectedClipId,
        projectFps: state.projectFps,
    })));
    const selectedPlacement = buildClipPlacements(videoClips)
        .find((placement) => placement.clip.id === selectedClipId);
    const selectedSource = selectedPlacement
        ? videoSources.find((source) => source.id === selectedPlacement.clip.sourceId) ?? null
        : null;

    const handleDetect = async () => {
        if (!selectedSource || !selectedPlacement || isDetecting) return;

        const source = new WebCodecsFrameSource(selectedSource.file);
        try {
            setIsDetecting(true);
            setDetectionProgress(0);

            await source.init();

            const detector = new HistogramHsvDetector();
            const pipeline = new CutDetectionPipeline(source, detector, {
                minScore,
                localMaxWindowFrames: 2,
                cooldownFrames: 4
            });

            const detectedCuts = await pipeline.run((progress) => {
                setDetectionProgress(progress);
            });

            setCuts(detectedCuts.flatMap((cut) => {
                if (cut.timeSec < selectedPlacement.clip.sourceStart || cut.timeSec >= selectedPlacement.clip.sourceEnd) {
                    return [];
                }
                const timeSec = selectedPlacement.projectStart
                    + cut.timeSec
                    - selectedPlacement.clip.sourceStart;
                return [{ ...cut, timeSec, frameIndex: Math.round(timeSec * projectFps) }];
            }));
        } catch (error) {
            console.error('[VideoCut] Detection failed:', error);
            alert('Error al detectar cortes. Revisa la consola para más detalles.');
        } finally {
            setIsDetecting(false);
            setDetectionProgress(0);
            await source.close();
        }
    };

    return (
        <Popover
            isOpen={isOpen}
            onOpenChange={setIsOpen}
            width={256} // w-64 = 256px
            trigger={
                <Button
                    variant={isOpen || cuts.length > 0 ? 'primary' : 'secondary'}
                    title="Detección de cortes"
                    className="flex items-center gap-1"
                    disabled={!selectedSource}
                >
                    {isDetecting ? (
                        <Loader2 className="w-[18px] h-[18px] animate-spin" />
                    ) : (
                        <Scissors className="w-[18px] h-[18px]" />
                    )}
                    <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                </Button>
            }
        >
            <div className="px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-700/50 mb-1">
                Detección de Cortes (MVP)
            </div>

            <div className="px-3 py-3 space-y-4">
                <div className="space-y-2">
                    <div className="flex justify-between items-center">
                        <label className="text-xs text-gray-400">Sensibilidad</label>
                        <span className="text-xs font-mono text-blue-400">{minScore.toFixed(2)}</span>
                    </div>
                    <input
                        type="range"
                        min="0.1"
                        max="0.9"
                        step="0.05"
                        value={minScore}
                        onChange={(e) => setMinScore(parseFloat(e.target.value))}
                        className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                    <p className="text-[10px] text-gray-500 italic">
                        Valores más bajos detectan más cortes (más ruido).
                    </p>
                </div>

                {isDetecting ? (
                    <div className="space-y-2">
                        <div className="h-1.5 w-full bg-gray-700 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-blue-500 transition-all duration-300"
                                style={{ width: `${detectionProgress * 100}%` }}
                            />
                        </div>
                        <p className="text-[10px] text-center text-gray-400">
                            Procesando: {(detectionProgress * 100).toFixed(0)}%
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                handleDetect();
                            }}
                            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors text-sm font-medium"
                        >
                            <RefreshCw className="w-4 h-4" />
                            {cuts.length > 0 ? 'Recalcular' : 'Detectar Cortes'}
                        </button>

                        {cuts.length > 0 && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    clearCuts();
                                }}
                                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-gray-700 hover:bg-red-900/40 text-gray-300 hover:text-red-400 rounded transition-colors text-sm font-medium"
                            >
                                <Trash2 className="w-4 h-4" />
                                Limpiar ({cuts.length})
                            </button>
                        )}
                    </div>
                )}
            </div>
        </Popover>
    );
}
