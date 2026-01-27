'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/subtitle-editor';
import { SubtitleAnimationStyle } from '@/components/video-editor/subtitle-editor/types';
import { GoogleFontManager } from '@/components/video-editor/GoogleFontManager';
import { useRouter } from 'next/navigation';
import { Subtitle } from '@/types/timeline';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';
import { TranscriptionModal } from '@/components/video-editor/TranscriptionModal';
import { TranscriptionModelId } from '@/types/transcription';
import { EditorHeader } from '@/components/video-editor/EditorHeader';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { extractAudio } from '@/lib/mediabunny-utils';
import { useProjectStore } from '@/stores/project-store';
import { useBackgroundRenderer } from '@/hooks/use-background-renderer';
import { storageService } from '@/lib/storage/storage-service';
import { exportProjectBundle } from '@/lib/project-bundle';

export function Editor() {
    const {
        isPlaying,
        currentTime,
        duration: playbackDuration,
        contentDuration,
        pause,
        toggle: togglePlayback,
        seek,
        setFps,
        setDuration,
        setContentDuration
    } = usePlaybackStore();

    const {
        videoFile,
        duration: videoDuration
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

    const { saveCurrentProject, activeProject, closeProject, isDirty, isSaving, updateProjectName } = useProjectStore();

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

    // Unified Keyboard Shortcuts
    useKeyboardShortcuts({
        SAVE: () => handleSave(),
        UNDO: () => undo(),
        REDO: () => redo(),
        COPY: () => copySelection(),
        PASTE: () => pasteSelection(currentTime),
        TRIM_START: () => trimSubtitleAtTime(currentTime, 'start'),
        TRIM_END: () => trimSubtitleAtTime(currentTime, 'end'),
        DELETE: () => {
            const { isVideoSelected, setVideoSelected, pushHistory } = useTimelineStore.getState();
            const { clearVideo } = useVideoStore.getState();

            if (isVideoSelected && activeProject) {
                pushHistory();
                clearVideo();
                storageService.deleteVideo(activeProject.id);
                setVideoSelected(false);
                return;
            }

            if (selectedSubtitleIds.length > 0) {
                [...selectedSubtitleIds].forEach(id => {
                    const track = tracks.find(t => t.subtitles.some(s => s.id === id));
                    if (track) removeSubtitleFromTrack(track.id, id);
                });
                clearSelection();
            }
        },
        PLAY_PAUSE: () => togglePlayback(),
        EDIT_SUBTITLE: () => requestEditSubtitleAtTime(currentTime),
        SELECT_SUBTITLE: () => selectSubtitleAtTime(currentTime)
    });

    /* eslint-disable @typescript-eslint/no-unused-vars */
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const handleVideoLoad = useCallback((_videoDuration: number, fps: number | null, _file?: File) => {
        setDetectedFps(fps);
    }, []);

    // Sync playback duration with video + subtitles
    useEffect(() => {
        const lastSubEnd = tracks.reduce((max, track) => {
            const trackMax = track.subtitles.reduce((tMax, s) => Math.max(tMax, s.endTime), 0);
            return Math.max(max, trackMax);
        }, 0);

        const { fps } = useVideoStore.getState();
        const frameDuration = fps > 0 ? 1 / fps : 1 / 30;
        const snappedVideoDuration = Math.round(videoDuration / frameDuration) * frameDuration;

        const contentEnd = Math.max(snappedVideoDuration, lastSubEnd);
        const viewableDuration = contentEnd + 60; // "Infinite" buffer

        setContentDuration(contentEnd);
        setDuration(viewableDuration);

        // Sync FPS for accurate playhead quantization
        setFps(fps);
    }, [tracks, videoDuration, setContentDuration, setDuration, setFps]);

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



    const router = useRouter();

    const handleSave = async () => {
        await saveCurrentProject();
    };

    const handleClose = () => {
        if (!isDirty) {
            closeProject();
            router.push('/');
            return;
        }
        setShowExitConfirm(true);
    };

    const handleConfirmClose = () => {
        closeProject();
        router.push('/');
    };

    const handleExportBundle = async () => {
        if (!activeProject) return;
        try {
            const blob = await exportProjectBundle(activeProject.id);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${activeProject.name}.waptions`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Failed to export project bundle:', error);
            alert('Error al exportar el proyecto');
        }
    };

    return (
        <div className="h-screen flex flex-col overflow-hidden bg-gray-900 text-white">
            <GoogleFontManager />
            <EditorHeader
                projectName={activeProject?.name || ""}
                onRename={updateProjectName}
                onClose={handleClose}
                onUndo={undo}
                onRedo={redo}
                canUndo={history.length > 0}
                canRedo={redoStack.length > 0}
                onCopy={copySelection}
                onPaste={() => pasteSelection(currentTime)}
                canCopy={selectedSubtitleIds.length > 0}
                canPaste={!!clipboard && clipboard.length > 0}
                onSave={handleSave}
                isDirty={isDirty}
                isSaving={isSaving}
                onExportBundle={handleExportBundle}
                videoFile={videoFile}
                tracks={tracks}
                fps={detectedFps || 30}
            />

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
                            contentDuration={contentDuration}
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
