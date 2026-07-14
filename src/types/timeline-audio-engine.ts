import type { AudioMixPlan } from '@/lib/audio-mix-plan';
import type { EditorDocumentV3 } from './video';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
        ? readonly DeepReadonly<Item>[]
        : T extends object
            ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
            : T;

/** Immutable handoff from editor state to the real-time audio engine. */
export interface TimelineAudioEngineSnapshot {
    readonly documentRevision: number;
    readonly audioGraphRevision: number;
    readonly document: DeepReadonly<EditorDocumentV3>;
    readonly mixPlan: DeepReadonly<AudioMixPlan>;
    readonly contentEndSample: number;
}

export interface TimelineAudioClockEvent {
    generation: number;
    outputSample: number;
    timeSeconds: number;
    playing: boolean;
    playbackRate: number;
}

export interface TimelineAudioUnderrunEvent {
    generation: number;
    outputSample: number;
    missingSampleCount: number;
}

export interface TimelineAudioEngineCallbacks {
    onClock: (event: TimelineAudioClockEvent) => void;
    onUnderrun: (event: TimelineAudioUnderrunEvent) => void;
    onError: (error: Error) => void;
}

/**
 * Short-lived complete mix plan used while previewing an uncommitted timeline edit.
 *
 * Move, trim, and split drafts change contributor geometry as well as gain. Supplying the entire
 * immutable plan keeps those previews coherent; setting null restores the durable snapshot.
 */
export interface TimelineAudioTransientOverride {
    readonly mixPlan: DeepReadonly<AudioMixPlan>;
}

/**
 * Port implemented by the browser preview engine. All positions use canonical 48 kHz output
 * samples, keeping play, seek, clock reporting, and export comparisons in one integer domain.
 */
export interface TimelineAudioEnginePort {
    setSnapshot(snapshot: TimelineAudioEngineSnapshot): void;
    play(): Promise<void>;
    pause(): void;
    seek(outputSample: number): void;
    setPlaybackRate(playbackRate: number): void;
    setMasterGain(gainLinear: number): void;
    setTransientOverride(override: TimelineAudioTransientOverride | null): void;
    hasAudibleContributors(): boolean;
    /** Releases owned browser resources. Repeated calls must resolve without side effects. */
    destroy(): Promise<void>;
}

export type TimelineAudioEngine = TimelineAudioEnginePort;
