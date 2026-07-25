/**
 * A SHA-256 content address or opaque identity digest.
 *
 * The template literal prevents accidental use of an unprefixed identifier at compile time.
 * Runtime readers must still use `isSha256Digest` to enforce exactly 64 lowercase hexadecimal
 * characters; TypeScript cannot express that length constraint without an impractical union.
 */
export type Sha256Digest = `sha256:${string}`;

/** Fixed source-time domain used by every editorial transcript and narrative core. */
export const EDITORIAL_TRANSCRIPT_SAMPLE_RATE_HZ = 16_000 as const;

/** Fixed project-time domain used by persisted dependent-link offsets. */
export const EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ = 48_000 as const;

export const EDITORIAL_TRANSCRIPT_REQUESTED_MODEL = 'qwen-1.7b-edit-max' as const;
export const EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA = 'edit-max-v1' as const;
export const EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION = 1 as const;
export const EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION = 1 as const;
export const EDITORIAL_CANONICAL_JSON_VERSION = 1 as const;
export const EDITORIAL_TRANSCRIPT_COVERAGE_VERSION = 2 as const;
export const EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION = 'range-merge-v1' as const;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Narrows unknown persisted input before it is accepted as a content address. */
export function isSha256Digest(value: unknown): value is Sha256Digest {
    return typeof value === 'string' && SHA256_DIGEST_PATTERN.test(value);
}

export type EditorialSpeakerMode = 'none' | 'diarized';
export type EditorialTranscriptAcquisition = 'provider' | 'local-no-audio';

/**
 * Persisted provenance for one immutable editorial transcript record.
 *
 * This descriptor is the only transcript value allowed in EditorDocumentV4, history patches,
 * or the bundle manifest. In particular, it must never gain transcript text, aligned ranges,
 * a raw endpoint, an API key, or an Authorization value. The endpoint digest is deliberately
 * opaque: it supports request identity without making the configured URL part of project data.
 */
export interface EditorialTranscriptDescriptorV1 {
    version: 1;
    /** Content address of the final canonical body bytes. */
    recordId: Sha256Digest;
    /** Provenance/cache identity; it is intentionally distinct from the content-derived ID. */
    requestKey: Sha256Digest;
    sourceKind: 'video-source-audio';
    sourceId: string;
    sourceFingerprint: string;
    pcmAlgorithmVersion: 1;
    recordBodyVersion: 1;
    canonicalJsonVersion: 1;
    responseSchema: 'edit-max-v1';
    requestedModel: 'qwen-1.7b-edit-max';
    canonicalModel: string;
    sampleRateHz: 16_000;
    /** Exact full-source sample count; clip crops and selected ranges never change this value. */
    sampleCount: number;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    endpointIdentityDigest: Sha256Digest;
    acquisition: EditorialTranscriptAcquisition;
    createdAt: string;
}

/** A normalized half-open range in an explicitly declared sample-rate domain. */
export interface HalfOpenSampleRange {
    startSample: number;
    endSample: number;
}

export interface TranscriptionAcquisitionWindowV2 {
    /** Stable content-derived identity for the exact core and decoded ranges. */
    windowId: Sha256Digest;
    core: HalfOpenSampleRange;
    decoded: HalfOpenSampleRange;
    /** Immutable provider/local chunk records used by the deterministic merge. */
    chunkRecordIds: Sha256Digest[];
}

/**
 * Immutable proof of which parts of a source were acquired for one transcript.
 *
 * The record ID is the hash of the canonical record without `recordId`. Coverage is source
 * absolute, normalized, sorted, disjoint, and half-open. Context lives only in `decoded`; it
 * never grants narrative ownership outside `coreCoverage`.
 */
export interface TranscriptionCoverageRecordV2 {
    version: 2;
    recordId: Sha256Digest;
    sourceFingerprint: string;
    sourceSampleRate: number;
    sourceSampleCount: number;
    acquisitionProfileDigest: Sha256Digest;
    endpointIdentityDigest: Sha256Digest;
    contextSamples: number;
    requestedModel: string;
    responseSchema: string;
    pcmAlgorithmVersion: number;
    providerProfileVersion: number;
    language: string;
    speakerMode: EditorialSpeakerMode;
    mergeAlgorithmVersion: typeof EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION;
    coreCoverage: HalfOpenSampleRange[];
    acquisitionWindows: TranscriptionAcquisitionWindowV2[];
    mergedTranscriptRecordId: Sha256Digest;
}

/**
 * Range-covered descriptor accepted by the V4 graph without changing its root version.
 *
 * The merged transcript remains an ordinary canonical V1 record body with absolute source
 * coordinates. The separate coverage record proves that it is intentionally partial.
 */
export interface EditorialTranscriptDescriptorV2 {
    version: 2;
    recordId: Sha256Digest;
    coverageRecordId: Sha256Digest;
    requestKey: Sha256Digest;
    sourceKind: 'video-source-audio';
    sourceId: string;
    sourceFingerprint: string;
    pcmAlgorithmVersion: 1;
    recordBodyVersion: 1;
    canonicalJsonVersion: 1;
    coverageVersion: 2;
    responseSchema: 'edit-max-v1';
    requestedModel: 'qwen-1.7b-edit-max';
    canonicalModel: string;
    sampleRateHz: 16_000;
    /** Full source length. Coverage is held by the immutable coverage sidecar. */
    sampleCount: number;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    endpointIdentityDigest: Sha256Digest;
    acquisitionProfileDigest: Sha256Digest;
    mergeAlgorithmVersion: typeof EDITORIAL_TRANSCRIPT_MERGE_ALGORITHM_VERSION;
    acquisition: EditorialTranscriptAcquisition;
    createdAt: string;
}

/** Strict descriptor union persisted by EditorDocumentV4 and bundle manifests. */
export type EditorialTranscriptDescriptor =
    | EditorialTranscriptDescriptorV1
    | EditorialTranscriptDescriptorV2;

/** Evidence accepted from the frozen edit-max-v1 response profile. */
export type EditorialSpeechRegionEvidenceV1 =
    | 'alignment_acoustic'
    | 'alignment_only'
    | 'acoustic_only';

/**
 * One immutable source word in the canonical transcript body.
 *
 * Aligned bounds preserve provider evidence. Editable bounds are the deterministic,
 * non-overlapping half-open ranges produced by normalization. Narrative corrections refer to
 * `id` and live on a block instance; they never rewrite this source text or either timing pair.
 */
export interface EditorialWordV1 {
    id: string;
    text: string;
    alignedStartSample: number;
    alignedEndSample: number;
    editableStartSample: number;
    editableEndSample: number;
    probability: number | null;
    speakerId: string | null;
}

/** A source-backed region retained from edit-max-v1 diagnostics. */
export interface EditorialSpeechRegionV1 {
    id: string;
    /** Integer identifier supplied by the provider before stable-ID normalization. */
    providerRegionId: number;
    startSample: number;
    endSample: number;
    evidence: EditorialSpeechRegionEvidenceV1;
    /** Half-open indexes into `EditorialTranscriptRecordBodyV1.words`, when supplied. */
    wordStartIndex: number | null;
    wordEndIndex: number | null;
    vadPeakProbability: number | null;
    vadMeanProbability: number | null;
    startEnergyConfirmed: boolean;
    endEnergyConfirmed: boolean;
}

export type EditorialEditBoundaryTypeV1 = 'speech_start' | 'speech_end';

/** One stable source-sample boundary tied to a normalized speech region. */
export interface EditorialEditBoundaryV1 {
    id: string;
    regionId: string;
    type: EditorialEditBoundaryTypeV1;
    sample: number;
    evidence: EditorialSpeechRegionEvidenceV1;
    energyConfirmed: boolean;
}

/** A half-open diarization segment in the same 16 kHz source-time domain as words. */
export interface EditorialSpeakerSegmentV1 {
    startSample: number;
    endSample: number;
}

/** Stable speaker evidence. `label` remains immutable provider evidence, not UI identity. */
export interface EditorialSpeakerV1 {
    id: string;
    label: string;
    segments: EditorialSpeakerSegmentV1[];
}

/**
 * Canonical content-addressed transcript body stored only in the editorial CAS or a bundle
 * sidecar.
 *
 * `recordId` is intentionally absent because it is the SHA-256 of the canonical bytes and
 * cannot hash itself. Request identity, project/source IDs, endpoint identity and `createdAt`
 * are descriptor/index metadata and are also excluded from these bytes. `contentNamespace` is
 * the preliminary canonical-content hash used to derive stable word/region/boundary/speaker
 * IDs before the final body hash is computed.
 */
export interface EditorialTranscriptRecordBodyV1 {
    version: 1;
    canonicalJsonVersion: 1;
    contentNamespace: Sha256Digest;
    sourceFingerprint: string;
    pcmAlgorithmVersion: 1;
    sampleRateHz: 16_000;
    sampleCount: number;
    timeOrigin: 'decoded_audio_start';
    requestedModel: 'qwen-1.7b-edit-max';
    canonicalModel: string;
    profile: 'edit-max-v1';
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    noAudioStream: boolean;
    words: EditorialWordV1[];
    speechRegions: EditorialSpeechRegionV1[];
    editBoundaries: EditorialEditBoundaryV1[];
    speakers: EditorialSpeakerV1[];
}

type ResolvedEditorialSpeakerV1 = Readonly<Omit<EditorialSpeakerV1, 'segments'>> & {
    readonly segments: readonly Readonly<EditorialSpeakerSegmentV1>[];
};

/** Deep-readonly body exposed only after the runtime resolver verifies CAS bytes and identity. */
export type ResolvedEditorialTranscriptRecordBodyV1 = Readonly<Omit<
    EditorialTranscriptRecordBodyV1,
    'words' | 'speechRegions' | 'editBoundaries' | 'speakers'
>> & {
    readonly words: readonly Readonly<EditorialWordV1>[];
    readonly speechRegions: readonly Readonly<EditorialSpeechRegionV1>[];
    readonly editBoundaries: readonly Readonly<EditorialEditBoundaryV1>[];
    readonly speakers: readonly ResolvedEditorialSpeakerV1[];
};

/**
 * Non-persisted resolver input injected into selectors and pure command planners.
 *
 * Keeping this map separate from EditorDocumentV4 makes it impossible for ordinary document,
 * history, autosave, or bundle serialization to pick up a full transcript body by walking the
 * editor graph. Consumers must treat every value as immutable and must not retain credentials
 * or acquisition errors alongside it.
 */
export type ResolvedEditorialTranscriptMapV1 = Readonly<
    Record<Sha256Digest, ResolvedEditorialTranscriptRecordBodyV1>
>;

export const GLOBAL_EDITING_MODES = ['ripple', 'absolute'] as const;
export type GlobalEditingMode = (typeof GLOBAL_EDITING_MODES)[number];

export interface NarrativeSettingsV1 {
    globalPreMarginSamples: number;
    globalPostMarginSamples: number;
    boundaryRefinementEnabled: boolean;
    showSpeakers: boolean;
}

export interface MarginBoundaryPolicyV1 {
    kind: 'margin';
    mode: 'inherit-global' | 'explicit';
    /** Null is valid only for inherit-global; validators enforce the mode/value relationship. */
    requestedSamples: number | null;
}

/**
 * One side of a duration-preserving split.
 *
 * Matching seam IDs preserve the exact pre-split output frame across sibling blocks. A seam is
 * not a margin and must not be rematerialized by later global-margin changes. Only an explicit
 * user command may replace one seam side with a margin boundary.
 */
export interface PartitionSeamBoundaryPolicyV1 {
    kind: 'partition-seam';
    seamId: string;
}

export type MaterializedBoundaryPolicyV1 =
    | MarginBoundaryPolicyV1
    | PartitionSeamBoundaryPolicyV1;

/**
 * Exact source frames currently present in the montage.
 *
 * Narrative core timing is stored in 16 kHz source samples, while the renderable occurrence is
 * stored in source video frames. These bounds are authoritative output media and must never be
 * reconstructed from word times or margins during playback/export. Margin validators may
 * recompute expected bounds; partition seams instead validate against paired split lineage.
 */
export interface NarrativeMaterializationV1 {
    sourceStartFrame: number;
    sourceEndFrame: number;
    preBoundary: MaterializedBoundaryPolicyV1;
    postBoundary: MaterializedBoundaryPolicyV1;
}

export type NarrativeBoundaryRefinementOriginV1 = 'manual' | 'quiet-assisted';

/** Instance-local provenance for a refined semantic boundary; CAS timing remains immutable. */
export interface NarrativeBoundaryRefinementV1 {
    originalSample: number;
    chosenSample: number;
    algorithmVersion: number;
    origin: NarrativeBoundaryRefinementOriginV1;
}

export interface NarrativeBlockCommonV1 {
    id: string;
    /** Unique occurrence identity, even when another block uses the same source interval. */
    instanceId: string;
    lineageRootId: string;
    parentInstanceIds: string[];
    clipId: string;
    /** Track ownership survives unified cross-track reorder and every recovery operation. */
    trackId: string;
    sourceId: string;
    transcriptRecordId: Sha256Digest;
    /** Instance-stable identity for this exact source-backed interval occurrence. */
    sourceIntervalId: string;
    /** Half-open semantic bounds in the fixed 16 kHz full-source sample domain. */
    coreStartSample: number;
    coreEndSample: number;
    materialization: NarrativeMaterializationV1;
    /** Exact explicit project placement; block end is derived from the owned V4 clip duration. */
    timelineStartFrame: number;
    startBoundaryRefinement: NarrativeBoundaryRefinementV1 | null;
    endBoundaryRefinement: NarrativeBoundaryRefinementV1 | null;
    revision: number;
}

/** Sparse source-word-ID to non-empty instance-local replacement text. */
export type NarrativeWordTextOverridesV1 = Record<string, string>;

/** Sparse source-word-ID to instance-local presentation speaker identity. */
export type NarrativeSpeakerOverridesV1 = Record<string, string>;

export interface NarrativeSpeechBlockV1 extends NarrativeBlockCommonV1 {
    kind: 'speech';
    /** Ordered source word occurrences; implementations must never sort or deduplicate them. */
    sourceWordIds: string[];
    wordTextOverrides: NarrativeWordTextOverridesV1;
    speakerOverrides: NarrativeSpeakerOverridesV1;
}

export type NarrativeSilenceEvidenceV1 = 'quiet' | 'no-audio' | 'acoustic-only' | 'unknown';

export interface NarrativeSilenceBlockV1 extends NarrativeBlockCommonV1 {
    kind: 'silence';
    /** The empty tuple makes the no-word invariant explicit at the type boundary. */
    sourceWordIds: [];
    evidence: NarrativeSilenceEvidenceV1;
    wordTextOverrides?: never;
    speakerOverrides?: never;
}

export type NarrativeBlockV1 = NarrativeSpeechBlockV1 | NarrativeSilenceBlockV1;

/**
 * The one durable document-wide narrative.
 *
 * `blockIds` is the only ordered sequence, including when blocks belong to several controlled
 * video tracks. `sourceRecordIds` is a descriptor-ID recovery catalog and may remain populated
 * after every block is deleted. Neither field contains or aliases a transcript body.
 */
export interface NarrativeDocumentV1 {
    version: 1;
    id: string;
    revision: number;
    controlledTrackIds: string[];
    blockIds: string[];
    blocks: Record<string, NarrativeBlockV1>;
    sourceRecordIds: Sha256Digest[];
    settings: NarrativeSettingsV1;
    createdAt: string;
    updatedAt: string;
}

export interface TranscriptFragmentBindingV1 {
    version: 1;
    bindingId: string;
    transcriptRecordId: Sha256Digest;
    sourceIntervalId: string;
    /** Non-empty half-open exact fragment in the immutable 16 kHz source-time domain. */
    activeStartSample: number;
    activeEndSample: number;
    /** Prevents an equal source range in a different occurrence from stealing the binding. */
    lineageRootId: string;
    /** Immutable audit provenance; the live anchor may change after split or merge. */
    createdFromBlockId: string;
}

export type EditorialLinkAssociationV1 =
    | {
        kind: 'overlap';
        origin: 'auto' | 'manual';
    }
    | {
        kind: 'transcript-bound';
        binding: TranscriptFragmentBindingV1;
    };

export type EditorialDependentTargetV1 =
    | { kind: 'video-clip'; clipId: string }
    | { kind: 'audio-clip'; trackId: string; clipId: string }
    | { kind: 'subtitle'; trackId: string; subtitleId: string };

/**
 * Durable relationship between a controlled narrative occurrence and an uncontrolled target.
 *
 * Relative offsets are half-open values in the fixed 48 kHz project output-sample domain.
 * Video publication snaps to output frames, independent audio keeps exact samples, and subtitle
 * code converts only at its existing seconds-storage boundary. A link never grants narrative
 * ownership to its target.
 */
export interface EditorialDependentLinkV1 {
    version: 1;
    id: string;
    anchorBlockId: string;
    target: EditorialDependentTargetV1;
    association: EditorialLinkAssociationV1;
    followPolicy: 'none' | 'follow';
    relativeStartOutputSample: number;
    relativeEndOutputSample: number;
    revision: number;
}

/** Stable, runtime-only selection projected by both Text and Timeline workspaces. */
export interface TransientNarrativeSelectionV1 {
    kind: 'narrative';
    trackId: string;
    blockId: string;
    sourceWordIds: string[];
    boundary: {
        boundaryId: string;
        side: 'start' | 'end';
    } | null;
}
