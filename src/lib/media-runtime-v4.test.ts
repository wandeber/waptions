import { describe, expect, it } from 'vitest';
import type { SubtitleTrack } from '@/types/timeline';
import type { EditorDocumentV3, VideoSourceAssetV3 } from '@/types/video';
import { buildAudioMixPlan } from './audio-mix-plan';
import {
    getCanonicalEditorAudioGraphSignature,
} from './audio-graph-signature';
import { migrateEditorDocumentV3ToV4 } from './editor-document-v4-migration';
import { createDefaultRenderProfile } from './render-profile';
import {
    buildVideoFrameRuntimePlan,
    resolveVideoFrameRuntimePlacementAtFrame,
} from './video-frame-plan';
import {
    getTimelineContentEndFrame,
    getTimelineContentEndFrameV4,
} from './video-timeline';

function source(id: string): VideoSourceAssetV3 {
    const file = {
        name: `${id}.webm`,
        type: 'video/webm',
        size: 100,
        lastModified: 1,
    } as File;
    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: `fingerprint_${id}`,
        duration: 5,
        fps: 30,
        width: 320,
        height: 180,
        bitrate: 1_000_000,
        hasAudio: true,
        file,
    };
}

function makeV3Document(): EditorDocumentV3 {
    const first = source('first_source');
    const second = source('second_source');
    return {
        version: 3,
        revision: 2,
        audioGraphRevision: 1,
        renderProfile: createDefaultRenderProfile(),
        subtitleTracks: [{
            id: 'subtitles',
            name: 'Subtitles',
            style: {} as SubtitleTrack['style'],
            subtitles: [{ id: 'tail', startTime: 3, endTime: 4, text: 'Tail' }],
            isVisible: true,
            isLocked: false,
            timingDomain: 'absolute',
        }],
        videoSources: [first, second],
        videoClips: [{
            id: 'first_clip',
            sourceId: first.id,
            sourceStart: 0,
            sourceEnd: 1,
            audio: { linkState: 'linked', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 },
        }, {
            id: 'second_clip',
            sourceId: second.id,
            sourceStart: 2,
            sourceEnd: 3,
            audio: { linkState: 'linked', muted: false, gainDb: -3, fadeInFrames: 0, fadeOutFrames: 0 },
        }],
        videoTracks: [{ id: 'top', name: 'Top', clipIds: ['second_clip'] }, {
            id: 'lower', name: 'Lower', clipIds: ['first_clip'],
        }],
        audioSources: [],
        audioTracks: [{
            id: 'detached',
            name: 'Detached',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                id: 'detached_clip',
                source: { kind: 'video-source-audio', videoSourceId: first.id },
                timelineStartFrame: 90,
                sourceStart: 1,
                sourceEnd: 2,
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            }],
        }],
        activeSubtitleTrackId: 'subtitles',
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

describe('migrated V3 explicit-media runtime parity', () => {
    it('preserves frame/source mapping, audio geometry, content end, and graph signature', () => {
        const legacy = makeV3Document();
        const migrated = migrateEditorDocumentV3ToV4(legacy);
        const legacyPlan = buildVideoFrameRuntimePlan(legacy);
        const migratedPlan = buildVideoFrameRuntimePlan(migrated);

        for (let frame = 0; frame < 65; frame += 1) {
            const before = resolveVideoFrameRuntimePlacementAtFrame(legacyPlan, frame);
            const after = resolveVideoFrameRuntimePlacementAtFrame(migratedPlan, frame);
            expect(after?.placement.clip.id ?? null).toBe(before?.placement.clip.id ?? null);
            if (before && after) expect(after.sourceTime).toBeCloseTo(before.sourceTime, 12);
            else expect(after?.sourceTime ?? null).toBe(before?.sourceTime ?? null);
        }

        expect(buildAudioMixPlan(migrated)).toEqual(buildAudioMixPlan(legacy));
        expect(getTimelineContentEndFrameV4(migrated)).toBe(getTimelineContentEndFrame(
            legacy.videoClips,
            legacy.subtitleTracks,
            {
                renderProfile: legacy.renderProfile,
                videoSources: legacy.videoSources,
                audioSources: legacy.audioSources,
                audioTracks: legacy.audioTracks,
            },
        ));
        expect(getCanonicalEditorAudioGraphSignature(migrated))
            .toBe(getCanonicalEditorAudioGraphSignature(legacy));
    });
});
