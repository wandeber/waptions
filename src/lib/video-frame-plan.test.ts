import { describe, expect, it } from 'vitest';
import {
    createEditorDocumentV4Fixture,
    createVideoSourceAssetV4Fixture,
} from '@/types/editorial.test-fixtures';
import type { EditorDocumentV4, VideoClipV4 } from '@/types/video';
import {
    buildPreviewWarmupFramePlanForRuntime,
    buildVideoFramePlanSignaturesV4,
    buildVideoFrameRuntimePlan,
    diffVideoFramePlanSignaturesV4,
    getDecodedVideoFrameCacheIdentityV4,
    resolveVideoFrameRuntimePlacementAtFrame,
    type VideoFrameRuntimeDocument,
} from './video-frame-plan';

function videoClip(overrides: Partial<VideoClipV4>): VideoClipV4 {
    return {
        id: 'lower_clip',
        sourceId: 'lower_source',
        trackId: 'lower_track',
        timelineStartFrame: 0,
        sourceStart: 0,
        sourceEnd: 3,
        audio: {
            linkState: 'linked',
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        },
        ...overrides,
    };
}

function makeDocument(): EditorDocumentV4 {
    const lowerSource = createVideoSourceAssetV4Fixture({
        id: 'lower_source',
        fingerprint: 'lower_fingerprint',
    });
    const topSource = createVideoSourceAssetV4Fixture({
        id: 'top_source',
        fingerprint: 'top_fingerprint',
    });
    return createEditorDocumentV4Fixture({
        videoSources: [lowerSource, topSource],
        videoTracks: [
            { id: 'top_track', name: 'Top', visible: true, locked: true },
            { id: 'lower_track', name: 'Lower', visible: true, locked: false },
        ],
        videoClips: [
            videoClip({}),
            videoClip({
                id: 'top_clip',
                sourceId: 'top_source',
                trackId: 'top_track',
                timelineStartFrame: 30,
                sourceStart: 2,
                sourceEnd: 3,
            }),
        ],
        editorialTranscriptDescriptors: [],
        narrative: null,
    });
}

describe('V4 video frame runtime plan', () => {
    it('resolves the top visible layer, renders locked tracks, maps source time, and preserves gaps', () => {
        const document = makeDocument();
        const plan = buildVideoFrameRuntimePlan(document);

        expect(plan.version).toBe(4);
        expect(resolveVideoFrameRuntimePlacementAtFrame(plan, 15)).toMatchObject({
            placement: { clip: { id: 'lower_clip' } },
            sourceTime: 0.5,
        });
        expect(resolveVideoFrameRuntimePlacementAtFrame(plan, 35)).toMatchObject({
            placement: { clip: { id: 'top_clip' } },
            sourceTime: 2 + 5 / 30,
        });
        expect(resolveVideoFrameRuntimePlacementAtFrame(plan, 100)).toBeNull();

        document.videoTracks[0] = { ...document.videoTracks[0], visible: false };
        const hiddenTopPlan = buildVideoFrameRuntimePlan(document);
        expect(resolveVideoFrameRuntimePlacementAtFrame(hiddenTopPlan, 35)?.placement.clip.id)
            .toBe('lower_clip');
    });

    it('warms only the winning visual occurrence and emits no request for black gaps', () => {
        const document = makeDocument();
        const plan = buildVideoFrameRuntimePlan(document);
        const warmup = buildPreviewWarmupFramePlanForRuntime({
            isPlaying: true,
            currentProjectFrameIndex: 28,
            projectFrameRate: document.renderProfile.fps,
            plan,
            sources: document.videoSources,
            rangeForward: 5,
            rangeBackward: 2,
            sparseFps: 10,
            playbackLookaheadFrames: 65,
            hasFrame: () => false,
        });

        expect(warmup.find((frame) => frame.projectFrameIndex === 35)).toMatchObject({
            sourceId: 'top_source',
        });
        expect(warmup.some((frame) => frame.projectFrameIndex > 90)).toBe(false);
    });

    it('fails closed instead of cumulatively rendering a mixed-version media graph', () => {
        const document = makeDocument();
        const mixed = {
            renderProfile: document.renderProfile,
            videoClips: document.videoClips,
            videoTracks: [{ id: 'legacy', name: 'Legacy', clipIds: ['lower_clip'] }],
        } as unknown as VideoFrameRuntimeDocument;

        expect(() => buildVideoFrameRuntimePlan(mixed)).toThrow(/same editor graph version/i);
    });

    it('separates targeted mapping replans from decoded source-frame invalidation', () => {
        const original = makeDocument();
        const before = buildVideoFramePlanSignaturesV4(original);
        const cacheIdentity = getDecodedVideoFrameCacheIdentityV4(original.videoSources[0], 12);

        const moved = {
            ...original,
            videoClips: original.videoClips.map((clip) => clip.id === 'top_clip'
                ? { ...clip, timelineStartFrame: 60 }
                : clip),
        };
        const moveInvalidation = diffVideoFramePlanSignaturesV4(
            before,
            buildVideoFramePlanSignaturesV4(moved),
        );
        expect(moveInvalidation.sourceIdsToInvalidate).toEqual([]);
        expect(moveInvalidation.clipIdsToReplan).toContain('top_clip');
        expect(getDecodedVideoFrameCacheIdentityV4(moved.videoSources[0], 12)).toBe(cacheIdentity);

        const cropped = {
            ...original,
            videoClips: original.videoClips.map((clip) => clip.id === 'top_clip'
                ? { ...clip, sourceStart: 2.25, sourceEnd: 3.25 }
                : clip),
        };
        const cropInvalidation = diffVideoFramePlanSignaturesV4(
            before,
            buildVideoFramePlanSignaturesV4(cropped),
        );
        expect(cropInvalidation.sourceIdsToInvalidate).toEqual([]);
        expect(cropInvalidation.clipIdsToReplan).toContain('top_clip');

        const hidden = {
            ...original,
            videoTracks: original.videoTracks.map((track) => track.id === 'top_track'
                ? { ...track, visible: false }
                : track),
        };
        const movedWhileHidden = {
            ...hidden,
            videoClips: hidden.videoClips.map((clip) => clip.id === 'top_clip'
                ? { ...clip, timelineStartFrame: 60 }
                : clip),
        };
        const hiddenMoveInvalidation = diffVideoFramePlanSignaturesV4(
            buildVideoFramePlanSignaturesV4(hidden),
            buildVideoFramePlanSignaturesV4(movedWhileHidden),
        );
        expect(hiddenMoveInvalidation.clipIdsToReplan).toEqual(['top_clip']);

        const replaced = {
            ...original,
            videoSources: original.videoSources.map((source) => source.id === 'lower_source'
                ? { ...source, fingerprint: 'replacement_fingerprint' }
                : source),
        };
        expect(diffVideoFramePlanSignaturesV4(
            before,
            buildVideoFramePlanSignaturesV4(replaced),
        ).sourceIdsToInvalidate).toEqual(['lower_source']);
    });
});
