import { describe, expect, it, vi } from 'vitest';
import type { RenderMediaByteSourcePort } from '../../src/lib/render-plan';
import {
    FfmpegResolvedPlanRenderBackend,
    type FfmpegResolvedPlanExecutorPort,
} from './ffmpeg-backend';
import {
    buildFfmpegAudioDecoderArgs,
    buildFfmpegEncoderArgs,
    buildFfmpegVideoDecoderArgs,
} from './ffmpeg-command';
import { createNodeFfmpegPlanFixture } from './node-ffmpeg.test-fixtures';
import type { HeadlessRenderResourceBudgetPort } from './contracts';

describe('fixed FFmpeg argument construction', () => {
    it('builds deterministic 30000/1001 segment and encoder arguments', () => {
        const plan = createNodeFfmpegPlanFixture();
        const segment = plan.videoSegments[0];
        if (segment.kind !== 'video') throw new Error('Expected a video fixture segment.');

        const decoder = buildFfmpegVideoDecoderArgs({
            segment,
            outputWidth: plan.renderProfile.width,
            outputHeight: plan.renderProfile.height,
            fpsNumerator: plan.renderProfile.fps.numerator,
            fpsDenominator: plan.renderProfile.fps.denominator,
            backgroundColor: plan.backgroundColor,
        });
        const encoder = buildFfmpegEncoderArgs({
            width: plan.renderProfile.width,
            height: plan.renderProfile.height,
            fpsNumerator: plan.renderProfile.fps.numerator,
            fpsDenominator: plan.renderProfile.fps.denominator,
            frameCount: plan.contentEndFrame,
            outputSampleCount: plan.outputEndSample,
        });

        expect(decoder).toContain('/dev/fd/3');
        expect(decoder).toContain('2');
        expect(decoder.join('\n')).toContain(
            'fps=fps=30000/1001:start_time=0:round=near',
        );
        expect(decoder.join('\n')).toContain('setpts=(PTS-STARTPTS)/1');
        expect(decoder.join('\n')).toContain(
            'pad=64:36:0:0:color=0x112233',
        );
        expect(encoder).toEqual(expect.arrayContaining([
            '-framerate', '30000/1001',
            '-frames:v', '5',
            '-preset', 'medium',
            '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-b:a', '192k',
            '-ar', '48000',
            '-ac', '2',
            '/dev/fd/3',
            '/dev/fd/4',
        ]));
        expect(encoder).not.toContain('-shortest');
    });

    it('maps sourceSecondsPerOutputFrame into a deterministic decoder speed', () => {
        const plan = createNodeFfmpegPlanFixture();
        const original = plan.videoSegments[0];
        if (original.kind !== 'video') throw new Error('Expected a video fixture segment.');
        const args = buildFfmpegVideoDecoderArgs({
            segment: {
                ...original,
                sourceSecondsPerOutputFrame: original.sourceSecondsPerOutputFrame * 2,
            },
            outputWidth: plan.renderProfile.width,
            outputHeight: plan.renderProfile.height,
            fpsNumerator: plan.renderProfile.fps.numerator,
            fpsDenominator: plan.renderProfile.fps.denominator,
            backgroundColor: plan.backgroundColor,
        });

        expect(args.join('\n')).toContain('setpts=(PTS-STARTPTS)/2');
        expect(args).toEqual(expect.arrayContaining(['-frames:v', '2']));
    });

    it('does not place source ids, names, paths, or text into argv or filters', () => {
        const plan = createNodeFfmpegPlanFixture();
        const segment = {
            ...plan.videoSegments[0],
            sourceId: '$(touch /tmp/injected);drawtext=text=owned',
            clipId: '`open /Applications/Calculator.app`',
        };
        if (segment.kind !== 'video') throw new Error('Expected a video fixture segment.');

        const args = buildFfmpegVideoDecoderArgs({
            segment,
            outputWidth: plan.renderProfile.width,
            outputHeight: plan.renderProfile.height,
            fpsNumerator: plan.renderProfile.fps.numerator,
            fpsDenominator: plan.renderProfile.fps.denominator,
            backgroundColor: plan.backgroundColor,
        });
        const rendered = args.join('\n');

        expect(rendered).not.toContain('touch');
        expect(rendered).not.toContain('drawtext');
        expect(rendered).not.toContain('Calculator');
        expect(rendered).not.toContain(plan.sources[0].originalName);
        expect(args.filter((argument) => argument.startsWith('/dev/fd/')))
            .toEqual(['/dev/fd/3']);
    });

    it('keeps native-sample audio selection numeric and seekable', () => {
        const args = buildFfmpegAudioDecoderArgs({
            startSample: 12_345,
            endSample: 67_890,
        });

        expect(args).toContain('/dev/fd/3');
        expect(args.join('\n')).toContain(
            'atrim=start_sample=12345:end_sample=67890',
        );
        expect(args.join('\n')).not.toContain('pipe:3');
    });
});

describe('FFmpeg subtitle capability boundary', () => {
    it('fails closed before probing or allocating when subtitle tracks are nonempty', async () => {
        const executor: FfmpegResolvedPlanExecutorPort = {
            probe: vi.fn(),
            encode: vi.fn(),
        };
        const budget: HeadlessRenderResourceBudgetPort = {
            authority: 'process-wide-decoded-memory-v1',
            acquire: vi.fn(),
            snapshot: vi.fn(),
        };
        const media: RenderMediaByteSourcePort = {
            acquire: vi.fn(),
        };
        const backend = new FfmpegResolvedPlanRenderBackend(executor, budget, media);
        const plan = createNodeFfmpegPlanFixture({
            // The backend must reject on capability alone and never inspect subtitle contents.
            subtitleTracks: [{} as never],
        });

        await expect(backend.probe(plan)).resolves.toMatchObject({
            supported: false,
        });
        expect(executor.probe).not.toHaveBeenCalled();
        await expect(backend.render({
            jobId: 'job:subtitle',
            plan,
            outputCapability: {
                version: 1,
                kind: 'create-only-staged-output',
                capabilityId: 'capability:output',
                grantId: 'grant:output',
                stagingId: 'staging:output',
            },
            limits: {
                version: 1,
                maxReadChunkBytes: 1,
                maxDecodedPixelBytes: 1,
                maxVideoDecoderSessions: 1,
                maxCanvasFrames: 1,
                maxAudioMixBytes: 1,
                maxConcurrentExports: 1,
                maxBackendProcesses: 1,
            },
        })).rejects.toMatchObject({ code: 'CODEC_UNAVAILABLE' });
        expect(budget.acquire).not.toHaveBeenCalled();
    });
});
