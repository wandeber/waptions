import {
    EDITORIAL_CANONICAL_JSON_VERSION,
    EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
    EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
    EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
    EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
    EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
    type EditorialDependentLinkV1,
    type EditorialTranscriptDescriptorV1,
    type EditorialTranscriptRecordBodyV1,
    type NarrativeDocumentV1,
    type NarrativeSilenceBlockV1,
    type NarrativeSpeechBlockV1,
    type Sha256Digest,
    type TranscriptFragmentBindingV1,
} from './editorial';
import type { AnimationStyle, SubtitleTrackV4 } from './timeline';
import type {
    EditorDocumentV4,
    EditorManifestV4,
    VideoSourceAssetV3,
} from './video';

/**
 * Shared shape-valid hashes for structural tests. Tests that verify canonical bytes must replace
 * `EDITORIAL_TEST_RECORD_ID` with the hash produced by the canonicalizer under test.
 */
export const EDITORIAL_TEST_RECORD_ID = `sha256:${'a'.repeat(64)}` as Sha256Digest;
export const EDITORIAL_TEST_REQUEST_KEY = `sha256:${'b'.repeat(64)}` as Sha256Digest;
export const EDITORIAL_TEST_CONTENT_NAMESPACE = `sha256:${'c'.repeat(64)}` as Sha256Digest;
export const EDITORIAL_TEST_ENDPOINT_DIGEST = `sha256:${'d'.repeat(64)}` as Sha256Digest;

const createTestFile = (
    name = 'editorial-video.webm',
    type = 'video/webm',
    size = 1_024,
    lastModified = 1_700_000_000_000,
): File => ({ name, type, size, lastModified } as File);

export function createEditorialTranscriptDescriptorFixture(
    overrides: Partial<EditorialTranscriptDescriptorV1> = {},
): EditorialTranscriptDescriptorV1 {
    return {
        version: 1,
        recordId: EDITORIAL_TEST_RECORD_ID,
        requestKey: EDITORIAL_TEST_REQUEST_KEY,
        sourceKind: 'video-source-audio',
        sourceId: 'video_source_editorial',
        sourceFingerprint: 'editorial-source-fingerprint',
        pcmAlgorithmVersion: EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
        recordBodyVersion: EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
        canonicalJsonVersion: EDITORIAL_CANONICAL_JSON_VERSION,
        responseSchema: EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
        requestedModel: EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
        canonicalModel: 'qwen-1.7b-edit-max-runtime',
        sampleRateHz: EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
        sampleCount: 160_000,
        language: 'en',
        speakerMode: 'none',
        endpointIdentityDigest: EDITORIAL_TEST_ENDPOINT_DIGEST,
        acquisition: 'provider',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

export function createEditorialTranscriptBodyFixture(
    overrides: Partial<EditorialTranscriptRecordBodyV1> = {},
): EditorialTranscriptRecordBodyV1 {
    return {
        version: 1,
        canonicalJsonVersion: EDITORIAL_CANONICAL_JSON_VERSION,
        contentNamespace: EDITORIAL_TEST_CONTENT_NAMESPACE,
        sourceFingerprint: 'editorial-source-fingerprint',
        pcmAlgorithmVersion: EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
        sampleRateHz: EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ,
        sampleCount: 160_000,
        timeOrigin: 'decoded_audio_start',
        requestedModel: EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
        canonicalModel: 'qwen-1.7b-edit-max-runtime',
        profile: EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
        language: 'en',
        speakerMode: 'none',
        noAudioStream: false,
        words: [{
            id: 'editorial_word_1',
            text: 'Hello',
            alignedStartSample: 0,
            alignedEndSample: 16_000,
            editableStartSample: 0,
            editableEndSample: 16_000,
            probability: 0.99,
            speakerId: null,
        }],
        speechRegions: [{
            id: 'editorial_region_1',
            providerRegionId: 1,
            startSample: 0,
            endSample: 16_000,
            evidence: 'alignment_acoustic',
            wordStartIndex: 0,
            wordEndIndex: 1,
            vadPeakProbability: 0.99,
            vadMeanProbability: 0.95,
            startEnergyConfirmed: true,
            endEnergyConfirmed: true,
        }],
        editBoundaries: [{
            id: 'editorial_boundary_start_1',
            regionId: 'editorial_region_1',
            type: 'speech_start',
            sample: 0,
            evidence: 'alignment_acoustic',
            energyConfirmed: true,
        }, {
            id: 'editorial_boundary_end_1',
            regionId: 'editorial_region_1',
            type: 'speech_end',
            sample: 16_000,
            evidence: 'alignment_acoustic',
            energyConfirmed: true,
        }],
        speakers: [],
        ...overrides,
    };
}

export function createTranscriptFragmentBindingFixture(
    overrides: Partial<TranscriptFragmentBindingV1> = {},
): TranscriptFragmentBindingV1 {
    return {
        version: 1,
        bindingId: 'transcript_binding_1',
        transcriptRecordId: EDITORIAL_TEST_RECORD_ID,
        sourceIntervalId: 'source_interval_1',
        activeStartSample: 0,
        activeEndSample: 16_000,
        lineageRootId: 'narrative_lineage_1',
        createdFromBlockId: 'narrative_block_1',
        ...overrides,
    };
}

export function createEditorialDependentLinkFixture(
    overrides: Partial<EditorialDependentLinkV1> = {},
): EditorialDependentLinkV1 {
    return {
        version: 1,
        id: 'editorial_link_1',
        anchorBlockId: 'narrative_block_1',
        target: { kind: 'subtitle', trackId: 'subtitle_track_editorial', subtitleId: 'subtitle_1' },
        association: {
            kind: 'transcript-bound',
            binding: createTranscriptFragmentBindingFixture(),
        },
        followPolicy: 'none',
        relativeStartOutputSample: 0,
        relativeEndOutputSample: 48_000,
        revision: 1,
        ...overrides,
    };
}

export function createNarrativeSpeechBlockFixture(
    overrides: Partial<NarrativeSpeechBlockV1> = {},
): NarrativeSpeechBlockV1 {
    return {
        id: 'narrative_block_1',
        instanceId: 'narrative_instance_1',
        lineageRootId: 'narrative_lineage_1',
        parentInstanceIds: [],
        kind: 'speech',
        clipId: 'video_clip_editorial',
        trackId: 'video_track_editorial',
        sourceId: 'video_source_editorial',
        transcriptRecordId: EDITORIAL_TEST_RECORD_ID,
        sourceIntervalId: 'source_interval_1',
        coreStartSample: 0,
        coreEndSample: 16_000,
        materialization: {
            sourceStartFrame: 0,
            sourceEndFrame: 30,
            preBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
            postBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
        },
        timelineStartFrame: 0,
        sourceWordIds: ['editorial_word_1'],
        wordTextOverrides: {},
        speakerOverrides: {},
        startBoundaryRefinement: null,
        endBoundaryRefinement: null,
        revision: 1,
        ...overrides,
    };
}

export function createNarrativeSilenceBlockFixture(
    overrides: Partial<NarrativeSilenceBlockV1> = {},
): NarrativeSilenceBlockV1 {
    return {
        id: 'narrative_silence_1',
        instanceId: 'narrative_silence_instance_1',
        lineageRootId: 'narrative_silence_lineage_1',
        parentInstanceIds: [],
        kind: 'silence',
        clipId: 'video_clip_silence',
        trackId: 'video_track_editorial',
        sourceId: 'video_source_editorial',
        transcriptRecordId: EDITORIAL_TEST_RECORD_ID,
        sourceIntervalId: 'source_interval_silence_1',
        coreStartSample: 16_000,
        coreEndSample: 32_000,
        materialization: {
            sourceStartFrame: 30,
            sourceEndFrame: 60,
            preBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
            postBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
        },
        timelineStartFrame: 30,
        sourceWordIds: [],
        evidence: 'quiet',
        startBoundaryRefinement: null,
        endBoundaryRefinement: null,
        revision: 1,
        ...overrides,
    };
}

export function createNarrativeDocumentFixture(
    overrides: Partial<NarrativeDocumentV1> = {},
): NarrativeDocumentV1 {
    const block = createNarrativeSpeechBlockFixture();
    return {
        version: 1,
        id: 'narrative_document_1',
        revision: 1,
        controlledTrackIds: [block.trackId],
        blockIds: [block.id],
        blocks: { [block.id]: block },
        sourceRecordIds: [EDITORIAL_TEST_RECORD_ID],
        settings: {
            globalPreMarginSamples: 0,
            globalPostMarginSamples: 0,
            boundaryRefinementEnabled: true,
            showSpeakers: false,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

export function createSubtitleTrackV4Fixture(
    overrides: Partial<SubtitleTrackV4> = {},
): SubtitleTrackV4 {
    return {
        id: 'subtitle_track_editorial',
        name: 'Editorial subtitles',
        style: {} as AnimationStyle,
        subtitles: [],
        isVisible: true,
        isLocked: false,
        unlinkedVideoEditResponse: 'stay-absolute',
        ...overrides,
    };
}

export function createVideoSourceAssetV4Fixture(
    overrides: Partial<VideoSourceAssetV3> = {},
): VideoSourceAssetV3 {
    const file = overrides.file ?? createTestFile();
    return {
        id: 'video_source_editorial',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: 'editorial-source-fingerprint',
        duration: 10,
        fps: 30,
        width: 1_920,
        height: 1_080,
        bitrate: 5_000_000,
        hasAudio: true,
        file,
        ...overrides,
    };
}

export function createEditorDocumentV4Fixture(
    overrides: Partial<EditorDocumentV4> = {},
): EditorDocumentV4 {
    const narrative = createNarrativeDocumentFixture();
    return {
        version: 4,
        revision: 1,
        audioGraphRevision: 0,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 },
            width: 1_920,
            height: 1_080,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        subtitleTracks: [],
        videoSources: [createVideoSourceAssetV4Fixture()],
        videoClips: [{
            id: 'video_clip_editorial',
            sourceId: 'video_source_editorial',
            trackId: 'video_track_editorial',
            timelineStartFrame: 0,
            sourceStart: 0,
            sourceEnd: 1,
            audio: {
                linkState: 'linked',
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        }],
        videoTracks: [{
            id: 'video_track_editorial',
            name: 'Editorial video',
            visible: true,
            locked: false,
        }],
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
        globalEditingMode: 'ripple',
        editorialTranscriptDescriptors: [createEditorialTranscriptDescriptorFixture()],
        narrative,
        dependentLinks: [],
        ...overrides,
    };
}

export function createEditorManifestV4Fixture(
    overrides: Partial<EditorManifestV4> = {},
): EditorManifestV4 {
    const document = createEditorDocumentV4Fixture();
    return {
        version: 4,
        revision: document.revision,
        audioGraphRevision: document.audioGraphRevision,
        renderProfile: document.renderProfile,
        subtitleTracks: document.subtitleTracks,
        videoSourceDescriptors: document.videoSources.map(({ file, ...descriptor }) => {
            void file;
            return descriptor;
        }),
        videoClips: document.videoClips,
        videoTracks: document.videoTracks,
        audioSourceDescriptors: [],
        audioTracks: document.audioTracks,
        activeSubtitleTrackId: document.activeSubtitleTrackId,
        transcriptionByTrackId: document.transcriptionByTrackId,
        globalEditingMode: document.globalEditingMode,
        editorialTranscriptDescriptors: document.editorialTranscriptDescriptors,
        narrative: document.narrative,
        dependentLinks: document.dependentLinks,
        ...overrides,
    };
}
