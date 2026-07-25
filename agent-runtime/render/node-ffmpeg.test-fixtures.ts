import type { ResolvedRenderPlanV1 } from '../../src/lib/render-plan';

export function createNodeFfmpegPlanFixture(
    overrides: Partial<ResolvedRenderPlanV1> = {},
): ResolvedRenderPlanV1 {
    const fps = { numerator: 30_000, denominator: 1_001 };
    const contentEndFrame = 5;
    const outputEndSample = Math.floor(
        (contentEndFrame * fps.denominator * 48_000 + fps.numerator / 2)
        / fps.numerator,
    );
    return {
        version: 1,
        planId: 'render-plan-v1:node-ffmpeg',
        sourceSnapshotId: 'snapshot:node-ffmpeg',
        documentRevision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps,
            width: 64,
            height: 36,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        backgroundColor: '#112233',
        contentEndFrame,
        outputEndSample,
        videoSegments: [
            {
                kind: 'video',
                outputStartFrame: 0,
                outputEndFrame: 2,
                clipId: 'clip:first',
                trackId: 'track:video',
                sourceId: 'video:source',
                sourceStartSeconds: 0,
                sourceEndSeconds: 1,
                sourceSecondsPerOutputFrame: fps.denominator / fps.numerator,
                sourceWidth: 64,
                sourceHeight: 36,
                contain: { x: 0, y: 0, width: 64, height: 36 },
            },
            {
                kind: 'background',
                outputStartFrame: 2,
                outputEndFrame: 3,
            },
            {
                kind: 'video',
                outputStartFrame: 3,
                outputEndFrame: 5,
                clipId: 'clip:second',
                trackId: 'track:video',
                sourceId: 'video:source',
                sourceStartSeconds: 0.25,
                sourceEndSeconds: 1,
                sourceSecondsPerOutputFrame: fps.denominator / fps.numerator,
                sourceWidth: 64,
                sourceHeight: 36,
                contain: { x: 0, y: 0, width: 64, height: 36 },
            },
        ],
        subtitleTracks: [],
        audioMixPlan: {
            sampleRate: 48_000,
            totalSampleCount: outputEndSample,
            videoSampleCount: outputEndSample,
            contributors: [],
        },
        sources: [{
            sourceId: 'video:source',
            kind: 'video',
            byteSourceCapabilityId: 'source-capability:video',
            fingerprint: 'sha256:video',
            size: 1,
            lastModified: 1,
            originalName: 'untrusted;$(touch injected).mov',
            mimeType: 'video/quicktime',
            duration: 1,
        }],
        requiredFontFamilies: [],
        output: {
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
        },
        ...overrides,
    };
}
