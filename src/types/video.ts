import type { Subtitle, SubtitleTrack } from './timeline';

export interface VideoSourceDescriptor {
    id: string;
    originalName: string;
    mimeType: string;
    size: number;
    lastModified: number;
    fingerprint: string;
    duration: number;
    fps: number;
    width: number;
    height: number;
    bitrate: number | null;
    hasAudio: boolean;
}

/**
 * Canonical in-memory representation of an imported source.
 *
 * The File deliberately stays next to its validated descriptor. Persisted manifests only
 * contain VideoSourceDescriptor values, so object URLs and browser File handles can never
 * accidentally leak into project serialization.
 */
export interface VideoSourceAsset extends VideoSourceDescriptor {
    file: File;
}

/** V3 intentionally keeps the existing video descriptor contract for migration compatibility. */
export type VideoSourceDescriptorV3 = VideoSourceDescriptor;

export interface VideoSourceAssetV3 extends VideoSourceDescriptorV3 {
    file: File;
}

export interface VideoSourceHandle {
    sourceId: string;
    objectUrl: string;
}

export interface VideoClip {
    id: string;
    sourceId: string;
    sourceStart: number;
    sourceEnd: number;
}

/**
 * Exact frame rate used by the editor timeline and renderer.
 *
 * Keeping the rate rational avoids rounding broadcast rates such as 24000/1001 to a decimal
 * approximation. The canonical form is always positive and reduced to lowest terms.
 */
export interface RationalFrameRate {
    numerator: number;
    denominator: number;
}

/** The durable output contract selected for an editor project. */
export interface RenderProfile {
    fps: RationalFrameRate;
    width: number;
    height: number;
    audioSampleRate: 48_000;
    isFrameRateLocked: boolean;
    isCanvasSizeLocked: boolean;
}

/** Embedded audio fades follow the output-frame timing domain of its parent video clip. */
export interface VideoClipAudioSettings {
    linkState: 'linked' | 'detached';
    muted: boolean;
    gainDb: number;
    fadeInFrames: number;
    fadeOutFrames: number;
}

/**
 * A v3 video edit keeps source media bounds in seconds because decoded video timestamps are
 * time based. Embedded audio remains attached to the clip but has independent mix controls.
 */
export interface VideoClipV3 {
    id: string;
    sourceId: string;
    sourceStart: number;
    sourceEnd: number;
    /** Null is reserved for video sources that were probed without an audio stream. */
    audio: VideoClipAudioSettings | null;
}

/**
 * Durable vertical lane membership for video clips.
 *
 * Clip timing remains canonical in EditorDocumentV3.videoClips. Tracks only describe which
 * visible lane owns each clip, so moving a clip vertically cannot change preview/export order.
 */
export interface VideoTrack {
    id: string;
    name: string;
    clipIds: string[];
}

export interface AudioSourceDescriptor {
    id: string;
    originalName: string;
    mimeType: string;
    size: number;
    lastModified: number;
    fingerprint: string;
    duration: number;
    nativeSampleRate: number;
    nativeSampleCount: number;
    nativeChannelCount: number;
    bitrate: number | null;
    codec: string | null;
}

/** Runtime audio asset. Only the descriptor portion is serialized in an editor manifest. */
export interface AudioSourceAsset extends AudioSourceDescriptor {
    file: File;
}

export interface AudioClipCommon {
    id: string;
    timelineStartFrame: number;
    muted: boolean;
    gainDb: number;
}

/** Imported-audio fades stay in the same native-sample domain as their source crop. */
export interface ImportedAudioClip extends AudioClipCommon {
    source: {
        kind: 'audio-source';
        audioSourceId: string;
    };
    sourceStartSample: number;
    sourceEndSample: number;
    /**
     * Exact 48 kHz render duration after a trim or split. Older V3 documents derive it from the
     * native crop; edited clips persist it so frame rounding never stretches their audio.
     */
    timelineDurationSamples?: number;
    fadeInSamples: number;
    fadeOutSamples: number;
}

/**
 * Detached video audio keeps the same second-based source crop as its originating video clip.
 * Its timeline placement and fades use integer output frames so later independent edits never
 * depend on a decoder's native audio timebase being present in the video descriptor.
 */
export interface VideoSourceAudioClip extends AudioClipCommon {
    source: {
        kind: 'video-source-audio';
        videoSourceId: string;
    };
    sourceStart: number;
    sourceEnd: number;
    fadeInFrames: number;
    fadeOutFrames: number;
}

export type AudioClip = ImportedAudioClip | VideoSourceAudioClip;

/** Mix controls shared by every independently editable audio clip. */
export type AudioClipMixSettings = Pick<AudioClipCommon, 'muted' | 'gainDb'>;

export interface AudioTrack {
    id: string;
    name: string;
    muted: boolean;
    solo: boolean;
    locked: boolean;
    gainDb: number;
    clips: AudioClip[];
}

/**
 * Subtitles remain compatible with the existing second-based renderer while declaring whether
 * media ripple edits move them or they remain at absolute timeline positions.
 */
export interface SubtitleTrackV3 extends SubtitleTrack {
    timingDomain: 'video-ripple' | 'absolute';
}

export interface TrackTranscriptionProvenanceV3 extends TrackTranscriptionState {
    provider?: string;
    model?: string;
    generatedAt?: string;
    sourceDocumentRevision: number;
    sourceAudioGraphRevision: number;
    sourceAudioGraphSignature: string;
    stale: boolean;
    /** Provider-specific details may be retained without changing the core graph contract. */
    extensions?: Record<string, unknown>;
}

/** Snapshot captured when a transcription job starts and checked again before applying it. */
export interface TranscriptionJobGuard {
    documentRevision: number;
    audioGraphRevision: number;
    audioGraphSignature: string;
    targetTrackSignature: string;
}

/** Ephemeral selection is intentionally discriminated and never stored in the v3 manifest. */
export type TransientMediaSelection =
    | { kind: 'none' }
    | { kind: 'video-clip'; clipId: string }
    | { kind: 'audio-clip'; trackId: string; clipId: string }
    | { kind: 'subtitles'; trackId: string; subtitleIds: string[] };

export interface EditorDocumentV3 {
    version: 3;
    revision: number;
    audioGraphRevision: number;
    renderProfile: RenderProfile;
    subtitleTracks: SubtitleTrackV3[];
    videoSources: VideoSourceAssetV3[];
    videoClips: VideoClipV3[];
    videoTracks: VideoTrack[];
    audioSources: AudioSourceAsset[];
    audioTracks: AudioTrack[];
    activeSubtitleTrackId: string | null;
    transientSelection: TransientMediaSelection;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
}

export interface EditorManifestV3 {
    version: 3;
    revision: number;
    audioGraphRevision: number;
    renderProfile: RenderProfile;
    subtitleTracks: SubtitleTrackV3[];
    videoSourceDescriptors: VideoSourceDescriptorV3[];
    videoClips: VideoClipV3[];
    videoTracks: VideoTrack[];
    audioSourceDescriptors: AudioSourceDescriptor[];
    audioTracks: AudioTrack[];
    activeSubtitleTrackId: string | null;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
}

export type EditorDocumentV3ValidationCode =
    | 'invalid-version'
    | 'invalid-revision'
    | 'invalid-render-profile'
    | 'invalid-id'
    | 'duplicate-id'
    | 'file-mismatch'
    | 'invalid-source'
    | 'missing-source'
    | 'missing-track'
    | 'missing-clip'
    | 'missing-subtitle'
    | 'invalid-clip-bounds'
    | 'overlapping-clips'
    | 'invalid-mix-controls'
    | 'invalid-subtitle-interval'
    | 'invalid-transcription-provenance';

export interface EditorDocumentV3ValidationIssue {
    code: EditorDocumentV3ValidationCode;
    path: string;
    message: string;
}

export interface EditorDocumentV3ValidationResult {
    valid: boolean;
    issues: EditorDocumentV3ValidationIssue[];
}

export interface ClipPlacement {
    clip: VideoClip;
    index: number;
    projectStart: number;
    projectEnd: number;
    duration: number;
}

export interface TrackTranscriptionState {
    raw: Subtitle[];
    groups: Record<string, Subtitle[]>;
    containerIds: string[];
}

export interface EditorDocumentV2 {
    revision: number;
    projectFps: number;
    tracks: SubtitleTrack[];
    videoSources: VideoSourceAsset[];
    videoClips: VideoClip[];
    activeTrackId: string | null;
    selectedSubtitleIds: string[];
    selectedClipId: string | null;
    transcriptionByTrackId: Record<string, TrackTranscriptionState>;
}

export interface EditorManifestV2 {
    version: 2;
    revision: number;
    projectFps: number;
    tracks: SubtitleTrack[];
    sourceDescriptors: VideoSourceDescriptor[];
    videoClips: VideoClip[];
    activeTrackId: string | null;
    transcriptionByTrackId: Record<string, TrackTranscriptionState>;
}

export type VideoDocumentValidationCode =
    | 'invalid-revision'
    | 'invalid-project-fps'
    | 'invalid-id'
    | 'duplicate-id'
    | 'file-mismatch'
    | 'invalid-source'
    | 'missing-source'
    | 'invalid-clip-bounds'
    | 'invalid-subtitle-interval'
    | 'missing-clip'
    | 'missing-track'
    | 'missing-subtitle'
    | 'invalid-transcription-provenance';

export interface VideoDocumentValidationIssue {
    code: VideoDocumentValidationCode;
    path: string;
    message: string;
}

export interface VideoDocumentValidationResult {
    valid: boolean;
    issues: VideoDocumentValidationIssue[];
}

/** A retained old half-open interval translated without changing its duration. */
export interface RetainedIntervalMapping {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    kind: 'media' | 'black-tail';
}

export interface MediaEditResult {
    videoClips: VideoClip[];
    retainedIntervals: RetainedIntervalMapping[];
    oldMediaDuration: number;
    newMediaDuration: number;
    oldContentDuration: number;
}

export interface SplitClipResult {
    videoClips: VideoClip[];
    leftClip: VideoClip;
    rightClip: VideoClip;
}

export type TimelineIdFactory = () => string;

export interface TimelineDurations {
    mediaDuration: number;
    contentDuration: number;
    viewDuration: number;
}
