'use client';

import { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    Check,
    KeyRound,
    LoaderCircle,
    Server,
    Sparkles,
    X,
} from 'lucide-react';
import { Button } from '@/components/design-system/Button';
import { Select } from '@/components/design-system/Select';
import type { NarrativeActivationReport } from '@/lib/narrative/commands';
import {
    DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
    loadEditorialTranscriptionPreferences,
    normalizeEditorialTranscriptionPreferences,
    saveEditorialTranscriptionPreferences,
    type EditorialTranscriptionPreferencesV1,
} from '@/lib/editorial-transcription/preferences';
import { useEditorialTranscription } from '@/hooks/use-editorial-transcription';
import { useTimelineStore } from '@/stores/timeline-store';
import type {
    TimelineNarrativeActivationProgress,
    TimelineV4CommandResult,
} from '@/stores/timeline-v4-command-types';
import { chooseDefaultEditorialTrackIds } from './text-editor-model';

interface EditorialSetupPanelProps {
    addingTracks?: boolean;
    onActivated?: (report: NarrativeActivationReport | null) => void;
    onClose?: () => void;
}

type SetupStatus =
    | { kind: 'idle' }
    | { kind: 'running'; progress: TimelineNarrativeActivationProgress | null }
    | { kind: 'error'; message: string }
    | { kind: 'success'; message: string };

const PROGRESS_LABELS: Record<string, string> = {
    'preparing-full-source-audio': 'Preparing full source audio',
    'uploading-source': 'Uploading source',
    'transcribing-and-aligning': 'Transcribing and aligning',
    'validating-edit-timeline': 'Validating edit timeline',
    'saving-transcript-cache': 'Saving transcript cache',
    'building-text-edit': 'Building text edit',
};

/** Separate editorial acquisition form; it never touches subtitle-generation state. */
export function EditorialSetupPanel({
    addingTracks = false,
    onActivated,
    onClose,
}: EditorialSetupPanelProps) {
    const videoTracks = useTimelineStore((state) => state.videoTracks);
    const videoClips = useTimelineStore((state) => state.videoClips);
    const narrative = useTimelineStore((state) => state.narrative);
    const activateNarrative = useTimelineStore((state) => state.activateNarrative);
    const [preferences, setPreferences] = useState<EditorialTranscriptionPreferencesV1>({
        ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
    });
    const [endpointDraft, setEndpointDraft] = useState(
        DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES.endpoint,
    );
    const [languageDraft, setLanguageDraft] = useState('');
    const [preferencesLoaded, setPreferencesLoaded] = useState(false);
    const [storageHealthy, setStorageHealthy] = useState(true);
    const transcriptionSession = useEditorialTranscription();
    const controlledTrackIds = useMemo(
        () => new Set(narrative?.controlledTrackIds ?? []),
        [narrative?.controlledTrackIds],
    );
    const eligibleTracks = useMemo(
        () => videoTracks.filter((track) => !controlledTrackIds.has(track.id)),
        [controlledTrackIds, videoTracks],
    );
    const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
    const [status, setStatus] = useState<SetupStatus>({ kind: 'idle' });
    const [report, setReport] = useState<NarrativeActivationReport | null>(null);

    useEffect(() => {
        const loaded = loadEditorialTranscriptionPreferences(window.localStorage);
        setPreferences(loaded.preferences);
        setEndpointDraft(loaded.preferences.endpoint);
        setLanguageDraft(loaded.preferences.language ?? '');
        setStorageHealthy(loaded.storageHealthy);
        setPreferencesLoaded(true);
    }, []);

    useEffect(() => {
        if (selectedTrackIds.length > 0 || eligibleTracks.length === 0) return;
        setSelectedTrackIds(chooseDefaultEditorialTrackIds(
            eligibleTracks.map((track) => ({ id: track.id, locked: track.locked ?? false })),
            videoClips.map((clip) => ({
                trackId: clip.trackId
                    ?? videoTracks.find((track) => track.clipIds.includes(clip.id))?.id
                    ?? '',
                audio: clip.audio,
            })),
        ));
    }, [eligibleTracks, selectedTrackIds.length, videoClips, videoTracks]);

    const running = status.kind === 'running' || transcriptionSession.state.running;
    const toggleTrack = (trackId: string) => {
        setSelectedTrackIds((current) => current.includes(trackId)
            ? current.filter((id) => id !== trackId)
            : [...current, trackId]);
    };

    const start = async (regenerate = false) => {
        if (selectedTrackIds.length === 0) {
            setStatus({ kind: 'error', message: 'Select at least one unlocked video track.' });
            return;
        }
        let normalized: EditorialTranscriptionPreferencesV1;
        try {
            normalized = normalizeEditorialTranscriptionPreferences({
                ...preferences,
                endpoint: endpointDraft,
                language: languageDraft,
            });
            if (!normalized.endpoint) throw new Error('Enter an OpenAI-compatible transcription endpoint.');
        } catch (error) {
            setStatus({
                kind: 'error',
                message: error instanceof Error ? error.message : 'Transcription settings are invalid.',
            });
            return;
        }

        const saved = saveEditorialTranscriptionPreferences(window.localStorage, normalized);
        setStorageHealthy(saved.storageHealthy);
        setPreferences(normalized);
        setReport(null);
        setStatus({ kind: 'running', progress: null });
        const operation = { signal: undefined as AbortSignal | undefined };
        let result: TimelineV4CommandResult;
        try {
            result = await transcriptionSession.run(({ apiKey, signal }) => {
                operation.signal = signal;
                return activateNarrative({
                    selectedTrackIds,
                    preferences: normalized,
                    ...(apiKey ? { apiKey } : {}),
                    signal,
                    regenerate,
                    splitOnSpeakerChange: normalized.detectSpeakers,
                    onProgress: (progress) => setStatus({ kind: 'running', progress }),
                });
            });
        } catch (error) {
            setStatus({
                kind: 'error',
                message: error instanceof Error
                    ? error.message
                    : 'Text preparation failed before activation.',
            });
            return;
        }
        if (operation.signal?.aborted) {
            setStatus({
                kind: 'error',
                message: 'Text preparation was canceled. Verified cache records, if any, remain reusable.',
            });
            return;
        }
        const activationReport = readActivationReport(result);
        setReport(activationReport);
        if (result.kind === 'error') {
            setStatus({ kind: 'error', message: result.error.message });
            return;
        }
        if (result.kind === 'noop') {
            setStatus({
                kind: 'error',
                message: result.code === 'no-accepted-candidates'
                    ? 'Every candidate overlaps another controlled or selected candidate. Nothing was activated.'
                    : 'No project change was required.',
            });
            return;
        }
        setStatus({
            kind: 'success',
            message: activationReport?.exclusions.length
                ? 'Text editing is ready. Overlapping candidates remained ordinary media.'
                : 'Text editing is ready.',
        });
        onActivated?.(activationReport);
    };

    return (
        <section
            data-testid="editorial-text-setup"
            className="flex h-full min-h-0 flex-col overflow-auto bg-slate-950 px-5 py-4 text-slate-200"
            aria-labelledby="editorial-setup-title"
        >
            <div className="mx-auto grid w-full max-w-4xl gap-4">
                <div className="flex items-start gap-3">
                    <div className="rounded-lg border border-sky-400/30 bg-sky-500/10 p-2 text-sky-200">
                        <Sparkles className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h2 id="editorial-setup-title" className="text-sm font-semibold text-white">
                                {addingTracks ? 'Add controlled tracks' : 'Edit video from text'}
                            </h2>
                            {onClose && (
                                <button
                                    type="button"
                                    className="ml-auto rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"
                                    onClick={onClose}
                                    aria-label="Close text setup"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
                            This workflow edits source-backed media from words. It is independent from
                            subtitles and never creates or rewrites subtitle cues.
                        </p>
                    </div>
                </div>

                <fieldset className="rounded-lg border border-slate-800 bg-slate-900/55 p-3">
                    <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        Video tracks
                    </legend>
                    <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {videoTracks.map((track, index) => {
                            const controlled = controlledTrackIds.has(track.id);
                            const disabled = controlled || Boolean(track.locked) || running;
                            return (
                                <label
                                    key={track.id}
                                    className={`flex items-center gap-2 rounded border px-2.5 py-2 text-xs ${disabled
                                        ? 'border-slate-800 bg-slate-950/40 text-slate-600'
                                        : 'cursor-pointer border-slate-700 bg-slate-950/70 text-slate-200 hover:border-sky-500/50'}`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedTrackIds.includes(track.id)}
                                        disabled={disabled}
                                        onChange={() => toggleTrack(track.id)}
                                        className="accent-sky-500"
                                    />
                                    <span className="rounded bg-sky-500/15 px-1 font-mono text-[10px] text-sky-300">
                                        V{index + 1}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">{track.name}</span>
                                    <span className="text-[10px] text-slate-500">
                                        {controlled ? 'Controlled' : track.locked ? 'Locked' : ''}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                    {eligibleTracks.length === 0 && (
                        <p className="mt-2 text-xs text-slate-500">No additional unlocked video track is available.</p>
                    )}
                </fieldset>

                <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/55 p-3 lg:grid-cols-2">
                    <label className="grid gap-1 text-[11px] text-slate-400 lg:col-span-2">
                        OpenAI-compatible endpoint
                        <input
                            type="url"
                            value={endpointDraft}
                            disabled={running}
                            onChange={(event) => setEndpointDraft(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400"
                        />
                    </label>
                    <div className="grid gap-1 text-[11px] text-slate-400">
                        Request path
                        <div className="flex h-8 rounded border border-slate-700 bg-slate-950 p-0.5" role="group" aria-label="Editorial request path">
                            {(['browser', 'server'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    disabled={running}
                                    aria-pressed={preferences.requestMode === mode}
                                    onClick={() => setPreferences((current) => ({ ...current, requestMode: mode }))}
                                    className={`flex flex-1 items-center justify-center gap-1 rounded text-xs capitalize ${preferences.requestMode === mode
                                        ? 'bg-sky-500/20 text-sky-100'
                                        : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
                                >
                                    <Server className="h-3 w-3" />
                                    {mode}
                                </button>
                            ))}
                        </div>
                        <span className="text-[10px] leading-relaxed text-slate-500">
                            {preferences.requestMode === 'browser'
                                ? 'Browser sends directly; the endpoint must allow CORS.'
                                : 'Server avoids browser CORS; localhost resolves on the Waptions server.'}
                        </span>
                    </div>
                    <label className="grid gap-1 text-[11px] text-slate-400">
                        <span className="flex items-center gap-1"><KeyRound className="h-3 w-3" /> API key (this editor session only)</span>
                        <input
                            type="password"
                            disabled={running}
                            onChange={(event) => transcriptionSession.setApiKey(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400"
                        />
                        <span className="text-[10px] text-slate-500">Never saved to preferences, project history, cache, or bundles.</span>
                    </label>
                    <label className="grid gap-1 text-[11px] text-slate-400">
                        Language
                        <input
                            type="text"
                            value={languageDraft}
                            disabled={running}
                            onChange={(event) => setLanguageDraft(event.target.value)}
                            placeholder="Auto detect"
                            autoComplete="off"
                            className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-white outline-none focus:border-sky-400"
                        />
                    </label>
                    <label className="grid gap-1 text-[11px] text-slate-400">
                        Speaker analysis
                        <Select
                            value={preferences.detectSpeakers ? 'on' : 'off'}
                            disabled={running}
                            tone="modal"
                            controlSize="xs"
                            onChange={(event) => setPreferences((current) => ({
                                ...current,
                                detectSpeakers: event.target.value === 'on',
                            }))}
                        >
                            <option value="off">Do not detect speakers</option>
                            <option value="on">Detect speakers</option>
                        </Select>
                    </label>
                    <div className="rounded border border-slate-800 bg-slate-950/70 px-2.5 py-2 text-[11px] text-slate-400 lg:col-span-2">
                        Accuracy profile: <strong className="text-slate-200">qwen-1.7b-edit-max</strong>
                        <span className="mx-1.5 text-slate-600">·</span>
                        <strong className="text-slate-200">edit-max-v1</strong>
                        <span className="ml-2 text-slate-500">Fixed for this production workflow.</span>
                    </div>
                </div>

                {!storageHealthy && preferencesLoaded && (
                    <p className="flex items-center gap-1.5 text-xs text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Browser preference storage is unavailable. The current non-secret settings remain in memory only.
                    </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        variant="primary"
                        size="sm"
                        disabled={running || selectedTrackIds.length === 0 || eligibleTracks.length === 0}
                        onClick={() => void start(false)}
                        className="h-8 px-3 text-xs"
                    >
                        {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Sparkles className="h-3.5 w-3.5" />}
                        {addingTracks ? 'Add controlled tracks' : 'Prepare text editor'}
                    </Button>
                    {status.kind === 'error' && (
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={running}
                            onClick={() => void start(false)}
                            className="h-8 px-3 text-xs"
                        >
                            Retry
                        </Button>
                    )}
                    {running && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={transcriptionSession.cancel}
                            className="h-8 px-3 text-xs text-slate-300"
                        >
                            Cancel
                        </Button>
                    )}
                    {status.kind === 'success' && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void start(true)}
                            className="h-8 px-3 text-xs text-slate-400"
                            title="Bypass the request index and acquire the same full-source profile again"
                        >
                            Regenerate
                        </Button>
                    )}
                </div>

                <SetupStatusView status={status} />
                {report && <ActivationReportView report={report} videoTracks={videoTracks} />}
            </div>
        </section>
    );
}

function SetupStatusView({ status }: { status: SetupStatus }) {
    if (status.kind === 'idle') return null;
    if (status.kind === 'running') {
        const progress = status.progress;
        return (
            <div
                role="status"
                aria-live="polite"
                className="rounded border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-100"
            >
                <div className="flex items-center gap-2">
                    <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                    <span className="font-medium">
                        {progress ? PROGRESS_LABELS[progress.stage] ?? 'Preparing text editor' : 'Starting text preparation'}
                    </span>
                    {progress && progress.stage !== 'building-text-edit' && progress.sourceCount > 1 && (
                        <span className="text-sky-300">{progress.sourceIndex + 1} of {progress.sourceCount}</span>
                    )}
                </div>
                {progress && progress.stage !== 'building-text-edit' && progress.cacheHit && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-300">
                        <Check className="h-3 w-3" /> Using a verified full-source transcript cache record.
                    </p>
                )}
                <div className="mt-2 h-1 overflow-hidden rounded bg-sky-950">
                    <div className="h-full w-1/3 animate-pulse rounded bg-sky-400 motion-reduce:animate-none" />
                </div>
                <p className="mt-1 text-[10px] text-sky-300">Remote alignment is indeterminate; no percentage is estimated.</p>
            </div>
        );
    }
    return (
        <p
            role={status.kind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            className={`rounded border px-3 py-2 text-xs ${status.kind === 'error'
                ? 'border-red-500/30 bg-red-500/10 text-red-200'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}
        >
            {status.message}
        </p>
    );
}

export function ActivationReportView({
    report,
    videoTracks,
}: {
    report: NarrativeActivationReport;
    videoTracks: readonly { id: string; name: string }[];
}) {
    if (report.exclusions.length === 0) return null;
    const trackNames = new Map(videoTracks.map((track) => [track.id, track.name]));
    return (
        <section className="rounded border border-amber-500/30 bg-amber-500/5 p-3" aria-labelledby="overlap-report-title">
            <h3 id="overlap-report-title" className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5" />
                {report.exclusions.length} overlapping {report.exclusions.length === 1 ? 'candidate' : 'candidates'} excluded
            </h3>
            <p className="mt-1 text-[11px] text-amber-100/70">
                Excluded clips remain ordinary media. No winner was selected from an overlap-connected component.
            </p>
            <ul className="mt-2 grid gap-1.5">
                {report.exclusions.map((exclusion) => (
                    <li key={exclusion.candidateId} className="rounded bg-slate-950/60 px-2 py-1.5 text-[11px] text-slate-300">
                        <span className="font-medium text-amber-100">{exclusion.candidateId}</span>
                        <span className="mx-1.5 text-slate-600">·</span>
                        {trackNames.get(exclusion.trackId) ?? exclusion.trackId}
                        <span className="mx-1.5 text-slate-600">·</span>
                        frames [{exclusion.interval.start}, {exclusion.interval.end})
                        <span className="mx-1.5 text-slate-600">·</span>
                        conflicts with {exclusion.conflictingIds.join(', ')}
                    </li>
                ))}
            </ul>
        </section>
    );
}

function readActivationReport(result: TimelineV4CommandResult): NarrativeActivationReport | null {
    if ('activationReport' in result && result.activationReport) return result.activationReport;
    // Compatibility with the initial WP6 no-accepted result; the connector normalizes this to the
    // declared `activationReport` shape, but retaining the read boundary keeps old in-memory tests
    // and an interrupted hot-reload session able to show the exclusion evidence.
    if ('acceptedClipIds' in result && 'exclusions' in result
        && Array.isArray(result.acceptedClipIds) && Array.isArray(result.exclusions)) {
        return {
            acceptedClipIds: result.acceptedClipIds as string[],
            exclusions: result.exclusions as NarrativeActivationReport['exclusions'],
        };
    }
    return null;
}
