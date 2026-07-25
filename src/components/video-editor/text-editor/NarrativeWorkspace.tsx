'use client';

import { useEffect, useMemo, useState } from 'react';
import {
    ArchiveRestore,
    Eye,
    EyeOff,
    GitMerge,
    LocateFixed,
    Plus,
    Scissors,
    Trash2,
    Unplug,
} from 'lucide-react';
import { Button } from '@/components/design-system/Button';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';
import { Select } from '@/components/design-system/Select';
import { formatShortcutTitle, getShortcutAriaKeys } from '@/config/shortcuts';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { secondsToFrames } from '@/lib/render-profile';
import { usePlaybackStore } from '@/stores/playback-store';
import { timelineEditorialRuntime } from '@/stores/timeline-editorial-runtime';
import { useTimelineStore } from '@/stores/timeline-store';
import type { NarrativeActivationReport } from '@/lib/narrative/commands';
import { ActivationReportView, EditorialSetupPanel } from './EditorialSetupPanel';
import { GlobalEditingModeControl } from './GlobalEditingModeControl';
import { NarrativeList } from './NarrativeList';
import { SourceRangeDialog } from './SourceRangeDialog';
import {
    buildNarrativeListProjection,
    getBlockSplitSample,
    getSelectedWordBounds,
    summarizeSilenceDeletion,
} from './text-editor-model';
import { useTextEditorCommands } from './useTextEditorCommands';

interface NarrativeWorkspaceProps {
    active: boolean;
    latestActivationReport: NarrativeActivationReport | null;
    onActivationReport: (report: NarrativeActivationReport | null) => void;
}

type SilenceScope = { kind: 'document' } | { kind: 'track'; trackId: string };

/** Active document-wide narrative editor backed only by the canonical V4 store/runtime graph. */
export function NarrativeWorkspace({
    active,
    latestActivationReport,
    onActivationReport,
}: NarrativeWorkspaceProps) {
    const revision = useTimelineStore((state) => state.revision);
    const transientSelection = useTimelineStore((state) => state.transientSelection);
    const document = useMemo(
        () => {
            if (!Number.isSafeInteger(revision)) throw new Error('Timeline revision must be a safe integer.');
            return useTimelineStore.getState().buildEditorDocumentV4();
        },
        [revision],
    );
    // TextEditorWorkspace mounts this component only for an active narrative. Keeping the
    // invariant explicit avoids conditional hook registration while the parent swaps setup and
    // active workspaces atomically on the same store revision.
    const narrative = document.narrative!;
    const { feedback, pending, runNarrative, runMode, runRelease } = useTextEditorCommands();
    const [showAddTracks, setShowAddTracks] = useState(false);
    const [sourceAction, setSourceAction] = useState<'insert' | 'recover' | null>(null);
    const [silenceScope, setSilenceScope] = useState<SilenceScope | null>(null);
    const [releaseTrackId, setReleaseTrackId] = useState(narrative.controlledTrackIds[0] ?? '');
    const [followPlayhead, setFollowPlayhead] = useState(false);
    const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);

    useEffect(() => {
        if (!narrative.controlledTrackIds.includes(releaseTrackId)) {
            setReleaseTrackId(narrative.controlledTrackIds[0] ?? '');
        }
    }, [narrative.controlledTrackIds, releaseTrackId]);

    const projection = useMemo(
        () => buildNarrativeListProjection({
            narrative,
            bodies: timelineEditorialRuntime.getResolvedBodies(),
            videoClips: document.videoClips,
            videoTracks: document.videoTracks,
            dependentLinks: document.dependentLinks,
            renderProfile: document.renderProfile,
        }),
        // Switching panes changes only `active`. A stable projection prevents NarrativeList's
        // selection-focus effect from stealing focus back from the persistent Timeline/Text tabs.
        // Every durable narrative/body publication advances the document revision and therefore
        // replaces this memoized document, so real edits still rebuild the projection.
        [document, narrative],
    );
    const selectedRow = transientSelection.kind === 'narrative'
        ? projection.blockRowById.get(transientSelection.blockId)
        : undefined;
    const selectedBounds = selectedRow && transientSelection.kind === 'narrative'
        ? getSelectedWordBounds(selectedRow, transientSelection.sourceWordIds)
        : null;
    const splitSample = selectedRow && transientSelection.kind === 'narrative'
        ? getBlockSplitSample(selectedRow, transientSelection.sourceWordIds)
        : null;
    const selectedIndex = selectedRow ? narrative.blockIds.indexOf(selectedRow.id) : -1;
    const mergeRightId = selectedIndex >= 0 ? narrative.blockIds[selectedIndex + 1] : undefined;
    const controlledTracks = document.videoTracks.filter((track) => (
        narrative.controlledTrackIds.includes(track.id)
    ));
    const releaseTrack = controlledTracks.find((track) => track.id === releaseTrackId);

    const currentPlayheadFrame = () => secondsToFrames(
        usePlaybackStore.getState().currentTime,
        document.renderProfile.fps,
        'nearest',
    );

    const splitSelection = () => {
        if (!selectedRow || splitSample === null) return;
        void runNarrative({
            type: 'split-block',
            blockId: selectedRow.id,
            splitSample,
        }, { structural: true });
    };

    const mergeSelection = () => {
        if (!selectedRow || !mergeRightId) return;
        void runNarrative({
            type: 'merge-blocks',
            leftBlockId: selectedRow.id,
            rightBlockId: mergeRightId,
        }, { structural: true });
    };

    const deleteSelection = () => {
        if (!selectedRow) return;
        if (selectedBounds) {
            void runNarrative({
                type: 'delete-words',
                firstBlockId: selectedRow.id,
                firstWordId: selectedBounds.firstWordId,
                lastBlockId: selectedRow.id,
                lastWordId: selectedBounds.lastWordId,
                currentPlayheadFrame: currentPlayheadFrame(),
            }, { structural: true });
            return;
        }
        void runNarrative({
            type: 'delete-range',
            selection: {
                start: { blockId: selectedRow.id, sample: selectedRow.block.coreStartSample },
                end: { blockId: selectedRow.id, sample: selectedRow.block.coreEndSample },
            },
            currentPlayheadFrame: currentPlayheadFrame(),
        }, { structural: true });
    };

    const confirmDeleteSilences = () => {
        const scope = silenceScope;
        setSilenceScope(null);
        if (!scope) return;
        void runNarrative({
            type: 'delete-all-silences',
            scope,
            currentPlayheadFrame: currentPlayheadFrame(),
        }, { structural: true });
    };

    useKeyboardShortcuts(active ? {
        TEXT_SPLIT_BLOCK: splitSelection,
        TEXT_MERGE_NEXT: mergeSelection,
        TEXT_DELETE_SELECTION: deleteSelection,
        TEXT_DELETE_ALL_SILENCES: () => setSilenceScope({ kind: 'document' }),
    } : {});

    const deleteSummary = silenceScope
        ? summarizeSilenceDeletion({
            narrative,
            videoClips: document.videoClips,
            renderProfile: document.renderProfile,
            ...(silenceScope.kind === 'track' ? { trackId: silenceScope.trackId } : {}),
        })
        : null;
    const scopeTrack = silenceScope?.kind === 'track'
        ? document.videoTracks.find((track) => track.id === silenceScope.trackId)
        : null;

    return (
        <section className="relative flex h-full min-h-0 flex-col bg-slate-950" aria-label="Text editor">
            <div
                data-testid="text-editor-toolbar"
                className="flex h-10 flex-none items-center gap-1.5 overflow-x-auto border-b border-slate-800 bg-slate-900/95 px-2"
            >
                {/* EditorWorkspace renders the single persistent pane selector over this slot. */}
                <div className="w-40 flex-none" aria-hidden="true" />
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-slate-300"
                    disabled={!selectedRow || splitSample === null || pending}
                    title={formatShortcutTitle('Split selected text block', 'TEXT_SPLIT_BLOCK')}
                    aria-keyshortcuts={getShortcutAriaKeys('TEXT_SPLIT_BLOCK')}
                    onClick={splitSelection}
                >
                    <Scissors className="h-3.5 w-3.5" /> Split
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-slate-300"
                    disabled={!selectedRow || !mergeRightId || pending}
                    title={formatShortcutTitle('Merge with the next narrative block', 'TEXT_MERGE_NEXT')}
                    aria-keyshortcuts={getShortcutAriaKeys('TEXT_MERGE_NEXT')}
                    onClick={mergeSelection}
                >
                    <GitMerge className="h-3.5 w-3.5" /> Merge next
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-red-300"
                    disabled={!selectedRow || pending}
                    title={formatShortcutTitle('Delete selected source-backed media', 'TEXT_DELETE_SELECTION')}
                    aria-keyshortcuts={getShortcutAriaKeys('TEXT_DELETE_SELECTION')}
                    onClick={deleteSelection}
                >
                    <Trash2 className="h-3.5 w-3.5" /> Delete media
                </Button>
                <div className="mx-1 h-5 w-px flex-none bg-slate-700" />
                <GlobalEditingModeControl
                    mode={document.globalEditingMode}
                    disabled={pending}
                    onChange={(mode) => void runMode(mode)}
                />
                <div className="mx-1 h-5 w-px flex-none bg-slate-700" />
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-amber-200"
                    disabled={pending}
                    title={formatShortcutTitle('Delete all source-backed silences in the document', 'TEXT_DELETE_ALL_SILENCES')}
                    aria-keyshortcuts={getShortcutAriaKeys('TEXT_DELETE_ALL_SILENCES')}
                    onClick={() => setSilenceScope({ kind: 'document' })}
                >
                    Delete all silences
                </Button>
                <Select
                    value={releaseTrackId}
                    tone="modal"
                    controlSize="xs"
                    wrapperClassName="w-36 flex-none"
                    aria-label="Controlled track for secondary actions"
                    onChange={(event) => setReleaseTrackId(event.target.value)}
                >
                    {controlledTracks.map((track) => (
                        <option key={track.id} value={track.id}>V{document.videoTracks.indexOf(track) + 1} · {track.name}</option>
                    ))}
                </Select>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[10px] text-slate-400"
                    disabled={!releaseTrack || pending}
                    title={`Delete source-backed silence only on ${releaseTrack?.name ?? 'the selected controlled track'}`}
                    onClick={() => releaseTrack && setSilenceScope({ kind: 'track', trackId: releaseTrack.id })}
                >
                    Track silences
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[10px] text-slate-400"
                    disabled={!releaseTrack || pending}
                    title="Release Text ownership while keeping current media placement"
                    onClick={() => releaseTrack && setShowReleaseConfirm(true)}
                >
                    <Unplug className="h-3 w-3" /> Release
                </Button>
                <div className="ml-auto flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[10px] text-slate-400"
                        onClick={() => void runNarrative({
                            type: 'set-speaker-visibility',
                            showSpeakers: !narrative.settings.showSpeakers,
                        }, { structural: false })}
                        title={narrative.settings.showSpeakers ? 'Hide speaker badges' : 'Show speaker badges'}
                    >
                        {narrative.settings.showSpeakers
                            ? <EyeOff className="h-3 w-3" />
                            : <Eye className="h-3 w-3" />}
                        Speakers
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        isActive={followPlayhead}
                        aria-pressed={followPlayhead}
                        className="h-7 px-2 text-[10px] text-slate-400"
                        onClick={() => setFollowPlayhead((current) => !current)}
                        title="Keep the active narrative occurrence visible while playback moves; focus is never stolen"
                    >
                        <LocateFixed className="h-3 w-3" /> Follow playhead
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[10px] text-slate-400"
                        onClick={() => setSourceAction('recover')}
                        title="Browse an immutable full-source transcript and recover deleted media"
                    >
                        <ArchiveRestore className="h-3 w-3" /> Recover
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[10px] text-slate-400"
                        onClick={() => setSourceAction('insert')}
                        title="Insert another occurrence from an immutable full-source transcript"
                    >
                        <Plus className="h-3 w-3" /> Insert
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[10px] text-sky-200"
                        onClick={() => setShowAddTracks(true)}
                        title="Acquire transcripts and add another isolated source track to the unified narrative"
                    >
                        <Plus className="h-3 w-3" /> Controlled track
                    </Button>
                </div>
            </div>

            {latestActivationReport && latestActivationReport.exclusions.length > 0 && (
                <details className="flex-none border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
                    <summary className="cursor-pointer text-[10px] text-amber-200">
                        {latestActivationReport.exclusions.length} overlap-excluded candidates remain ordinary media
                    </summary>
                    <div className="mt-2">
                        <ActivationReportView report={latestActivationReport} videoTracks={document.videoTracks} />
                    </div>
                </details>
            )}

            <NarrativeList
                projection={projection}
                selection={transientSelection}
                videoSources={document.videoSources}
                videoTracks={document.videoTracks}
                projectFps={document.renderProfile.fps}
                mode={document.globalEditingMode}
                showSpeakers={narrative.settings.showSpeakers}
                followPlayhead={followPlayhead}
                onSelect={(blockId, sourceWordIds) => {
                    useTimelineStore.getState().selectNarrativeRange(blockId, sourceWordIds);
                }}
                onReorder={(blockId, targetIndex) => void runNarrative({
                    type: 'reorder-blocks',
                    blockIds: [blockId],
                    targetIndex,
                }, { structural: true })}
            />

            {feedback.message && (
                <p
                    role={feedback.tone === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                    className={`flex-none border-t px-3 py-1.5 text-[10px] ${feedback.tone === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-200'
                        : feedback.tone === 'success'
                            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200'
                            : 'border-slate-800 bg-slate-900 text-slate-400'}`}
                >
                    {feedback.message}
                </p>
            )}

            {showAddTracks && (
                <div className="absolute inset-0 z-40 bg-slate-950">
                    <EditorialSetupPanel
                        addingTracks
                        onClose={() => setShowAddTracks(false)}
                        onActivated={(report) => {
                            onActivationReport(report);
                            setShowAddTracks(false);
                        }}
                    />
                </div>
            )}
            {sourceAction && (
                <SourceRangeDialog
                    action={sourceAction}
                    pending={pending}
                    runNarrative={runNarrative}
                    onClose={() => setSourceAction(null)}
                />
            )}
            <ConfirmDialog
                isOpen={silenceScope !== null}
                title={scopeTrack ? `Delete silences on ${scopeTrack.name}` : 'Delete all silences'}
                message={deleteSummary ? (
                    <>
                        Delete <strong>{deleteSummary.count}</strong> source-backed silence or
                        untranscribed {deleteSummary.count === 1 ? 'block' : 'blocks'} totaling{' '}
                        <strong>{deleteSummary.durationFrames} project frames</strong>?
                        {scopeTrack
                            ? ` Every other controlled track, speech block, ordinary target, subtitle, and project gap is preserved.`
                            : ` This is document scope; speech, ordinary targets, subtitles, and project gaps are preserved.`}
                        {' '}{document.globalEditingMode === 'ripple'
                            ? 'Ripple mode closes the removed durations across the unified narrative.'
                            : 'Absolute mode preserves unrelated starts and leaves project gaps.'}
                    </>
                ) : 'No source-backed silence is selected for deletion.'}
                confirmLabel="Delete silences"
                cancelLabel="Cancel"
                confirmVariant="danger"
                onConfirm={confirmDeleteSilences}
                onCancel={() => setSilenceScope(null)}
            />
            <ConfirmDialog
                isOpen={showReleaseConfirm}
                title={`Release ${releaseTrack?.name ?? 'controlled track'}`}
                message={releaseTrack ? (
                    <>
                        Stop controlling <strong>{releaseTrack.name}</strong> from Text? Its current
                        video occurrences remain exactly in place as ordinary media. Links anchored
                        only to released blocks are resolved by their persisted follow policy. This
                        can be undone from history.
                    </>
                ) : 'The controlled track is no longer available.'}
                confirmLabel="Release control"
                cancelLabel="Cancel"
                onConfirm={() => {
                    setShowReleaseConfirm(false);
                    if (releaseTrack) void runRelease([releaseTrack.id]);
                }}
                onCancel={() => setShowReleaseConfirm(false)}
            />
        </section>
    );
}
