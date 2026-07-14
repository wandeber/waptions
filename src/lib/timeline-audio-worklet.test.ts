import { describe, expect, it } from 'vitest';
import {
    clampTimelinePlaybackRate,
    getProjectCursorIncrement,
    getTimelineAudioWorkletUrl,
    TimelineAudioQueueModel,
    TIMELINE_AUDIO_WORKLET_PATH,
    TIMELINE_AUDIO_MAX_QUEUED_BLOCKS,
    TIMELINE_AUDIO_WORKLET_PROCESSOR,
    TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION,
} from './timeline-audio-worklet';

describe('timeline AudioWorklet deployment contract', () => {
    it('uses a versioned same-origin public asset and stable processor name', () => {
        expect(TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION).toBe(3);
        expect(TIMELINE_AUDIO_WORKLET_PATH).toBe('/worklets/timeline-audio-worklet.js?v=3');
        expect(TIMELINE_AUDIO_WORKLET_PROCESSOR).toBe('timeline-audio-processor');
        expect(getTimelineAudioWorkletUrl('https://waptions.example/editor/project').href)
            .toBe('https://waptions.example/worklets/timeline-audio-worklet.js?v=3');
    });

    it('maps 0.1x, 1x, and 2x playback into a device-rate-independent cursor increment', () => {
        expect(getProjectCursorIncrement(48_000, 0.1)).toBeCloseTo(0.1);
        expect(getProjectCursorIncrement(44_100, 1)).toBeCloseTo(48_000 / 44_100);
        expect(getProjectCursorIncrement(96_000, 2)).toBe(1);
        expect(clampTimelinePlaybackRate(0)).toBe(0.1);
        expect(clampTimelinePlaybackRate(3)).toBe(2);
    });

    it('freezes the canonical cursor on underrun and resumes the same sample after refill', () => {
        const queue = new TimelineAudioQueueModel(10);
        expect(queue.renderFrame(1)).toBeNull();
        expect(queue.outputSample).toBe(10);
        queue.queue({
            startSample: 10,
            left: Float32Array.of(0.25, 0.5),
            right: Float32Array.of(-0.25, -0.5),
        });
        expect(queue.renderFrame(1)).toEqual([0.25, -0.25]);
        expect(queue.outputSample).toBe(11);
    });

    it('interpolates at a fractional project cursor and reports contiguous queued coverage', () => {
        const queue = new TimelineAudioQueueModel(0);
        queue.queue({
            startSample: 0,
            left: Float32Array.of(0, 1, 2),
            right: Float32Array.of(2, 1, 0),
        });
        expect(queue.getQueuedUntilSample()).toBe(3);
        expect(queue.renderFrame(0.5)).toEqual([0, 2]);
        expect(queue.renderFrame(0.5)).toEqual([0.5, 1.5]);
    });

    it('preserves earliest playable blocks when the bounded queue overflows', () => {
        const queue = new TimelineAudioQueueModel(0);
        for (let startSample = 0; startSample <= TIMELINE_AUDIO_MAX_QUEUED_BLOCKS; startSample += 1) {
            queue.queue({
                startSample,
                left: Float32Array.of(startSample),
                right: Float32Array.of(startSample),
            });
        }

        expect(queue.getQueuedUntilSample()).toBe(TIMELINE_AUDIO_MAX_QUEUED_BLOCKS);
        expect(queue.renderFrame(1)).toEqual([0, 0]);
    });
});
