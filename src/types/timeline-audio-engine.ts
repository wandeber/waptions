import type { AudioMixPlan } from '@/lib/audio-mix-plan';
import type { EditorDocumentV3 } from './video';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
        ? readonly DeepReadonly<Item>[]
        : T extends object
            ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
            : T;

/** Minimal media graph required by preview decoding and mix projection. */
export type TimelineAudioRuntimeDocument = DeepReadonly<Pick<
    EditorDocumentV3,
    'renderProfile' | 'videoSources' | 'videoClips' | 'audioSources' | 'audioTracks'
>>;

/** Immutable handoff from editor state to the real-time audio engine. */
export interface TimelineAudioEngineSnapshot {
    readonly document: TimelineAudioRuntimeDocument;
    readonly mixPlan: DeepReadonly<AudioMixPlan>;
    /** Changes only when a typed source id points at a different immutable media fingerprint. */
    readonly sourceCatalogKey: string;
    /** Complete audible mix semantics, including the fingerprints of referenced media sources. */
    readonly audibleMixKey: string;
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
    /**
     * Applies editor state and its current playhead as one transaction.
     *
     * Semantic projection keys let the implementation distinguish a mix replacement from a
     * subtitle-only content boundary update, avoiding duplicate seek + snapshot queue resets.
     */
    applySnapshot(snapshot: TimelineAudioEngineSnapshot, playheadSample: number): void;
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
