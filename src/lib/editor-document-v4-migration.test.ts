import { describe, expect, it } from 'vitest';
import type { SubtitleTrack } from '@/types/timeline';
import { createEditorDocumentV4Fixture } from '@/types/editorial.test-fixtures';
import type {
    AudioSourceAsset,
    EditorDocumentV3,
    EditorManifestV2,
    VideoSourceAssetV3,
} from '@/types/video';
import { getEditorAudioGraphSignature, validateEditorDocumentV3 } from './editor-document-v3';
import { getEditorAudioGraphSignatureV4, validateEditorDocumentV4 } from './editor-document-v4';
import {
    createEditorManifestV4,
    hydrateEditorDocumentV4,
    migrateEditorDocumentToV4,
    migrateEditorDocumentV2ToV4,
    migrateEditorDocumentV3ToV4,
    migrateEditorHistoryProjectionSequenceToV4,
    migrateEditorManifestV3ToV4,
    migrateLegacyEditorDocumentToV4,
    tryMigrateOptionalEditorHistoryProjectionSequenceToV4,
} from './editor-document-v4-migration';
import { createEditorManifestV3 } from './editor-document-migration';
import { createDefaultRenderProfile } from './render-profile';
import { buildVideoTrackPlacementsV4, resolveVisibleVideoPlacementAtFrame } from './video-placement-v4';

function videoSource(
    id: string,
    overrides: Partial<VideoSourceAssetV3> = {},
): VideoSourceAssetV3 {
    const file = {
        name: `${id}.webm`,
        type: 'video/webm',
        size: 1_000,
        lastModified: 100,
    } as File;
    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: `fingerprint_${id}`,
        duration: 10,
        fps: 30,
        width: 1_920,
        height: 1_080,
        bitrate: null,
        hasAudio: true,
        file,
        ...overrides,
    };
}

function audioSource(): AudioSourceAsset {
    const file = { name: 'voice.wav', type: 'audio/wav', size: 2_000, lastModified: 200 } as File;
    return {
        id: 'audio_source_detached',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: 'fingerprint_audio_source_detached',
        duration: 10,
        nativeSampleRate: 48_000,
        nativeSampleCount: 480_000,
        nativeChannelCount: 1,
        bitrate: null,
        codec: 'pcm_s16le',
        file,
    };
}

function subtitleTrack(timingDomain: 'video-ripple' | 'absolute' = 'absolute') {
    return {
        id: 'subtitle_track',
        name: 'Subtitles',
        style: {} as SubtitleTrack['style'],
        subtitles: [{ id: 'subtitle_1', startTime: 0.25, endTime: 1.25, text: 'Subtitle' }],
        isVisible: true,
        isLocked: false,
        timingDomain,
    };
}

function emptyV3(): EditorDocumentV3 {
    return {
        version: 3,
        revision: 2,
        audioGraphRevision: 0,
        renderProfile: createDefaultRenderProfile(),
        subtitleTracks: [],
        videoSources: [],
        videoClips: [],
        videoTracks: [{ id: 'video_track_empty', name: 'Empty video', clipIds: [] }],
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

function populatedV3(): EditorDocumentV3 {
    const sourceA = videoSource('source_a');
    const sourceB = videoSource('source_b');
    const document: EditorDocumentV3 = {
        version: 3,
        revision: 7,
        audioGraphRevision: 3,
        renderProfile: createDefaultRenderProfile(),
        subtitleTracks: [subtitleTrack('absolute'), {
            ...subtitleTrack('video-ripple'),
            id: 'subtitle_track_ripple',
            subtitles: [],
        }],
        videoSources: [sourceA, sourceB],
        videoClips: [{
            id: 'clip_a_first',
            sourceId: sourceA.id,
            sourceStart: 0,
            sourceEnd: 1,
            audio: { linkState: 'linked', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 },
        }, {
            id: 'clip_b',
            sourceId: sourceB.id,
            sourceStart: 2,
            sourceEnd: 4,
            audio: { linkState: 'linked', muted: true, gainDb: -3, fadeInFrames: 0, fadeOutFrames: 0 },
        }, {
            id: 'clip_a_repeated',
            sourceId: sourceA.id,
            sourceStart: 0,
            sourceEnd: 0.5,
            audio: { linkState: 'detached', muted: false, gainDb: -6, fadeInFrames: 0, fadeOutFrames: 0 },
        }],
        videoTracks: [{
            id: 'video_track_top',
            name: 'Top video',
            clipIds: ['clip_b'],
        }, {
            id: 'video_track_lower',
            name: 'Lower video',
            clipIds: ['clip_a_first', 'clip_a_repeated'],
        }],
        audioSources: [audioSource()],
        audioTracks: [{
            id: 'audio_track_imported',
            name: 'Imported audio',
            muted: false,
            solo: false,
            locked: false,
            gainDb: -1,
            clips: [{
                id: 'audio_clip_imported',
                source: { kind: 'audio-source', audioSourceId: 'audio_source_detached' },
                timelineStartFrame: 0,
                sourceStartSample: 0,
                sourceEndSample: 48_000,
                timelineDurationSamples: 48_000,
                muted: false,
                gainDb: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
            }, {
                id: 'audio_clip_video_detached',
                source: { kind: 'video-source-audio', videoSourceId: sourceA.id },
                timelineStartFrame: 60,
                sourceStart: 1,
                sourceEnd: 2,
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            }],
        }],
        activeSubtitleTrackId: 'subtitle_track',
        transientSelection: { kind: 'subtitles', trackId: 'subtitle_track', subtitleIds: ['subtitle_1'] },
        transcriptionByTrackId: {},
    };
    document.transcriptionByTrackId.subtitle_track = {
        raw: [{ id: 'raw_1', startTime: 0, endTime: 1, text: 'Raw' }],
        groups: { group_1: [{ id: 'raw_1', startTime: 0, endTime: 1, text: 'Raw' }] },
        containerIds: ['group_1'],
        provider: 'provider',
        model: 'model',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceDocumentRevision: document.revision,
        sourceAudioGraphRevision: document.audioGraphRevision,
        sourceAudioGraphSignature: getEditorAudioGraphSignature(document),
        stale: false,
        extensions: { future: { retained: true } },
    };
    return document;
}

describe('V4 document migration', () => {
    it('migrates an empty V3 graph without synthesizing editorial state', () => {
        const migrated = migrateEditorDocumentV3ToV4(emptyV3());

        expect(migrated).toMatchObject({
            version: 4,
            globalEditingMode: 'ripple',
            videoTracks: [{ id: 'video_track_empty', visible: true, locked: false }],
            videoClips: [],
            editorialTranscriptDescriptors: [],
            narrative: null,
            dependentLinks: [],
        });
        expect(validateEditorDocumentV4(migrated)).toEqual({ valid: true, issues: [] });
    });

    it('maps exact V3 lane ownership while retaining one cumulative global placement cursor', () => {
        const source = populatedV3();
        expect(validateEditorDocumentV3(source).valid).toBe(true);
        const originalSnapshot = structuredClone({
            videoClips: source.videoClips,
            videoTracks: source.videoTracks,
            subtitleTracks: source.subtitleTracks,
            audioTracks: source.audioTracks,
        });

        const migrated = migrateEditorDocumentV3ToV4(source);

        expect(migrated.videoClips.map((item) => ({
            id: item.id,
            trackId: item.trackId,
            timelineStartFrame: item.timelineStartFrame,
        }))).toEqual([
            { id: 'clip_a_first', trackId: 'video_track_lower', timelineStartFrame: 0 },
            { id: 'clip_b', trackId: 'video_track_top', timelineStartFrame: 30 },
            { id: 'clip_a_repeated', trackId: 'video_track_lower', timelineStartFrame: 90 },
        ]);
        expect(migrated.videoTracks).toEqual([
            { id: 'video_track_top', name: 'Top video', visible: true, locked: false },
            { id: 'video_track_lower', name: 'Lower video', visible: true, locked: false },
        ]);
        expect(migrated.subtitleTracks.map((track) => track.unlinkedVideoEditResponse)).toEqual([
            'stay-absolute',
            'follow-project-ripple',
        ]);
        expect(migrated.audioSources).toEqual(source.audioSources);
        expect(migrated.audioTracks).toEqual(source.audioTracks);
        expect(migrated.transcriptionByTrackId).toEqual(source.transcriptionByTrackId);
        expect(getEditorAudioGraphSignatureV4(migrated)).toBe(getEditorAudioGraphSignature(source));
        const placements = buildVideoTrackPlacementsV4(migrated);
        expect([0, 30, 90].map((frame) => resolveVisibleVideoPlacementAtFrame(placements, frame)?.clip.id))
            .toEqual(source.videoClips.map((clip) => clip.id));
        expect(validateEditorDocumentV4(migrated)).toEqual({ valid: true, issues: [] });
        expect({
            videoClips: source.videoClips,
            videoTracks: source.videoTracks,
            subtitleTracks: source.subtitleTracks,
            audioTracks: source.audioTracks,
        }).toEqual(originalSnapshot);
    });

    it('composes scalar V1 and manifest V2 through the existing V3 authority', () => {
        const asset = videoSource('legacy_source');
        const { file, ...descriptor } = asset;
        void file;
        const v2: EditorManifestV2 = {
            version: 2,
            revision: 4,
            projectFps: 30,
            tracks: [],
            sourceDescriptors: [descriptor],
            videoClips: [{ id: 'legacy_clip', sourceId: asset.id, sourceStart: 0, sourceEnd: 1 }],
            activeTrackId: null,
            transcriptionByTrackId: {},
        };
        const fromV2 = migrateEditorDocumentV2ToV4({ manifest: v2, loadedVideoSources: [asset] });
        const fromV1 = migrateLegacyEditorDocumentToV4({
            tracks: [],
            rawTranscription: null,
            transcriptionGroups: null,
            transcriptionContainerIds: null,
            loadedVideoSource: asset,
        });

        expect(fromV2).toMatchObject({ version: 4, videoClips: [{ timelineStartFrame: 0 }] });
        expect(fromV1).toMatchObject({ version: 4, videoClips: [{ timelineStartFrame: 0 }] });
        expect(validateEditorDocumentV4(fromV2).valid).toBe(true);
        expect(validateEditorDocumentV4(fromV1).valid).toBe(true);
        expect(migrateEditorDocumentToV4({
            sourceVersion: 2,
            input: { manifest: v2, loadedVideoSources: [asset] },
        })).toEqual(fromV2);
        expect(migrateEditorDocumentToV4({ sourceVersion: 3, input: emptyV3() }))
            .toMatchObject({ version: 4, narrative: null });
        expect(migrateEditorDocumentToV4({
            sourceVersion: 1,
            input: {
                tracks: [],
                rawTranscription: null,
                transcriptionGroups: null,
                transcriptionContainerIds: null,
                loadedVideoSource: asset,
            },
        })).toEqual(fromV1);
    });

    it('returns a valid V4 dispatcher input by reference and never normalizes malformed current data', () => {
        const current = migrateEditorDocumentV3ToV4(emptyV3());
        expect(migrateEditorDocumentToV4({ sourceVersion: 4, input: current })).toBe(current);

        const malformed = { ...current, globalEditingMode: 'hidden-mode' } as unknown as typeof current;
        expect(() => migrateEditorDocumentToV4({ sourceVersion: 4, input: malformed })).toThrow(/globalEditingMode/);
    });

    it('migrates manifests and rehydrates only with exact matching source assets', () => {
        const v3 = populatedV3();
        const manifestV4 = migrateEditorManifestV3ToV4(createEditorManifestV3(v3));
        const hydrated = hydrateEditorDocumentV4(manifestV4, v3.videoSources, v3.audioSources);

        expect(manifestV4).not.toHaveProperty('transientSelection');
        expect(manifestV4.videoClips.map((clip) => clip.timelineStartFrame)).toEqual([0, 30, 90]);
        expect(hydrated.transientSelection).toEqual({ kind: 'none' });
        expect(createEditorManifestV4(hydrated)).toEqual(manifestV4);

        const mismatched = [{ ...v3.videoSources[0], originalName: 'different.webm' }, v3.videoSources[1]];
        expect(() => hydrateEditorDocumentV4(manifestV4, mismatched, v3.audioSources)).toThrow(/File metadata/i);
    });

    it('rejects invalid V3 ownership instead of inventing a clip lane', () => {
        const invalid = populatedV3();
        invalid.videoTracks[1].clipIds = ['clip_a_first'];

        expect(() => migrateEditorDocumentV3ToV4(invalid)).toThrow(/not assigned/i);
    });

    it('migrates reconstructed history projections atomically and exposes descriptor pin union', () => {
        const v3 = emptyV3();
        const v4 = createEditorDocumentV4Fixture();
        const migrated = migrateEditorHistoryProjectionSequenceToV4([v3, v4]);

        expect(migrated.projections[0].version).toBe(4);
        expect(migrated.projections[1]).toBe(v4);
        expect(migrated.requiredRecordIds).toEqual([
            v4.editorialTranscriptDescriptors[0].recordId,
        ]);

        const corruptOptional = {
            ...v4,
            videoClips: [{ ...v4.videoClips[0], trackId: 'missing_track' }],
        };
        expect(tryMigrateOptionalEditorHistoryProjectionSequenceToV4([v3, corruptOptional])).toBeNull();
        expect(validateEditorDocumentV3(v3).valid).toBe(true);
    });
});
