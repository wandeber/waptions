import { describe, expect, it } from 'vitest';
import { buildPreviewWarmupFramePlan } from './use-background-renderer';

describe('buildPreviewWarmupFramePlan', () => {
    it('keeps a full-fps runway ahead of playback', () => {
        const plan = buildPreviewWarmupFramePlan({
            isPlaying: true,
            currentFrameIndex: 100,
            cacheFps: 30,
            rangeForward: 5,
            rangeBackward: 2,
            sparseFps: 10,
            playbackLookaheadFrames: 4,
            hasFrame: () => false,
        });

        expect(plan).toEqual([101, 102, 103, 104]);
    });

    it('skips already cached playback frames', () => {
        const cached = new Set([102, 104]);
        const plan = buildPreviewWarmupFramePlan({
            isPlaying: true,
            currentFrameIndex: 100,
            cacheFps: 30,
            rangeForward: 5,
            rangeBackward: 2,
            sparseFps: 10,
            playbackLookaheadFrames: 4,
            hasFrame: (frameIndex) => cached.has(frameIndex),
        });

        expect(plan).toEqual([101, 103]);
    });

    it('builds dense near-idle frames followed by sparse far frames without duplicates', () => {
        const plan = buildPreviewWarmupFramePlan({
            isPlaying: false,
            currentFrameIndex: 10,
            cacheFps: 4,
            rangeForward: 3,
            rangeBackward: 1,
            sparseFps: 2,
            playbackLookaheadFrames: 4,
            hasFrame: () => false,
        });

        expect(plan).toEqual([
            11, 12, 13, 14, 15, 16, 17, 18,
            20, 22, 8, 6,
        ]);
    });
});
