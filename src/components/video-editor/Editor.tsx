'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/subtitle-editor';
import { SubtitleAnimationStyle } from '@/components/video-editor/subtitle-editor/types';
import { ExportButton } from '@/components/video-editor/ExportButton';
import { GoogleFontManager } from '@/components/video-editor/GoogleFontManager';
import { UndoIcon } from '@/components/icons/UndoIcon';
import { RedoIcon } from '@/components/icons/RedoIcon';
import { CopyIcon } from '@/components/icons/CopyIcon';
import { PasteIcon } from '@/components/icons/PasteIcon';
import { Subtitle } from '@/types/timeline';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';
import { InlineEditor } from '@/components/design-system/InlineEditor';
import { TranscriptionModal } from '@/components/video-editor/TranscriptionModal';
import { TranscriptionModelId } from '@/types/transcription';

import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { extractAudio } from '@/lib/mediabunny-utils';
import { useProjectStore } from '@/stores/project-store';
import { useBackgroundRenderer } from '@/hooks/use-background-renderer';

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
        redoStack,
        selectedSubtitleIds,
        clearSelection,
        copySelection,
        pasteSelection,
        trimSubtitleAtTime,
        requestEditSubtitleAtTime,
        selectSubtitleAtTime,
        clipboard
    } = useTimelineStore();

    const { saveCurrentProject, activeProject, closeProject, isDirty, updateProjectName } = useProjectStore();

    // Activate background rendering for caching
    useBackgroundRenderer();

    const [detectedFps, setDetectedFps] = useState<number | null>(null);
    const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
    const [showThirdsGuide, setShowThirdsGuide] = useState(false);
    const [showDevinGuide, setShowDevinGuide] = useState(false);
    const [showMetaInfo, setShowMetaInfo] = useState(true);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [showExitConfirm, setShowExitConfirm] = useState(false);
    const [showTranscriptionModal, setShowTranscriptionModal] = useState(false);

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

    // Keyboard shortcuts for Undo/Redo and Multi-Delete
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Si estamos escribiendo en un input o textarea, no procesar atajos globales
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement
            ) {
                return;
            }

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

            // Copy: Ctrl+C or Cmd+C
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                copySelection();
            }

            // Paste: Ctrl+V or Cmd+V
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                e.preventDefault();
                pasteSelection(currentTime);
            }

            // Trim shortcuts
            if (e.key.toLowerCase() === 'q') {
                e.preventDefault();
                trimSubtitleAtTime(currentTime, 'start');
            }
            if (e.key.toLowerCase() === 'w') {
                e.preventDefault();
                trimSubtitleAtTime(currentTime, 'end');
            }

            // Enter: Select and focus subtitle under playhead
            if (e.key === 'Enter') {
                e.preventDefault();
                requestEditSubtitleAtTime(currentTime);
            }

            // V: Select subtitle under playhead without focus
            if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                selectSubtitleAtTime(currentTime);
            }

            // Multi-Delete: Backspace or Delete
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (selectedSubtitleIds.length > 0) {
                    e.preventDefault();
                    [...selectedSubtitleIds].forEach(id => {
                        const track = tracks.find(t => t.subtitles.some(s => s.id === id));
                        if (track) {
                            removeSubtitleFromTrack(track.id, id);
                        }
                    });
                    clearSelection();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [undo, redo, selectedSubtitleIds, removeSubtitleFromTrack, clearSelection, tracks, copySelection, currentTime, pasteSelection, trimSubtitleAtTime, requestEditSubtitleAtTime, selectSubtitleAtTime]);

    /* eslint-disable @typescript-eslint/no-unused-vars */
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const handleVideoLoad = useCallback((videoDuration: number, fps: number | null, _file?: File) => {
        setPlaybackDuration(videoDuration);
        setDetectedFps(fps);
    }, [setPlaybackDuration]);

    const handleSubtitleClick = useCallback((subtitle: Subtitle | null) => {
        // Selection is now handled directly by SubtitleList and TimelineTrackOverlay
        // based on modifiers (Cmd/Shift). We only keep this for clearing selection
        // when clicking background if needed, or other side effects.
        if (!subtitle) {
            clearSelection();
        }
    }, [clearSelection]);

    const handlePlayPause = useCallback(() => {
        togglePlayback();
    }, [togglePlayback]);

    const handleThirdsGuideToggle = useCallback(() => {
        setShowThirdsGuide(prev => !prev);
    }, []);

    const handleDevinGuideToggle = useCallback(() => {
        setShowDevinGuide(prev => !prev);
    }, []);

    const handleMetaInfoToggle = useCallback(() => {
        setShowMetaInfo(prev => !prev);
    }, []);

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

    const handleConfirmTranscription = async (modelId: TranscriptionModelId) => {
        if (!videoFile || !audioUrl) return;

        try {
            setIsGeneratingSubtitles(true);

            // Extraer solo el audio para optimizar el envío (< 25MB)
            const audioBlob = await extractAudio(videoFile);
            const formData = new FormData();
            formData.append('audio', audioBlob, 'audio.mp4');
            formData.append('model', modelId);

            // Llamar al endpoint
            const response = await fetch('/api/generate-subtitles', {
                method: 'POST',
                body: formData,
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Error al generar subtítulos');
            }

            const fps = detectedFps || 30;
            const frameDuration = 1 / fps;
            const snapTime = (t: number) => Math.round(t / frameDuration) * frameDuration;

            const snapSubtitles = (subs: Subtitle[]) => subs.map(s => ({
                ...s,
                startTime: snapTime(s.startTime),
                endTime: snapTime(s.endTime)
            }));

            if (activeTrack) {
                const timelineStore = useTimelineStore.getState();

                if (modelId === 'premium-whisper-gpt4o') {
                    // PREMIUM FLOW: Use pre-grouped data from API
                    const snappedRaw = snapSubtitles(data.raw as Subtitle[]);
                    const snappedGroups: { [key: string]: Subtitle[] } = {};
                    const containerIds: string[] = [];

                    (data.groups as Array<{ id: string; words: Subtitle[] }>).forEach((groupObj) => {
                        snappedGroups[groupObj.id] = snapSubtitles(groupObj.words);
                        containerIds.push(groupObj.id);
                    });

                    // 1. Raw Layer
                    // 2. Grouper Layer
                    timelineStore.setTranscriptionState(snappedGroups, containerIds, snappedRaw);

                    // 3. Timeline Layer (Final Subtitles)
                    const initialTimelineSubtitles: Subtitle[] = [];
                    containerIds.forEach((id: string) => {
                        const group = snappedGroups[id];
                        if (group && group.length > 0) {
                            initialTimelineSubtitles.push({
                                id: group[0].id,
                                startTime: group[0].startTime,
                                endTime: group[group.length - 1].endTime,
                                text: group.map((s: Subtitle) => s.text).join(' ')
                            });
                        }
                    });

                    const updatedTracks = tracks.map(t =>
                        t.id === activeTrack.id ? { ...t, subtitles: initialTimelineSubtitles } : t
                    );
                    setTracks(updatedTracks);
                } else {
                    // STANDARD FLOW: Use legacy word-to-subtitle logic
                    const snappedSubtitles = snapSubtitles(data.subtitles as Subtitle[]);

                    // 1. Raw Layer
                    // 2. Grouper Layer
                    const { groups, containerIds } = timelineStore.generateDefaultGrouperState(snappedSubtitles);
                    timelineStore.setTranscriptionState(groups, containerIds, snappedSubtitles);

                    // 3. Timeline Layer
                    const initialTimelineSubtitles = timelineStore.generateTimelineSubtitles(snappedSubtitles);
                    const updatedTracks = tracks.map(t =>
                        t.id === activeTrack.id ? { ...t, subtitles: initialTimelineSubtitles } : t
                    );
                    setTracks(updatedTracks);
                }
            }
            setShowTranscriptionModal(false);
        } catch (error) {
            console.error('Error detallado al generar subtítulos:', {
                error,
                message: error instanceof Error ? error.message : 'Error desconocido'
            });
            alert(error instanceof Error ? error.message : 'Error al generar los subtítulos. Por favor, intenta de nuevo.');
        } finally {
            setIsGeneratingSubtitles(false);
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
            <GoogleFontManager />
            {/* Header */}
            <header className="flex-none p-4 bg-gray-800 flex justify-between items-center border-b border-gray-700">
                <div className="flex items-center gap-4">
                    <button onClick={handleClose} className="text-gray-400 hover:text-white transition-colors">
                        ← Volver
                    </button>
                    <InlineEditor
                        initialValue={activeProject?.name || ""}
                        onSave={(val) => updateProjectName(val)}
                        textClassName="text-xl font-bold"
                        inputClassName="text-xl font-bold h-8"
                    />
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

                    <div className="w-[1px] h-6 bg-gray-700 mx-1" />

                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${selectedSubtitleIds.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={copySelection}
                        disabled={selectedSubtitleIds.length === 0}
                        title="Copiar (Cmd+C)"
                    >
                        <CopyIcon width={16} height={16} />
                    </button>
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${!clipboard || clipboard.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={() => pasteSelection(currentTime)}
                        disabled={!clipboard || clipboard.length === 0}
                        title="Pegar (Cmd+V)"
                    >
                        <PasteIcon width={16} height={16} />
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
                            onSubtitleClick={handleSubtitleClick}
                            onDelete={handleDelete}
                            onSubtitlesChange={handleSubtitlesChange}
                            onSubtitleUpdate={handleSubtitleUpdate}
                            onAddSubtitle={handleAddSubtitle}
                            currentTime={currentTime}
                            fps={detectedFps || 30}
                            onGenerateSubtitles={() => {
                                if (!videoFile || !audioUrl) {
                                    alert('Por favor, carga un video primero');
                                    return;
                                }
                                setShowTranscriptionModal(true);
                            }}
                            isGeneratingSubtitles={isGeneratingSubtitles}
                            animationStyle={animationStyle}
                            onAnimationStyleChange={handleAnimationStyleChange}
                        />
                    </div>
                </div>
            </main>

            <TranscriptionModal
                isOpen={showTranscriptionModal}
                onClose={() => setShowTranscriptionModal(false)}
                onConfirm={handleConfirmTranscription}
                isProcessing={isGeneratingSubtitles}
            />

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
