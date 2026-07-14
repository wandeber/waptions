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
});

describe('editor history and recovery storage', () => {
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
                version: 1,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [key],
            },
            new Map([[key, {
                version: 1,
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
                version: 1,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [key],
            },
            new Map([[key, {
                version: 1,
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
                version: 1,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [firstKey, secondKey],
            },
            new Map([[firstKey, {
                version: 1,
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
                version: 1,
                documentRevision: 4,
                sourceSignature: getManifestSourceSignature(manifest),
                entryKeys: [key],
            },
            new Map([[key, {
                version: 1,
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
