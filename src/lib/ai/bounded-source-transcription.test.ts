import { describe, expect, it } from 'vitest';
import type { AudioTranscriptionSourceJob } from '@/lib/audio-transcription-plan';
import {
    createBoundedSourceTranscriptionPlan,
    int16PcmToFloat32,
    projectWindowWordsToSource,
} from './bounded-source-transcription';

const job = (ranges: Array<{ startSeconds: number; endSeconds: number }>): AudioTranscriptionSourceJob => ({
    source: { kind: 'video-source-audio', videoSourceId: 'source' },
    sourceKey: 'video-source-audio:source',
    placements: ranges.map((range, index) => ({
        id: `clip-${index}`,
        source: { kind: 'video-source-audio', videoSourceId: 'source' },
        sourceKey: 'video-source-audio:source',
        contributorKind: 'embedded-video',
        trackId: 'track',
        projectStartFrame: 0,
        projectEndFrame: 30,
        projectStartSample: 0,
        projectEndSample: 48_000,
        sourceRange: { domain: 'seconds', ...range },
    })),
});

describe('bounded source transcription', () => {
    it('plans only used source ranges and caps every decoded window at thirty seconds', async () => {
        const plan = await createBoundedSourceTranscriptionPlan({
            job: job([
                { startSeconds: 10, endSeconds: 50 },
                { startSeconds: 3_000, endSeconds: 3_001 },
            ]),
            sourceFingerprint: 'source-fingerprint',
            sourceDurationSeconds: 7_200,
        });

        expect(plan.normalizedCoreCoverage).toEqual([
            { startSample: 160_000, endSample: 800_000 },
            { startSample: 48_000_000, endSample: 48_016_000 },
        ]);
        expect(plan.acquisitionWindows.length).toBeGreaterThan(2);
        expect(plan.acquisitionWindows.every(window => (
            window.decoded.endSample - window.decoded.startSample <= 30 * 16_000
        ))).toBe(true);
        expect(plan.acquisitionWindows.every(window => (
            window.decoded.endSample < 49_000_000
        ))).toBe(true);
    });

    it('keeps only core-owned words while projecting provider-local time to source zero', () => {
        const window = {
            windowId: `sha256:${'a'.repeat(64)}` as const,
            core: { startSample: 32_000, endSample: 48_000 },
            decoded: { startSample: 16_000, endSample: 64_000 },
            chunkRecordIds: [],
        };

        expect(projectWindowWordsToSource([
            { word: 'context-before', start: 0, end: 0.5 },
            { word: 'kept', start: 1, end: 2 },
            { word: 'context-after', start: 2.5, end: 3 },
        ], window)).toEqual([{
            word: 'kept',
            start: 2,
            end: 3,
        }]);
    });

    it('converts signed PCM without retaining or changing the input buffer', () => {
        const pcm = Int16Array.from([-32_768, 0, 32_767]);
        const converted = int16PcmToFloat32(pcm);

        expect(Array.from(converted)).toEqual([-1, 0, 1]);
        expect(pcm).toEqual(Int16Array.from([-32_768, 0, 32_767]));
        expect(converted.buffer).not.toBe(pcm.buffer);
    });
});
