import {
    EDITORIAL_CANONICAL_JSON_VERSION,
    EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ,
    EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
    EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
    EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
    EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
    EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
    isSha256Digest,
    type EditorialDependentLinkV1,
    type EditorialTranscriptDescriptorV1,
    type NarrativeBlockV1,
    type NarrativeDocumentV1,
    type ResolvedEditorialTranscriptMapV1,
    type ResolvedEditorialTranscriptRecordBodyV1,
    type Sha256Digest,
} from '@/types/editorial';
import type { SubtitleTrackV4 } from '@/types/timeline';
import type {
    AudioClip,
    AudioSourceAsset,
    AudioSourceDescriptor,
    AudioTrack,
    EditorDocumentV3,
    EditorDocumentV3ValidationCode,
    EditorDocumentV4,
    EditorManifestV3,
    RenderProfile,
    TrackTranscriptionProvenanceV3,
    TransientMediaSelectionV4,
    VideoClipV3,
    VideoClipV4,
    VideoSourceAssetV3,
    VideoSourceAudioClip,
    VideoSourceDescriptorV3,
    VideoTrackV4,
} from '@/types/video';
import {
    frameToOutputSample,
    nativeBoundaryToOutputSample,
} from './audio-timebase';
import {
    isSafeEditorId,
    validateEditorDocumentV3,
    validateEditorManifestV3,
} from './editor-document-v3';
import { isRenderBackgroundColor, secondsToFrames } from './render-profile';
import {
    buildVideoTrackPlacementsV4,
    getVideoClipDurationFramesV4,
    type VideoClipPlacementV4,
} from './video-placement-v4';

const NUMERICAL_GUARD = 1e-9;

export type EditorDocumentV4ValidationCode = EditorDocumentV3ValidationCode
    | 'invalid-graph-shape'
    | 'invalid-render-background'
    | 'invalid-global-mode'
    | 'invalid-subtitle-policy'
    | 'invalid-descriptor'
    | 'duplicate-descriptor'
    | 'conflicting-descriptor'
    | 'missing-transcript-record'
    | 'invalid-narrative'
    | 'invalid-materialization'
    | 'invalid-dependent-link'
    | 'invalid-transcript-body'
    | 'transcript-body-mismatch'
    | 'invalid-transcript-reference';

export interface EditorDocumentV4ValidationIssue {
    code: EditorDocumentV4ValidationCode;
    path: string;
    /** User-safe summary. It deliberately excludes transcript text, media names, and endpoints. */
    message: string;
}

export interface EditorDocumentV4ValidationResult {
    valid: boolean;
    issues: EditorDocumentV4ValidationIssue[];
}

type AddIssue = (code: EditorDocumentV4ValidationCode, path: string, message: string) => void;
type V4VideoSource = VideoSourceDescriptorV3 | VideoSourceAssetV3;
type V4AudioSource = AudioSourceDescriptor | AudioSourceAsset;

interface V4GraphView {
    version: number;
    revision: number;
    audioGraphRevision: number;
    renderProfile: RenderProfile;
    renderBackgroundColor: string;
    subtitleTracks: SubtitleTrackV4[];
    videoSources: V4VideoSource[];
    videoClips: VideoClipV4[];
    videoTracks: VideoTrackV4[];
    audioSources: V4AudioSource[];
    audioTracks: AudioTrack[];
    activeSubtitleTrackId: string | null;
    transcriptionByTrackId: Record<string, TrackTranscriptionProvenanceV3>;
    globalEditingMode: unknown;
    editorialTranscriptDescriptors: EditorialTranscriptDescriptorV1[];
    narrative: NarrativeDocumentV1 | null;
    dependentLinks: EditorialDependentLinkV1[];
    transientSelection?: TransientMediaSelectionV4;
    rawRoot: Record<string, unknown>;
}

interface StructuralContext {
    descriptorCatalog: DescriptorCatalog;
    videoSourceById: Map<string, V4VideoSource>;
    videoClipById: Map<string, VideoClipV4>;
    placementByClipId: Map<string, VideoClipPlacementV4>;
    blockById: Map<string, NarrativeBlockV1>;
    ownedClipIds: Set<string>;
    subtitleByTargetKey: Map<string, { startTime: number; endTime: number }>;
    audioClipByTargetKey: Map<string, AudioClip>;
}

interface DescriptorCatalog {
    /** One immutable CAS body may be intentionally mapped to multiple equivalent source assets. */
    byRecordId: Map<Sha256Digest, EditorialTranscriptDescriptorV1[]>;
    /** Narrative ownership resolves a descriptor by both body identity and exact source identity. */
    byRecordAndSourceId: Map<Sha256Digest, Map<string, EditorialTranscriptDescriptorV1>>;
}

interface BodyIndexes {
    wordIndexById: Map<string, number>;
    regionById: Map<string, ResolvedEditorialTranscriptRecordBodyV1['speechRegions'][number]>;
    boundaryIds: Set<string>;
    speakerIds: Set<string>;
}

const DESCRIPTOR_KEYS = new Set([
    'version',
    'recordId',
    'requestKey',
    'sourceKind',
    'sourceId',
    'sourceFingerprint',
    'pcmAlgorithmVersion',
    'recordBodyVersion',
    'canonicalJsonVersion',
    'responseSchema',
    'requestedModel',
    'canonicalModel',
    'sampleRateHz',
    'sampleCount',
    'language',
    'speakerMode',
    'endpointIdentityDigest',
    'acquisition',
    'createdAt',
]);
const NARRATIVE_DOCUMENT_KEYS = new Set([
    'version',
    'id',
    'revision',
    'controlledTrackIds',
    'blockIds',
    'blocks',
    'sourceRecordIds',
    'settings',
    'createdAt',
    'updatedAt',
]);
const NARRATIVE_BLOCK_KEYS = new Set([
    'id',
    'instanceId',
    'lineageRootId',
    'parentInstanceIds',
    'kind',
    'clipId',
    'trackId',
    'sourceId',
    'transcriptRecordId',
    'sourceIntervalId',
    'coreStartSample',
    'coreEndSample',
    'materialization',
    'timelineStartFrame',
    'sourceWordIds',
    'wordTextOverrides',
    'speakerOverrides',
    'evidence',
    'startBoundaryRefinement',
    'endBoundaryRefinement',
    'revision',
]);
const DOCUMENT_ROOT_KEYS = new Set([
    'version',
    'revision',
    'audioGraphRevision',
    'renderProfile',
    'renderBackgroundColor',
    'subtitleTracks',
    'videoSources',
    'videoClips',
    'videoTracks',
    'audioSources',
    'audioTracks',
    'activeSubtitleTrackId',
    'transientSelection',
    'transcriptionByTrackId',
    'globalEditingMode',
    'editorialTranscriptDescriptors',
    'narrative',
    'dependentLinks',
]);
const MANIFEST_ROOT_KEYS = new Set([
    'version',
    'revision',
    'audioGraphRevision',
    'renderProfile',
    'renderBackgroundColor',
    'subtitleTracks',
    'videoSourceDescriptors',
    'videoClips',
    'videoTracks',
    'audioSourceDescriptors',
    'audioTracks',
    'activeSubtitleTrackId',
    'transcriptionByTrackId',
    'globalEditingMode',
    'editorialTranscriptDescriptors',
    'narrative',
    'dependentLinks',
]);

/** Validates the runtime graph, including File/descriptor identity, without resolving CAS bodies. */
export function validateEditorDocumentV4(value: unknown): EditorDocumentV4ValidationResult {
    return validateV4Value(value, true);
}

/** Validates the persisted descriptor-only graph and deliberately performs no File checks. */
export function validateEditorManifestV4(value: unknown): EditorDocumentV4ValidationResult {
    return validateV4Value(value, false);
}

/**
 * Deep-validates all transcript-backed references after the CAS resolver has verified body bytes.
 *
 * `ResolvedEditorialTranscriptMapV1` is intentionally a post-integrity type: its contract says the
 * resolver already recomputed each canonical record hash before exposing a body. This synchronous,
 * pure graph validator therefore checks body schema, descriptor identity, and every stable
 * reference without duplicating the canonical JSON/SHA implementation owned by the CAS package.
 */
export function validateHydratedEditorDocumentV4(
    value: unknown,
    resolvedBodies: ResolvedEditorialTranscriptMapV1,
): EditorDocumentV4ValidationResult {
    const structural = validateEditorDocumentV4(value);
    if (!structural.valid) return structural;
    const document = value as EditorDocumentV4;
    const issues = [...structural.issues];
    const addIssue: AddIssue = (code, path, message) => issues.push({ code, path, message });
    validateHydratedGraph(toDocumentView(document), resolvedBodies, addIssue);
    return { valid: issues.length === 0, issues };
}

/**
 * V4 counterpart of the V3 stale-transcription guard signature.
 *
 * The serialized payload deliberately keeps the V3 field order and semantics. Migrated gapless
 * clips therefore retain the exact prior signature, while a later explicit V4 move or gap changes
 * it because `timelineStartFrame` is now read directly from the clip.
 */
export function getEditorAudioGraphSignatureV4(
    graph: Pick<V4GraphView, 'renderProfile' | 'videoSources' | 'videoClips' | 'audioSources' | 'audioTracks'>,
): string {
    const videoSourcesById = new Map(graph.videoSources.map((source) => [source.id, source]));
    const audioSourcesById = new Map(graph.audioSources.map((source) => [source.id, source]));
    const payload = JSON.stringify({
        fps: graph.renderProfile.fps,
        videoClips: graph.videoClips.map((clip) => {
            const source = videoSourcesById.get(clip.sourceId);
            const durationFrames = safeVideoDurationFrames(clip, graph.renderProfile);
            return {
                timelineStartFrame: clip.timelineStartFrame,
                timelineEndFrame: clip.timelineStartFrame + durationFrames,
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
                    timelineDurationSamples: clip.timelineDurationSamples ?? null,
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

function validateV4Value(value: unknown, validateFiles: boolean): EditorDocumentV4ValidationResult {
    const issues: EditorDocumentV4ValidationIssue[] = [];
    const addIssue: AddIssue = (code, path, message) => issues.push({ code, path, message });
    const graph = readGraph(value, validateFiles, addIssue);
    if (!graph) return { valid: false, issues };

    if (graph.version !== 4) {
        addIssue('invalid-version', 'version', 'Editor graph version must be 4.');
    }
    if (graph.rawRoot.editorialTranscriptRecordBodies !== undefined) {
        addIssue('invalid-descriptor', 'editorialTranscriptRecordBodies',
            'Transcript record bodies are forbidden in V4 documents and manifests.');
    }
    if (!isRenderBackgroundColor(graph.renderBackgroundColor)) {
        addIssue(
            'invalid-render-background',
            'renderBackgroundColor',
            'Render background color must use the #RRGGBB CSS hex format.',
        );
    }
    validateV3CompatibleGraph(graph, validateFiles, addIssue);
    validateTransientSelectionShape(graph.transientSelection, addIssue);
    validateExplicitVideoGraph(graph, addIssue);
    validateSubtitlePolicies(graph, addIssue);
    if (graph.globalEditingMode !== 'ripple' && graph.globalEditingMode !== 'absolute') {
        addIssue('invalid-global-mode', 'globalEditingMode',
            'Global editing mode must be ripple or absolute.');
    }
    const descriptorCatalog = validateDescriptors(graph, addIssue);
    const narrativeContext = validateNarrative(graph, descriptorCatalog, addIssue);
    validateDependentLinks(graph, narrativeContext, addIssue);
    validateTransientNarrativeSelection(graph, narrativeContext, addIssue);
    validateV4TranscriptionSignature(graph, addIssue);
    return { valid: issues.length === 0, issues };
}

function readGraph(value: unknown, validateFiles: boolean, addIssue: AddIssue): V4GraphView | null {
    if (!isRecord(value)) {
        addIssue('invalid-graph-shape', '$', 'Editor graph must be an object.');
        return null;
    }
    const allowedRootKeys = validateFiles ? DOCUMENT_ROOT_KEYS : MANIFEST_ROOT_KEYS;
    Object.keys(value).forEach((key) => {
        if (!allowedRootKeys.has(key) && key !== 'editorialTranscriptRecordBodies') {
            addIssue('invalid-graph-shape', key, 'V4 editor graph contains an unsupported root field.');
        }
    });
    const sourceKey = validateFiles ? 'videoSources' : 'videoSourceDescriptors';
    const audioSourceKey = validateFiles ? 'audioSources' : 'audioSourceDescriptors';
    const arrayKeys = [
        'subtitleTracks', sourceKey, 'videoClips', 'videoTracks', audioSourceKey,
        'audioTracks', 'editorialTranscriptDescriptors', 'dependentLinks',
    ];
    let shapeValid = true;
    arrayKeys.forEach((key) => {
        if (!Array.isArray(value[key])) {
            shapeValid = false;
            addIssue('invalid-graph-shape', key, 'Expected an array.');
        }
    });
    if (!isRecord(value.renderProfile)) {
        shapeValid = false;
        addIssue('invalid-graph-shape', 'renderProfile', 'Render profile must be an object.');
    }
    if (!isRecord(value.transcriptionByTrackId)) {
        shapeValid = false;
        addIssue('invalid-graph-shape', 'transcriptionByTrackId', 'Transcription provenance must be an object map.');
    }
    if (value.narrative !== null && !isRecord(value.narrative)) {
        shapeValid = false;
        addIssue('invalid-graph-shape', 'narrative', 'Narrative must be an object or null.');
    }
    if (validateFiles && !isRecord(value.transientSelection)) {
        shapeValid = false;
        addIssue('invalid-graph-shape', 'transientSelection', 'Runtime selection must be an object.');
    }
    if (!shapeValid) return null;

    const subtitleTracks = value.subtitleTracks as unknown[];
    const videoSources = value[sourceKey] as unknown[];
    const videoClips = value.videoClips as unknown[];
    const videoTracks = value.videoTracks as unknown[];
    const audioSources = value[audioSourceKey] as unknown[];
    const audioTracks = value.audioTracks as unknown[];
    const descriptors = value.editorialTranscriptDescriptors as unknown[];
    const links = value.dependentLinks as unknown[];
    const objectArrays: Array<[string, unknown[]]> = [
        ['subtitleTracks', subtitleTracks],
        [sourceKey, videoSources],
        ['videoClips', videoClips],
        ['videoTracks', videoTracks],
        [audioSourceKey, audioSources],
        ['audioTracks', audioTracks],
        ['editorialTranscriptDescriptors', descriptors],
        ['dependentLinks', links],
    ];
    objectArrays.forEach(([path, values]) => values.forEach((item, index) => {
        if (!isRecord(item)) {
            shapeValid = false;
            addIssue('invalid-graph-shape', `${path}[${index}]`, 'Expected an object.');
        }
    }));
    subtitleTracks.forEach((track, index) => {
        if (isRecord(track) && !Array.isArray(track.subtitles)) {
            shapeValid = false;
            addIssue('invalid-graph-shape', `subtitleTracks[${index}].subtitles`, 'Expected an array.');
        } else if (isRecord(track)) {
            (track.subtitles as unknown[]).forEach((subtitle, subtitleIndex) => {
                if (!isRecord(subtitle)) {
                    shapeValid = false;
                    addIssue('invalid-graph-shape', `subtitleTracks[${index}].subtitles[${subtitleIndex}]`,
                        'Subtitle entries must be objects.');
                }
            });
        }
    });
    audioTracks.forEach((track, index) => {
        if (isRecord(track) && !Array.isArray(track.clips)) {
            shapeValid = false;
            addIssue('invalid-graph-shape', `audioTracks[${index}].clips`, 'Expected an array.');
        } else if (isRecord(track)) {
            (track.clips as unknown[]).forEach((clip, clipIndex) => {
                if (!isRecord(clip) || !isRecord(clip.source)) {
                    shapeValid = false;
                    addIssue('invalid-graph-shape', `audioTracks[${index}].clips[${clipIndex}]`,
                        'Audio clips and their source references must be objects.');
                }
            });
        }
    });
    Object.entries(value.transcriptionByTrackId as Record<string, unknown>).forEach(([key, state]) => {
        if (!isRecord(state) || !Array.isArray(state.raw) || !Array.isArray(state.containerIds) || !isRecord(state.groups)) {
            shapeValid = false;
            addIssue('invalid-graph-shape', `transcriptionByTrackId.${key}`,
                'Transcription provenance arrays and group map are required.');
            return;
        }
        state.raw.forEach((subtitle, index) => {
            if (!isRecord(subtitle)) {
                shapeValid = false;
                addIssue('invalid-graph-shape', `transcriptionByTrackId.${key}.raw[${index}]`,
                    'Raw transcription entries must be objects.');
            }
        });
        Object.entries(state.groups).forEach(([groupId, group]) => {
            if (!Array.isArray(group)) {
                shapeValid = false;
                addIssue('invalid-graph-shape', `transcriptionByTrackId.${key}.groups.${groupId}`,
                    'Transcription groups must be arrays.');
                return;
            }
            group.forEach((subtitle, index) => {
                if (!isRecord(subtitle)) {
                    shapeValid = false;
                    addIssue('invalid-graph-shape', `transcriptionByTrackId.${key}.groups.${groupId}[${index}]`,
                        'Grouped transcription entries must be objects.');
                }
            });
        });
    });
    if (validateFiles) {
        [...videoSources, ...audioSources].forEach((source, index) => {
            if (!isRecord(source) || !isRecord(source.file)) {
                shapeValid = false;
                addIssue('file-mismatch', index < videoSources.length
                    ? `videoSources[${index}].file`
                    : `audioSources[${index - videoSources.length}].file`,
                'A runtime source must include its matching File object.');
            }
        });
    } else {
        [...videoSources, ...audioSources].forEach((source, index) => {
            if (isRecord(source) && Object.prototype.hasOwnProperty.call(source, 'file')) {
                addIssue('file-mismatch', index < videoSources.length
                    ? `videoSourceDescriptors[${index}].file`
                    : `audioSourceDescriptors[${index - videoSources.length}].file`,
                'Persisted source descriptors must not contain runtime File objects.');
            }
        });
    }
    if (!shapeValid) return null;

    return {
        version: value.version as number,
        revision: value.revision as number,
        audioGraphRevision: value.audioGraphRevision as number,
        renderProfile: value.renderProfile as unknown as RenderProfile,
        renderBackgroundColor: value.renderBackgroundColor as string,
        subtitleTracks: subtitleTracks as SubtitleTrackV4[],
        videoSources: videoSources as V4VideoSource[],
        videoClips: videoClips as VideoClipV4[],
        videoTracks: videoTracks as VideoTrackV4[],
        audioSources: audioSources as V4AudioSource[],
        audioTracks: audioTracks as AudioTrack[],
        activeSubtitleTrackId: value.activeSubtitleTrackId as string | null,
        transcriptionByTrackId: value.transcriptionByTrackId as Record<string, TrackTranscriptionProvenanceV3>,
        globalEditingMode: value.globalEditingMode,
        editorialTranscriptDescriptors: descriptors as EditorialTranscriptDescriptorV1[],
        narrative: value.narrative as unknown as NarrativeDocumentV1 | null,
        dependentLinks: links as EditorialDependentLinkV1[],
        transientSelection: validateFiles
            ? value.transientSelection as TransientMediaSelectionV4
            : undefined,
        rawRoot: value,
    };
}

function validateV3CompatibleGraph(graph: V4GraphView, validateFiles: boolean, addIssue: AddIssue): void {
    try {
        const projection = toV3Projection(graph, validateFiles);
        const validation = validateFiles
            ? validateEditorDocumentV3(projection as EditorDocumentV3)
            : validateEditorManifestV3(projection as EditorManifestV3);
        validation.issues.forEach((issue) => addIssue(issue.code, issue.path, issue.message));
    } catch {
        // V1-V3 validators predate an unknown-input API and may dereference a malformed nested
        // shape. V4 is an import boundary, so malformed values become a typed issue instead of
        // escaping as a runtime exception.
        addIssue('invalid-graph-shape', '$', 'Editor graph contains malformed legacy-compatible fields.');
    }
}

function toV3Projection(graph: V4GraphView, document: boolean): EditorDocumentV3 | EditorManifestV3 {
    const subtitleTracks = graph.subtitleTracks.map((track) => {
        const { unlinkedVideoEditResponse, ...legacyTrack } = track;
        return {
            ...legacyTrack,
            timingDomain: unlinkedVideoEditResponse === 'follow-project-ripple'
                ? 'video-ripple' as const
                : 'absolute' as const,
        };
    });
    const videoClips: VideoClipV3[] = graph.videoClips.map((clip) => ({
        id: clip.id,
        sourceId: clip.sourceId,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        audio: clip.audio,
    }));
    const videoTracks = graph.videoTracks.map((track) => ({
        id: track.id,
        name: track.name,
        clipIds: graph.videoClips.filter((clip) => clip.trackId === track.id).map((clip) => clip.id),
    }));
    // V3 validates every provenance field except the current signature against this compatibility
    // projection. The explicit V4 signature is checked separately below, so forcing this temporary
    // view stale avoids comparing valid V4 gaps/overlaps against a cumulative V3 cursor.
    const transcriptionByTrackId = Object.fromEntries(Object.entries(graph.transcriptionByTrackId)
        .map(([trackId, state]) => [trackId, { ...state, stale: true }]));
    const common = {
        version: 3 as const,
        revision: graph.revision,
        audioGraphRevision: graph.audioGraphRevision,
        renderProfile: graph.renderProfile,
        subtitleTracks,
        videoClips,
        videoTracks,
        audioTracks: graph.audioTracks,
        activeSubtitleTrackId: graph.activeSubtitleTrackId,
        transcriptionByTrackId,
    };
    if (document) {
        return {
            ...common,
            videoSources: graph.videoSources as VideoSourceAssetV3[],
            audioSources: graph.audioSources as AudioSourceAsset[],
            transientSelection: toV3CompatibleSelection(graph.transientSelection),
        };
    }
    return {
        ...common,
        videoSourceDescriptors: graph.videoSources as VideoSourceDescriptorV3[],
        audioSourceDescriptors: graph.audioSources as AudioSourceDescriptor[],
    };
}

function validateExplicitVideoGraph(graph: V4GraphView, addIssue: AddIssue): void {
    const trackIds = new Set<string>();
    graph.videoTracks.forEach((track, index) => {
        const path = `videoTracks[${index}]`;
        trackIds.add(track.id);
        if (typeof track.visible !== 'boolean') {
            addIssue('missing-track', `${path}.visible`, 'Video-track visibility must be boolean.');
        }
        if (typeof track.locked !== 'boolean') {
            addIssue('missing-track', `${path}.locked`, 'Video-track lock state must be boolean.');
        }
    });

    const intervalsByTrack = new Map<string, Array<{ start: number; end: number; path: string }>>();
    graph.videoClips.forEach((clip, index) => {
        const path = `videoClips[${index}]`;
        if (!isSafeEditorId(clip.trackId) || !trackIds.has(clip.trackId)) {
            addIssue('missing-track', `${path}.trackId`, 'Video clip must reference one existing V4 track.');
        }
        if (!Number.isSafeInteger(clip.timelineStartFrame) || clip.timelineStartFrame < 0) {
            addIssue('invalid-clip-bounds', `${path}.timelineStartFrame`,
                'Video placement must use a non-negative safe frame.');
            return;
        }
        try {
            const durationFrames = getVideoClipDurationFramesV4(clip, graph.renderProfile);
            const end = clip.timelineStartFrame + durationFrames;
            if (!Number.isSafeInteger(end)) {
                addIssue('invalid-clip-bounds', path, 'Video placement end exceeds the safe frame range.');
                return;
            }
            const intervals = intervalsByTrack.get(clip.trackId) ?? [];
            intervals.push({ start: clip.timelineStartFrame, end, path });
            intervalsByTrack.set(clip.trackId, intervals);
        } catch {
            addIssue('invalid-clip-bounds', path, 'Video clip must span at least one output frame.');
        }
    });
    intervalsByTrack.forEach((intervals) => {
        intervals.sort((left, right) => left.start - right.start || left.end - right.end);
        let occupiedEnd = intervals[0]?.end ?? 0;
        for (let index = 1; index < intervals.length; index += 1) {
            if (intervals[index].start < occupiedEnd) {
                addIssue('overlapping-clips', intervals[index].path,
                    'Video clips on the same track must not overlap.');
            }
            occupiedEnd = Math.max(occupiedEnd, intervals[index].end);
        }
    });
}

function validateSubtitlePolicies(graph: V4GraphView, addIssue: AddIssue): void {
    graph.subtitleTracks.forEach((track, index) => {
        const path = `subtitleTracks[${index}]`;
        if (Object.prototype.hasOwnProperty.call(track, 'timingDomain')) {
            addIssue('invalid-subtitle-policy', `${path}.timingDomain`,
                'V4 subtitle tracks must not retain the hidden V3 timing domain.');
        }
        if (track.unlinkedVideoEditResponse !== 'follow-project-ripple'
            && track.unlinkedVideoEditResponse !== 'stay-absolute'
            && track.unlinkedVideoEditResponse !== 'remove-with-deleted-video-range') {
            addIssue('invalid-subtitle-policy', `${path}.unlinkedVideoEditResponse`,
                'Unlinked video-edit response must be follow-project-ripple, stay-absolute, '
                + 'or remove-with-deleted-video-range.');
        }
        if (typeof track.isVisible !== 'boolean' || typeof track.isLocked !== 'boolean') {
            addIssue('invalid-subtitle-policy', path,
                'Subtitle visibility and lock state must be boolean values.');
        }
    });
}

function validateTransientSelectionShape(
    selection: V4GraphView['transientSelection'],
    addIssue: AddIssue,
): void {
    if (selection === undefined) return;
    if (!isRecord(selection)) {
        addIssue('invalid-graph-shape', 'transientSelection', 'Runtime selection must be an object.');
        return;
    }
    const candidate = selection as unknown as Record<string, unknown>;
    if (candidate.kind === 'none') return;
    if (candidate.kind === 'video-clip') {
        if (typeof candidate.clipId !== 'string' || !isSafeEditorId(candidate.clipId)) {
            addIssue('invalid-id', 'transientSelection.clipId', 'Selected video clip ID must be safe.');
        }
        return;
    }
    if (candidate.kind === 'audio-clip') {
        if (typeof candidate.trackId !== 'string' || !isSafeEditorId(candidate.trackId)
            || typeof candidate.clipId !== 'string' || !isSafeEditorId(candidate.clipId)) {
            addIssue('invalid-id', 'transientSelection', 'Selected audio track and clip IDs must be safe.');
        }
        return;
    }
    if (candidate.kind === 'subtitles') {
        if (typeof candidate.trackId !== 'string' || !isSafeEditorId(candidate.trackId)
            || !Array.isArray(candidate.subtitleIds)) {
            addIssue('invalid-graph-shape', 'transientSelection',
                'Subtitle selection requires a safe track ID and subtitle ID array.');
            return;
        }
        validateUniqueSafeIds(candidate.subtitleIds, 'transientSelection.subtitleIds', addIssue);
        return;
    }
    if (candidate.kind === 'narrative') {
        if (typeof candidate.trackId !== 'string' || !isSafeEditorId(candidate.trackId)
            || typeof candidate.blockId !== 'string' || !isSafeEditorId(candidate.blockId)
            || !Array.isArray(candidate.sourceWordIds)) {
            addIssue('invalid-graph-shape', 'transientSelection',
                'Narrative selection requires safe track/block IDs and a source-word ID array.');
            return;
        }
        validateUniqueStableReferenceIds(candidate.sourceWordIds, 'transientSelection.sourceWordIds', addIssue);
        return;
    }
    addIssue('invalid-graph-shape', 'transientSelection.kind', 'Runtime selection kind is unsupported.');
}

function toV3CompatibleSelection(
    selection: V4GraphView['transientSelection'],
): EditorDocumentV3['transientSelection'] {
    if (!selection || !isRecord(selection)) {
        return { kind: 'none' };
    }
    const candidate = selection as unknown as Record<string, unknown>;
    if (candidate.kind === 'none' || candidate.kind === 'narrative') return { kind: 'none' };
    if (candidate.kind === 'video-clip' && typeof candidate.clipId === 'string') {
        return { kind: 'video-clip', clipId: candidate.clipId };
    }
    if (candidate.kind === 'audio-clip'
        && typeof candidate.trackId === 'string' && typeof candidate.clipId === 'string') {
        return { kind: 'audio-clip', trackId: candidate.trackId, clipId: candidate.clipId };
    }
    if (candidate.kind === 'subtitles'
        && typeof candidate.trackId === 'string' && Array.isArray(candidate.subtitleIds)) {
        return {
            kind: 'subtitles',
            trackId: candidate.trackId,
            subtitleIds: candidate.subtitleIds.filter((id): id is string => typeof id === 'string'),
        };
    }
    return { kind: 'none' };
}

function validateDescriptors(
    graph: V4GraphView,
    addIssue: AddIssue,
): DescriptorCatalog {
    const catalog: DescriptorCatalog = {
        byRecordId: new Map(),
        byRecordAndSourceId: new Map(),
    };
    const firstDescriptorByRequestKey = new Map<Sha256Digest, EditorialTranscriptDescriptorV1>();
    const sources = new Map(graph.videoSources.map((source) => [source.id, source]));
    graph.editorialTranscriptDescriptors.forEach((descriptor, index) => {
        const path = `editorialTranscriptDescriptors[${index}]`;
        Object.keys(descriptor).forEach((key) => {
            if (!DESCRIPTOR_KEYS.has(key)) {
                addIssue('invalid-descriptor', `${path}.${key}`,
                    'Editorial transcript descriptors may contain provenance fields only.');
            }
        });
        if (descriptor.version !== 1
            || !isSha256Digest(descriptor.recordId)
            || !isSha256Digest(descriptor.requestKey)
            || !isSha256Digest(descriptor.endpointIdentityDigest)
            || descriptor.sourceKind !== 'video-source-audio'
            || descriptor.pcmAlgorithmVersion !== EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION
            || descriptor.recordBodyVersion !== EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION
            || descriptor.canonicalJsonVersion !== EDITORIAL_CANONICAL_JSON_VERSION
            || descriptor.responseSchema !== EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA
            || descriptor.requestedModel !== EDITORIAL_TRANSCRIPT_REQUESTED_MODEL
            || descriptor.sampleRateHz !== EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ
            || !Number.isSafeInteger(descriptor.sampleCount)
            || descriptor.sampleCount <= 0
            || !isNonEmptyTrimmedString(descriptor.canonicalModel)
            || (descriptor.language !== null && !isNonEmptyTrimmedString(descriptor.language))
            || (descriptor.speakerMode !== 'none' && descriptor.speakerMode !== 'diarized')
            || (descriptor.acquisition !== 'provider' && descriptor.acquisition !== 'local-no-audio')
            || !isIsoDate(descriptor.createdAt)) {
            addIssue('invalid-descriptor', path,
                'Editorial descriptor versions, hashes, model profile, timing, and provenance must use the frozen V1 contract.');
        }
        const source = sources.get(descriptor.sourceId);
        if (!source) {
            addIssue('missing-source', `${path}.sourceId`, 'Editorial descriptor references an unknown video source.');
        } else {
            if (source.fingerprint !== descriptor.sourceFingerprint) {
                addIssue('invalid-descriptor', `${path}.sourceFingerprint`,
                    'Editorial descriptor fingerprint does not match its source.');
            }
            const expectedAcquisition = source.hasAudio ? 'provider' : 'local-no-audio';
            if (descriptor.acquisition !== expectedAcquisition) {
                addIssue('invalid-descriptor', `${path}.acquisition`,
                    'Editorial descriptor acquisition does not match source audio capability.');
            }
        }
        if (isSha256Digest(descriptor.recordId)) {
            const recordDescriptors = catalog.byRecordId.get(descriptor.recordId) ?? [];
            const firstRecordDescriptor = recordDescriptors[0];
            if (firstRecordDescriptor && !descriptorsShareImmutableBody(firstRecordDescriptor, descriptor)) {
                addIssue('conflicting-descriptor', `${path}.recordId`,
                    'Descriptors sharing one record ID must describe exactly the same immutable body.');
            }
            recordDescriptors.push(descriptor);
            catalog.byRecordId.set(descriptor.recordId, recordDescriptors);

            if (typeof descriptor.sourceId === 'string') {
                const descriptorsBySourceId = catalog.byRecordAndSourceId.get(descriptor.recordId) ?? new Map();
                if (descriptorsBySourceId.has(descriptor.sourceId)) {
                    addIssue('duplicate-descriptor', `${path}.sourceId`,
                        'A source may map to a given immutable transcript record only once.');
                } else {
                    descriptorsBySourceId.set(descriptor.sourceId, descriptor);
                }
                catalog.byRecordAndSourceId.set(descriptor.recordId, descriptorsBySourceId);
            }
        }
        if (isSha256Digest(descriptor.requestKey)) {
            const firstRequestDescriptor = firstDescriptorByRequestKey.get(descriptor.requestKey);
            if (firstRequestDescriptor
                && (firstRequestDescriptor.recordId !== descriptor.recordId
                    || !descriptorsShareRequestIdentity(firstRequestDescriptor, descriptor))) {
                addIssue('conflicting-descriptor', `${path}.requestKey`,
                    'One request key cannot identify different request profiles or immutable records.');
            } else if (!firstRequestDescriptor) {
                firstDescriptorByRequestKey.set(descriptor.requestKey, descriptor);
            }
        }
    });
    return catalog;
}

/** Fields below are embedded in, or deterministically asserted against, the immutable CAS body. */
function descriptorsShareImmutableBody(
    left: EditorialTranscriptDescriptorV1,
    right: EditorialTranscriptDescriptorV1,
): boolean {
    return left.sourceFingerprint === right.sourceFingerprint
        && left.pcmAlgorithmVersion === right.pcmAlgorithmVersion
        && left.recordBodyVersion === right.recordBodyVersion
        && left.canonicalJsonVersion === right.canonicalJsonVersion
        && left.responseSchema === right.responseSchema
        && left.requestedModel === right.requestedModel
        && left.canonicalModel === right.canonicalModel
        && left.sampleRateHz === right.sampleRateHz
        && left.sampleCount === right.sampleCount
        && left.language === right.language
        && left.speakerMode === right.speakerMode
        && left.acquisition === right.acquisition;
}

/** Mirrors the frozen request-key input while intentionally excluding project-local source IDs. */
function descriptorsShareRequestIdentity(
    left: EditorialTranscriptDescriptorV1,
    right: EditorialTranscriptDescriptorV1,
): boolean {
    return left.sourceKind === right.sourceKind
        && left.sourceFingerprint === right.sourceFingerprint
        && left.pcmAlgorithmVersion === right.pcmAlgorithmVersion
        && left.recordBodyVersion === right.recordBodyVersion
        && left.canonicalJsonVersion === right.canonicalJsonVersion
        && left.responseSchema === right.responseSchema
        && left.requestedModel === right.requestedModel
        && left.sampleRateHz === right.sampleRateHz
        && left.sampleCount === right.sampleCount
        && left.language === right.language
        && left.speakerMode === right.speakerMode
        && left.endpointIdentityDigest === right.endpointIdentityDigest;
}

function validateNarrative(
    graph: V4GraphView,
    descriptorCatalog: DescriptorCatalog,
    addIssue: AddIssue,
): StructuralContext {
    const videoSourceById = new Map(graph.videoSources.map((source) => [source.id, source]));
    const videoClipById = new Map(graph.videoClips.map((clip) => [clip.id, clip]));
    const placementByClipId = new Map<string, VideoClipPlacementV4>();
    try {
        buildVideoTrackPlacementsV4({
            renderProfile: graph.renderProfile,
            videoTracks: graph.videoTracks,
            videoClips: graph.videoClips,
        }).forEach((track) => track.placements.forEach((placement) => {
            placementByClipId.set(placement.clip.id, placement);
        }));
    } catch {
        // Explicit video validation already reports the precise graph error. Narrative validation
        // skips placement-derived checks rather than emitting a cascade from an invalid base graph.
    }
    const subtitleByTargetKey = new Map<string, { startTime: number; endTime: number }>();
    graph.subtitleTracks.forEach((track) => track.subtitles.forEach((subtitle) => {
        subtitleByTargetKey.set(subtitleTargetKey(track.id, subtitle.id), subtitle);
    }));
    const audioClipByTargetKey = new Map<string, AudioClip>();
    graph.audioTracks.forEach((track) => track.clips.forEach((clip) => {
        audioClipByTargetKey.set(audioTargetKey(track.id, clip.id), clip);
    }));
    const context: StructuralContext = {
        descriptorCatalog,
        videoSourceById,
        videoClipById,
        placementByClipId,
        blockById: new Map(),
        ownedClipIds: new Set(),
        subtitleByTargetKey,
        audioClipByTargetKey,
    };
    const narrative = graph.narrative;
    if (!narrative) return context;

    Object.keys(narrative).forEach((field) => {
        if (!NARRATIVE_DOCUMENT_KEYS.has(field)) {
            addIssue('invalid-narrative', `narrative.${field}`,
                'V4 narrative documents permit only one document-wide blockIds sequence.');
        }
    });
    if (narrative.version !== 1 || !isSafeEditorId(narrative.id)
        || !isNonNegativeSafeInteger(narrative.revision)
        || narrative.revision > graph.revision
        || !isIsoDate(narrative.createdAt) || !isIsoDate(narrative.updatedAt)
        || (isIsoDate(narrative.createdAt) && isIsoDate(narrative.updatedAt)
            && Date.parse(narrative.updatedAt) < Date.parse(narrative.createdAt))) {
        addIssue('invalid-narrative', 'narrative',
            'Narrative identity, version, revision, and timestamps must use the V1 contract.');
    }
    if (!Array.isArray(narrative.controlledTrackIds)
        || !Array.isArray(narrative.blockIds)
        || !Array.isArray(narrative.sourceRecordIds)
        || !isRecord(narrative.blocks)
        || !isRecord(narrative.settings)) {
        addIssue('invalid-narrative', 'narrative',
            'Narrative track, block, source-record, block-map, and settings fields are required.');
        return context;
    }
    validateNarrativeSettings(narrative, addIssue);
    if (narrative.controlledTrackIds.length === 0) {
        addIssue('invalid-narrative', 'narrative.controlledTrackIds',
            'An active narrative must retain at least one controlled video track.');
    }
    if (narrative.sourceRecordIds.length === 0) {
        addIssue('invalid-narrative', 'narrative.sourceRecordIds',
            'An active narrative must retain at least one source transcript descriptor.');
    }
    const videoTrackIds = new Set(graph.videoTracks.map((track) => track.id));
    validateUniqueSafeIds(narrative.controlledTrackIds, 'narrative.controlledTrackIds', addIssue);
    narrative.controlledTrackIds.forEach((trackId, index) => {
        if (!videoTrackIds.has(trackId)) {
            addIssue('missing-track', `narrative.controlledTrackIds[${index}]`,
                'Narrative control references an unknown video track.');
        }
    });
    validateUniqueDigests(narrative.sourceRecordIds, 'narrative.sourceRecordIds', addIssue);
    narrative.sourceRecordIds.forEach((recordId, index) => {
        if (!descriptorCatalog.byRecordId.has(recordId)) {
            addIssue('missing-transcript-record', `narrative.sourceRecordIds[${index}]`,
                'Narrative recovery catalog references a missing transcript descriptor.');
        }
    });
    validateUniqueSafeIds(narrative.blockIds, 'narrative.blockIds', addIssue);

    Object.entries(narrative.blocks).forEach(([key, block]) => {
        const path = `narrative.blocks.${key}`;
        if (!isSafeEditorId(key) || !isRecord(block)) {
            addIssue('invalid-narrative', path, 'Narrative block map keys and values must be valid objects.');
            return;
        }
        const typedBlock = block as unknown as NarrativeBlockV1;
        if (typedBlock.id !== key) {
            addIssue('invalid-narrative', `${path}.id`, 'Narrative block ID must match its map key.');
        }
        if (context.blockById.has(typedBlock.id)) {
            addIssue('duplicate-id', `${path}.id`, 'Narrative block IDs must be unique.');
        } else {
            context.blockById.set(typedBlock.id, typedBlock);
        }
        if (!narrative.blockIds.includes(key)) {
            addIssue('invalid-narrative', path, 'Narrative block map contains an orphan not listed in blockIds.');
        }
    });
    narrative.blockIds.forEach((blockId, index) => {
        if (!context.blockById.has(blockId)) {
            addIssue('invalid-narrative', `narrative.blockIds[${index}]`,
                'Narrative blockIds references a missing block.');
        }
    });

    const instanceIds = new Set<string>();
    const sourceIntervalIds = new Set<string>();
    const intervals: Array<{ start: number; end: number; blockId: string; path: string }> = [];
    narrative.blockIds.forEach((blockId, index) => {
        const block = context.blockById.get(blockId);
        if (!block) return;
        const path = `narrative.blocks.${blockId}`;
        validateNarrativeBlock(block, path, narrative, graph, context, instanceIds, sourceIntervalIds, addIssue);
        const placement = context.placementByClipId.get(block.clipId);
        if (placement) intervals.push({
            start: block.timelineStartFrame,
            end: placement.endFrame,
            blockId,
            path: `narrative.blockIds[${index}]`,
        });
    });
    validateNarrativeOrder(intervals, addIssue);
    validateNarrativeSeams(narrative, context, addIssue);
    return context;
}

function validateNarrativeSettings(narrative: NarrativeDocumentV1, addIssue: AddIssue): void {
    const settings = narrative.settings;
    if (!isNonNegativeSafeInteger(settings.globalPreMarginSamples)
        || !isNonNegativeSafeInteger(settings.globalPostMarginSamples)
        || typeof settings.boundaryRefinementEnabled !== 'boolean'
        || typeof settings.showSpeakers !== 'boolean') {
        addIssue('invalid-narrative', 'narrative.settings',
            'Narrative margins must be non-negative sample counts and settings flags must be boolean.');
    }
}

function validateNarrativeBlock(
    block: NarrativeBlockV1,
    path: string,
    narrative: NarrativeDocumentV1,
    graph: V4GraphView,
    context: StructuralContext,
    instanceIds: Set<string>,
    sourceIntervalIds: Set<string>,
    addIssue: AddIssue,
): void {
    Object.keys(block).forEach((field) => {
        if (!NARRATIVE_BLOCK_KEYS.has(field)) {
            addIssue('invalid-narrative', `${path}.${field}`,
                'Narrative blocks may contain stable IDs, timing, materialization, and instance overrides only.');
        }
    });
    const identityFields: Array<[string, unknown]> = [
        ['id', block.id],
        ['instanceId', block.instanceId],
        ['lineageRootId', block.lineageRootId],
        ['clipId', block.clipId],
        ['trackId', block.trackId],
        ['sourceId', block.sourceId],
        ['sourceIntervalId', block.sourceIntervalId],
    ];
    identityFields.forEach(([field, value]) => {
        if (typeof value !== 'string' || !isSafeEditorId(value)) {
            addIssue('invalid-narrative', `${path}.${field}`, 'Narrative identities must be safe editor IDs.');
        }
    });
    if (instanceIds.has(block.instanceId)) {
        addIssue('duplicate-id', `${path}.instanceId`, 'Narrative occurrence instance IDs must be unique.');
    }
    instanceIds.add(block.instanceId);
    if (sourceIntervalIds.has(block.sourceIntervalId)) {
        addIssue('duplicate-id', `${path}.sourceIntervalId`,
            'Every source-backed interval occurrence must retain a unique identity.');
    }
    sourceIntervalIds.add(block.sourceIntervalId);
    if (!Array.isArray(block.parentInstanceIds)) {
        addIssue('invalid-narrative', `${path}.parentInstanceIds`, 'Parent occurrence IDs must be an array.');
    } else {
        validateUniqueSafeIds(block.parentInstanceIds, `${path}.parentInstanceIds`, addIssue);
        if (block.parentInstanceIds.includes(block.instanceId)) {
            addIssue('invalid-narrative', `${path}.parentInstanceIds`, 'A block cannot be its own parent occurrence.');
        }
    }
    if (!isNonNegativeSafeInteger(block.coreStartSample)
        || !isPositiveSafeInteger(block.coreEndSample)
        || block.coreEndSample <= block.coreStartSample
        || !isNonNegativeSafeInteger(block.timelineStartFrame)
        || !isNonNegativeSafeInteger(block.revision)
        || block.revision > narrative.revision) {
        addIssue('invalid-narrative', path,
            'Narrative core, placement, and revision values must be safe non-negative half-open ranges.');
    }
    const recordDescriptors = isSha256Digest(block.transcriptRecordId)
        ? context.descriptorCatalog.byRecordId.get(block.transcriptRecordId)
        : undefined;
    const descriptor = isSha256Digest(block.transcriptRecordId)
        ? context.descriptorCatalog.byRecordAndSourceId.get(block.transcriptRecordId)?.get(block.sourceId)
        : undefined;
    if (!isSha256Digest(block.transcriptRecordId) || !recordDescriptors) {
        addIssue('missing-transcript-record', `${path}.transcriptRecordId`,
            'Narrative block references a missing transcript descriptor.');
    } else if (!descriptor) {
        addIssue('invalid-narrative', `${path}.sourceId`,
            'Narrative block record and source must resolve to one exact descriptor mapping.');
    } else {
        if (!narrative.sourceRecordIds.includes(block.transcriptRecordId)) {
            addIssue('invalid-narrative', `${path}.transcriptRecordId`,
                'Narrative block record must be retained in sourceRecordIds.');
        }
        if (block.coreEndSample > descriptor.sampleCount) {
            addIssue('invalid-narrative', `${path}.coreEndSample`,
                'Narrative core exceeds the full-source transcript sample count.');
        }
        if (descriptor.sourceId !== block.sourceId) {
            addIssue('invalid-narrative', `${path}.sourceId`,
                'Narrative block source does not match its transcript descriptor.');
        }
    }
    if (!narrative.controlledTrackIds.includes(block.trackId)) {
        addIssue('missing-track', `${path}.trackId`, 'Narrative block track is not controlled by this narrative.');
    }
    const clip = context.videoClipById.get(block.clipId);
    const source = context.videoSourceById.get(block.sourceId);
    if (!clip) {
        addIssue('missing-clip', `${path}.clipId`, 'Narrative block owns an unknown video clip.');
    } else {
        if (context.ownedClipIds.has(clip.id)) {
            addIssue('duplicate-id', `${path}.clipId`, 'A controlled clip may be owned by only one narrative block.');
        }
        context.ownedClipIds.add(clip.id);
        if (clip.trackId !== block.trackId || clip.sourceId !== block.sourceId
            || clip.timelineStartFrame !== block.timelineStartFrame) {
            addIssue('invalid-narrative', path,
                'Narrative block track, source, and placement must match its owned V4 clip.');
        }
    }
    if (!source) addIssue('missing-source', `${path}.sourceId`, 'Narrative block references an unknown video source.');
    validateMaterialization(block, path, narrative, graph.renderProfile, clip, source, descriptor, addIssue);
    validateBoundaryRefinement(block.startBoundaryRefinement, block.coreStartSample,
        `${path}.startBoundaryRefinement`, descriptor?.sampleCount, addIssue);
    validateBoundaryRefinement(block.endBoundaryRefinement, block.coreEndSample,
        `${path}.endBoundaryRefinement`, descriptor?.sampleCount, addIssue);

    if (block.kind === 'speech') {
        const sourceWordIds = Array.isArray(block.sourceWordIds) ? block.sourceWordIds : [];
        if (sourceWordIds.length === 0) {
            addIssue('invalid-narrative', `${path}.sourceWordIds`, 'Speech blocks must retain at least one source word ID.');
        } else {
            validateUniqueStableReferenceIds(sourceWordIds, `${path}.sourceWordIds`, addIssue);
        }
        validateOverrides(block.wordTextOverrides, sourceWordIds, `${path}.wordTextOverrides`, true, addIssue);
        validateOverrides(block.speakerOverrides, sourceWordIds, `${path}.speakerOverrides`, true, addIssue);
    } else if (block.kind === 'silence') {
        if (!Array.isArray(block.sourceWordIds) || block.sourceWordIds.length !== 0) {
            addIssue('invalid-narrative', `${path}.sourceWordIds`, 'Silence blocks cannot retain source words.');
        }
        if (block.evidence !== 'quiet' && block.evidence !== 'no-audio'
            && block.evidence !== 'acoustic-only' && block.evidence !== 'unknown') {
            addIssue('invalid-narrative', `${path}.evidence`, 'Silence evidence uses an unsupported value.');
        }
        if (Object.prototype.hasOwnProperty.call(block, 'wordTextOverrides')
            || Object.prototype.hasOwnProperty.call(block, 'speakerOverrides')) {
            addIssue('invalid-narrative', path, 'Silence blocks cannot contain word or speaker overrides.');
        }
    } else {
        addIssue('invalid-narrative', `${path}.kind`, 'Narrative block kind must be speech or silence.');
    }
}

function validateMaterialization(
    block: NarrativeBlockV1,
    path: string,
    narrative: NarrativeDocumentV1,
    profile: RenderProfile,
    clip: VideoClipV4 | undefined,
    source: V4VideoSource | undefined,
    descriptor: EditorialTranscriptDescriptorV1 | undefined,
    addIssue: AddIssue,
): void {
    const materialization = block.materialization;
    if (!isRecord(materialization)
        || !isNonNegativeSafeInteger(materialization.sourceStartFrame)
        || !isPositiveSafeInteger(materialization.sourceEndFrame)
        || materialization.sourceEndFrame <= materialization.sourceStartFrame) {
        addIssue('invalid-materialization', `${path}.materialization`,
            'Materialized source frames must form a positive safe half-open interval.');
        return;
    }
    validateBoundaryPolicy(materialization.preBoundary, `${path}.materialization.preBoundary`, addIssue);
    validateBoundaryPolicy(materialization.postBoundary, `${path}.materialization.postBoundary`, addIssue);
    if (!source || !descriptor || !clip || !isPositiveFinite(source.fps)) return;

    const sourceEndFrame = Math.max(1, Math.ceil(source.duration * source.fps - NUMERICAL_GUARD));
    if (materialization.sourceEndFrame > sourceEndFrame) {
        addIssue('invalid-materialization', `${path}.materialization.sourceEndFrame`,
            'Materialized source frames cannot extend beyond the deterministic source tail.');
    }
    const startSeconds = materialization.sourceStartFrame / source.fps;
    const endSeconds = Math.min(source.duration, materialization.sourceEndFrame / source.fps);
    const tolerance = Math.max(NUMERICAL_GUARD, 1 / source.fps * 1e-7);
    if (Math.abs(clip.sourceStart - startSeconds) > tolerance
        || Math.abs(clip.sourceEnd - endSeconds) > tolerance) {
        addIssue('invalid-materialization', `${path}.materialization`,
            'Materialized source frames must match the owned clip crop.');
    }
    const coreStartSeconds = block.coreStartSample / EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ;
    const coreEndSeconds = block.coreEndSample / EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ;
    // Full-source PCM deliberately uses ceil(duration * 16 kHz), so the final canonical sample can
    // extend by less than one sample beyond the container duration. A block ending at sampleCount
    // owns that padded PCM tail semantically, while its media crop must still clamp to source.duration.
    const containedCoreEndSeconds = block.coreEndSample === descriptor.sampleCount
        ? Math.min(coreEndSeconds, source.duration)
        : coreEndSeconds;
    // Margin boundaries round outward and therefore must contain the semantic core. A paired
    // partition seam is different: it preserves one exact native-frame cut shared by adjacent
    // blocks, so a semantic sample boundary that falls inside that frame can legitimately sit on
    // either side of the seam by less than one frame. Requiring both seam children to contain the
    // same fractional boundary would be mathematically impossible without overlapping media.
    const startExcludesCore = isRecord(materialization.preBoundary)
        && materialization.preBoundary.kind === 'margin'
        && startSeconds > coreStartSeconds + tolerance;
    const endExcludesCore = isRecord(materialization.postBoundary)
        && materialization.postBoundary.kind === 'margin'
        && endSeconds < containedCoreEndSeconds - tolerance;
    if (startExcludesCore || endExcludesCore) {
        addIssue('invalid-materialization', `${path}.materialization`,
            'Materialized source frames must contain the semantic core.');
    }
    validateRecomputedMarginBoundary(
        'pre',
        materialization.preBoundary,
        materialization.sourceStartFrame,
        block.coreStartSample,
        narrative,
        source,
        descriptor,
        `${path}.materialization.preBoundary`,
        addIssue,
    );
    validateRecomputedMarginBoundary(
        'post',
        materialization.postBoundary,
        materialization.sourceEndFrame,
        block.coreEndSample,
        narrative,
        source,
        descriptor,
        `${path}.materialization.postBoundary`,
        addIssue,
    );
    try {
        const materializedSeconds = Math.max(0, endSeconds - startSeconds);
        const materializedDurationFrames = secondsToFrames(materializedSeconds, profile.fps, 'nearest');
        const clipDurationFrames = getVideoClipDurationFramesV4(clip, profile);
        if (materializedDurationFrames !== clipDurationFrames) {
            addIssue('invalid-materialization', `${path}.materialization`,
                'Materialized source frames and owned clip must produce the same output duration.');
        }
    } catch {
        // Base video validation owns malformed profile/crop diagnostics.
    }
}

function validateBoundaryPolicy(value: unknown, path: string, addIssue: AddIssue): void {
    if (!isRecord(value)) {
        addIssue('invalid-materialization', path, 'Boundary policy must be an object.');
        return;
    }
    if (value.kind === 'margin') {
        const valid = value.mode === 'inherit-global'
            ? value.requestedSamples === null
            : value.mode === 'explicit' && isNonNegativeSafeInteger(value.requestedSamples);
        if (!valid) addIssue('invalid-materialization', path,
            'Inherited margins require null samples; explicit margins require a non-negative sample count.');
        return;
    }
    if (value.kind === 'partition-seam') {
        if (typeof value.seamId !== 'string' || !isSafeEditorId(value.seamId)) {
            addIssue('invalid-materialization', `${path}.seamId`, 'Partition seam ID must be a safe editor ID.');
        }
        return;
    }
    addIssue('invalid-materialization', `${path}.kind`, 'Boundary policy must be margin or partition-seam.');
}

function validateRecomputedMarginBoundary(
    side: 'pre' | 'post',
    policy: NarrativeBlockV1['materialization']['preBoundary'],
    actualFrame: number,
    coreSample: number,
    narrative: NarrativeDocumentV1,
    source: V4VideoSource,
    descriptor: EditorialTranscriptDescriptorV1,
    path: string,
    addIssue: AddIssue,
): void {
    if (!isRecord(policy) || policy.kind !== 'margin') return;
    const requestedMargin = policy.mode === 'inherit-global'
        ? side === 'pre'
            ? narrative.settings.globalPreMarginSamples
            : narrative.settings.globalPostMarginSamples
        : policy.requestedSamples;
    if (!isNonNegativeSafeInteger(requestedMargin)) return;
    const requestedSample = side === 'pre'
        ? Math.max(0, coreSample - requestedMargin)
        : Math.min(descriptor.sampleCount, coreSample + requestedMargin);
    const exactFrame = requestedSample * source.fps / EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ;
    const sourceEndFrame = Math.max(1, Math.ceil(source.duration * source.fps - NUMERICAL_GUARD));
    const expectedFrame = side === 'pre'
        ? Math.max(0, Math.floor(exactFrame + NUMERICAL_GUARD))
        : Math.min(sourceEndFrame, Math.ceil(exactFrame - NUMERICAL_GUARD));
    if (actualFrame !== expectedFrame) {
        addIssue('invalid-materialization', path,
            'Materialized margin boundary is stale for its core and effective margin.');
    }
}

function validateBoundaryRefinement(
    refinement: NarrativeBlockV1['startBoundaryRefinement'],
    chosenCoreSample: number,
    path: string,
    sampleCount: number | undefined,
    addIssue: AddIssue,
): void {
    if (refinement === null) return;
    if (!isRecord(refinement)
        || !isNonNegativeSafeInteger(refinement.originalSample)
        || !isNonNegativeSafeInteger(refinement.chosenSample)
        || refinement.chosenSample !== chosenCoreSample
        || !isPositiveSafeInteger(refinement.algorithmVersion)
        || (refinement.origin !== 'manual' && refinement.origin !== 'quiet-assisted')
        || (sampleCount !== undefined
            && (refinement.originalSample > sampleCount || refinement.chosenSample > sampleCount))) {
        addIssue('invalid-narrative', path,
            'Boundary refinement must retain valid in-range source samples and algorithm provenance.');
    }
}

function validateOverrides(
    value: unknown,
    sourceWordIds: readonly string[],
    path: string,
    requireTrimmedValue: boolean,
    addIssue: AddIssue,
): void {
    if (!isRecord(value)) {
        addIssue('invalid-narrative', path, 'Narrative overrides must be an object map.');
        return;
    }
    Object.entries(value).forEach(([wordId, replacement]) => {
        if (!sourceWordIds.includes(wordId)) {
            addIssue('invalid-narrative', `${path}.${wordId}`,
                'Narrative override key must reference a word retained by this occurrence.');
        }
        if (typeof replacement !== 'string' || replacement.trim().length === 0
            || (requireTrimmedValue && replacement !== replacement.trim())) {
            addIssue('invalid-narrative', `${path}.${wordId}`, 'Narrative override values must be non-empty strings.');
        }
    });
}

function validateNarrativeOrder(
    intervals: Array<{ start: number; end: number; blockId: string; path: string }>,
    addIssue: AddIssue,
): void {
    let previousEnd = 0;
    intervals.forEach((interval, index) => {
        if (index > 0 && interval.start < previousEnd) {
            addIssue('invalid-narrative', interval.path,
                'Narrative blockIds order must follow globally non-overlapping project time.');
        }
        previousEnd = Math.max(previousEnd, interval.end);
    });
}

function validateNarrativeSeams(
    narrative: NarrativeDocumentV1,
    context: StructuralContext,
    addIssue: AddIssue,
): void {
    const seamUses = new Map<string, Array<{
        block: NarrativeBlockV1;
        side: 'pre' | 'post';
        sequenceIndex: number;
    }>>();
    narrative.blockIds.forEach((blockId, sequenceIndex) => {
        const block = context.blockById.get(blockId);
        if (!block || !isRecord(block.materialization)) return;
        const boundaries: Array<['pre' | 'post', NarrativeBlockV1['materialization']['preBoundary']]> = [
            ['pre', block.materialization.preBoundary],
            ['post', block.materialization.postBoundary],
        ];
        boundaries.forEach(([side, boundary]) => {
            if (!isRecord(boundary) || boundary.kind !== 'partition-seam'
                || typeof boundary.seamId !== 'string') return;
            const uses = seamUses.get(boundary.seamId) ?? [];
            uses.push({ block, side, sequenceIndex });
            seamUses.set(boundary.seamId, uses);
        });
    });
    seamUses.forEach((uses, seamId) => {
        if (uses.length > 2) {
            addIssue('invalid-materialization', 'narrative.blocks',
                `Partition seam ${seamId} is referenced by more than two boundaries.`);
            return;
        }
        // One use is valid after deleting a split sibling: the surviving side must remain a seam
        // so a later global-margin command cannot silently restore deleted context.
        if (uses.length < 2) return;
        const pre = uses.find((use) => use.side === 'pre');
        const post = uses.find((use) => use.side === 'post');
        if (!pre || !post
            || post.sequenceIndex + 1 !== pre.sequenceIndex
            || post.block.trackId !== pre.block.trackId
            || post.block.sourceId !== pre.block.sourceId
            || post.block.transcriptRecordId !== pre.block.transcriptRecordId
            || post.block.lineageRootId !== pre.block.lineageRootId
            || post.block.coreEndSample !== pre.block.coreStartSample
            || post.block.materialization.sourceEndFrame !== pre.block.materialization.sourceStartFrame) {
            addIssue('invalid-materialization', 'narrative.blocks',
                `Partition seam ${seamId} does not connect one compatible adjacent post/pre pair.`);
            return;
        }
        const left = context.placementByClipId.get(post.block.clipId);
        if (left && left.endFrame !== pre.block.timelineStartFrame) {
            addIssue('invalid-materialization', 'narrative.blocks',
                `Partition seam ${seamId} does not preserve an exact project-frame boundary.`);
        }
    });
}

function validateDependentLinks(
    graph: V4GraphView,
    context: StructuralContext,
    addIssue: AddIssue,
): void {
    const linkIds = new Set<string>();
    const targetKeys = new Set<string>();
    graph.dependentLinks.forEach((link, index) => {
        const path = `dependentLinks[${index}]`;
        if (link.version !== 1 || !isSafeEditorId(link.id)
            || !isNonNegativeSafeInteger(link.revision) || link.revision > graph.revision) {
            addIssue('invalid-dependent-link', path, 'Dependent link identity, version, and revision are invalid.');
        }
        if (linkIds.has(link.id)) addIssue('duplicate-id', `${path}.id`, 'Dependent link IDs must be unique.');
        linkIds.add(link.id);
        const anchor = context.blockById.get(link.anchorBlockId);
        if (!anchor) addIssue('invalid-dependent-link', `${path}.anchorBlockId`,
            'Dependent link anchor must reference an existing narrative block.');
        if (link.followPolicy !== 'none' && link.followPolicy !== 'follow') {
            addIssue('invalid-dependent-link', `${path}.followPolicy`, 'Follow policy must be none or follow.');
        }
        if (!Number.isSafeInteger(link.relativeStartOutputSample)
            || !Number.isSafeInteger(link.relativeEndOutputSample)
            || link.relativeEndOutputSample <= link.relativeStartOutputSample) {
            addIssue('invalid-dependent-link', path,
                'Dependent offsets must form a non-empty safe half-open output-sample interval.');
        }
        const targetKey = getDependentTargetKey(link);
        if (!targetKey) {
            addIssue('invalid-dependent-link', `${path}.target`, 'Dependent target kind or identity is invalid.');
        } else {
            if (targetKeys.has(targetKey)) addIssue('duplicate-id', `${path}.target`,
                'A dependent target may be referenced by only one link.');
            targetKeys.add(targetKey);
            validateDependentTarget(graph, link, path, targetKey, anchor, context, addIssue);
        }
        validateLinkAssociation(link, anchor, path, addIssue);
    });
}

function validateDependentTarget(
    graph: V4GraphView,
    link: EditorialDependentLinkV1,
    path: string,
    targetKey: string,
    anchor: NarrativeBlockV1 | undefined,
    context: StructuralContext,
    addIssue: AddIssue,
): void {
    let targetInterval: { start: number; end: number } | null = null;
    if (link.target.kind === 'video-clip') {
        const placement = context.placementByClipId.get(link.target.clipId);
        if (!placement) addIssue('missing-clip', `${path}.target.clipId`, 'Dependent video target does not exist.');
        else if (context.ownedClipIds.has(link.target.clipId)) addIssue('invalid-dependent-link', `${path}.target.clipId`,
            'A narrative-owned video clip cannot also be a dependent target.');
        else targetInterval = {
            start: frameToOutputSample(placement.startFrame, graph.renderProfile.fps),
            end: frameToOutputSample(placement.endFrame, graph.renderProfile.fps),
        };
    } else if (link.target.kind === 'audio-clip') {
        const clip = context.audioClipByTargetKey.get(targetKey);
        if (!clip) addIssue('missing-clip', `${path}.target`, 'Dependent audio target does not exist on the referenced track.');
        else targetInterval = getAudioTargetInterval(graph, clip);
    } else {
        const subtitle = context.subtitleByTargetKey.get(targetKey);
        if (!subtitle) addIssue('missing-subtitle', `${path}.target`,
            'Dependent subtitle target does not exist on the referenced track.');
        else targetInterval = {
            start: Math.round(subtitle.startTime * EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ),
            end: Math.round(subtitle.endTime * EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ),
        };
    }
    if (!targetInterval || !anchor) return;
    const anchorStart = frameToOutputSample(anchor.timelineStartFrame, graph.renderProfile.fps);
    if (link.relativeStartOutputSample !== targetInterval.start - anchorStart
        || link.relativeEndOutputSample !== targetInterval.end - anchorStart) {
        addIssue('invalid-dependent-link', path,
            'Dependent offsets are stale for the current anchor and target placements.');
    }
}

function validateLinkAssociation(
    link: EditorialDependentLinkV1,
    anchor: NarrativeBlockV1 | undefined,
    path: string,
    addIssue: AddIssue,
): void {
    if (!isRecord(link.association)) {
        addIssue('invalid-dependent-link', `${path}.association`, 'Dependent association must be an object.');
        return;
    }
    if (link.association.kind === 'overlap') {
        if (link.association.origin !== 'auto' && link.association.origin !== 'manual') {
            addIssue('invalid-dependent-link', `${path}.association.origin`,
                'Overlap association origin must be auto or manual.');
        }
        return;
    }
    if (link.association.kind !== 'transcript-bound' || !isRecord(link.association.binding)) {
        addIssue('invalid-dependent-link', `${path}.association`, 'Dependent association kind is invalid.');
        return;
    }
    const binding = link.association.binding;
    if (binding.version !== 1
        || !isSafeEditorId(binding.bindingId)
        || !isSha256Digest(binding.transcriptRecordId)
        || !isSafeEditorId(binding.sourceIntervalId)
        || !isNonNegativeSafeInteger(binding.activeStartSample)
        || !isPositiveSafeInteger(binding.activeEndSample)
        || binding.activeEndSample <= binding.activeStartSample
        || !isSafeEditorId(binding.lineageRootId)
        || !isSafeEditorId(binding.createdFromBlockId)) {
        addIssue('invalid-dependent-link', `${path}.association.binding`,
            'Transcript binding identity and active sample interval are invalid.');
    }
    if (anchor && (binding.transcriptRecordId !== anchor.transcriptRecordId
        || binding.sourceIntervalId !== anchor.sourceIntervalId
        || binding.lineageRootId !== anchor.lineageRootId
        || binding.activeStartSample < anchor.coreStartSample
        || binding.activeEndSample > anchor.coreEndSample)) {
        addIssue('invalid-dependent-link', `${path}.association.binding`,
            'Transcript binding must identify a non-empty fragment inside its exact anchor occurrence.');
    }
}

function validateTransientNarrativeSelection(
    graph: V4GraphView,
    context: StructuralContext,
    addIssue: AddIssue,
): void {
    const selection = graph.transientSelection;
    if (!selection || selection.kind !== 'narrative') return;
    const block = context.blockById.get(selection.blockId);
    if (!block) {
        addIssue('invalid-narrative', 'transientSelection.blockId',
            'Narrative selection references an unknown block.');
        return;
    }
    if (selection.trackId !== block.trackId) addIssue('invalid-narrative', 'transientSelection.trackId',
        'Narrative selection track does not match its block.');
    if (!Array.isArray(selection.sourceWordIds)) {
        addIssue('invalid-narrative', 'transientSelection.sourceWordIds', 'Selected word IDs must be an array.');
    } else {
        const blockWords = block.kind === 'speech' ? block.sourceWordIds : [];
        selection.sourceWordIds.forEach((wordId, index) => {
            if (!blockWords.includes(wordId)) addIssue('invalid-transcript-reference',
                `transientSelection.sourceWordIds[${index}]`, 'Selected word is not retained by the selected block.');
        });
    }
    if (selection.boundary !== null && (!isRecord(selection.boundary)
        || !isStableTranscriptReferenceId(selection.boundary.boundaryId)
        || (selection.boundary.side !== 'start' && selection.boundary.side !== 'end'))) {
        addIssue('invalid-narrative', 'transientSelection.boundary', 'Selected boundary identity or side is invalid.');
    }
}

function validateV4TranscriptionSignature(graph: V4GraphView, addIssue: AddIssue): void {
    let signature: string;
    try {
        signature = getEditorAudioGraphSignatureV4(graph);
    } catch {
        return;
    }
    Object.entries(graph.transcriptionByTrackId).forEach(([trackId, provenance]) => {
        if (typeof provenance.stale !== 'boolean') {
            addIssue('invalid-transcription-provenance', `transcriptionByTrackId.${trackId}.stale`,
                'Transcription stale state must be boolean.');
            return;
        }
        if (provenance.stale === false && provenance.sourceAudioGraphSignature !== signature) {
            addIssue('invalid-transcription-provenance', `transcriptionByTrackId.${trackId}`,
                'Non-stale transcription provenance must match the explicit V4 audio graph.');
        }
    });
}

function validateHydratedGraph(
    graph: V4GraphView,
    resolvedBodies: ResolvedEditorialTranscriptMapV1,
    addIssue: AddIssue,
): void {
    const descriptorsByRecordId = new Map<Sha256Digest, EditorialTranscriptDescriptorV1[]>();
    graph.editorialTranscriptDescriptors.forEach((descriptor) => {
        const descriptors = descriptorsByRecordId.get(descriptor.recordId) ?? [];
        descriptors.push(descriptor);
        descriptorsByRecordId.set(descriptor.recordId, descriptors);
    });
    const referencedRecordIds = new Set<Sha256Digest>();
    graph.narrative?.sourceRecordIds.forEach((recordId) => referencedRecordIds.add(recordId));
    if (graph.narrative) {
        Object.values(graph.narrative.blocks)
            .forEach((block) => referencedRecordIds.add(block.transcriptRecordId));
    }
    graph.dependentLinks.forEach((link) => {
        if (link.association.kind === 'transcript-bound') {
            referencedRecordIds.add(link.association.binding.transcriptRecordId);
        }
    });

    const indexesByRecordId = new Map<Sha256Digest, BodyIndexes>();
    referencedRecordIds.forEach((recordId) => {
        const descriptors = descriptorsByRecordId.get(recordId);
        const body = resolvedBodies[recordId];
        const path = `resolvedBodies.${recordId}`;
        if (!descriptors) return;
        if (!body) {
            addIssue('missing-transcript-record', path,
                'A transcript body required by the current narrative is unresolved.');
            return;
        }
        const indexes = validateTranscriptBody(body, descriptors, path, addIssue);
        if (indexes) indexesByRecordId.set(recordId, indexes);
    });
    validateHydratedNarrativeReferences(graph, resolvedBodies, indexesByRecordId, addIssue);
}

function validateTranscriptBody(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    descriptors: readonly EditorialTranscriptDescriptorV1[],
    path: string,
    addIssue: AddIssue,
): BodyIndexes | null {
    if (body.version !== 1
        || body.canonicalJsonVersion !== EDITORIAL_CANONICAL_JSON_VERSION
        || !isSha256Digest(body.contentNamespace)
        || body.pcmAlgorithmVersion !== EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION
        || body.sampleRateHz !== EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ
        || !isPositiveSafeInteger(body.sampleCount)
        || body.timeOrigin !== 'decoded_audio_start'
        || body.requestedModel !== EDITORIAL_TRANSCRIPT_REQUESTED_MODEL
        || !isNonEmptyTrimmedString(body.canonicalModel)
        || body.profile !== EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA
        || (body.language !== null && !isNonEmptyTrimmedString(body.language))
        || (body.speakerMode !== 'none' && body.speakerMode !== 'diarized')
        || typeof body.noAudioStream !== 'boolean'
        || !Array.isArray(body.words)
        || !Array.isArray(body.speechRegions)
        || !Array.isArray(body.editBoundaries)
        || !Array.isArray(body.speakers)) {
        addIssue('invalid-transcript-body', path, 'Resolved transcript body does not use the frozen V1 schema.');
        return null;
    }
    descriptors.forEach((descriptor, descriptorIndex) => {
        validateTranscriptBodyDescriptorIdentity(
            body,
            descriptor,
            `${path}.descriptorMappings[${descriptorIndex}]`,
            addIssue,
        );
    });
    const speakerIds = validateBodySpeakers(body, path, addIssue);
    const wordIndexById = validateBodyWords(body, speakerIds, path, addIssue);
    const regionById = validateBodyRegions(body, path, addIssue);
    const boundaryIds = validateBodyBoundaries(body, regionById, path, addIssue);
    if (body.noAudioStream && (body.words.length > 0 || body.speechRegions.length > 0
        || body.editBoundaries.length > 0 || body.speakers.length > 0)) {
        addIssue('invalid-transcript-body', path, 'A local no-audio body must not contain speech or speaker evidence.');
    }
    return { wordIndexById, regionById, boundaryIds, speakerIds };
}

function validateTranscriptBodyDescriptorIdentity(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    descriptor: EditorialTranscriptDescriptorV1,
    path: string,
    addIssue: AddIssue,
): void {
    if (body.sourceFingerprint !== descriptor.sourceFingerprint
        || body.pcmAlgorithmVersion !== descriptor.pcmAlgorithmVersion
        || body.sampleRateHz !== descriptor.sampleRateHz
        || body.sampleCount !== descriptor.sampleCount
        || body.requestedModel !== descriptor.requestedModel
        || body.canonicalModel !== descriptor.canonicalModel
        || body.profile !== descriptor.responseSchema
        || body.language !== descriptor.language
        || body.speakerMode !== descriptor.speakerMode
        || body.noAudioStream !== (descriptor.acquisition === 'local-no-audio')) {
        addIssue('transcript-body-mismatch', path,
            'Resolved transcript body identity does not match its project descriptor.');
    }
}

function validateBodySpeakers(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    path: string,
    addIssue: AddIssue,
): Set<string> {
    const speakerIds = new Set<string>();
    body.speakers.forEach((speaker, index) => {
        const speakerPath = `${path}.speakers[${index}]`;
        if (!isRecord(speaker) || !isSha256Digest(speaker.id) || !isNonEmptyTrimmedString(speaker.label)
            || !Array.isArray(speaker.segments) || speaker.segments.length === 0) {
            addIssue('invalid-transcript-body', speakerPath,
                'Speaker identity must be SHA-256-derived and its segment catalog must be valid.');
            return;
        }
        if (speakerIds.has(speaker.id)) addIssue('invalid-transcript-body', `${speakerPath}.id`,
            'Speaker IDs must be unique.');
        speakerIds.add(speaker.id);
        let previousEnd = 0;
        speaker.segments.forEach((segment, segmentIndex) => {
            if (!isRecord(segment)
                || !isNonNegativeSafeInteger(segment.startSample)
                || !isPositiveSafeInteger(segment.endSample)
                || segment.endSample <= segment.startSample
                || segment.endSample > body.sampleCount
                || (segmentIndex > 0 && segment.startSample < previousEnd)) {
                addIssue('invalid-transcript-body', `${speakerPath}.segments[${segmentIndex}]`,
                    'Speaker segments must be sorted, non-overlapping, in-range half-open intervals.');
            }
            if (isPositiveSafeInteger(segment.endSample)) {
                previousEnd = Math.max(previousEnd, segment.endSample);
            }
        });
    });
    if ((body.speakerMode === 'none' && speakerIds.size > 0)
        || (body.speakerMode === 'diarized' && speakerIds.size === 0 && body.words.length > 0)) {
        addIssue('invalid-transcript-body', `${path}.speakers`,
            'Speaker catalog presence must match transcript speaker mode.');
    }
    return speakerIds;
}

function validateBodyWords(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    speakerIds: Set<string>,
    path: string,
    addIssue: AddIssue,
): Map<string, number> {
    const indexes = new Map<string, number>();
    let previousEditableEnd = 0;
    let previousAlignedStart = 0;
    let previousAlignedEnd = 0;
    body.words.forEach((word, index) => {
        const wordPath = `${path}.words[${index}]`;
        if (!isRecord(word)) {
            addIssue('invalid-transcript-body', wordPath, 'Source word must be an object.');
            return;
        }
        if (!isSha256Digest(word.id) || indexes.has(word.id)) {
            addIssue('invalid-transcript-body', `${wordPath}.id`,
                'Source word IDs must be SHA-256-derived and unique.');
        } else indexes.set(word.id, index);
        if (!isNonEmptyTrimmedString(word.text)
            || !isHalfOpenSampleRange(word.alignedStartSample, word.alignedEndSample, body.sampleCount)
            || !isHalfOpenSampleRange(word.editableStartSample, word.editableEndSample, body.sampleCount)
            || word.editableStartSample < word.alignedStartSample
            || word.editableEndSample > word.alignedEndSample
            || (index > 0 && word.alignedStartSample < previousAlignedStart)
            || (index > 0 && word.alignedEndSample < previousAlignedEnd)
            || (index > 0 && word.editableStartSample < previousEditableEnd)
            || (word.probability !== null && !Number.isFinite(word.probability))) {
            addIssue('invalid-transcript-body', wordPath,
                'Source words must have non-empty text and sorted, non-overlapping in-range timing.');
        }
        if (body.speakerMode === 'none' ? word.speakerId !== null
            : typeof word.speakerId !== 'string' || !speakerIds.has(word.speakerId)) {
            addIssue('invalid-transcript-body', `${wordPath}.speakerId`,
                'Word speaker reference does not match the body speaker catalog.');
        }
        if (isNonNegativeSafeInteger(word.alignedStartSample)) previousAlignedStart = word.alignedStartSample;
        if (isPositiveSafeInteger(word.alignedEndSample)) previousAlignedEnd = word.alignedEndSample;
        if (isPositiveSafeInteger(word.editableEndSample)) {
            previousEditableEnd = Math.max(previousEditableEnd, word.editableEndSample);
        }
    });
    return indexes;
}

function validateBodyRegions(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    path: string,
    addIssue: AddIssue,
): Map<string, ResolvedEditorialTranscriptRecordBodyV1['speechRegions'][number]> {
    const regions = new Map<string, ResolvedEditorialTranscriptRecordBodyV1['speechRegions'][number]>();
    const providerIds = new Set<number>();
    let previousEnd = 0;
    body.speechRegions.forEach((region, index) => {
        const regionPath = `${path}.speechRegions[${index}]`;
        if (!isRecord(region)) {
            addIssue('invalid-transcript-body', regionPath, 'Speech region must be an object.');
            return;
        }
        if (!isSha256Digest(region.id) || regions.has(region.id)
            || !isNonNegativeSafeInteger(region.providerRegionId) || providerIds.has(region.providerRegionId)
            || !isHalfOpenSampleRange(region.startSample, region.endSample, body.sampleCount)
            || (index > 0 && region.startSample < previousEnd)
            || (region.evidence !== 'alignment_acoustic'
                && region.evidence !== 'alignment_only' && region.evidence !== 'acoustic_only')
            || !isProbabilityOrNull(region.vadPeakProbability)
            || !isProbabilityOrNull(region.vadMeanProbability)
            || typeof region.startEnergyConfirmed !== 'boolean'
            || typeof region.endEnergyConfirmed !== 'boolean') {
            addIssue('invalid-transcript-body', regionPath,
                'Speech regions must be unique, sorted, in-range, and use supported evidence.');
        }
        if ((region.wordStartIndex === null) !== (region.wordEndIndex === null)
            || (region.wordStartIndex !== null && region.wordEndIndex !== null
                && (!isNonNegativeSafeInteger(region.wordStartIndex)
                    || !isPositiveSafeInteger(region.wordEndIndex)
                    || region.wordEndIndex <= region.wordStartIndex
                    || region.wordEndIndex > body.words.length))) {
            addIssue('invalid-transcript-body', regionPath,
                'Speech-region word indexes must be null together or form a valid half-open word range.');
        } else if (region.wordStartIndex !== null && region.wordEndIndex !== null) {
            const words = body.words.slice(region.wordStartIndex, region.wordEndIndex);
            if (words.some((word) => !isRecord(word)
                || word.alignedStartSample < region.startSample
                || word.alignedEndSample > region.endSample)) {
                addIssue('invalid-transcript-body', regionPath,
                    'Speech-region word indexes must reference words contained by that region.');
            }
        }
        if (isSha256Digest(region.id) && !regions.has(region.id)) regions.set(region.id, region);
        if (isNonNegativeSafeInteger(region.providerRegionId)) providerIds.add(region.providerRegionId);
        if (isPositiveSafeInteger(region.endSample)) previousEnd = Math.max(previousEnd, region.endSample);
    });
    return regions;
}

function validateBodyBoundaries(
    body: ResolvedEditorialTranscriptRecordBodyV1,
    regions: Map<string, ResolvedEditorialTranscriptRecordBodyV1['speechRegions'][number]>,
    path: string,
    addIssue: AddIssue,
): Set<string> {
    const boundaryIds = new Set<string>();
    const edgeKeys = new Set<string>();
    let previousSample = 0;
    body.editBoundaries.forEach((boundary, index) => {
        const boundaryPath = `${path}.editBoundaries[${index}]`;
        if (!isRecord(boundary)) {
            addIssue('invalid-transcript-body', boundaryPath, 'Edit boundary must be an object.');
            return;
        }
        const region = regions.get(boundary.regionId);
        const expectedSample = boundary.type === 'speech_start'
            ? region?.startSample
            : boundary.type === 'speech_end'
                ? region?.endSample
                : undefined;
        const expectedEnergy = boundary.type === 'speech_start'
            ? region?.startEnergyConfirmed
            : boundary.type === 'speech_end'
                ? region?.endEnergyConfirmed
                : undefined;
        const edgeKey = `${boundary.regionId}:${boundary.type}`;
        if (!isSha256Digest(boundary.id) || boundaryIds.has(boundary.id)
            || !region || expectedSample === undefined || boundary.sample !== expectedSample
            || boundary.evidence !== region.evidence
            || typeof boundary.energyConfirmed !== 'boolean' || boundary.energyConfirmed !== expectedEnergy
            || (index > 0 && boundary.sample < previousSample)
            || edgeKeys.has(edgeKey)) {
            addIssue('invalid-transcript-body', boundaryPath,
                'Edit boundaries must uniquely reference the matching sorted speech-region edge.');
        }
        if (isSha256Digest(boundary.id)) boundaryIds.add(boundary.id);
        edgeKeys.add(edgeKey);
        if (isNonNegativeSafeInteger(boundary.sample)) {
            previousSample = Math.max(previousSample, boundary.sample);
        }
    });
    regions.forEach((region) => {
        if (!edgeKeys.has(`${region.id}:speech_start`) || !edgeKeys.has(`${region.id}:speech_end`)) {
            addIssue('invalid-transcript-body', `${path}.editBoundaries`,
                'Every speech region must provide one start and one end edit boundary.');
        }
    });
    return boundaryIds;
}

function validateHydratedNarrativeReferences(
    graph: V4GraphView,
    bodies: ResolvedEditorialTranscriptMapV1,
    indexesByRecordId: Map<Sha256Digest, BodyIndexes>,
    addIssue: AddIssue,
): void {
    if (!graph.narrative) return;
    Object.entries(graph.narrative.blocks).forEach(([blockId, block]) => {
        const path = `narrative.blocks.${blockId}`;
        const body = bodies[block.transcriptRecordId];
        const indexes = indexesByRecordId.get(block.transcriptRecordId);
        if (!body || !indexes) return;
        if (block.kind === 'silence') {
            // Activation deliberately keeps a word cut by the outer crop as untranscribed
            // coverage because a block may reference only the complete editable word interval.
            // Reject only a fully retained word, which should have produced a speech occurrence.
            if (body.words.some((word) => isRecord(word)
                && word.editableStartSample >= block.coreStartSample
                && word.editableEndSample <= block.coreEndSample)) {
                addIssue('invalid-transcript-reference', path,
                    'A silence occurrence cannot cover a retained aligned source word.');
            }
            if ((block.evidence === 'no-audio') !== body.noAudioStream) {
                addIssue('invalid-transcript-reference', `${path}.evidence`,
                    'No-audio evidence must match the resolved full-source audio contract.');
            }
            return;
        }
        if (body.noAudioStream) {
            addIssue('invalid-transcript-reference', path,
                'A local no-audio transcript cannot back a speech occurrence.');
            return;
        }
        let previousWordIndex = -1;
        block.sourceWordIds.forEach((wordId, wordOccurrenceIndex) => {
            const bodyWordIndex = indexes.wordIndexById.get(wordId);
            if (bodyWordIndex === undefined) {
                addIssue('invalid-transcript-reference', `${path}.sourceWordIds[${wordOccurrenceIndex}]`,
                    'Narrative speech references a missing source word.');
                return;
            }
            const word = body.words[bodyWordIndex];
            if (bodyWordIndex <= previousWordIndex
                || word.editableStartSample < block.coreStartSample
                || word.editableEndSample > block.coreEndSample) {
                addIssue('invalid-transcript-reference', `${path}.sourceWordIds[${wordOccurrenceIndex}]`,
                    'Narrative source words must retain body order and fit inside the block core.');
            }
            previousWordIndex = bodyWordIndex;
        });
        Object.values(block.speakerOverrides).forEach((speakerId) => {
            if (!isNonEmptyTrimmedString(speakerId)) addIssue('invalid-transcript-reference', `${path}.speakerOverrides`,
                'Speaker overrides must use non-empty presentation identities.');
        });
    });
    const selection = graph.transientSelection;
    if (selection?.kind === 'narrative' && selection.boundary) {
        const block = graph.narrative.blocks[selection.blockId];
        const indexes = block ? indexesByRecordId.get(block.transcriptRecordId) : undefined;
        if (indexes && !indexes.boundaryIds.has(selection.boundary.boundaryId)) {
            addIssue('invalid-transcript-reference', 'transientSelection.boundary.boundaryId',
                'Selected edit boundary does not exist in the resolved transcript body.');
        }
    }
}

function getDependentTargetKey(link: EditorialDependentLinkV1): string | null {
    if (!isRecord(link.target)) return null;
    if (link.target.kind === 'video-clip') {
        return isSafeEditorId(link.target.clipId) ? `video:${link.target.clipId}` : null;
    }
    if (link.target.kind === 'audio-clip') {
        return isSafeEditorId(link.target.trackId) && isSafeEditorId(link.target.clipId)
            ? audioTargetKey(link.target.trackId, link.target.clipId)
            : null;
    }
    if (link.target.kind === 'subtitle') {
        return isSafeEditorId(link.target.trackId) && isSafeEditorId(link.target.subtitleId)
            ? subtitleTargetKey(link.target.trackId, link.target.subtitleId)
            : null;
    }
    return null;
}

function getAudioTargetInterval(graph: V4GraphView, clip: AudioClip): { start: number; end: number } | null {
    if (!isNonNegativeSafeInteger(clip.timelineStartFrame)) return null;
    const start = frameToOutputSample(clip.timelineStartFrame, graph.renderProfile.fps);
    if (isVideoSourceAudioClip(clip)) {
        const durationFrames = safeDetachedVideoDurationFrames(clip, graph.renderProfile);
        return durationFrames > 0
            ? { start, end: frameToOutputSample(clip.timelineStartFrame + durationFrames, graph.renderProfile.fps) }
            : null;
    }
    const source = graph.audioSources.find((candidate) => candidate.id === clip.source.audioSourceId);
    if (!source) return null;
    const duration = clip.timelineDurationSamples
        ?? nativeBoundaryToOutputSample(clip.sourceEndSample, source.nativeSampleRate)
        - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate);
    return isPositiveSafeInteger(duration) ? { start, end: start + duration } : null;
}

function validateUniqueSafeIds(values: readonly unknown[], path: string, addIssue: AddIssue): void {
    const ids = new Set<string>();
    values.forEach((value, index) => {
        if (typeof value !== 'string' || !isSafeEditorId(value)) {
            addIssue('invalid-id', `${path}[${index}]`, 'Expected a safe editor ID.');
        } else if (ids.has(value)) {
            addIssue('duplicate-id', `${path}[${index}]`, 'IDs in this list must be unique.');
        } else ids.add(value);
    });
}

/**
 * Transcript entity references cross the descriptor-only validation boundary before their CAS
 * bodies are available. Canonical records use SHA-256 IDs, while structural validation also
 * accepts an opaque editor-safe token so older projections can reach the hydrated corruption
 * check instead of being rejected before the referenced body is resolved. Hydrated validation
 * requires the entity catalog itself to use SHA-256 IDs and proves every reference by lookup.
 */
function isStableTranscriptReferenceId(value: unknown): value is string {
    return typeof value === 'string' && (isSha256Digest(value) || isSafeEditorId(value));
}

function validateUniqueStableReferenceIds(
    values: readonly unknown[],
    path: string,
    addIssue: AddIssue,
): void {
    const ids = new Set<string>();
    values.forEach((value, index) => {
        if (!isStableTranscriptReferenceId(value)) {
            addIssue('invalid-id', `${path}[${index}]`, 'Expected a stable transcript entity reference.');
        } else if (ids.has(value)) {
            addIssue('duplicate-id', `${path}[${index}]`, 'Transcript references in this list must be unique.');
        } else ids.add(value);
    });
}

function validateUniqueDigests(values: readonly unknown[], path: string, addIssue: AddIssue): void {
    const ids = new Set<Sha256Digest>();
    values.forEach((value, index) => {
        if (!isSha256Digest(value)) {
            addIssue('invalid-descriptor', `${path}[${index}]`, 'Expected a lowercase SHA-256 content address.');
        } else if (ids.has(value)) {
            addIssue('duplicate-descriptor', `${path}[${index}]`, 'Content addresses in this list must be unique.');
        } else ids.add(value);
    });
}

function toDocumentView(document: EditorDocumentV4): V4GraphView {
    return { ...document, rawRoot: document as unknown as Record<string, unknown> };
}

function safeVideoDurationFrames(clip: VideoClipV4, profile: RenderProfile): number {
    try {
        return getVideoClipDurationFramesV4(clip, profile);
    } catch {
        return 0;
    }
}

function safeDetachedVideoDurationFrames(clip: VideoSourceAudioClip, profile: RenderProfile): number {
    if (!Number.isFinite(clip.sourceStart) || !Number.isFinite(clip.sourceEnd) || clip.sourceEnd <= clip.sourceStart) {
        return 0;
    }
    try {
        return Math.max(1, secondsToFrames(clip.sourceEnd - clip.sourceStart, profile.fps, 'nearest'));
    } catch {
        return 0;
    }
}

function subtitleTargetKey(trackId: string, subtitleId: string): string {
    return `subtitle:${trackId}:${subtitleId}`;
}

function audioTargetKey(trackId: string, clipId: string): string {
    return `audio:${trackId}:${clipId}`;
}

function isVideoSourceAudioClip(clip: AudioClip): clip is VideoSourceAudioClip {
    return clip.source.kind === 'video-source-audio';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isIsoDate(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPositiveFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isHalfOpenSampleRange(start: unknown, end: unknown, maximum: number): boolean {
    return isNonNegativeSafeInteger(start) && isPositiveSafeInteger(end) && end > start && end <= maximum;
}

function isProbabilityOrNull(value: unknown): boolean {
    return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}
