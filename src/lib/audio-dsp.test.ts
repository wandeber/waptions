import { describe, expect, it } from 'vitest';
import type { AudioMixContributor, AudioMixPlan } from './audio-mix-plan';
import {
    downmixFrameToStereo,
    limitLinkedStereoFrame,
    renderAudioMixPlan,
    resampleLinearSpan,
} from './audio-dsp';

const standalone = (
    overrides: Partial<AudioMixContributor> = {},
): AudioMixContributor => ({
    id: 'audio:track:clip',
    kind: 'independent-audio',
    trackId: 'track',
    source: { kind: 'audio-source', audioSourceId: 'source' },
    outputStartSample: 0,
    outputEndSample: 4,
    sourceRange: {
        domain: 'native-samples',
        startSample: 0,
        endSample: 4,
        sampleRate: 48_000,
    },
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gainLinear: 1,
    ...overrides,
});

const makePlan = (
    contributors: AudioMixContributor[],
    totalSampleCount = Math.max(0, ...contributors.map((item) => item.outputEndSample)),
): AudioMixPlan => ({
    sampleRate: 48_000,
    totalSampleCount,
    videoSampleCount: 0,
    contributors,
});

describe('deterministic audio DSP', () => {
    it('uses exact centre-position linear resampling for 44.1 kHz to 48 kHz', () => {
        const source = Float32Array.from({ length: 441 }, (_, index) => index);
        const rendered = resampleLinearSpan(source, 0, 441, 480);

        expect(rendered).toHaveLength(480);
        // The theoretical first centre falls just before source index zero and is edge-clamped.
        expect(rendered[0]).toBe(0);
        expect(rendered[1]).toBeCloseTo(0.878125, 6);
        expect(rendered[479]).toBe(440);
    });

    it('downmixes mono, stereo, and 5.1 with the declared coefficients', () => {
        expect(downmixFrameToStereo([0.25])).toEqual([0.25, 0.25]);
        expect(downmixFrameToStereo([0.25, -0.5])).toEqual([0.25, -0.5]);
        const [left, right] = downmixFrameToStereo([1, 2, 3, 4, 5, 6]);
        expect(left).toBeCloseTo(1 + 3 * Math.SQRT1_2 + 2 + 5 * Math.SQRT1_2);
        expect(right).toBeCloseTo(2 + 3 * Math.SQRT1_2 + 2 + 6 * Math.SQRT1_2);
    });

    it('renders native-sample fades and gain before linked limiting', async () => {
        const contributor = standalone({
            fadeInSamples: 2,
            fadeOutSamples: 2,
            gainLinear: 0.5,
        });
        const rendered = await renderAudioMixPlan(makePlan([contributor]), () => ({
            sampleRate: 48_000,
            startSample: 0,
            channels: [Float32Array.of(1, 1, 1, 1)],
        }));

        expect(Array.from(rendered.channels[0])).toEqual([0.125, 0.375, 0.375, 0.125]);
        expect(Array.from(rendered.channels[1])).toEqual([0.125, 0.375, 0.375, 0.125]);
    });

    it('preserves fractional embedded crops and output-frame fades', async () => {
        const contributor: AudioMixContributor = {
            id: 'video:clip',
            kind: 'embedded-video',
            trackId: null,
            source: { kind: 'video-source-audio', videoSourceId: 'video' },
            outputStartSample: 0,
            outputEndSample: 5,
            sourceRange: { domain: 'seconds', startSeconds: 0.25, endSeconds: 1.25 },
            fadeInSamples: 1,
            fadeOutSamples: 1,
            gainLinear: 1,
        };
        const rendered = await renderAudioMixPlan(makePlan([contributor]), () => ({
            sampleRate: 10,
            startSample: 0,
            channels: [Float32Array.from({ length: 20 }, (_, index) => index / 20)],
        }), { limiterThreshold: 1 });

        // Source sample centres are 3, 5, 7, 9 and 11 for the fractional [2.5, 12.5) crop.
        expect(Array.from(rendered.channels[0])).toEqual([
            expect.closeTo(0.075),
            expect.closeTo(0.25),
            expect.closeTo(0.35),
            expect.closeTo(0.45),
            expect.closeTo(0.275),
        ]);
    });

    it('is invariant to Float64 chunk boundaries and preview slicing', async () => {
        const sampleCount = 9_137;
        const first = standalone({
            id: 'first',
            outputEndSample: sampleCount,
            sourceRange: {
                domain: 'native-samples',
                startSample: 0,
                endSample: sampleCount,
                sampleRate: 48_000,
            },
        });
        const second = standalone({
            id: 'second',
            outputStartSample: 137,
            outputEndSample: sampleCount,
            sourceRange: {
                domain: 'native-samples',
                startSample: 137,
                endSample: sampleCount,
                sampleRate: 48_000,
            },
            gainLinear: 0.25,
        });
        const source = Float32Array.from({ length: sampleCount }, (_, index) => (
            Math.sin(index / 37) * 0.2
        ));
        const decode = () => ({ sampleRate: 48_000, startSample: 0, channels: [source] });
        const plan = makePlan([first, second], sampleCount);
        const oneChunk = await renderAudioMixPlan(plan, decode, { chunkSize: sampleCount });
        const irregularChunks = await renderAudioMixPlan(plan, decode, { chunkSize: 997 });
        const preview = await renderAudioMixPlan(plan, decode, {
            startSample: 4_000,
            endSample: 5_000,
            chunkSize: 113,
        });

        expect(irregularChunks.channels[0]).toEqual(oneChunk.channels[0]);
        expect(irregularChunks.channels[1]).toEqual(oneChunk.channels[1]);
        expect(preview.channels[0]).toEqual(oneChunk.channels[0].slice(4_000, 5_000));
        expect(preview.channels[1]).toEqual(oneChunk.channels[1].slice(4_000, 5_000));
    });

    it('decodes bounded contributor windows sequentially instead of whole files', async () => {
        const calls: Array<[string, number, number]> = [];
        let concurrent = 0;
        let maximumConcurrent = 0;
        const first = standalone({ id: 'first', outputEndSample: 8, sourceRange: {
            domain: 'native-samples', startSample: 0, endSample: 8, sampleRate: 48_000,
        } });
        const second = standalone({ id: 'second', outputEndSample: 8, sourceRange: {
            domain: 'native-samples', startSample: 0, endSample: 8, sampleRate: 48_000,
        } });
        await renderAudioMixPlan(makePlan([first, second], 8), async (contributor, request) => {
            concurrent += 1;
            maximumConcurrent = Math.max(maximumConcurrent, concurrent);
            calls.push([contributor.id, request.outputStartSample, request.outputEndSample]);
            await Promise.resolve();
            concurrent -= 1;
            return {
                sampleRate: 48_000,
                startSample: 0,
                channels: [new Float32Array(8)],
            };
        }, { chunkSize: 4 });

        expect(maximumConcurrent).toBe(1);
        expect(calls).toEqual([
            ['first', 0, 4], ['second', 0, 4],
            ['first', 4, 8], ['second', 4, 8],
        ]);
    });

    it('limits both channels with one gain and leaves exact silence in gaps', async () => {
        expect(limitLinkedStereoFrame(2, 1)).toEqual([0.999, 0.4995]);

        const contributor = standalone({ outputStartSample: 2, outputEndSample: 4 });
        const rendered = await renderAudioMixPlan(makePlan([contributor], 6), () => ({
            sampleRate: 48_000,
            startSample: 0,
            channels: [Float32Array.of(2, 2, 2, 2)],
        }));
        expect(Array.from(rendered.channels[0])).toEqual([
            0,
            0,
            expect.closeTo(0.999, 6),
            expect.closeTo(0.999, 6),
            0,
            0,
        ]);
    });
});
