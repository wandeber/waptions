'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/subtitle-editor';
import { SubtitleAnimationStyle } from '@/components/video-editor/subtitle-editor/types';
import { ExportButton } from '@/components/video-editor/ExportButton';
import { UndoIcon } from '@/components/icons/UndoIcon';
import { RedoIcon } from '@/components/icons/RedoIcon';
import { Subtitle } from '@/types/timeline';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';

import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { extractAudio } from '@/lib/mediabunny-utils';
import { useProjectStore } from '@/stores/project-store';

export function Editor() {
    const {
        isPlaying,
        currentTime,
        duration: playbackDuration,
        pause,
        toggle: togglePlayback,
        seek,
        setDuration: setPlaybackDuration
    } = usePlaybackStore();

    const {
        videoFile,
    } = useVideoStore();

    const {
        tracks,
        activeTrackId,
        addTrack,
        updateTrackStyle,
        removeSubtitleFromTrack,
        addSubtitleToTrack,
        updateSubtitleInTrack,
        setTracks,
        undo,
        redo,
        history,
        redoStack
    } = useTimelineStore();

    const { saveCurrentProject, activeProject, closeProject, isDirty } = useProjectStore();

    const [selectedSubtitle, setSelectedSubtitle] = useState<Subtitle | null>(null);
    const [detectedFps, setDetectedFps] = useState<number | null>(null);
    const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
    const [showThirdsGuide, setShowThirdsGuide] = useState(false);
    const [showDevinGuide, setShowDevinGuide] = useState(false);
    const [showMetaInfo, setShowMetaInfo] = useState(true);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [showExitConfirm, setShowExitConfirm] = useState(false);

    // Active track and its data
    const activeTrack = tracks.find(t => t.id === activeTrackId) || tracks[0];
    const subtitles = activeTrack?.subtitles || [];
    const animationStyle = activeTrack?.style;

    // Initialize first track if none exists
    useEffect(() => {
        if (tracks.length === 0) {
            addTrack('Subtítulos 1', undefined, { skipHistory: true });
        }
    }, [tracks.length, addTrack]);

    // Keyboard shortcuts for Undo/Redo
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Undo: Ctrl+Z or Cmd+Z
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
            }
            // Redo: Ctrl+Shift+Z or Cmd+Shift+Z or Ctrl+Y
            if (
                ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) ||
                ((e.ctrlKey || e.metaKey) && e.key === 'y')
            ) {
                e.preventDefault();
                redo();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [undo, redo]);

    /* eslint-disable @typescript-eslint/no-unused-vars */
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const handleVideoLoad = useCallback((videoDuration: number, fps: number | null, _file?: File) => {
        setPlaybackDuration(videoDuration);
        setDetectedFps(fps);
    }, [setPlaybackDuration]);

    const handleSubtitleClick = (subtitle: Subtitle | null) => {
        if (subtitle !== null || !selectedSubtitle) {
            setSelectedSubtitle(subtitle);
        }
    };

    const handlePlayPause = () => {
        togglePlayback();
    };

    const handleThirdsGuideToggle = () => {
        setShowThirdsGuide(!showThirdsGuide);
    };

    const handleDevinGuideToggle = () => {
        setShowDevinGuide(!showDevinGuide);
    };

    const handleMetaInfoToggle = () => {
        setShowMetaInfo(!showMetaInfo);
    };

    const handleAudioExtracted = useCallback((url: string) => {
        setAudioUrl(prev => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
        });
    }, []);

    const handleWaveformReady = () => {
        // No necesitamos hacer nada aquí
    };

    const handleAnimationStyleChange = (style: SubtitleAnimationStyle) => {
        if (activeTrack) {
            updateTrackStyle(activeTrack.id, style);
        }
    };

    const handleDelete = (subtitleId: string) => {
        if (activeTrack) {
            removeSubtitleFromTrack(activeTrack.id, subtitleId);
            if (selectedSubtitle?.id === subtitleId) {
                setSelectedSubtitle(null);
            }
        }
    };

    const handleSubtitlesChange = (newSubtitles: Subtitle[]) => {
        if (activeTrack) {
            const updatedTracks = tracks.map(t =>
                t.id === activeTrack.id ? { ...t, subtitles: newSubtitles } : t
            );
            setTracks(updatedTracks);
        }
    };

    const handleAddSubtitle = (subtitle: Omit<Subtitle, 'id'>) => {
        if (activeTrack) {
            return addSubtitleToTrack(activeTrack.id, subtitle);
        }
        return '';
    };

    const handleSubtitleUpdate = (id: string, updates: Partial<Subtitle>, options?: { skipHistory?: boolean }) => {
        if (activeTrack) {
            updateSubtitleInTrack(activeTrack.id, id, updates, options);
        }
    };



    const handleSave = async () => {
        await saveCurrentProject();
    };

    const handleClose = () => {
        const { isDirty } = useProjectStore.getState();
        if (!isDirty) {
            closeProject();
            return;
        }
        setShowExitConfirm(true);
    };

    const handleConfirmClose = () => {
        closeProject();
    };

    return (
        <div className="h-screen flex flex-col overflow-hidden bg-gray-900 text-white">
            {/* Header */}
            <header className="flex-none p-4 bg-gray-800 flex justify-between items-center border-b border-gray-700">
                <div className="flex items-center gap-4">
                    <button onClick={handleClose} className="text-gray-400 hover:text-white transition-colors">
                        ← Volver
                    </button>
                    <h1 className="text-xl font-bold select-none">{activeProject?.name || "Sin Título"}</h1>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${history.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={undo}
                        disabled={history.length === 0}
                        title="Deshacer (Ctrl+Z)"
                    >
                        <UndoIcon width={16} height={16} />
                    </button>
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors mr-2 flex items-center justify-center ${redoStack.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={redo}
                        disabled={redoStack.length === 0}
                        title="Rehacer (Ctrl+Shift+Z)"
                    >
                        <RedoIcon width={16} height={16} />
                    </button>

                    <button
                        className={`h-8 px-3 rounded text-sm font-medium transition-colors flex items-center gap-2 ${isDirty
                            ? 'bg-blue-600 hover:bg-blue-700 text-white'
                            : 'bg-gray-700 text-gray-400 cursor-default'
                            }`}
                        onClick={handleSave}
                        disabled={!isDirty}
                    >
                        {isDirty ? 'Guardar' : 'Guardado'}
                    </button>
                    <div className="w-px h-6 bg-gray-700 mx-2" />
                    <ExportButton
                        videoFile={videoFile}
                        subtitles={subtitles}
                        fps={detectedFps || 30}
                        animationStyle={animationStyle}
                    />
                </div>
            </header>

            {/* Main content */}
            <main className="flex-1 p-4 min-h-0">
                <div className="h-full flex gap-4">
                    <div className="flex-1 flex flex-col gap-4 min-h-0 min-w-0 overflow-hidden">
                        <VideoViewport
                            onVideoLoad={handleVideoLoad}
                            onEnded={() => pause()}
                            showThirdsGuide={showThirdsGuide}
                            showDevinGuide={showDevinGuide}
                            showMetaInfo={showMetaInfo}
                            onAudioExtracted={handleAudioExtracted}
                        />
                        <Timeline
                            duration={playbackDuration}
                            currentTime={currentTime}
                            onTimeUpdate={seek}
                            onSubtitleClick={handleSubtitleClick}
                            selectedSubtitleId={selectedSubtitle?.id}
                            isPlaying={isPlaying}
                            onPlayPause={handlePlayPause}
                            fps={detectedFps ?? 0}
                            showThirdsGuide={showThirdsGuide}
                            onThirdsGuideToggle={handleThirdsGuideToggle}
                            showDevinGuide={showDevinGuide}
                            onDevinGuideToggle={handleDevinGuideToggle}
                            showMetaInfo={showMetaInfo}
                            onMetaInfoToggle={handleMetaInfoToggle}
                        />
                    </div>

                    <div className="w-96 flex flex-col gap-4">
                        <SubtitleEditor
                            subtitles={subtitles}
                            selectedSubtitleId={selectedSubtitle?.id}
                            onSubtitleClick={handleSubtitleClick}
                            onDelete={handleDelete}
                            onSubtitlesChange={handleSubtitlesChange}
                            onSubtitleUpdate={handleSubtitleUpdate}
                            onAddSubtitle={handleAddSubtitle}
                            currentTime={currentTime}
                            fps={detectedFps || 30}
                            onGenerateSubtitles={async () => {
                                if (!videoFile || !audioUrl) {
                                    alert('Por favor, carga un video primero');
                                    return;
                                }

                                try {
                                    setIsGeneratingSubtitles(true);

                                    // Extraer solo el audio para optimizar el envío a Whisper (< 25MB)
                                    const audioBlob = await extractAudio(videoFile);
                                    const formData = new FormData();
                                    formData.append('audio', audioBlob, 'audio.mp4');

                                    // Llamar al endpoint
                                    const response = await fetch('/api/generate-subtitles', {
                                        method: 'POST',
                                        body: formData,
                                    });

                                    const data = await response.json();

                                    if (!response.ok) {
                                        throw new Error(data.error || 'Error al generar subtítulos');
                                    }

                                    // Aplicar snap a frames en los subtítulos generados
                                    const fps = detectedFps || 30;
                                    const frameDuration = 1 / fps;
                                    const snapTime = (t: number) => Math.round(t / frameDuration) * frameDuration;

                                    const snappedSubtitles = (data.subtitles as Subtitle[]).map(s => ({
                                        ...s,
                                        startTime: snapTime(s.startTime),
                                        endTime: snapTime(s.endTime)
                                    }));

                                    if (activeTrack) {
                                        const updatedTracks = tracks.map(t =>
                                            t.id === activeTrack.id ? { ...t, subtitles: snappedSubtitles } : t
                                        );
                                        setTracks(updatedTracks);
                                    }
                                } catch (error) {
                                    console.error('Error detallado al generar subtítulos:', {
                                        error,
                                        message: error instanceof Error ? error.message : 'Error desconocido'
                                    });
                                    alert(error instanceof Error ? error.message : 'Error al generar los subtítulos. Por favor, intenta de nuevo.');
                                } finally {
                                    setIsGeneratingSubtitles(false);
                                }
                            }}
                            isGeneratingSubtitles={isGeneratingSubtitles}
                            animationStyle={animationStyle}
                            onAnimationStyleChange={handleAnimationStyleChange}
                        />
                    </div>
                </div>
            </main>

            <ConfirmDialog
                isOpen={showExitConfirm}
                title="Salir del proyecto"
                message={<>Hay cambios sin guardar. ¿Seguro que quieres salir del proyecto?</>}
                confirmLabel="Salir sin guardar"
                cancelLabel="Cancelar"
                confirmVariant="danger"
                onConfirm={handleConfirmClose}
                onCancel={() => setShowExitConfirm(false)}
            />
        </div>
    );
}
