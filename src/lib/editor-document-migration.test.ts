import { describe, expect, it } from 'vitest';
import type { EditorManifestV2, VideoSourceAssetV3 } from '@/types/video';
import type { SubtitleTrack } from '@/types/timeline';
import { createVideoSourceFingerprint } from './video-timeline';
import { createDefaultRenderProfile } from './render-profile';
import {
    createEditorManifestV3,
    migrateEditorDocumentV2ToV3,
    migrateLegacyEditorDocumentToV3,
    hydrateEditorDocumentV3,
} from './editor-document-migration';

const source = (hasAudio = true): VideoSourceAssetV3 => {
    const file = { name: 'video.mp4', type: 'video/mp4', size: 12, lastModified: 3 } as File;
    return {
        id: 'video_a',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createVideoSourceFingerprint(file),
        duration: 3,
        fps: 29.97,
        width: 1280,
        height: 720,
        bitrate: null,
        hasAudio,
        file,
    };
};

const manifest = (asset: VideoSourceAssetV3): EditorManifestV2 => {
    const { file, ...descriptor } = asset;
    void file;
    return {
        version: 2,
        revision: 4,
        projectFps: 29.97,
        tracks: [{
            id: 'track_a',
            name: 'Subtitles',
            subtitles: [{ id: 'subtitle_a', startTime: 0, endTime: 1, text: 'Hello' }],
            style: {} as SubtitleTrack['style'],
            isVisible: true,
            isLocked: false,
        }],
        sourceDescriptors: [descriptor],
        videoClips: [{ id: 'clip_a', sourceId: asset.id, sourceStart: 0, sourceEnd: 2 }],
        activeTrackId: 'track_a',
        transcriptionByTrackId: {
            track_a: { raw: [], groups: {}, containerIds: [] },
        },
    };
};

describe('editor document v3 migration', () => {
    it('creates linked audio, rational render state, ripple subtitles, and fresh provenance', () => {
        const asset = source();
        const document = migrateEditorDocumentV2ToV3({ manifest: manifest(asset), loadedVideoSources: [asset] });
        expect(document).toMatchObject({
            version: 3,
            revision: 4,
            audioGraphRevision: 0,
            renderProfile: {
                fps: { numerator: 30_000, denominator: 1_001 },
                width: 1280,
                height: 720,
                isFrameRateLocked: true,
                isCanvasSizeLocked: true,
            },
            videoClips: [{ audio: { linkState: 'linked', muted: false, gainDb: 0 } }],
            videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['clip_a'] }],
            subtitleTracks: [{ timingDomain: 'video-ripple' }],
            audioSources: [],
            audioTracks: [],
            transientSelection: { kind: 'none' },
        });
        expect(document.transcriptionByTrackId.track_a).toMatchObject({
            sourceDocumentRevision: 4,
            sourceAudioGraphRevision: 0,
            stale: false,
        });
        expect(document.transcriptionByTrackId.track_a.sourceAudioGraphSignature).toMatch(/^fnv1a64:/);
        expect(createEditorManifestV3(document)).not.toHaveProperty('transientSelection');
    });

    it('normalizes only legacy V3 manifests that omit video tracks', () => {
        const asset = source();
        const migrated = migrateEditorDocumentV2ToV3({ manifest: manifest(asset), loadedVideoSources: [asset] });
        const legacyManifest = createEditorManifestV3(migrated) as unknown as Record<string, unknown>;
        delete legacyManifest.videoTracks;
        const hydrated = hydrateEditorDocumentV3(
            legacyManifest as unknown as ReturnType<typeof createEditorManifestV3>,
            [asset],
            [],
        );
        expect(hydrated.videoTracks).toEqual([{
            id: 'video_track_1', name: 'Video 1', clipIds: ['clip_a'],
        }]);

        const malformed = createEditorManifestV3(migrated);
        malformed.videoTracks = [{ id: 'bad track', name: '', clipIds: [] }];
        expect(() => hydrateEditorDocumentV3(malformed, [asset], [])).toThrow(/videoTracks/);
    });

    it('uses null audio for silent sources and preserves safely shaped runtime mix settings', () => {
        const silent = source(false);
        expect(migrateEditorDocumentV2ToV3({
            manifest: manifest(silent),
            loadedVideoSources: [silent],
        }).videoClips[0].audio).toBeNull();

        const audible = source(true);
        const v2 = manifest(audible);
        Object.assign(v2.videoClips[0], {
            audio: { linkState: 'detached', muted: true, gainDb: -3, fadeInFrames: 1, fadeOutFrames: 2 },
        });
        expect(migrateEditorDocumentV2ToV3({ manifest: v2, loadedVideoSources: [audible] }).videoClips[0].audio)
            .toEqual({ linkState: 'detached', muted: true, gainDb: -3, fadeInFrames: 1, fadeOutFrames: 2 });

        const partialV2 = manifest(audible);
        Object.assign(partialV2.videoClips[0], {
            audio: { muted: true, gainDb: -6, fadeInFrames: 2, fadeOutFrames: 3 },
        });
        expect(migrateEditorDocumentV2ToV3({ manifest: partialV2, loadedVideoSources: [audible] }).videoClips[0].audio)
            .toEqual({ linkState: 'linked', muted: true, gainDb: -6, fadeInFrames: 2, fadeOutFrames: 3 });
    });

    it('migrates already-inspected scalar v1 media without importing inspection modules', () => {
        const asset = source();
        const document = migrateLegacyEditorDocumentToV3({
            tracks: [],
            rawTranscription: null,
            transcriptionGroups: null,
            transcriptionContainerIds: null,
            loadedVideoSource: asset,
        });
        expect(document.videoSources).toEqual([asset]);
        expect(document.videoClips).toHaveLength(1);
        expect(document.videoClips[0]).toMatchObject({ sourceId: asset.id, audio: { linkState: 'linked' } });
    });

    it('keeps source-less migration defaults unlocked and honors an explicit profile', () => {
        const sourceLess = migrateLegacyEditorDocumentToV3({
            tracks: [],
            rawTranscription: null,
            transcriptionGroups: null,
            transcriptionContainerIds: null,
            loadedVideoSource: null,
        });
        expect(sourceLess.renderProfile).toMatchObject({
            isFrameRateLocked: false,
            isCanvasSizeLocked: false,
        });

        const explicit = createDefaultRenderProfile({
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        });
        expect(migrateLegacyEditorDocumentToV3({
            tracks: [],
            rawTranscription: null,
            transcriptionGroups: null,
            transcriptionContainerIds: null,
            loadedVideoSource: null,
            renderProfile: explicit,
        }).renderProfile).toBe(explicit);
    });
});
