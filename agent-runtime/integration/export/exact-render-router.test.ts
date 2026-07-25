import { describe, expect, it, vi } from 'vitest';
import {
    createHeadlessRenderSnapshotFixture,
} from '../../../src/lib/headless-render/headless-render.test-fixtures';
import { createResolvedRenderPlan } from '../../../src/lib/render-plan';
import {
    DEFAULT_HEADLESS_RENDER_LIMITS,
    type HeadlessRenderBackendName,
    type HeadlessRenderBackendPort,
} from '../../render/contracts';
import { ExactCompositionRenderRouter } from './exact-render-router';

describe('exact composition render routing', () => {
    it.each([
        [true, 'chromium-webcodecs' as const],
        [false, 'ffmpeg' as const],
    ])('routes visible subtitles=%s to %s', async (withSubtitles, expected) => {
        const ffmpeg = backend('ffmpeg');
        const chromium = backend('chromium-webcodecs');
        const router = new ExactCompositionRenderRouter(ffmpeg, chromium);
        const snapshot = createHeadlessRenderSnapshotFixture();
        if (!withSubtitles) {
            snapshot.manifest.subtitleTracks = [];
            snapshot.manifest.activeSubtitleTrackId = null;
        }
        const plan = createResolvedRenderPlan(snapshot);

        await expect(router.render({
            jobId: 'job-route',
            plan,
            outputCapability: {
                version: 1,
                kind: 'create-only-staged-output',
                capabilityId: 'output-capability',
                grantId: 'output-grant',
                stagingId: 'output-stage',
            },
            limits: DEFAULT_HEADLESS_RENDER_LIMITS,
            resetOutputForFallback: async () => undefined,
        })).resolves.toMatchObject({ backend: expected });

        expect(ffmpeg.render).toHaveBeenCalledTimes(expected === 'ffmpeg' ? 1 : 0);
        expect(chromium.render).toHaveBeenCalledTimes(expected === 'chromium-webcodecs' ? 1 : 0);
    });
});

function backend(name: HeadlessRenderBackendName): HeadlessRenderBackendPort {
    return {
        name,
        probe: vi.fn().mockResolvedValue({
            supported: true,
            backend: name,
            resolvedPlanVersion: 1,
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
        }),
        render: vi.fn().mockResolvedValue({
            backend: name,
            warnings: [],
            sourceRangesRead: [],
            diagnostics: {
                peakDecodedPixelBytes: 0,
                peakAudioMixBytes: 0,
                peakVideoDecoderSessions: 0,
                canvasFrames: 0,
            },
        }),
    };
}
