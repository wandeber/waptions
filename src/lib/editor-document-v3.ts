import type { Subtitle } from '@/types/timeline';
import type {
    AudioClip,
    AudioSourceAsset,
    AudioSourceDescriptor,
    AudioTrack,
    EditorDocumentV3,
    EditorDocumentV3ValidationIssue,
    EditorDocumentV3ValidationResult,
    EditorManifestV3,
    ImportedAudioClip,
    RenderProfile,
    SubtitleTrackV3,
    TrackTranscriptionProvenanceV3,
    VideoClipAudioSettings,
    VideoClipV3,
    VideoSourceAssetV3,
    VideoSourceAudioClip,
    VideoSourceDescriptorV3,
} from '@/types/video';
import { frameToOutputSample, nativeBoundaryToOutputSample } from './audio-timebase';
import { isSafeFrameRate, secondsToFrames } from './render-profile';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = MAX_CANVAS_DIMENSION * MAX_CANVAS_DIMENSION;
const MIN_GAIN_DB = -60;
const MAX_GAIN_DB = 12;
const NUMERICAL_GUARD = 1e-9;

type IssueCode = EditorDocumentV3ValidationIssue['code'];
type AddIssue = (code: IssueCode, path: string, message: string) => void;

interface V3GraphView {
    version: number;
    revision: number;
    audioGraphRevision: number;
    renderProfile: RenderProfile;
    subtitleTracks: SubtitleTrackV3[];
    videoSources: (VideoSourceDescriptorV3 | VideoSourceAssetV3)[];
    videoClips: VideoClipV3[];
    audioSources: (AudioSourceDescriptor | AudioSourceAsset)[];
    audioTracks: AudioTrack[];
    activeSubtitleTrackId: string | null;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
    transientSelection?: EditorDocumentV3['transientSelection'];
}

export function isSafeEditorId(id: string): boolean {
    return SAFE_ID_PATTERN.test(id);
}

export function validateEditorDocumentV3(document: EditorDocumentV3): EditorDocumentV3ValidationResult {
    return validateGraph(toDocumentView(document), true);
}

/** Manifest validation shares graph rules but deliberately skips runtime File checks. */
export function validateEditorManifestV3(manifest: EditorManifestV3): EditorDocumentV3ValidationResult {
    return validateGraph(toManifestView(manifest), false);
}

/**
 * Deterministic non-cryptographic signature used only to reject stale async job results.
 *
 * The signature follows transcription input rather than final mix output. It includes source
 * identity, placement, crop, link, mute, solo, and ordering, while deliberately excluding gain,
 * fades, names, locks, selection, subtitles, and provenance. FNV-1a keeps the persisted guard
 * compact; this is a change detector, not a security or source-integrity digest.
 */
export function getEditorAudioGraphSignature(
    graph: Pick<V3GraphView, 'renderProfile' | 'videoSources' | 'videoClips' | 'audioSources' | 'audioTracks'>,
): string {
    const videoSourcesById = new Map(graph.videoSources.map((source) => [source.id, source]));
    const audioSourcesById = new Map(graph.audioSources.map((source) => [source.id, source]));
    let videoFrameCursor = 0;
    const payload = JSON.stringify({
        fps: graph.renderProfile.fps,
        videoClips: graph.videoClips.map((clip) => {
            const source = videoSourcesById.get(clip.sourceId);
            const timelineStartFrame = videoFrameCursor;
            videoFrameCursor += getSignatureVideoFrameCount(
                clip.sourceEnd - clip.sourceStart,
                graph.renderProfile,
            );
            return {
                timelineStartFrame,
                timelineEndFrame: videoFrameCursor,
                sourceId: clip.sourceId,
                sourceFingerprint: source?.fingerprint ?? null,
                sourceHasAudio: source?.hasAudio ?? null,
                sourceStart: clip.sourceStart,
                sourceEnd: clip.sourceEnd,
                linkState: clip.audio?.linkState ?? null,
                muted: clip.audio?.muted ?? null,
            };
        }),
        audioTracks: graph.audioTracks.map((track) => ({
            id: track.id,
            muted: track.muted,
            solo: track.solo,
            clips: track.clips.map((clip) => {
                if (isVideoSourceAudioClip(clip)) {
                    const source = videoSourcesById.get(clip.source.videoSourceId);
                    return {
                        id: clip.id,
                        sourceKind: clip.source.kind,
                        sourceId: clip.source.videoSourceId,
                        sourceFingerprint: source?.fingerprint ?? null,
                        timelineStartFrame: clip.timelineStartFrame,
                        sourceStart: clip.sourceStart,
                        sourceEnd: clip.sourceEnd,
                        muted: clip.muted,
                    };
                }
                const source = audioSourcesById.get(clip.source.audioSourceId);
                return {
                    id: clip.id,
                    sourceKind: clip.source.kind,
                    sourceId: clip.source.audioSourceId,
                    sourceFingerprint: source?.fingerprint ?? null,
                    timelineStartFrame: clip.timelineStartFrame,
                    sourceStartSample: clip.sourceStartSample,
                    sourceEndSample: clip.sourceEndSample,
                    muted: clip.muted,
                };
            }),
        })),
    });
    let hash = BigInt('14695981039346656037');
    for (let index = 0; index < payload.length; index += 1) {
        hash ^= BigInt(payload.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * BigInt('1099511628211'));
    }
    return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function validateGraph(graph: V3GraphView, validateFiles: boolean): EditorDocumentV3ValidationResult {
    const issues: EditorDocumentV3ValidationIssue[] = [];
    const addIssue: AddIssue = (code, path, message) => issues.push({ code, path, message });

    if (graph.version !== 3) addIssue('invalid-version', 'version', 'Editor graph version must be 3.');
    if (!Number.isSafeInteger(graph.revision) || graph.revision < 0) {
        addIssue('invalid-revision', 'revision', 'Revision must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(graph.audioGraphRevision) || graph.audioGraphRevision < 0) {
        addIssue('invalid-revision', 'audioGraphRevision', 'Audio graph revision must be a non-negative safe integer.');
    }
    validateRenderProfile(graph.renderProfile, addIssue);

    validateNamespaceIds(graph.videoSources, 'videoSources', addIssue);
    const videoClipIds = validateNamespaceIds(graph.videoClips, 'videoClips', addIssue);
    validateNamespaceIds(graph.audioSources, 'audioSources', addIssue);
    const audioTrackIds = validateNamespaceIds(graph.audioTracks, 'audioTracks', addIssue);
    const subtitleTrackIds = validateNamespaceIds(graph.subtitleTracks, 'subtitleTracks', addIssue);

    const subtitleIds = new Set<string>();
    const subtitleTrackIdsBySubtitleId = new Map<string, string>();
    graph.subtitleTracks.forEach((track, trackIndex) => {
        const trackPath = `subtitleTracks[${trackIndex}]`;
        if (track.timingDomain !== 'video-ripple' && track.timingDomain !== 'absolute') {
            addIssue('invalid-subtitle-interval', `${trackPath}.timingDomain`,
                'V3 subtitle tracks must use the video-ripple or absolute timing domain.');
        }
        track.subtitles.forEach((subtitle, subtitleIndex) => {
            const path = `${trackPath}.subtitles[${subtitleIndex}]`;
            validateId(subtitle.id, `${path}.id`, addIssue);
            if (subtitleIds.has(subtitle.id)) addIssue('duplicate-id', `${path}.id`, `Duplicate subtitle ID "${subtitle.id}".`);
            subtitleIds.add(subtitle.id);
            subtitleTrackIdsBySubtitleId.set(subtitle.id, track.id);
            validateSubtitleInterval(subtitle, path, addIssue);
        });
    });

    const videoSourcesById = new Map(graph.videoSources.map((source) => [source.id, source]));
    graph.videoSources.forEach((source, index) => {
        const path = `videoSources[${index}]`;
        validateVideoSource(source, path, addIssue);
        if (validateFiles && 'file' in source) validateVideoFile(source, path, addIssue);
    });
    graph.videoClips.forEach((clip, index) => {
        const path = `videoClips[${index}]`;
        const source = videoSourcesById.get(clip.sourceId);
        if (!source) {
            addIssue('missing-source', `${path}.sourceId`, `Unknown video source ID "${clip.sourceId}".`);
            return;
        }
        const duration = clip.sourceEnd - clip.sourceStart;
        if (!isNonNegativeFinite(clip.sourceStart) || !isPositiveFinite(clip.sourceEnd)
            || clip.sourceEnd > source.duration + NUMERICAL_GUARD
            || duration < 1 / source.fps - NUMERICAL_GUARD) {
            addIssue('invalid-clip-bounds', path,
                'Video source bounds must be half-open, stay within the source, and span at least one native frame.');
        }
        if (source.hasAudio !== (clip.audio !== null)) {
            addIssue('invalid-mix-controls', `${path}.audio`,
                'Video clip audio must be settings exactly when the resolved source contains audio.');
        }
        if (clip.audio) {
            validateVideoMixControls(clip.audio, `${path}.audio`, safeDurationFrames(duration, graph.renderProfile), addIssue);
        }
    });

    const audioSourcesById = new Map(graph.audioSources.map((source) => [source.id, source]));
    graph.audioSources.forEach((source, index) => {
        const path = `audioSources[${index}]`;
        validateAudioSource(source, path, addIssue);
        if (validateFiles && 'file' in source) validateAudioFile(source, path, addIssue);
    });

    const audioClipIds = new Set<string>();
    const audioClipTrackIds = new Map<string, string>();
    graph.audioTracks.forEach((track, trackIndex) => {
        const trackPath = `audioTracks[${trackIndex}]`;
        validateLaneFlags(track, trackPath, addIssue);
        validateGain(track.gainDb, `${trackPath}.gainDb`, addIssue);
        const validIntervals: Array<{ startSample: number; endSample: number; path: string }> = [];
        track.clips.forEach((clip, clipIndex) => {
            const path = `${trackPath}.clips[${clipIndex}]`;
            validateId(clip.id, `${path}.id`, addIssue);
            if (audioClipIds.has(clip.id)) addIssue('duplicate-id', `${path}.id`, `Duplicate audio clip ID "${clip.id}".`);
            audioClipIds.add(clip.id);
            audioClipTrackIds.set(clip.id, track.id);
            if (!Number.isSafeInteger(clip.timelineStartFrame) || clip.timelineStartFrame < 0) {
                addIssue('invalid-clip-bounds', `${path}.timelineStartFrame`,
                    'Audio placement must use a non-negative output-frame boundary.');
                return;
            }
            validateGain(clip.gainDb, `${path}.gainDb`, addIssue);
            if (typeof clip.muted !== 'boolean') addIssue('invalid-mix-controls', `${path}.muted`, 'Mute must be boolean.');

            const interval = isVideoSourceAudioClip(clip)
                ? validateVideoSourceAudioClip(clip, path, videoSourcesById, graph.renderProfile, addIssue)
                : validateImportedAudioClip(clip, path, audioSourcesById, graph.renderProfile, addIssue);
            if (interval) validIntervals.push({ ...interval, path });
        });
        validateAudioTrackOverlap(validIntervals, addIssue);
    });

    if (graph.activeSubtitleTrackId !== null && !subtitleTrackIds.has(graph.activeSubtitleTrackId)) {
        addIssue('missing-track', 'activeSubtitleTrackId',
            `Unknown active subtitle track ID "${graph.activeSubtitleTrackId}".`);
    }
    validateTransientSelection(graph.transientSelection, videoClipIds, audioTrackIds, audioClipIds,
        audioClipTrackIds, subtitleTrackIds, subtitleIds, subtitleTrackIdsBySubtitleId, addIssue);
    validateTranscriptionProvenance(
        graph.transcriptionByTrackId,
        subtitleTrackIds,
        graph.revision,
        graph.audioGraphRevision,
        getEditorAudioGraphSignature(graph),
        addIssue,
    );

    return { valid: issues.length === 0, issues };
}

function validateVideoSourceAudioClip(
    clip: VideoSourceAudioClip,
    path: string,
    sourcesById: Map<string, VideoSourceDescriptorV3 | VideoSourceAssetV3>,
    profile: RenderProfile,
    addIssue: AddIssue,
): { startSample: number; endSample: number } | null {
    const source = sourcesById.get(clip.source.videoSourceId);
    if (!source || !source.hasAudio) {
        addIssue('missing-source', `${path}.source.videoSourceId`,
            `Unknown video audio source ID "${clip.source.videoSourceId}".`);
        return null;
    }
    const duration = clip.sourceEnd - clip.sourceStart;
    if (!isNonNegativeFinite(clip.sourceStart) || !isPositiveFinite(clip.sourceEnd)
        || clip.sourceEnd > source.duration + NUMERICAL_GUARD
        || duration < 1 / source.fps - NUMERICAL_GUARD) {
        addIssue('invalid-clip-bounds', path,
            'Detached video audio must use a non-empty seconds crop within its video source.');
        return null;
    }
    const durationFrames = safeDurationFrames(duration, profile);
    validateFrameFades(clip.fadeInFrames, clip.fadeOutFrames, durationFrames, path, addIssue);
    return {
        startSample: frameToOutputSample(clip.timelineStartFrame, profile.fps),
        endSample: frameToOutputSample(clip.timelineStartFrame + durationFrames, profile.fps),
    };
}

function validateImportedAudioClip(
    clip: ImportedAudioClip,
    path: string,
    sourcesById: Map<string, AudioSourceDescriptor | AudioSourceAsset>,
    profile: RenderProfile,
    addIssue: AddIssue,
): { startSample: number; endSample: number } | null {
    const source = sourcesById.get(clip.source.audioSourceId);
    if (!source) {
        addIssue('missing-source', `${path}.source.audioSourceId`,
            `Unknown imported audio source ID "${clip.source.audioSourceId}".`);
        return null;
    }
    if (!Number.isSafeInteger(clip.sourceStartSample) || clip.sourceStartSample < 0
        || !Number.isSafeInteger(clip.sourceEndSample) || clip.sourceEndSample <= clip.sourceStartSample
        || clip.sourceEndSample > source.nativeSampleCount) {
        addIssue('invalid-clip-bounds', path,
            'Imported audio must use a non-empty half-open crop within native sample bounds.');
        return null;
    }
    validateSampleFades(clip.fadeInSamples, clip.fadeOutSamples,
        clip.sourceEndSample - clip.sourceStartSample, path, addIssue);
    const startSample = frameToOutputSample(clip.timelineStartFrame, profile.fps);
    const durationSamples = nativeBoundaryToOutputSample(clip.sourceEndSample, source.nativeSampleRate)
        - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate);
    return { startSample, endSample: startSample + durationSamples };
}

function validateRenderProfile(profile: RenderProfile, addIssue: AddIssue): void {
    if (!isSafeFrameRate(profile.fps)) addIssue('invalid-render-profile', 'renderProfile.fps',
        'Render FPS must use positive safe-integer numerator and denominator values.');
    if (!Number.isSafeInteger(profile.width) || !Number.isSafeInteger(profile.height)
        || profile.width <= 0 || profile.height <= 0
        || profile.width > MAX_CANVAS_DIMENSION || profile.height > MAX_CANVAS_DIMENSION
        || profile.width * profile.height > MAX_CANVAS_PIXELS) {
        addIssue('invalid-render-profile', 'renderProfile',
            `Render canvas dimensions must be positive safe integers no larger than ${MAX_CANVAS_DIMENSION}.`);
    }
    if (profile.audioSampleRate !== 48_000) addIssue('invalid-render-profile', 'renderProfile.audioSampleRate',
        'V3 output audio must use 48 kHz.');
    if (typeof profile.isFrameRateLocked !== 'boolean' || typeof profile.isCanvasSizeLocked !== 'boolean') {
        addIssue('invalid-render-profile', 'renderProfile', 'Render profile lock flags must be boolean values.');
    }
}

function validateVideoSource(source: VideoSourceDescriptorV3, path: string, addIssue: AddIssue): void {
    if (!isNonEmptyString(source.originalName) || !isNonEmptyString(source.mimeType)
        || !Number.isSafeInteger(source.size) || source.size < 0
        || !Number.isSafeInteger(source.lastModified) || source.lastModified < 0
        || !isNonEmptyString(source.fingerprint) || !isPositiveFinite(source.duration)
        || !isPositiveFinite(source.fps) || !Number.isSafeInteger(source.width) || source.width <= 0
        || !Number.isSafeInteger(source.height) || source.height <= 0
        || (source.bitrate !== null && !isNonNegativeFinite(source.bitrate))
        || typeof source.hasAudio !== 'boolean') {
        addIssue('invalid-source', path, 'Video source metadata is incomplete or outside safe numeric ranges.');
    }
}

function validateAudioSource(source: AudioSourceDescriptor, path: string, addIssue: AddIssue): void {
    if (!isNonEmptyString(source.originalName) || !isNonEmptyString(source.mimeType)
        || !Number.isSafeInteger(source.size) || source.size < 0
        || !Number.isSafeInteger(source.lastModified) || source.lastModified < 0
        || !isNonEmptyString(source.fingerprint) || !isPositiveFinite(source.duration)
        || !Number.isSafeInteger(source.nativeSampleRate) || source.nativeSampleRate <= 0
        || !Number.isSafeInteger(source.nativeSampleCount) || source.nativeSampleCount <= 0
        || !Number.isSafeInteger(source.nativeChannelCount) || source.nativeChannelCount <= 0
        || (source.bitrate !== null && !isNonNegativeFinite(source.bitrate))
        || (source.codec !== null && !isNonEmptyString(source.codec))) {
        addIssue('invalid-source', path, 'Audio source metadata is incomplete or outside safe numeric ranges.');
    }
}

function validateVideoFile(source: VideoSourceAssetV3, path: string, addIssue: AddIssue): void {
    if (source.file.name !== source.originalName || source.file.type !== source.mimeType
        || source.file.size !== source.size || source.file.lastModified !== source.lastModified) {
        addIssue('file-mismatch', `${path}.file`, 'Video File metadata does not match its descriptor.');
    }
}

function validateAudioFile(source: AudioSourceAsset, path: string, addIssue: AddIssue): void {
    if (source.file.name !== source.originalName || source.file.type !== source.mimeType
        || source.file.size !== source.size || source.file.lastModified !== source.lastModified) {
        addIssue('file-mismatch', `${path}.file`, 'Audio File metadata does not match its descriptor.');
    }
}

function validateVideoMixControls(
    controls: VideoClipAudioSettings,
    path: string,
    durationFrames: number,
    addIssue: AddIssue,
): void {
    if (controls.linkState !== 'linked' && controls.linkState !== 'detached') {
        addIssue('invalid-mix-controls', `${path}.linkState`, 'Audio link state must be linked or detached.');
    }
    if (typeof controls.muted !== 'boolean') addIssue('invalid-mix-controls', `${path}.muted`, 'Mute must be boolean.');
    validateGain(controls.gainDb, `${path}.gainDb`, addIssue);
    validateFrameFades(controls.fadeInFrames, controls.fadeOutFrames, durationFrames, path, addIssue);
}

function validateFrameFades(fadeIn: number, fadeOut: number, duration: number, path: string, addIssue: AddIssue): void {
    if (!Number.isSafeInteger(fadeIn) || fadeIn < 0 || !Number.isSafeInteger(fadeOut) || fadeOut < 0
        || fadeIn + fadeOut > duration) {
        addIssue('invalid-mix-controls', path,
            'Frame fades must be non-negative and their sum must not exceed clip duration.');
    }
}

function validateSampleFades(fadeIn: number, fadeOut: number, duration: number, path: string, addIssue: AddIssue): void {
    if (!Number.isSafeInteger(fadeIn) || fadeIn < 0 || !Number.isSafeInteger(fadeOut) || fadeOut < 0
        || fadeIn + fadeOut > duration) {
        addIssue('invalid-mix-controls', path,
            'Native-sample fades must be non-negative and their sum must not exceed the source crop.');
    }
}

function validateGain(gainDb: number, path: string, addIssue: AddIssue): void {
    if (!Number.isFinite(gainDb) || gainDb < MIN_GAIN_DB || gainDb > MAX_GAIN_DB) {
        addIssue('invalid-mix-controls', path, `Gain must be between ${MIN_GAIN_DB} dB and ${MAX_GAIN_DB} dB.`);
    }
}

function validateLaneFlags(lane: { muted: boolean; solo: boolean; locked: boolean }, path: string, addIssue: AddIssue): void {
    if (typeof lane.muted !== 'boolean' || typeof lane.solo !== 'boolean' || typeof lane.locked !== 'boolean') {
        addIssue('invalid-mix-controls', path, 'Track mute, solo, and lock controls must be boolean values.');
    }
}

function validateAudioTrackOverlap(
    intervals: Array<{ startSample: number; endSample: number; path: string }>,
    addIssue: AddIssue,
): void {
    const ordered = [...intervals].sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample);
    let occupiedEnd = ordered[0]?.endSample ?? 0;
    for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].startSample < occupiedEnd) addIssue('overlapping-clips', ordered[index].path,
            'Audio clips on the same track must not overlap; touching half-open boundaries are allowed.');
        occupiedEnd = Math.max(occupiedEnd, ordered[index].endSample);
    }
}

function validateTransientSelection(
    selection: V3GraphView['transientSelection'],
    videoClipIds: Set<string>,
    audioTrackIds: Set<string>,
    audioClipIds: Set<string>,
    audioClipTrackIds: Map<string, string>,
    subtitleTrackIds: Set<string>,
    subtitleIds: Set<string>,
    subtitleTrackIdsBySubtitleId: Map<string, string>,
    addIssue: AddIssue,
): void {
    if (!selection || selection.kind === 'none') return;
    if (selection.kind === 'video-clip') {
        if (!videoClipIds.has(selection.clipId)) addIssue('missing-clip', 'transientSelection.clipId',
            `Unknown video clip ID "${selection.clipId}".`);
        return;
    }
    if (selection.kind === 'audio-clip') {
        if (!audioTrackIds.has(selection.trackId)) addIssue('missing-track', 'transientSelection.trackId',
            `Unknown audio track ID "${selection.trackId}".`);
        if (!audioClipIds.has(selection.clipId)) addIssue('missing-clip', 'transientSelection.clipId',
            `Unknown audio clip ID "${selection.clipId}".`);
        else if (audioClipTrackIds.get(selection.clipId) !== selection.trackId) addIssue('missing-clip',
            'transientSelection.clipId', `Audio clip "${selection.clipId}" does not belong to track "${selection.trackId}".`);
        return;
    }
    if (!subtitleTrackIds.has(selection.trackId)) addIssue('missing-track', 'transientSelection.trackId',
        `Unknown subtitle track ID "${selection.trackId}".`);
    selection.subtitleIds.forEach((id, index) => {
        if (!subtitleIds.has(id)) addIssue('missing-subtitle', `transientSelection.subtitleIds[${index}]`,
            `Unknown subtitle ID "${id}".`);
        else if (subtitleTrackIdsBySubtitleId.get(id) !== selection.trackId) addIssue('missing-subtitle',
            `transientSelection.subtitleIds[${index}]`, `Subtitle "${id}" does not belong to track "${selection.trackId}".`);
    });
}

function validateTranscriptionProvenance(
    provenanceByTrackId: Record<string, TrackTranscriptionProvenanceV3>,
    subtitleTrackIds: Set<string>,
    documentRevision: number,
    audioGraphRevision: number,
    audioGraphSignature: string,
    addIssue: AddIssue,
): void {
    Object.entries(provenanceByTrackId).forEach(([trackId, state]) => {
        const path = `transcriptionByTrackId.${trackId}`;
        validateId(trackId, path, addIssue);
        if (!subtitleTrackIds.has(trackId)) addIssue('missing-track', path,
            `Transcription provenance references unknown track "${trackId}".`);
        if (!Number.isSafeInteger(state.sourceDocumentRevision) || state.sourceDocumentRevision < 0
            || state.sourceDocumentRevision > documentRevision
            || !Number.isSafeInteger(state.sourceAudioGraphRevision) || state.sourceAudioGraphRevision < 0
            || state.sourceAudioGraphRevision > audioGraphRevision
            || !isNonEmptyString(state.sourceAudioGraphSignature)
            || typeof state.stale !== 'boolean') {
            addIssue('invalid-transcription-provenance', path,
                'Transcription revision, signature, and stale fields must form a valid historical snapshot.');
        }
        if (state.stale === false && (state.sourceAudioGraphRevision !== audioGraphRevision
            || state.sourceAudioGraphSignature !== audioGraphSignature)) {
            addIssue('invalid-transcription-provenance', path,
                'Non-stale transcription provenance must match the current audio graph revision and signature.');
        }
        if (state.generatedAt !== undefined && Number.isNaN(Date.parse(state.generatedAt))) {
            addIssue('invalid-transcription-provenance', `${path}.generatedAt`,
                'Generated-at provenance must be an ISO-compatible date string.');
        }

        const rawIds = new Set<string>();
        state.raw.forEach((subtitle, index) => {
            const subtitlePath = `${path}.raw[${index}]`;
            validateId(subtitle.id, `${subtitlePath}.id`, addIssue);
            if (rawIds.has(subtitle.id)) addIssue('invalid-transcription-provenance', `${subtitlePath}.id`,
                `Duplicate raw transcription ID "${subtitle.id}".`);
            rawIds.add(subtitle.id);
            validateSubtitleInterval(subtitle, subtitlePath, addIssue);
        });
        const containerIds = new Set(state.containerIds);
        if (containerIds.size !== state.containerIds.length) addIssue('invalid-transcription-provenance',
            `${path}.containerIds`, 'Transcription container IDs must be unique.');
        state.containerIds.forEach((containerId, index) => {
            validateId(containerId, `${path}.containerIds[${index}]`, addIssue);
            if (!(containerId in state.groups)) addIssue('invalid-transcription-provenance',
                `${path}.containerIds[${index}]`, `Transcription container "${containerId}" has no group.`);
        });
        Object.entries(state.groups).forEach(([containerId, group]) => {
            validateId(containerId, `${path}.groups.${containerId}`, addIssue);
            if (!containerIds.has(containerId)) addIssue('invalid-transcription-provenance',
                `${path}.groups.${containerId}`, `Transcription group "${containerId}" is not listed as a container.`);
            const groupIds = new Set<string>();
            group.forEach((subtitle, index) => {
                const subtitlePath = `${path}.groups.${containerId}[${index}]`;
                validateId(subtitle.id, `${subtitlePath}.id`, addIssue);
                if (groupIds.has(subtitle.id)) addIssue('invalid-transcription-provenance', `${subtitlePath}.id`,
                    `Duplicate grouped transcription ID "${subtitle.id}".`);
                groupIds.add(subtitle.id);
                if (!rawIds.has(subtitle.id)) addIssue('invalid-transcription-provenance', subtitlePath,
                    `Grouped subtitle "${subtitle.id}" is not present in raw transcription.`);
                validateSubtitleInterval(subtitle, subtitlePath, addIssue);
            });
        });
    });
}

function validateSubtitleInterval(subtitle: Subtitle, path: string, addIssue: AddIssue): void {
    if (!isNonNegativeFinite(subtitle.startTime) || !isPositiveFinite(subtitle.endTime)
        || subtitle.endTime <= subtitle.startTime) {
        addIssue('invalid-subtitle-interval', path,
            'Subtitle intervals must be finite, non-negative, and half-open with end after start.');
    }
}

function validateNamespaceIds<T extends { id: string }>(values: readonly T[], path: string, addIssue: AddIssue): Set<string> {
    const ids = new Set<string>();
    values.forEach((value, index) => {
        validateId(value.id, `${path}[${index}].id`, addIssue);
        if (ids.has(value.id)) addIssue('duplicate-id', `${path}[${index}].id`, `Duplicate ID "${value.id}" in ${path}.`);
        ids.add(value.id);
    });
    return ids;
}

function validateId(id: string, path: string, addIssue: AddIssue): void {
    if (!isSafeEditorId(id)) addIssue('invalid-id', path,
        'ID must contain 1-64 ASCII letters, numbers, underscores, or hyphens.');
}

function safeDurationFrames(durationSeconds: number, profile: RenderProfile): number {
    if (!isNonNegativeFinite(durationSeconds) || !isSafeFrameRate(profile.fps)) return 0;
    try {
        return Math.max(1, secondsToFrames(durationSeconds, profile.fps, 'nearest'));
    } catch {
        return 0;
    }
}

function getSignatureVideoFrameCount(durationSeconds: number, profile: RenderProfile): number {
    if (!isNonNegativeFinite(durationSeconds) || !isSafeFrameRate(profile.fps)) return 0;
    try {
        return Math.max(1, secondsToFrames(durationSeconds, profile.fps, 'nearest'));
    } catch {
        return 0;
    }
}

function toDocumentView(document: EditorDocumentV3): V3GraphView {
    return { ...document, videoSources: document.videoSources, audioSources: document.audioSources };
}

function toManifestView(manifest: EditorManifestV3): V3GraphView {
    return { ...manifest, videoSources: manifest.videoSourceDescriptors, audioSources: manifest.audioSourceDescriptors };
}

function isVideoSourceAudioClip(clip: AudioClip): clip is VideoSourceAudioClip {
    return clip.source.kind === 'video-source-audio';
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
}
