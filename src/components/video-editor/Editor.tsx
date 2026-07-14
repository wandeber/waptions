'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { MediaInspector } from '@/components/video-editor/MediaInspector';
import { SubtitleEditor } from '@/components/video-editor/subtitle-editor';
import { SubtitleAnimationStyle } from '@/components/video-editor/subtitle-editor/types';
import { GoogleFontManager } from '@/components/video-editor/GoogleFontManager';
import { useRouter } from 'next/navigation';
import { Subtitle } from '@/types/timeline';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';
import { Button } from '@/components/design-system/Button';
import { TranscriptionModal } from '@/components/video-editor/TranscriptionModal';
import { LocalBrowserTranscriptionSettings, OpenAICompatibleTranscriptionSettings, TranscriptionModelId } from '@/types/transcription';
import { EditorHeader } from '@/components/video-editor/EditorHeader';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useTimelineAudioEngine } from '@/hooks/use-timeline-audio-engine';

import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { transcribeWithOpenAICompatibleEndpoint } from '@/lib/ai/openai-compatible-transcription';
import { LocalBrowserTranscriptionProgress, transcribeWithLocalBrowserModel } from '@/lib/ai/local-browser-transcription';
import { extractAudio } from '@/lib/mediabunny-utils';
import { useProjectStore } from '@/stores/project-store';
import { useBackgroundRenderer } from '@/hooks/use-background-renderer';
import { exportProjectBundle } from '@/lib/project-bundle';
import { getTimelineDurations } from '@/lib/video-timeline';
import {
    mapAudioTranscriptionPlanToProject,
    mapPremiumAudioTranscriptionPlanToProject,
    type SourcePremiumTranscription,
} from '@/lib/timeline-transcription';
import { buildAudioTranscriptionPlan } from '@/lib/audio-transcription-plan';
import { resolveAudioMediaAsset, type AudioMediaCacheKey } from '@/lib/media-asset-ref';
import { clampTimelineHeight } from '@/lib/editor-layout';

interface GenerateSubtitlesResponse {
    subtitles?: Subtitle[];
    raw?: Subtitle[];
    groups?: Array<{ id: string; words: Subtitle[] }>;
}

interface TimedTranscriptionWord {
    word: string;
    start: number;
    end: number;
}

interface TimedTranscriptionResponse {
    words?: TimedTranscriptionWord[];
}

const buildSubtitlesFromTimedWords = (transcription: TimedTranscriptionResponse): Subtitle[] => {
    if (!transcription.words) {
        return [];
    }

    return transcription.words.map(word => ({
        id: crypto.randomUUID(),
        startTime: word.start,
        endTime: word.end,
        text: word.word.trim()
    }));
};

const formatLocalTranscriptionProgress = (progress: LocalBrowserTranscriptionProgress): string => {
    if (typeof progress.progress === 'number') {
        return `${progress.message} (${Math.round(progress.progress * 100)}%)`;
    }

    return progress.message;
};

const isAbortLikeError = (error: unknown): boolean => {
    return error instanceof DOMException && error.name === 'AbortError';
};

export function Editor() {
    const {
        isPlaying,
        currentTime,
        duration: playbackDuration,
        contentDuration,
        toggle: togglePlayback,
        seek,
        setFps,
        setDuration,
        setContentDuration
    } = usePlaybackStore();

    const {
        tracks,
        activeTrackId,
        projectFps,
        renderProfile,
        videoSources,
        videoClips,
        audioSources,
        audioTracks,
        transientSelection,
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
        clipboard,
        replaceTrackWithTranscription,
        deleteSelectedMedia,
    } = useTimelineStore();

    const {
        saveCurrentProject,
        activeProject,
        closeProject,
        isDirty,
        isSaving,
        updateProjectName,
        updateProjectDuration,
    } = useProjectStore();

    // Activate background rendering for caching
    useBackgroundRenderer();
    // The editor owns exactly one sample-accurate audio engine for the active project.
    useTimelineAudioEngine();

    const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
    const [showThirdsGuide, setShowThirdsGuide] = useState(false);
    const [showDevinGuide, setShowDevinGuide] = useState(false);
    const [showMetaInfo, setShowMetaInfo] = useState(true);
    const [isInspectorVisible, setIsInspectorVisible] = useState(true);
    const [timelineHeight, setTimelineHeight] = useState(260);
    const [showExitConfirm, setShowExitConfirm] = useState(false);
    const [showTranscriptionModal, setShowTranscriptionModal] = useState(false);
    const [transcriptionStatus, setTranscriptionStatus] = useState<string | null>(null);
    const transcriptionAbortControllerRef = useRef<AbortController | null>(null);

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

    useEffect(() => {
        return () => {
            transcriptionAbortControllerRef.current?.abort();
        };
    }, []);

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
            const timeline = useTimelineStore.getState();
            if (timeline.transientSelection.kind === 'video-clip'
                || timeline.transientSelection.kind === 'audio-clip') {
                deleteSelectedMedia();
                return;
            }

            if (selectedSubtitleIds.length > 0) {
                const selectedIds = new Set(selectedSubtitleIds);
                setTracks(tracks.map(track => ({
                    ...track,
                    subtitles: track.subtitles.filter(subtitle => !selectedIds.has(subtitle.id))
                })));
                clearSelection();
            }
        },
        PLAY_PAUSE: () => togglePlayback(),
        EDIT_SUBTITLE: () => requestEditSubtitleAtTime(currentTime),
        SELECT_SUBTITLE: () => selectSubtitleAtTime(currentTime)
    });

    const timelineDurations = useMemo(() => getTimelineDurations(videoClips, tracks, {
        audioTracks,
        videoSources,
        audioSources,
        renderProfile,
    }), [audioSources, audioTracks, renderProfile, tracks, videoClips, videoSources]);

    // Sync playback duration with every visual, subtitle, and independent-audio contributor.
    useEffect(() => {
        // Playback duration setters quantize against the store's current frame rate. Publish the
        // canonical project FPS first so a render-profile change cannot quantize either duration
        // using the previous project's grid for one effect cycle.
        setFps(projectFps);
        setContentDuration(timelineDurations.contentDuration);
        setDuration(timelineDurations.viewDuration);
    }, [projectFps, setContentDuration, setDuration, setFps, timelineDurations]);

    useEffect(() => {
        if (!activeProject) return;
        if (Math.abs((activeProject.duration ?? 0) - timelineDurations.contentDuration) > 0.0005) {
            void updateProjectDuration(timelineDurations.contentDuration);
        }
    }, [activeProject, timelineDurations.contentDuration, updateProjectDuration]);

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

    const workspaceRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;

        const reclampTimeline = (workspaceHeight: number) => {
            setTimelineHeight((currentHeight) => {
                const nextHeight = clampTimelineHeight(currentHeight, workspaceHeight);
                // Returning the existing value prevents a resize notification from causing a
                // redundant render, which also protects against observer feedback loops.
                return nextHeight === currentHeight ? currentHeight : nextHeight;
            });
        };

        reclampTimeline(workspace.clientHeight);
        if (typeof ResizeObserver === 'undefined') {
            const handleWindowResize = () => reclampTimeline(workspace.clientHeight);
            window.addEventListener('resize', handleWindowResize);
            return () => window.removeEventListener('resize', handleWindowResize);
        }

        const observer = new ResizeObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === workspace);
            reclampTimeline(entry?.contentRect.height ?? workspace.clientHeight);
        });
        observer.observe(workspace);
        return () => observer.disconnect();
    }, []);

    const handleTimelineResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = timelineHeight;

        const handlePointerMove = (moveEvent: PointerEvent) => {
            const workspaceHeight = workspaceRef.current?.clientHeight ?? window.innerHeight;
            // Dragging the horizontal divider upward gives the timeline more room. The bounded
            // height keeps both the preview and timeline usable on a 720px-tall viewport.
            setTimelineHeight(clampTimelineHeight(
                startHeight + startY - moveEvent.clientY,
                workspaceHeight,
            ));
        };
        const handlePointerUp = () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
    }, [timelineHeight]);

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

    const handleConfirmTranscription = async (
        modelId: TranscriptionModelId,
        customOpenAITranscription?: OpenAICompatibleTranscriptionSettings | null,
        localBrowserTranscription?: LocalBrowserTranscriptionSettings | null
    ) => {
        const targetTrackId = activeTrack?.id;
        if (!targetTrackId) return;

        const timeline = useTimelineStore.getState();
        const document = timeline.buildEditorDocument();
        const transcriptionPlan = buildAudioTranscriptionPlan(document);
        const targetGuard = timeline.createTranscriptionGuard(targetTrackId);
        if (!targetGuard || transcriptionPlan.sourceJobs.length === 0) return;

        const abortController = new AbortController();
        transcriptionAbortControllerRef.current = abortController;

        try {
            setIsGeneratingSubtitles(true);
            const sourceWords = new Map<AudioMediaCacheKey, Subtitle[]>();
            const premiumTranscriptionBySourceKey = new Map<AudioMediaCacheKey, SourcePremiumTranscription>();
            for (let sourceIndex = 0; sourceIndex < transcriptionPlan.sourceJobs.length; sourceIndex += 1) {
                const sourceJob = transcriptionPlan.sourceJobs[sourceIndex];
                const media = resolveAudioMediaAsset(
                    sourceJob.source,
                    document.videoSources,
                    document.audioSources,
                );
                if (!media) {
                    throw new Error(`The audio source ${sourceJob.sourceKey} is no longer available.`);
                }
                const sourceName = media.asset.originalName;
                setTranscriptionStatus(`Extracting audio ${sourceIndex + 1}/${transcriptionPlan.sourceJobs.length}: ${sourceName}`);
                const audioBlob = await extractAudio(media.asset.file);
                let data: GenerateSubtitlesResponse;

                if (abortController.signal.aborted) throw new DOMException('Transcription cancelled.', 'AbortError');

                if (modelId === 'local-browser' && localBrowserTranscription?.enabled) {
                    const transcription = await transcribeWithLocalBrowserModel({
                        audioBlob,
                        settings: localBrowserTranscription,
                        signal: abortController.signal,
                        onProgress: (progress) => setTranscriptionStatus(
                            `${sourceIndex + 1}/${transcriptionPlan.sourceJobs.length} · ${formatLocalTranscriptionProgress(progress)}`,
                        ),
                    });
                    data = { subtitles: buildSubtitlesFromTimedWords(transcription) };
                } else if (
                    modelId === 'whisper-1'
                    && customOpenAITranscription?.enabled
                    && customOpenAITranscription.requestMode === 'browser'
                ) {
                    try {
                        setTranscriptionStatus(`Transcribing ${sourceIndex + 1}/${transcriptionPlan.sourceJobs.length} in this browser…`);
                        const transcription = await transcribeWithOpenAICompatibleEndpoint({
                            settings: customOpenAITranscription,
                            audioFile: audioBlob,
                            fallbackModel: 'faster-whisper',
                            options: {
                                response_format: 'verbose_json',
                                timestamp_granularities: ['word'],
                                prompt: 'Use correct punctuation.',
                                temperature: 0,
                            },
                            signal: abortController.signal,
                        }) as TimedTranscriptionResponse;
                        data = { subtitles: buildSubtitlesFromTimedWords(transcription) };
                    } catch (error) {
                        if (abortController.signal.aborted) throw error;
                        const message = error instanceof Error ? error.message : 'The browser could not call the transcriber.';
                        throw new Error(`${message} Check that the endpoint allows CORS from ${window.location.origin}.`);
                    }
                } else {
                    setTranscriptionStatus(`Transcribing ${sourceIndex + 1}/${transcriptionPlan.sourceJobs.length} on the server…`);
                    const formData = new FormData();
                    formData.append('audio', audioBlob, `${media.asset.id}.mp4`);
                    formData.append('model', modelId);
                    if (customOpenAITranscription?.enabled) {
                        formData.append('customOpenAITranscription', JSON.stringify(customOpenAITranscription));
                    }
                    const response = await fetch('/api/generate-subtitles', {
                        method: 'POST',
                        body: formData,
                        signal: abortController.signal,
                    });
                    data = await response.json();
                    if (!response.ok) {
                        throw new Error((data as { error?: string }).error || 'Subtitle generation failed.');
                    }
                }

                if (modelId === 'premium-whisper-gpt4o') {
                    premiumTranscriptionBySourceKey.set(sourceJob.sourceKey, {
                        raw: data.raw ?? data.subtitles ?? [],
                        groups: data.groups ?? [],
                    });
                } else {
                    sourceWords.set(sourceJob.sourceKey, data.raw ?? data.subtitles ?? []);
                }
            }

            setTranscriptionStatus('Mapping source words onto the edited timeline…');
            if (modelId === 'premium-whisper-gpt4o') {
                const mappedPremium = mapPremiumAudioTranscriptionPlanToProject(
                    transcriptionPlan,
                    premiumTranscriptionBySourceKey,
                );
                // Preserve the current track when every premium group falls outside the edited
                // source ranges, matching the no-word behavior of standard transcription routes.
                if (mappedPremium.raw.length === 0) {
                    setShowTranscriptionModal(false);
                    return;
                }

                const applied = replaceTrackWithTranscription(
                    targetTrackId,
                    mappedPremium.timelineSubtitles,
                    {
                        raw: mappedPremium.raw,
                        groups: mappedPremium.groups,
                        containerIds: mappedPremium.containerIds,
                    },
                    targetGuard,
                );
                if (!applied) {
                    throw new Error('The timeline changed while transcription was running. Run transcription again on the current edit.');
                }
                setShowTranscriptionModal(false);
                return;
            }

            const mappedWords = mapAudioTranscriptionPlanToProject(transcriptionPlan, sourceWords);

            // Silent clips, clipped-out source ranges, and providers returning no words leave the
            // current subtitle state untouched instead of replacing it with an empty track.
            if (mappedWords.length === 0) {
                setShowTranscriptionModal(false);
                return;
            }

            const timelineStore = useTimelineStore.getState();
            const { groups, containerIds } = timelineStore.generateDefaultGrouperState(mappedWords);
            const timelineSubtitles = timelineStore.generateTimelineSubtitles(mappedWords);
            const applied = replaceTrackWithTranscription(
                targetTrackId,
                timelineSubtitles,
                { raw: mappedWords, groups, containerIds },
                targetGuard,
            );
            if (!applied) {
                throw new Error('The timeline changed while transcription was running. Run transcription again on the current edit.');
            }
            setShowTranscriptionModal(false);
        } catch (error) {
            if (abortController.signal.aborted || isAbortLikeError(error)) {
                return;
            }

            console.error('Error detallado al generar subtítulos:', {
                error,
                message: error instanceof Error ? error.message : 'Error desconocido'
            });
            alert(error instanceof Error ? error.message : 'Error al generar los subtítulos. Por favor, intenta de nuevo.');
        } finally {
            if (transcriptionAbortControllerRef.current === abortController) {
                transcriptionAbortControllerRef.current = null;
            }

            setIsGeneratingSubtitles(false);
            setTranscriptionStatus(null);
        }
    };

    const handleCancelTranscription = useCallback(() => {
        transcriptionAbortControllerRef.current?.abort();
        setTranscriptionStatus('Cancelling transcription...');
    }, []);

    const isMediaSelection = transientSelection.kind === 'video-clip'
        || transientSelection.kind === 'audio-clip';



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
            await saveCurrentProject();
            const persistenceError = useProjectStore.getState().persistenceError;
            if (persistenceError) throw persistenceError;
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
                tracks={tracks}
                fps={projectFps}
            />

            {/* Main content */}
            <main className="flex-1 p-2 min-h-0 relative">
                <Button
                    variant="secondary"
                    size="sm"
                    className="absolute top-4 right-4 z-50 h-8 w-8 p-0 bg-gray-800/90 border border-gray-700"
                    onClick={() => setIsInspectorVisible((visible) => !visible)}
                    title={isInspectorVisible ? 'Hide inspector' : 'Show inspector'}
                >
                    {isInspectorVisible
                        ? <PanelRightClose className="h-4 w-4" />
                        : <PanelRightOpen className="h-4 w-4" />}
                </Button>

                <div ref={workspaceRef} className="h-full flex gap-2 min-w-0">
                    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                        <VideoViewport
                            showThirdsGuide={showThirdsGuide}
                            showDevinGuide={showDevinGuide}
                            showMetaInfo={showMetaInfo}
                        />

                        <div
                            className="h-2 flex-none cursor-row-resize group flex items-center"
                            onPointerDown={handleTimelineResizeStart}
                            onDoubleClick={() => setTimelineHeight(clampTimelineHeight(
                                260,
                                workspaceRef.current?.clientHeight ?? window.innerHeight,
                            ))}
                            title="Drag to resize the timeline"
                        >
                            <div className="h-px w-full bg-gray-800 group-hover:bg-blue-500 transition-colors" />
                        </div>

                        <div className="flex-none min-h-0" style={{ height: timelineHeight }}>
                            <Timeline
                                duration={playbackDuration}
                                currentTime={currentTime}
                                contentDuration={contentDuration}
                                onTimeUpdate={seek}
                                onSubtitleClick={handleSubtitleClick}
                                isPlaying={isPlaying}
                                onPlayPause={handlePlayPause}
                                fps={projectFps}
                                showThirdsGuide={showThirdsGuide}
                                onThirdsGuideToggle={handleThirdsGuideToggle}
                                showDevinGuide={showDevinGuide}
                                onDevinGuideToggle={handleDevinGuideToggle}
                                showMetaInfo={showMetaInfo}
                                onMetaInfoToggle={handleMetaInfoToggle}
                            />
                        </div>
                    </div>

                    <div
                        className={`flex-none flex flex-col min-h-0 overflow-hidden transition-[width,opacity] duration-200 ${isInspectorVisible
                            ? 'w-[360px] opacity-100 bg-gray-800 border border-gray-700 rounded-lg'
                            : 'w-0 opacity-0 pointer-events-none'
                            }`}
                        aria-hidden={!isInspectorVisible}
                    >
                        {isMediaSelection ? <MediaInspector /> : <SubtitleEditor
                            subtitles={subtitles}
                            onSubtitleClick={handleSubtitleClick}
                            onDelete={handleDelete}
                            onSubtitlesChange={handleSubtitlesChange}
                            onSubtitleUpdate={handleSubtitleUpdate}
                            onAddSubtitle={handleAddSubtitle}
                            currentTime={currentTime}
                            fps={projectFps}
                            onGenerateSubtitles={() => {
                                const plan = buildAudioTranscriptionPlan(
                                    useTimelineStore.getState().buildEditorDocument(),
                                );
                                if (plan.sourceJobs.length === 0) {
                                    alert('The timeline has no audible audio to transcribe.');
                                    return;
                                }
                                setShowTranscriptionModal(true);
                            }}
                            isGeneratingSubtitles={isGeneratingSubtitles}
                            animationStyle={animationStyle}
                            onAnimationStyleChange={handleAnimationStyleChange}
                        />}
                    </div>
                </div>
            </main>

            <TranscriptionModal
                isOpen={showTranscriptionModal}
                onClose={() => {
                    setTranscriptionStatus(null);
                    setShowTranscriptionModal(false);
                }}
                onConfirm={handleConfirmTranscription}
                isProcessing={isGeneratingSubtitles}
                status={transcriptionStatus}
                onCancelProcessing={handleCancelTranscription}
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
