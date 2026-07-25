import { describe, expect, it } from 'vitest';
import {
    EDITORIAL_TEST_RECORD_ID,
    createEditorManifestV4Fixture,
    createEditorialTranscriptBodyFixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import type { ResolvedEditorialTranscriptMapV1 } from '@/types/editorial';
import type {
    AudioClip,
    AudioSourceDescriptor,
    AudioTrack,
    EditorManifestV4,
} from '@/types/video';
import { createDescriptorAssetHydration } from './editor-command-planner';
import {
    createEditorEngine,
    DeterministicEditorIdGenerator,
    EditorCommandError,
    FixedEditorClock,
    parseEditorCommandBatchRequest,
    type EditorCommandBatchRequest,
    type EditorEnginePorts,
    type EditorEngineSnapshot,
    type EditorPersistenceCommit,
    type EditorPersistencePort,
    type EditorSemanticOperation,
} from '.';

const NOW = {
    iso: '2026-07-25T15:00:00.000Z',
    epochMs: Date.parse('2026-07-25T15:00:00.000Z'),
};
const SESSION_EPOCH = 'epoch-command-units';

class MemoryPersistence implements EditorPersistencePort {
    readonly commits: EditorPersistenceCommit[] = [];

    async getReceipt(): Promise<null> {
        return null;
    }

    async commit(input: EditorPersistenceCommit): Promise<void> {
        this.commits.push(structuredClone(input));
    }
}

function createHarness(input: {
    manifest?: EditorManifestV4;
    projectName?: string;
    transcriptBodies?: ResolvedEditorialTranscriptMapV1;
} = {}) {
    const manifest = input.manifest ?? ordinaryManifest();
    const persistence = new MemoryPersistence();
    const assetCalls: Array<{ videoSourceIds: string[]; audioSourceIds: string[] }> = [];
    const transcriptCalls: string[][] = [];
    const ports: EditorEnginePorts = {
        persistence,
        assets: {
            hydrate: async ({ manifest: requestedManifest, videoSourceIds, audioSourceIds }) => {
                assetCalls.push({
                    videoSourceIds: [...videoSourceIds],
                    audioSourceIds: [...audioSourceIds],
                });
                const hydration = createDescriptorAssetHydration(requestedManifest);
                return {
                    videoSources: hydration.videoSources.filter(
                        (source) => videoSourceIds.includes(source.id),
                    ),
                    audioSources: hydration.audioSources.filter(
                        (source) => audioSourceIds.includes(source.id),
                    ),
                };
            },
        },
        transcripts: {
            hydrate: async ({ references }) => {
                const recordIds = references.map((reference) => reference.recordId);
                transcriptCalls.push(recordIds);
                const bodies = input.transcriptBodies ?? {};
                return Object.fromEntries(recordIds.map((recordId) => [
                    recordId,
                    bodies[recordId as keyof typeof bodies],
                ])) as ResolvedEditorialTranscriptMapV1;
            },
        },
        clock: new FixedEditorClock(NOW),
        ids: new DeterministicEditorIdGenerator('command-units'),
        events: { emit: () => undefined },
    };
    const engine = createEditorEngine({
        projectId: 'project-command-units',
        sessionEpoch: SESSION_EPOCH,
        initialManifest: manifest,
        initialProjectMetadata: { name: input.projectName ?? 'Original project' },
        ports,
        closePorts: false,
    });
    return { engine, persistence, assetCalls, transcriptCalls };
}

function ordinaryManifest(overrides: Partial<EditorManifestV4> = {}): EditorManifestV4 {
    return createEditorManifestV4Fixture({
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
        ...overrides,
    });
}

function request(
    snapshot: EditorEngineSnapshot,
    operation: EditorSemanticOperation,
    overrides: Partial<EditorCommandBatchRequest> = {},
): EditorCommandBatchRequest {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_edit_apply',
        sessionEpoch: SESSION_EPOCH,
        expected: expectedRevisions(snapshot),
        idempotencyKey: `key-${operation.operationId}`,
        operations: [operation],
        ...overrides,
    };
}

function expectedRevisions(
    snapshot: EditorEngineSnapshot,
): EditorCommandBatchRequest['expected'] {
    return {
        sessionRevision: snapshot.revisions.sessionRevision,
        documentRevision: snapshot.revisions.documentRevision,
        audioGraphRevision: snapshot.revisions.audioGraphRevision,
        ...(snapshot.revisions.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.revisions.narrativeRevision }),
    };
}

function rawRequest(operation: unknown): unknown {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_edit_apply',
        sessionEpoch: SESSION_EPOCH,
        expected: {
            sessionRevision: 0,
            documentRevision: 1,
            audioGraphRevision: 0,
            narrativeRevision: 1,
        },
        idempotencyKey: 'raw-time-domain-request',
        operations: [operation],
    };
}

function expectInvalidRequest(operation: unknown): void {
    let captured: unknown;
    try {
        parseEditorCommandBatchRequest(rawRequest(operation));
    } catch (error) {
        captured = error;
    }
    expect(captured).toBeInstanceOf(EditorCommandError);
    expect(captured).toMatchObject({ code: 'INVALID_REQUEST' });
}

function canonicalNarrativeFixture(): {
    manifest: EditorManifestV4;
    bodies: ResolvedEditorialTranscriptMapV1;
} {
    const wordId = `sha256:${'1'.repeat(64)}`;
    const regionId = `sha256:${'2'.repeat(64)}`;
    const startBoundaryId = `sha256:${'3'.repeat(64)}`;
    const endBoundaryId = `sha256:${'4'.repeat(64)}`;
    const manifest = createEditorManifestV4Fixture();
    Object.values(manifest.narrative?.blocks ?? {}).forEach((block) => {
        if (block.kind === 'speech') block.sourceWordIds = [wordId];
    });
    const body = structuredClone(createEditorialTranscriptBodyFixture());
    body.words[0].id = wordId;
    body.speechRegions[0].id = regionId;
    body.editBoundaries[0].id = startBoundaryId;
    body.editBoundaries[0].regionId = regionId;
    body.editBoundaries[1].id = endBoundaryId;
    body.editBoundaries[1].regionId = regionId;
    return {
        manifest,
        bodies: {
            [EDITORIAL_TEST_RECORD_ID]: body,
        } as unknown as ResolvedEditorialTranscriptMapV1,
    };
}

function audioManifest(): EditorManifestV4 {
    const source: AudioSourceDescriptor = {
        id: 'audio_source_native',
        originalName: 'native.wav',
        mimeType: 'audio/wav',
        size: 88_200,
        lastModified: 1_700_000_000_000,
        fingerprint: 'native-audio-fingerprint',
        duration: 2,
        nativeSampleRate: 44_100,
        nativeSampleCount: 88_200,
        nativeChannelCount: 1,
        bitrate: 705_600,
        codec: 'pcm_s16le',
    };
    const imported: AudioClip = {
        id: 'audio_clip_imported',
        source: { kind: 'audio-source', audioSourceId: source.id },
        timelineStartFrame: 0,
        sourceStartSample: 0,
        sourceEndSample: 44_100,
        timelineDurationSamples: 48_000,
        muted: false,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
    };
    const detached: AudioClip = {
        id: 'audio_clip_detached',
        source: { kind: 'video-source-audio', videoSourceId: 'video_source_editorial' },
        timelineStartFrame: 60,
        sourceStart: 0,
        sourceEnd: 1,
        muted: false,
        gainDb: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
    };
    const track: AudioTrack = {
        id: 'audio_track_semantic',
        name: 'Semantic audio',
        muted: false,
        solo: false,
        locked: false,
        gainDb: 0,
        clips: [imported, detached],
    };
    return ordinaryManifest({
        audioSourceDescriptors: [source],
        audioTracks: [track],
    });
}

function audioClip(snapshot: EditorEngineSnapshot, clipId: string): AudioClip {
    const clip = snapshot.manifest.audioTracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === clipId);
    if (!clip) throw new Error(`Missing audio clip ${clipId}.`);
    return clip;
}

describe('Editor command public semantic time domains', () => {
    it('rejects 48 kHz output fields for transcript-fragment binding', () => {
        expectInvalidRequest({
            operationId: 'link-wrong-domain',
            type: 'link.bind-target',
            payload: {
                target: {
                    kind: 'subtitle',
                    trackId: 'captions',
                    subtitleId: 'subtitle_1',
                },
                anchorBlockId: 'narrative_block_1',
                activeStartOutputSample: 48_000,
                activeEndOutputSample: 96_000,
            },
        });
    });

    it.each([
        {
            label: 'subtitle insert',
            operation: {
                operationId: 'raw-subtitle-insert',
                type: 'subtitle.insert',
                payload: {
                    trackId: 'captions',
                    subtitle: {
                        id: 'subtitle_raw',
                        startTime: 0,
                        endTime: 1,
                        text: 'Raw seconds',
                    },
                },
            },
        },
        {
            label: 'subtitle bulk replace',
            operation: {
                operationId: 'raw-subtitle-bulk',
                type: 'subtitle.bulk-replace',
                payload: {
                    trackId: 'captions',
                    subtitles: [{
                        id: 'subtitle_raw',
                        startTime: 0,
                        endTime: 1,
                        text: 'Raw seconds',
                    }],
                },
            },
        },
    ])('rejects raw V4 startTime/endTime in $label', ({ operation }) => {
        expectInvalidRequest(operation);
    });

    it('converts semantic subtitle insert and bulk output samples to V4 seconds', async () => {
        const track = createSubtitleTrackV4Fixture({
            id: 'captions',
            subtitles: [],
        });
        const harness = createHarness({
            manifest: ordinaryManifest({
                subtitleTracks: [track],
                activeSubtitleTrackId: track.id,
            }),
        });
        let snapshot = harness.engine.getSnapshot();

        const inserted = await harness.engine.dispatch(request(snapshot, {
            operationId: 'insert-subtitle',
            type: 'subtitle.insert',
            payload: {
                trackId: track.id,
                subtitle: {
                    id: 'subtitle_inserted',
                    startOutputSample: 24_000,
                    endOutputSample: 72_000,
                    text: 'Inserted',
                },
            },
        }));
        expect(inserted.ok, JSON.stringify(inserted)).toBe(true);
        snapshot = harness.engine.getSnapshot();
        expect(snapshot.manifest.subtitleTracks[0].subtitles).toEqual([{
            id: 'subtitle_inserted',
            startTime: 0.5,
            endTime: 1.5,
            text: 'Inserted',
        }]);

        const replaced = await harness.engine.dispatch(request(snapshot, {
            operationId: 'replace-subtitles',
            type: 'subtitle.bulk-replace',
            payload: {
                trackId: track.id,
                subtitles: [{
                    id: 'subtitle_a',
                    startOutputSample: 0,
                    endOutputSample: 48_000,
                    text: 'A',
                }, {
                    id: 'subtitle_b',
                    startOutputSample: 96_000,
                    endOutputSample: 144_000,
                    text: 'B',
                }],
            },
        }));
        expect(replaced.ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.subtitleTracks[0].subtitles).toEqual([{
            id: 'subtitle_a',
            startTime: 0,
            endTime: 1,
            text: 'A',
        }, {
            id: 'subtitle_b',
            startTime: 2,
            endTime: 3,
            text: 'B',
        }]);
    });

    it.each([
        {
            label: 'trim sample',
            operation: {
                operationId: 'old-trim',
                type: 'narrative.trim-block',
                payload: { blockId: 'narrative_block_1', side: 'end', sample: 8_000 },
            },
        },
        {
            label: 'split sample',
            operation: {
                operationId: 'old-split',
                type: 'narrative.split-block',
                payload: { blockId: 'narrative_block_1', splitSample: 8_000 },
            },
        },
        {
            label: 'range point sample',
            operation: {
                operationId: 'old-range',
                type: 'narrative.delete-range',
                payload: {
                    start: { blockId: 'narrative_block_1', sample: 0 },
                    end: { blockId: 'narrative_block_1', sample: 8_000 },
                },
            },
        },
        {
            label: 'global margin samples',
            operation: {
                operationId: 'old-global-margins',
                type: 'narrative.change-global-margins',
                payload: { preSamples: 0, postSamples: 0 },
            },
        },
        {
            label: 'block requested samples',
            operation: {
                operationId: 'old-block-margin',
                type: 'narrative.change-block-margin',
                payload: {
                    blockId: 'narrative_block_1',
                    side: 'post',
                    policy: { kind: 'margin', mode: 'explicit', requestedSamples: 1_600 },
                },
            },
        },
        {
            label: 'source range samples',
            operation: {
                operationId: 'old-source-range',
                type: 'narrative.insert-source-range',
                payload: {
                    recordId: EDITORIAL_TEST_RECORD_ID,
                    sourceId: 'video_source_editorial',
                    sourceRange: { start: 0, end: 16_000 },
                    destinationTrackId: 'video_track_editorial',
                    clipAudio: null,
                },
            },
        },
    ])('rejects old narrative $label field names', ({ operation }) => {
        expectInvalidRequest(operation);
    });

    it.each([
        {
            label: 'trim sample',
            operation: {
                operationId: 'explicit-trim',
                type: 'narrative.trim-block',
                payload: { blockId: 'narrative_block_1', side: 'end', sample16k: 8_000 },
            },
        },
        {
            label: 'split sample',
            operation: {
                operationId: 'explicit-split',
                type: 'narrative.split-block',
                payload: { blockId: 'narrative_block_1', splitSample16k: 8_000 },
            },
        },
        {
            label: 'range point sample',
            operation: {
                operationId: 'explicit-range',
                type: 'narrative.delete-range',
                payload: {
                    start: { blockId: 'narrative_block_1', sample16k: 0 },
                    end: { blockId: 'narrative_block_1', sample16k: 8_000 },
                },
            },
        },
        {
            label: 'global margin samples',
            operation: {
                operationId: 'explicit-global-margins',
                type: 'narrative.change-global-margins',
                payload: { preSamples16k: 0, postSamples16k: 0 },
            },
        },
        {
            label: 'block requested samples',
            operation: {
                operationId: 'explicit-block-margin',
                type: 'narrative.change-block-margin',
                payload: {
                    blockId: 'narrative_block_1',
                    side: 'post',
                    policy: {
                        kind: 'margin',
                        mode: 'explicit',
                        requestedSamples16k: 1_600,
                    },
                },
            },
        },
        {
            label: 'source range samples',
            operation: {
                operationId: 'explicit-source-range',
                type: 'narrative.insert-source-range',
                payload: {
                    recordId: EDITORIAL_TEST_RECORD_ID,
                    sourceId: 'video_source_editorial',
                    sourceRange: { startSample16k: 0, endSample16k: 16_000 },
                    destinationTrackId: 'video_track_editorial',
                    clipAudio: null,
                },
            },
        },
    ])('accepts explicit narrative $label 16 kHz fields', ({ operation }) => {
        expect(() => parseEditorCommandBatchRequest(rawRequest(operation))).not.toThrow();
    });

    it('executes an explicit 16 kHz narrative margin command through the engine', async () => {
        const fixture = canonicalNarrativeFixture();
        const harness = createHarness({
            manifest: fixture.manifest,
            transcriptBodies: fixture.bodies,
        });
        const before = harness.engine.getSnapshot();
        const result = await harness.engine.dispatch(request(before, {
            operationId: 'narrative-margin-16k',
            type: 'narrative.change-global-margins',
            payload: {
                preSamples16k: 0,
                postSamples16k: 1_600,
            },
        }));

        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(harness.engine.getSnapshot().manifest.narrative?.settings).toMatchObject({
            globalPreMarginSamples: 0,
            globalPostMarginSamples: 1_600,
        });
    });

    it.each([
        {
            label: 'missing source range',
            sourceRange: undefined,
        },
        {
            label: 'implicit output-sample domain',
            sourceRange: {
                domain: 'output-samples',
                startOutputSample: 0,
                endOutputSample: 48_000,
            },
        },
    ])('rejects audio trim with $label', ({ sourceRange }) => {
        expectInvalidRequest({
            operationId: 'invalid-audio-trim',
            type: 'audio-clip.trim',
            payload: {
                clipId: 'audio_clip_imported',
                ...(sourceRange === undefined ? {} : { sourceRange }),
            },
        });
    });

    it.each([
        {
            label: 'seconds for imported audio',
            clipId: 'audio_clip_imported',
            sourceRange: {
                domain: 'seconds',
                videoSourceId: 'video_source_editorial',
                startSeconds: 0.1,
                endSeconds: 0.9,
            },
        },
        {
            label: 'wrong imported source identity',
            clipId: 'audio_clip_imported',
            sourceRange: {
                domain: 'native-samples',
                audioSourceId: 'audio_source_other',
                nativeSampleRateHz: 44_100,
                startNativeSample: 1_000,
                endNativeSample: 40_000,
            },
        },
        {
            label: 'wrong imported native rate',
            clipId: 'audio_clip_imported',
            sourceRange: {
                domain: 'native-samples',
                audioSourceId: 'audio_source_native',
                nativeSampleRateHz: 48_000,
                startNativeSample: 1_000,
                endNativeSample: 40_000,
            },
        },
        {
            label: 'native samples for detached video audio',
            clipId: 'audio_clip_detached',
            sourceRange: {
                domain: 'native-samples',
                audioSourceId: 'audio_source_native',
                nativeSampleRateHz: 44_100,
                startNativeSample: 1_000,
                endNativeSample: 40_000,
            },
        },
        {
            label: 'wrong detached video source identity',
            clipId: 'audio_clip_detached',
            sourceRange: {
                domain: 'seconds',
                videoSourceId: 'video_source_other',
                startSeconds: 0.1,
                endSeconds: 0.9,
            },
        },
    ])('rejects audio trim with $label', async ({ clipId, sourceRange }, caseIndex) => {
        const harness = createHarness({ manifest: audioManifest() });
        const before = harness.engine.getSnapshot();
        const result = await harness.engine.dispatch(request(before, {
            operationId: `mismatched-audio-trim-${caseIndex}`,
            type: 'audio-clip.trim',
            payload: {
                clipId,
                sourceRange,
            } as Extract<
                EditorSemanticOperation,
                { type: 'audio-clip.trim' }
            >['payload'],
        }));

        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_OPERATION' } });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(harness.persistence.commits).toHaveLength(0);
    });

    it('accepts matching native-sample and detached-video seconds trims', async () => {
        const harness = createHarness({ manifest: audioManifest() });
        let snapshot = harness.engine.getSnapshot();
        const imported = await harness.engine.dispatch(request(snapshot, {
            operationId: 'trim-imported-native',
            type: 'audio-clip.trim',
            payload: {
                clipId: 'audio_clip_imported',
                sourceRange: {
                    domain: 'native-samples',
                    audioSourceId: 'audio_source_native',
                    nativeSampleRateHz: 44_100,
                    startNativeSample: 2_205,
                    endNativeSample: 41_895,
                },
            },
        }));
        expect(imported.ok, JSON.stringify(imported)).toBe(true);
        snapshot = harness.engine.getSnapshot();
        expect(audioClip(snapshot, 'audio_clip_imported')).toMatchObject({
            sourceStartSample: 2_205,
            sourceEndSample: 41_895,
        });

        const detached = await harness.engine.dispatch(request(snapshot, {
            operationId: 'trim-detached-seconds',
            type: 'audio-clip.trim',
            payload: {
                clipId: 'audio_clip_detached',
                sourceRange: {
                    domain: 'seconds',
                    videoSourceId: 'video_source_editorial',
                    startSeconds: 0.25,
                    endSeconds: 0.75,
                },
            },
        }));
        expect(detached.ok).toBe(true);
        expect(audioClip(harness.engine.getSnapshot(), 'audio_clip_detached')).toMatchObject({
            sourceStart: 0.25,
            sourceEnd: 0.75,
        });
    });

    it('converts, clamps, and no-ops semantic 48 kHz fades in each canonical domain', async () => {
        expectInvalidRequest({
            operationId: 'old-fade-fields',
            type: 'audio-clip.set-fades',
            payload: {
                clipId: 'audio_clip_imported',
                fadeInSamples: 48_000,
                fadeOutSamples: 48_000,
            },
        });

        const harness = createHarness({ manifest: audioManifest() });
        let snapshot = harness.engine.getSnapshot();
        const importedOperation: EditorSemanticOperation = {
            operationId: 'fade-imported',
            type: 'audio-clip.set-fades',
            payload: {
                clipId: 'audio_clip_imported',
                fadeInOutputSamples48k: 48_000,
                fadeOutOutputSamples48k: 48_000,
            },
        };
        const imported = await harness.engine.dispatch(request(snapshot, importedOperation));
        expect(imported.ok, JSON.stringify(imported)).toBe(true);
        snapshot = harness.engine.getSnapshot();
        expect(audioClip(snapshot, 'audio_clip_imported')).toMatchObject({
            fadeInSamples: 22_050,
            fadeOutSamples: 22_050,
        });
        const afterImported = snapshot;

        const importedNoop = await harness.engine.dispatch(request(snapshot, {
            ...importedOperation,
            operationId: 'fade-imported-noop',
        }));
        expect(importedNoop).toMatchObject({ ok: true, noOp: true, noOpReason: 'unchanged' });
        expect(harness.engine.getSnapshot()).toEqual(afterImported);

        snapshot = harness.engine.getSnapshot();
        const detachedOperation: EditorSemanticOperation = {
            operationId: 'fade-detached',
            type: 'audio-clip.set-fades',
            payload: {
                clipId: 'audio_clip_detached',
                fadeInOutputSamples48k: 48_000,
                fadeOutOutputSamples48k: 48_000,
            },
        };
        const detached = await harness.engine.dispatch(request(snapshot, detachedOperation));
        expect(detached.ok).toBe(true);
        snapshot = harness.engine.getSnapshot();
        expect(audioClip(snapshot, 'audio_clip_detached')).toMatchObject({
            fadeInFrames: 15,
            fadeOutFrames: 15,
        });
        const afterDetached = snapshot;

        const detachedNoop = await harness.engine.dispatch(request(snapshot, {
            ...detachedOperation,
            operationId: 'fade-detached-noop',
        }));
        expect(detachedNoop).toMatchObject({ ok: true, noOp: true, noOpReason: 'unchanged' });
        expect(harness.engine.getSnapshot()).toEqual(afterDetached);
    });
});

describe('EditorEngine project metadata history', () => {
    it('keeps project.set-name outside document hydration and revision history', async () => {
        const harness = createHarness({ projectName: 'Original project' });
        const before = harness.engine.getSnapshot();
        const renamed = await harness.engine.dispatch(request(before, {
            operationId: 'rename-project',
            type: 'project.set-name',
            payload: { name: 'Renamed project' },
        }));

        expect(renamed.ok).toBe(true);
        const afterRename = harness.engine.getSnapshot();
        expect(afterRename.project.name).toBe('Renamed project');
        expect(afterRename.revisions).toMatchObject({
            sessionRevision: before.revisions.sessionRevision + 1,
            documentRevision: before.revisions.documentRevision,
            audioGraphRevision: before.revisions.audioGraphRevision,
        });
        expect(afterRename.manifest).toEqual(before.manifest);
        expect(afterRename.history.past).toHaveLength(1);
        expect(harness.assetCalls).toEqual([]);
        expect(harness.transcriptCalls).toEqual([]);
        expect(harness.persistence.commits).toHaveLength(1);

        const repeated = await harness.engine.dispatch(request(afterRename, {
            operationId: 'rename-project-noop',
            type: 'project.set-name',
            payload: { name: 'Renamed project' },
        }));
        expect(repeated).toMatchObject({ ok: true, noOp: true, noOpReason: 'unchanged' });
        expect(harness.engine.getSnapshot()).toEqual(afterRename);
        expect(harness.assetCalls).toEqual([]);
        expect(harness.transcriptCalls).toEqual([]);

        const undone = await harness.engine.undo({
            apiVersion: '2026-07-25',
            toolName: 'waptions_history_apply',
            sessionEpoch: SESSION_EPOCH,
            expected: expectedRevisions(afterRename),
            idempotencyKey: 'undo-project-name',
        });
        expect(undone.ok).toBe(true);
        const afterUndo = harness.engine.getSnapshot();
        expect(afterUndo.project.name).toBe('Original project');
        expect(afterUndo.revisions).toMatchObject({
            sessionRevision: afterRename.revisions.sessionRevision + 1,
            documentRevision: before.revisions.documentRevision,
            audioGraphRevision: before.revisions.audioGraphRevision,
        });
        expect(afterUndo.manifest).toEqual(before.manifest);
        expect(afterUndo.history.past).toEqual([]);
        expect(afterUndo.history.future).toHaveLength(1);
        expect(Object.keys(afterUndo.manifest).some(
            (key) => key.toLowerCase().includes('selection'),
        )).toBe(false);
        expect(JSON.stringify(afterUndo.manifest)).not.toContain('transientSelection');
        expect(harness.assetCalls).toEqual([]);
        expect(harness.transcriptCalls).toEqual([]);
    });
});
