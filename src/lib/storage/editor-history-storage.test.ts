import { describe, expect, it } from 'vitest';
import { createEditorManifestV3 } from '@/lib/editor-document-migration';
import { getEditorAudioGraphSignature } from '@/lib/editor-document-v3';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { createSerializablePatches } from '@/lib/serializable-patch';
import type { EditorDocumentV3 } from '@/types/video';
import type { AnimationStyle } from '@/types/timeline';
import { TIMELINE_HISTORY_ROOTS } from '@/stores/timeline-history-projection';
import { recordTimelineHistory } from '@/stores/timeline-history';
import {
    EDITOR_HISTORY_STORAGE_VERSION,
    createHistoryIndex,
    getManifestSourceSignature,
    projectEditorDocumentHistory,
    recoveryEntryStorageKey,
    restoreEditorRuntimeState,
} from './editor-history-storage';

const document = (revision = 4): EditorDocumentV3 => ({
    version: 3,
    revision,
    audioGraphRevision: 0,
    renderProfile: createDefaultRenderProfile(),
    subtitleTracks: [{
        id: 'captions',
        name: 'Captions',
        style: {} as AnimationStyle,
        subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'Before' }],
        isVisible: true,
        isLocked: false,
        timingDomain: 'absolute',
    }],
    videoSources: [],
    videoClips: [],
    videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: [] }],
    audioSources: [],
    audioTracks: [],
    activeSubtitleTrackId: 'captions',
    transientSelection: { kind: 'none' },
    transcriptionByTrackId: {},
});

const documentWithAudio = (revision = 4): EditorDocumentV3 => ({
    ...document(revision),
    videoSources: [{
        id: 'video_source',
        originalName: 'video.mp4',
        mimeType: 'video/mp4',
        size: 100,
        lastModified: 1,
        fingerprint: 'video-fingerprint',
        duration: 2,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: null,
        hasAudio: true,
        file: {
            name: 'video.mp4',
            type: 'video/mp4',
            size: 100,
            lastModified: 1,
        } as File,
    }],
    videoClips: [{
        id: 'video_clip',
        sourceId: 'video_source',
        sourceStart: 0,
        sourceEnd: 2,
        audio: {
            linkState: 'linked',
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        },
    }],
    videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['video_clip'] }],
});

describe('editor history and recovery storage', () => {
    it('discards incompatible pre-lane history storage without affecting the durable document', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            {
                version: 1,
                documentRevision: baseline.revision,
                sourceSignature: getManifestSourceSignature(manifest),
                historyEntryIds: ['legacy'],
                redoEntryIds: [],
            },
            new Map(),
            null,
            new Map(),
        );
        expect(restored.document).toBe(baseline);
        expect(restored.history.history).toEqual([]);
        expect(restored.recovered).toBe(false);
    });

    it('applies a complete source-stable WAL chain and restores both document revisions', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const before = projectEditorDocumentHistory(baseline);
        const after = structuredClone(before);
        after.tracks[0].subtitles[0].text = 'Recovered';
        const patches = createSerializablePatches(
            before,
            after,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        ).patches;
        const key = recoveryEntryStorageKey(5);
        const recoveredHistoryIndex = createHistoryIndex({ ...manifest, revision: 5 }, {
            history: [],
            redoStack: [],
            projection: after,
        });

        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            null,
            new Map(),
            {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [key],
            },
            new Map([[key, {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                fromRevision: 4,
                toRevision: 5,
                fromAudioGraphRevision: 0,
                toAudioGraphRevision: 3,
                patches,
                historyIndex: recoveredHistoryIndex,
                historyEntries: [],
            }]]),
        );

        expect(restored.recovered).toBe(true);
        expect(restored.document.revision).toBe(5);
        expect(restored.document.audioGraphRevision).toBe(3);
        expect(restored.document.subtitleTracks[0].subtitles[0].text).toBe('Recovered');
        expect(restored.recoveryEntryKeys).toEqual([key]);
    });

    it('restores video lane membership from a complete WAL entry', () => {
        const baseline = documentWithAudio();
        const manifest = createEditorManifestV3(baseline);
        const before = projectEditorDocumentHistory(baseline);
        const after = structuredClone(before);
        after.videoTracks = [{ id: 'recovered_lane', name: 'Recovered lane', clipIds: ['video_clip'] }];
        const key = recoveryEntryStorageKey(5);

        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            null,
            new Map(),
            {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [key],
            },
            new Map([[key, {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                fromRevision: 4,
                toRevision: 5,
                fromAudioGraphRevision: 0,
                toAudioGraphRevision: 0,
                patches: createSerializablePatches(
                    before,
                    after,
                    TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
                ).patches,
                historyIndex: createHistoryIndex({
                    ...manifest,
                    revision: 5,
                    videoTracks: after.videoTracks.map((track) => ({
                        id: track.id,
                        name: track.name,
                        clipIds: [...(track.clipIds ?? [])],
                    })),
                }, {
                    history: [],
                    redoStack: [],
                    projection: after,
                }),
                historyEntries: [],
            }]]),
        );

        expect(restored.recovered).toBe(true);
        expect(restored.document.videoTracks).toEqual(after.videoTracks);
        expect(restored.document.videoTracks).not.toBe(after.videoTracks);
    });

    it('keeps durable history separate from entries supplied only by recovery', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const currentProjection = projectEditorDocumentHistory(baseline);
        const originalProjection = structuredClone(currentProjection);
        originalProjection.tracks[0].name = 'Original';
        const durableState = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            originalProjection,
            currentProjection,
            {
                metadata: { label: 'Rename subtitle track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1,
            },
        );
        const recoveredProjection = structuredClone(currentProjection);
        recoveredProjection.tracks[0].subtitles[0].text = 'Recovered';
        const recoveredState = recordTimelineHistory(
            durableState,
            currentProjection,
            recoveredProjection,
            {
                metadata: { label: 'Edit subtitle' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 2,
            },
        );
        const durableIndex = createHistoryIndex(manifest, {
            history: durableState.history,
            redoStack: [],
            projection: currentProjection,
        });
        const recoveredManifest = { ...manifest, revision: 5 };
        const recoveredIndex = createHistoryIndex(recoveredManifest, {
            history: recoveredState.history,
            redoStack: [],
            projection: recoveredProjection,
        });
        const key = recoveryEntryStorageKey(5);
        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            durableIndex,
            new Map([[durableState.history[0].id, durableState.history[0]]]),
            {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [key],
            },
            new Map([[key, {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                fromRevision: 4,
                toRevision: 5,
                fromAudioGraphRevision: 0,
                toAudioGraphRevision: 0,
                patches: createSerializablePatches(
                    currentProjection,
                    recoveredProjection,
                    TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
                ).patches,
                historyIndex: recoveredIndex,
                historyEntries: [recoveredState.history[1]],
            }]]),
        );

        expect(restored.durableHistory.history.map((entry) => entry.id)).toEqual(['history-1']);
        expect(restored.history.history.map((entry) => entry.id)).toEqual(['history-1', 'history-2']);
        expect(restored.recovered).toBe(true);
    });

    it('rejects the entire WAL when any revision link is missing', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const firstKey = recoveryEntryStorageKey(5);
        const secondKey = recoveryEntryStorageKey(6);
        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            null,
            new Map(),
            {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [firstKey, secondKey],
            },
            new Map([[firstKey, {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                fromRevision: 5,
                toRevision: 6,
                fromAudioGraphRevision: 0,
                toAudioGraphRevision: 0,
                patches: [{ op: 'set', path: ['tracks', { id: 'captions' }, 'name'], value: 'Partial' }],
                historyIndex: createHistoryIndex({ ...manifest, revision: 6 }, {
                    history: [],
                    redoStack: [],
                    projection: projectEditorDocumentHistory(baseline),
                }),
                historyEntries: [],
            }]]),
        );

        expect(restored.recovered).toBe(false);
        expect(restored.document).toBe(baseline);
        expect(restored.recoveryEntryKeys).toEqual([firstKey, secondKey]);
    });

    it('requires history checkpoint and document revisions to match exactly', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const staleIndex = createHistoryIndex({ ...manifest, revision: 3 }, {
            history: [],
            redoStack: [],
            projection: projectEditorDocumentHistory(baseline),
        });
        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            staleIndex,
            new Map(),
            null,
            new Map(),
        );

        expect(restored.history.history).toEqual([]);
        expect(restored.history.historySequence).toBe(0);
    });

    it('discards syntactically valid history that cannot round-trip the restored document', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const current = projectEditorDocumentHistory(baseline);
        const original = structuredClone(current);
        original.tracks[0].name = 'Original';
        const recorded = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            original,
            current,
            {
                metadata: { label: 'Rename subtitle track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1,
            },
        );
        const corruptEntry = structuredClone(recorded.history[0]);
        corruptEntry.inversePatches = [{
            op: 'set',
            path: ['tracks', { id: 'missing-track' }, 'name'],
            value: 'Original',
        }];
        const index = createHistoryIndex(manifest, {
            history: [corruptEntry],
            redoStack: [],
            projection: current,
        });

        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            index,
            new Map([[corruptEntry.id, corruptEntry]]),
            null,
            new Map(),
        );

        expect(restored.durableHistory.history).toEqual([]);
        expect(restored.history.history).toEqual([]);
    });

    it('rejects history that encodes a missing non-null active subtitle track', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const current = projectEditorDocumentHistory(baseline);
        const original = structuredClone(current);
        original.tracks[0].name = 'Original';
        const recorded = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            original,
            current,
            {
                metadata: { label: 'Rename subtitle track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1,
            },
        );
        const corruptEntry = structuredClone(recorded.history[0]);
        const inverseActiveTrack = corruptEntry.inversePatches.find((patch) => (
            patch.path.length === 1 && patch.path[0] === 'activeTrackId'
        ));
        if (!inverseActiveTrack || inverseActiveTrack.op !== 'set') {
            throw new Error('Expected active track context patch.');
        }
        inverseActiveTrack.value = 'missing-track';
        const index = createHistoryIndex(manifest, {
            history: [corruptEntry],
            redoStack: [],
            projection: current,
        });

        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            index,
            new Map([[corruptEntry.id, corruptEntry]]),
            null,
            new Map(),
        );

        expect(restored.durableHistory.history).toEqual([]);
        expect(restored.history.history).toEqual([]);
    });

    it('rejects history whose inverse produces malformed video lane membership', () => {
        const baseline = documentWithAudio();
        const manifest = createEditorManifestV3(baseline);
        const current = projectEditorDocumentHistory(baseline);
        const original = structuredClone(current);
        original.videoTracks = [{ id: 'previous_lane', name: 'Previous lane', clipIds: ['video_clip'] }];
        const recorded = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            original,
            current,
            {
                metadata: { label: 'Move video clip to track' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1,
            },
        );
        const corruptEntry = structuredClone(recorded.history[0]);
        corruptEntry.inversePatches = [{
            op: 'set',
            path: ['videoTracks'],
            value: [
                { id: 'lane_a', name: 'Lane A', clipIds: ['video_clip'] },
                { id: 'lane_b', name: 'Lane B', clipIds: ['video_clip'] },
            ],
        }];
        const index = createHistoryIndex(manifest, {
            history: [corruptEntry],
            redoStack: [],
            projection: current,
        });

        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            index,
            new Map([[corruptEntry.id, corruptEntry]]),
            null,
            new Map(),
        );

        expect(restored.durableHistory.history).toEqual([]);
        expect(restored.history.history).toEqual([]);
        expect(restored.document).toBe(baseline);
    });

    it('retains valid history across fresh transcription and a later audio graph command', () => {
        const initialDocument = documentWithAudio();
        const initial = projectEditorDocumentHistory(initialDocument);
        const afterSubtitle = structuredClone(initial);
        afterSubtitle.tracks[0].subtitles[0].text = 'After';
        const subtitleHistory = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            initial,
            afterSubtitle,
            {
                metadata: { label: 'Edit subtitle' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: false,
                now: 1,
            },
        );
        const freshTranscription = structuredClone(afterSubtitle);
        freshTranscription.transcriptionByTrackId = {
            captions: {
                raw: [],
                groups: {},
                containerIds: [],
                sourceDocumentRevision: 5,
                sourceAudioGraphRevision: 0,
                sourceAudioGraphSignature: getEditorAudioGraphSignature(initialDocument),
                stale: false,
            },
        };
        const afterAudioMutation = structuredClone(freshTranscription);
        afterAudioMutation.videoClips[0].audio!.muted = true;
        afterAudioMutation.transcriptionByTrackId.captions.stale = true;
        const completeHistory = recordTimelineHistory(
            subtitleHistory,
            freshTranscription,
            afterAudioMutation,
            {
                metadata: { label: 'Mute embedded audio' },
                impact: 'invalidate-transcription',
                recalculatesContentBoundary: false,
                now: 2,
            },
        );
        const currentDocument = structuredClone(initialDocument);
        currentDocument.revision = 6;
        currentDocument.audioGraphRevision = 1;
        currentDocument.subtitleTracks[0].subtitles[0].text = 'After';
        currentDocument.videoClips[0].audio!.muted = true;
        currentDocument.transcriptionByTrackId = afterAudioMutation.transcriptionByTrackId;
        const manifest = createEditorManifestV3(currentDocument);
        const index = createHistoryIndex(manifest, {
            history: completeHistory.history,
            redoStack: [],
            projection: afterAudioMutation,
        });

        const restored = restoreEditorRuntimeState(
            currentDocument,
            manifest,
            index,
            new Map(completeHistory.history.map((entry) => [entry.id, entry])),
            null,
            new Map(),
        );

        expect(restored.durableHistory.history.map((entry) => entry.id)).toEqual([
            'history-1',
            'history-2',
        ]);
        expect(restored.history.history.map((entry) => entry.id)).toEqual([
            'history-1',
            'history-2',
        ]);
    });

    it('round-trips an anchored diarization set as one persisted history command', () => {
        const baseline = document();
        const before = projectEditorDocumentHistory(baseline);
        const after = structuredClone(before);
        after.tracks = [
            { ...after.tracks[0], subtitles: [{ id: 'speaker_a', startTime: 0, endTime: 1, text: 'A' }] },
            {
                ...after.tracks[0],
                id: 'speaker_track_2',
                name: 'Speaker 2',
                subtitles: [{ id: 'speaker_b', startTime: 1, endTime: 2, text: 'B' }],
            },
        ];
        const signature = getEditorAudioGraphSignature(baseline);
        const makeProvenance = (trackId: string, ordinal: number, subtitleId: string) => ({
            raw: [{ id: subtitleId, startTime: ordinal, endTime: ordinal + 1, text: ordinal ? 'B' : 'A' }],
            groups: {
                [`group_${ordinal}`]: [{
                    id: subtitleId, startTime: ordinal, endTime: ordinal + 1, text: ordinal ? 'B' : 'A',
                }],
            },
            containerIds: [`group_${ordinal}`],
            provider: 'custom-openai-compatible',
            model: 'whisper-1',
            generatedAt: '2026-07-17T20:00:00.000Z',
            sourceDocumentRevision: 5,
            sourceAudioGraphRevision: 0,
            sourceAudioGraphSignature: signature,
            stale: false,
            extensions: {
                'waptions.transcription.diarization': {
                    version: 1,
                    setId: 'persisted_set',
                    targetTrackId: 'captions',
                    speakerOrdinal: ordinal,
                    sourceSpeakerLabel: `SPEAKER_0${ordinal}`,
                    audioScope: 'audible-project-mix',
                },
                retained: { trackId },
            },
        });
        after.transcriptionByTrackId = {
            captions: makeProvenance('captions', 0, 'speaker_a'),
            speaker_track_2: makeProvenance('speaker_track_2', 1, 'speaker_b'),
        };
        after.rawTranscription = after.transcriptionByTrackId.captions.raw;
        after.transcriptionGroups = after.transcriptionByTrackId.captions.groups;
        after.transcriptionContainerIds = after.transcriptionByTrackId.captions.containerIds;
        const history = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            before,
            after,
            {
                metadata: { label: 'Replace subtitles with diarized transcription' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: true,
                now: 1,
            },
        );
        const currentDocument = structuredClone(baseline);
        currentDocument.revision = 5;
        currentDocument.subtitleTracks = after.tracks.map((track) => ({
            ...track,
            timingDomain: 'absolute' as const,
        }));
        currentDocument.transcriptionByTrackId = after.transcriptionByTrackId;
        const manifest = createEditorManifestV3(currentDocument);
        const index = createHistoryIndex(manifest, {
            history: history.history,
            redoStack: [],
            projection: after,
        });

        const restored = restoreEditorRuntimeState(
            currentDocument,
            manifest,
            index,
            new Map(history.history.map((entry) => [entry.id, entry])),
            null,
            new Map(),
        );

        expect(restored.durableHistory.history).toHaveLength(1);
        expect(restored.document.subtitleTracks.map((track) => track.id)).toEqual([
            'captions', 'speaker_track_2',
        ]);
        expect(restored.document.transcriptionByTrackId.speaker_track_2.extensions).toMatchObject({
            'waptions.transcription.diarization': {
                setId: 'persisted_set', targetTrackId: 'captions', speakerOrdinal: 1,
            },
            retained: { trackId: 'speaker_track_2' },
        });
    });

    it('discards history when an intermediate Undo state is semantically invalid', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const current = projectEditorDocumentHistory(baseline);
        const original = structuredClone(current);
        original.tracks[0].subtitles[0].endTime = 0.5;
        const recorded = recordTimelineHistory(
            { history: [], redoStack: [], historySequence: 0, historyBytes: 0 },
            original,
            current,
            {
                metadata: { label: 'Resize subtitle' },
                impact: 'preserve-transcription',
                recalculatesContentBoundary: true,
                now: 1,
            },
        );
        const corruptEntry = structuredClone(recorded.history[0]);
        const inverseEnd = corruptEntry.inversePatches.find((patch) => (
            patch.path.at(-1) === 'endTime'
        ));
        if (!inverseEnd || inverseEnd.op !== 'set') throw new Error('Expected subtitle end patch.');
        inverseEnd.value = -1;
        const index = createHistoryIndex(manifest, {
            history: [corruptEntry],
            redoStack: [],
            projection: current,
        });

        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            index,
            new Map([[corruptEntry.id, corruptEntry]]),
            null,
            new Map(),
        );

        expect(restored.durableHistory.history).toEqual([]);
        expect(restored.history.history).toEqual([]);
    });

    it('rejects a serializable WAL whose completed document is semantically invalid', () => {
        const baseline = document();
        const manifest = createEditorManifestV3(baseline);
        const before = projectEditorDocumentHistory(baseline);
        const invalid = structuredClone(before);
        invalid.tracks[0].subtitles[0].endTime = -1;
        const key = recoveryEntryStorageKey(5);
        const restored = restoreEditorRuntimeState(
            baseline,
            manifest,
            null,
            new Map(),
            {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [key],
            },
            new Map([[key, {
                version: EDITOR_HISTORY_STORAGE_VERSION,
                fromRevision: 4,
                toRevision: 5,
                fromAudioGraphRevision: 0,
                toAudioGraphRevision: 0,
                patches: createSerializablePatches(
                    before,
                    invalid,
                    TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
                ).patches,
                historyIndex: createHistoryIndex({ ...manifest, revision: 5 }, {
                    history: [],
                    redoStack: [],
                    projection: invalid,
                }),
                historyEntries: [],
            }]]),
        );

        expect(restored).toMatchObject({
            document: baseline,
            recovered: false,
            history: { history: [], redoStack: [] },
        });
    });
});
