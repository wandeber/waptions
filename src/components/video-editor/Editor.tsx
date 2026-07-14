'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';
import { EditorHeader } from '@/components/video-editor/EditorHeader';
import {
    EditorTransactionProvider,
    useEditorTransactionCoordinator,
    useHasPendingUndoableDraft,
} from '@/components/video-editor/EditorTransactionContext';
import { EditorWorkspace } from '@/components/video-editor/EditorWorkspace';
import { GoogleFontManager } from '@/components/video-editor/GoogleFontManager';
import { TranscriptionModal } from '@/components/video-editor/TranscriptionModal';
import type { SubtitleAnimationStyle } from '@/components/video-editor/subtitle-editor/types';
import { useBackgroundRenderer } from '@/hooks/use-background-renderer';
import { useEditorProjectSync } from '@/hooks/use-editor-project-sync';
import { useEditorTranscription } from '@/hooks/use-editor-transcription';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useTimelineAudioEngine } from '@/hooks/use-timeline-audio-engine';
import { exportProjectBundle } from '@/lib/project-bundle';
import { usePlaybackStore } from '@/stores/playback-store';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { Subtitle } from '@/types/timeline';

export function Editor() {
    return (
        <EditorTransactionProvider>
            <EditorContent />
        </EditorTransactionProvider>
    );
}

function EditorContent() {
    const router = useRouter();
    const transactionCoordinator = useEditorTransactionCoordinator();
    const hasPendingUndoableDraft = useHasPendingUndoableDraft();
    const {
        tracks,
        activeTrackId,
        projectFps,
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
        deleteSelectedMedia,
    } = useTimelineStore(useShallow((state) => ({
        tracks: state.tracks,
        activeTrackId: state.activeTrackId,
        projectFps: state.projectFps,
        updateTrackStyle: state.updateTrackStyle,
        removeSubtitleFromTrack: state.removeSubtitleFromTrack,
        addSubtitleToTrack: state.addSubtitleToTrack,
        updateSubtitleInTrack: state.updateSubtitleInTrack,
        setTracks: state.setTracks,
        undo: state.undo,
        redo: state.redo,
        history: state.history,
        redoStack: state.redoStack,
        selectedSubtitleIds: state.selectedSubtitleIds,
        clearSelection: state.clearSelection,
        copySelection: state.copySelection,
        pasteSelection: state.pasteSelection,
        trimSubtitleAtTime: state.trimSubtitleAtTime,
        requestEditSubtitleAtTime: state.requestEditSubtitleAtTime,
        selectSubtitleAtTime: state.selectSubtitleAtTime,
        clipboard: state.clipboard,
        deleteSelectedMedia: state.deleteSelectedMedia,
    })));
    const {
        saveCurrentProject,
        activeProject,
        closeProject,
        isDirty,
        isSaving,
        updateProjectName,
    } = useProjectStore(useShallow((state) => ({
        saveCurrentProject: state.saveCurrentProject,
        activeProject: state.activeProject,
        closeProject: state.closeProject,
        isDirty: state.isDirty,
        isSaving: state.isSaving,
        updateProjectName: state.updateProjectName,
    })));
    const [showExitConfirm, setShowExitConfirm] = useState(false);
    const activeTrack = tracks.find((track) => track.id === activeTrackId) ?? tracks[0];
    const transcription = useEditorTranscription(activeTrack?.id);

    const handleSave = useCallback(async () => {
        await saveCurrentProject();
    }, [saveCurrentProject]);
    const handleClose = useCallback(() => {
        if (!isDirty) {
            closeProject();
            router.push('/');
            return;
        }
        setShowExitConfirm(true);
    }, [closeProject, isDirty, router]);
    const handleConfirmClose = useCallback(() => {
        closeProject();
        router.push('/');
    }, [closeProject, router]);
    const handleHistoryPointerDown = useCallback(() => {
        // Pointerdown precedes the focused field's blur. Each registered control resolves its
        // semantic history boundary here: text commits so Undo targets the draft, while numeric,
        // color, range, and pointer previews cancel. The click repeats this idempotently.
        transactionCoordinator.prepareHistoryNavigation();
    }, [transactionCoordinator]);
    const handleUndo = useCallback(async () => {
        transactionCoordinator.prepareHistoryNavigation();
        await undo();
    }, [transactionCoordinator, undo]);
    const handleRedo = useCallback(async () => {
        transactionCoordinator.prepareHistoryNavigation();
        await redo();
    }, [redo, transactionCoordinator]);

    useKeyboardShortcuts({
        SAVE: handleSave,
        UNDO: handleUndo,
        REDO: handleRedo,
        REDO_Y: handleRedo,
        COPY: copySelection,
        PASTE: () => pasteSelection(usePlaybackStore.getState().currentTime),
        TRIM_START: () => trimSubtitleAtTime(usePlaybackStore.getState().currentTime, 'start'),
        TRIM_END: () => trimSubtitleAtTime(usePlaybackStore.getState().currentTime, 'end'),
        DELETE: () => {
            const timeline = useTimelineStore.getState();
            if (timeline.transientSelection.kind === 'video-clip'
                || timeline.transientSelection.kind === 'audio-clip') {
                deleteSelectedMedia();
                return;
            }
            if (selectedSubtitleIds.length === 0) return;
            const selectedIds = new Set(selectedSubtitleIds);
            setTracks(tracks.map((track) => ({
                ...track,
                subtitles: track.subtitles.filter((subtitle) => !selectedIds.has(subtitle.id)),
            })));
            clearSelection();
        },
        PLAY_PAUSE: () => usePlaybackStore.getState().toggle(),
        EDIT_SUBTITLE: () => requestEditSubtitleAtTime(usePlaybackStore.getState().currentTime),
        SELECT_SUBTITLE: () => selectSubtitleAtTime(usePlaybackStore.getState().currentTime),
    });

    const handleSubtitleClick = useCallback((subtitle: Subtitle | null) => {
        // Lists and timeline blocks own positive selection; the shared callback only clears it.
        if (!subtitle) clearSelection();
    }, [clearSelection]);
    const handleAnimationStyleChange = useCallback((style: SubtitleAnimationStyle) => {
        if (activeTrack) updateTrackStyle(activeTrack.id, style);
    }, [activeTrack, updateTrackStyle]);
    const handleDelete = useCallback((subtitleId: string) => {
        if (activeTrack) removeSubtitleFromTrack(activeTrack.id, subtitleId);
    }, [activeTrack, removeSubtitleFromTrack]);
    const handleSubtitlesChange = useCallback((subtitles: Subtitle[]) => {
        if (!activeTrack) return;
        setTracks(tracks.map((track) => (
            track.id === activeTrack.id ? { ...track, subtitles } : track
        )));
    }, [activeTrack, setTracks, tracks]);
    const handleAddSubtitle = useCallback((subtitle: Omit<Subtitle, 'id'>) => (
        activeTrack ? addSubtitleToTrack(activeTrack.id, subtitle) : ''
    ), [activeTrack, addSubtitleToTrack]);
    const handleSubtitleUpdate = useCallback((
        id: string,
        updates: Partial<Subtitle>,
        options?: { skipHistory?: boolean },
    ) => {
        if (activeTrack) updateSubtitleInTrack(activeTrack.id, id, updates, options);
    }, [activeTrack, updateSubtitleInTrack]);

    const handleExportBundle = useCallback(async () => {
        if (!activeProject) return;
        try {
            await saveCurrentProject();
            const persistenceError = useProjectStore.getState().persistenceError;
            if (persistenceError) throw persistenceError;
            const blob = await exportProjectBundle(activeProject.id);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${activeProject.name}.waptions`;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Failed to export project bundle:', error);
            alert('The project bundle could not be exported.');
        }
    }, [activeProject, saveCurrentProject]);

    return (
        <div className="h-screen flex flex-col overflow-hidden bg-gray-900 text-white">
            <EditorRuntimeEffects />
            <GoogleFontManager />
            <EditorHeader
                projectName={activeProject?.name ?? ''}
                onRename={updateProjectName}
                onClose={handleClose}
                onUndo={handleUndo}
                onRedo={handleRedo}
                onHistoryPointerDown={handleHistoryPointerDown}
                canUndo={history.length > 0 || hasPendingUndoableDraft}
                canRedo={redoStack.length > 0}
                onCopy={copySelection}
                onPaste={() => pasteSelection(usePlaybackStore.getState().currentTime)}
                canCopy={selectedSubtitleIds.length > 0}
                canPaste={Boolean(clipboard?.length)}
                onSave={handleSave}
                isDirty={isDirty}
                isSaving={isSaving}
                onExportBundle={handleExportBundle}
            />
            <EditorWorkspace
                subtitles={activeTrack?.subtitles ?? []}
                projectFps={projectFps}
                animationStyle={activeTrack?.style}
                isGeneratingSubtitles={transcription.isGenerating}
                onSubtitleClick={handleSubtitleClick}
                onDelete={handleDelete}
                onSubtitlesChange={handleSubtitlesChange}
                onSubtitleUpdate={handleSubtitleUpdate}
                onAddSubtitle={handleAddSubtitle}
                onGenerateSubtitles={transcription.open}
                onAnimationStyleChange={handleAnimationStyleChange}
                onUndo={handleUndo}
                onRedo={handleRedo}
            />
            <TranscriptionModal
                isOpen={transcription.isModalOpen}
                onClose={transcription.close}
                onConfirm={transcription.confirm}
                isProcessing={transcription.isGenerating}
                status={transcription.status}
                onCancelProcessing={transcription.cancel}
            />
            <ConfirmDialog
                isOpen={showExitConfirm}
                title="Leave project"
                message={<>There are unsaved changes. Are you sure you want to leave?</>}
                confirmLabel="Leave without saving"
                cancelLabel="Cancel"
                confirmVariant="danger"
                onConfirm={handleConfirmClose}
                onCancel={() => setShowExitConfirm(false)}
            />
        </div>
    );
}

/** Runtime/store coordination lives in a leaf so its subscriptions cannot repaint the editor UI. */
function EditorRuntimeEffects() {
    useBackgroundRenderer();
    useTimelineAudioEngine();
    useEditorProjectSync();
    return null;
}
