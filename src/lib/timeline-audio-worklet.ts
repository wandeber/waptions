export const TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION = 2 as const;
export const TIMELINE_AUDIO_WORKLET_PROCESSOR = 'timeline-audio-processor';
export const TIMELINE_AUDIO_WORKLET_PATH = '/worklets/timeline-audio-worklet.js?v=2';
export const TIMELINE_AUDIO_LOW_WATER_SAMPLES = 12_000;
export const TIMELINE_AUDIO_MAX_QUEUED_BLOCKS = 32;

interface WorkletMessageBase {
    version: typeof TIMELINE_AUDIO_WORKLET_PROTOCOL_VERSION;
    generation: number;
}

export type TimelineAudioWorkletMessage =
    | (WorkletMessageBase & { type: 'reset'; outputSample: number })
    | (WorkletMessageBase & {
        type: 'queue';
        startSample: number;
        left: Float32Array;
        right: Float32Array;
    })
    | (WorkletMessageBase & { type: 'play' })
    | (WorkletMessageBase & { type: 'pause' })
    | (WorkletMessageBase & { type: 'set-rate'; playbackRate: number });

export interface TimelineAudioWorkletClockEvent extends WorkletMessageBase {
    type: 'clock';
    outputSample: number;
    timeSeconds: number;
    playing: boolean;
    playbackRate: number;
}

export interface TimelineAudioWorkletUnderrunEvent extends WorkletMessageBase {
    type: 'underrun';
    outputSample: number;
    missingStartSample: number;
    missingEndSample: number;
}

export interface TimelineAudioWorkletLowWaterEvent extends WorkletMessageBase {
    type: 'low-water';
    outputSample: number;
    queuedUntilSample: number;
}

export type TimelineAudioWorkletEvent =
    | TimelineAudioWorkletClockEvent
    | TimelineAudioWorkletUnderrunEvent
    | TimelineAudioWorkletLowWaterEvent;

/** Same-origin public assets are copied unchanged by Next.js and OpenNext. */
export function getTimelineAudioWorkletUrl(origin: string): URL {
    return new URL(TIMELINE_AUDIO_WORKLET_PATH, origin);
}

export function clampTimelinePlaybackRate(playbackRate: number): number {
    if (!Number.isFinite(playbackRate)) throw new RangeError('Playback rate must be finite.');
    return Math.min(2, Math.max(0.1, playbackRate));
}

export function getProjectCursorIncrement(deviceSampleRate: number, playbackRate: number): number {
    if (!Number.isFinite(deviceSampleRate) || deviceSampleRate <= 0) {
        throw new RangeError('Device sample rate must be positive and finite.');
    }
    return clampTimelinePlaybackRate(playbackRate) * 48_000 / deviceSampleRate;
}

export interface TimelineAudioQueueBlock {
    startSample: number;
    left: Float32Array;
    right: Float32Array;
}

/**
 * Pure model for the processor's absolute block queue and fractional 48 kHz project cursor.
 * The static AudioWorklet file cannot execute in Vitest, so keeping the queue math here gives
 * protocol tests one deterministic oracle for interpolation, underrun freezing, and refill.
 */
export class TimelineAudioQueueModel {
    private blocks: TimelineAudioQueueBlock[] = [];
    private cursor: number;

    constructor(outputSample: number) {
        this.cursor = outputSample;
    }

    get outputSample(): number {
        return Math.floor(this.cursor);
    }

    reset(outputSample: number): void {
        this.cursor = outputSample;
        this.blocks = [];
    }

    queue(block: TimelineAudioQueueBlock): void {
        if (block.left.length !== block.right.length) {
            throw new RangeError('Queued stereo blocks must have equal channel lengths.');
        }
        this.blocks.push(block);
        this.blocks.sort((left, right) => left.startSample - right.startSample);
        // Match the deployed worklet: preserve the earliest playable coverage and reject the
        // latest/farthest block if a buggy producer exceeds the bounded queue.
        if (this.blocks.length > TIMELINE_AUDIO_MAX_QUEUED_BLOCKS) this.blocks.pop();
    }

    renderFrame(increment: number): [number, number] | null {
        const sampleIndex = Math.floor(this.cursor);
        const fraction = this.cursor - sampleIndex;
        const first = this.read(sampleIndex);
        if (!first) return null;
        const second = this.read(sampleIndex + 1) ?? first;
        const frame: [number, number] = [
            first[0] * (1 - fraction) + second[0] * fraction,
            first[1] * (1 - fraction) + second[1] * fraction,
        ];
        this.cursor += increment;
        this.blocks = this.blocks.filter((block) => (
            block.startSample + block.left.length > Math.floor(this.cursor)
        ));
        return frame;
    }

    getQueuedUntilSample(): number {
        let cursor = Math.floor(this.cursor);
        for (const block of this.blocks) {
            const end = block.startSample + block.left.length;
            if (end <= cursor) continue;
            if (block.startSample > cursor) break;
            cursor = Math.max(cursor, end);
        }
        return cursor;
    }

    private read(sampleIndex: number): [number, number] | null {
        for (const block of this.blocks) {
            const offset = sampleIndex - block.startSample;
            if (offset >= 0 && offset < block.left.length) {
                return [block.left[offset], block.right[offset]];
            }
        }
        return null;
    }
}
