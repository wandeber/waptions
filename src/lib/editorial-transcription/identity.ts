import {
    EDITORIAL_CANONICAL_JSON_VERSION,
    EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
    EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
    EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
    EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
    type EditorialSpeakerMode,
    type EditorialTranscriptAcquisition,
    type EditorialTranscriptDescriptor,
    type EditorialTranscriptDescriptorV2,
    type EditorialTranscriptDescriptorV1,
    type EditorialTranscriptRecordBodyV1,
    type Sha256Digest,
    type TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import { sha256CanonicalJson } from './canonical-json';

export interface EditorialTranscriptRequestIdentityV1 {
    sourceFingerprint: string;
    sampleCount: number;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    endpointIdentityDigest: Sha256Digest;
}

export async function createEditorialTranscriptRequestKey(
    identity: EditorialTranscriptRequestIdentityV1,
): Promise<Sha256Digest> {
    if (!identity.sourceFingerprint.trim()) throw new Error('Editorial source fingerprint is required.');
    if (!Number.isSafeInteger(identity.sampleCount) || identity.sampleCount < 0) {
        throw new Error('Editorial request sample count must be a non-negative safe integer.');
    }
    return sha256CanonicalJson({
        sourceKind: 'video-source-audio',
        sourceFingerprint: identity.sourceFingerprint,
        pcmAlgorithmVersion: EDITORIAL_TRANSCRIPT_PCM_ALGORITHM_VERSION,
        sampleCount: identity.sampleCount,
        requestedModel: EDITORIAL_TRANSCRIPT_REQUESTED_MODEL,
        profile: EDITORIAL_TRANSCRIPT_RESPONSE_SCHEMA,
        recordBodyVersion: EDITORIAL_TRANSCRIPT_RECORD_BODY_VERSION,
        parserVersion: 1,
        canonicalJsonVersion: EDITORIAL_CANONICAL_JSON_VERSION,
        language: identity.language,
        speakerMode: identity.speakerMode,
        endpointIdentityDigest: identity.endpointIdentityDigest,
    });
}

export function createEditorialTranscriptDescriptor(input: {
    recordId: Sha256Digest;
    requestKey: Sha256Digest;
    sourceId: string;
    sourceFingerprint: string;
    endpointIdentityDigest: Sha256Digest;
    body: EditorialTranscriptRecordBodyV1;
    acquisition: EditorialTranscriptAcquisition;
    createdAt?: string;
}): EditorialTranscriptDescriptorV1 {
    const descriptor: EditorialTranscriptDescriptorV1 = {
        version: 1,
        recordId: input.recordId,
        requestKey: input.requestKey,
        sourceKind: 'video-source-audio',
        sourceId: input.sourceId,
        sourceFingerprint: input.sourceFingerprint,
        pcmAlgorithmVersion: 1,
        recordBodyVersion: 1,
        canonicalJsonVersion: 1,
        responseSchema: 'edit-max-v1',
        requestedModel: 'qwen-1.7b-edit-max',
        canonicalModel: input.body.canonicalModel,
        sampleRateHz: 16_000,
        sampleCount: input.body.sampleCount,
        language: input.body.language,
        speakerMode: input.body.speakerMode,
        endpointIdentityDigest: input.endpointIdentityDigest,
        acquisition: input.acquisition,
        createdAt: input.createdAt ?? new Date().toISOString(),
    };
    assertEditorialDescriptorMatchesBody(descriptor, input.body);
    return descriptor;
}

export function assertEditorialDescriptorMatchesBody(
    descriptor: EditorialTranscriptDescriptor,
    body: EditorialTranscriptRecordBodyV1,
): void {
    if (
        descriptor.sourceFingerprint !== body.sourceFingerprint
        || descriptor.pcmAlgorithmVersion !== body.pcmAlgorithmVersion
        || descriptor.recordBodyVersion !== body.version
        || descriptor.canonicalJsonVersion !== body.canonicalJsonVersion
        || descriptor.responseSchema !== body.profile
        || descriptor.requestedModel !== body.requestedModel
        || descriptor.canonicalModel !== body.canonicalModel
        || descriptor.sampleRateHz !== body.sampleRateHz
        || descriptor.sampleCount !== body.sampleCount
        || descriptor.language !== body.language
        || descriptor.speakerMode !== body.speakerMode
        || (descriptor.acquisition === 'local-no-audio') !== body.noAudioStream
    ) {
        throw new Error('Editorial transcript descriptor does not match its immutable body.');
    }
}

export function createEditorialTranscriptDescriptorV2(input: {
    recordId: Sha256Digest;
    coverageRecord: TranscriptionCoverageRecordV2;
    requestKey: Sha256Digest;
    sourceId: string;
    sourceFingerprint: string;
    endpointIdentityDigest: Sha256Digest;
    body: EditorialTranscriptRecordBodyV1;
    acquisition: EditorialTranscriptAcquisition;
    createdAt?: string;
}): EditorialTranscriptDescriptorV2 {
    if (input.coverageRecord.mergedTranscriptRecordId !== input.recordId
        || input.coverageRecord.sourceFingerprint !== input.sourceFingerprint
        || input.coverageRecord.sourceSampleRate !== input.body.sampleRateHz
        || input.coverageRecord.sourceSampleCount !== input.body.sampleCount
        || input.coverageRecord.speakerMode !== input.body.speakerMode
        || input.coverageRecord.language !== (input.body.language ?? 'auto')) {
        throw new Error('Editorial coverage record does not match its merged transcript.');
    }
    const descriptor: EditorialTranscriptDescriptorV2 = {
        version: 2,
        recordId: input.recordId,
        coverageRecordId: input.coverageRecord.recordId,
        requestKey: input.requestKey,
        sourceKind: 'video-source-audio',
        sourceId: input.sourceId,
        sourceFingerprint: input.sourceFingerprint,
        pcmAlgorithmVersion: 1,
        recordBodyVersion: 1,
        canonicalJsonVersion: 1,
        coverageVersion: 2,
        responseSchema: 'edit-max-v1',
        requestedModel: 'qwen-1.7b-edit-max',
        canonicalModel: input.body.canonicalModel,
        sampleRateHz: 16_000,
        sampleCount: input.body.sampleCount,
        language: input.body.language,
        speakerMode: input.body.speakerMode,
        endpointIdentityDigest: input.endpointIdentityDigest,
        acquisitionProfileDigest: input.coverageRecord.acquisitionProfileDigest,
        mergeAlgorithmVersion: input.coverageRecord.mergeAlgorithmVersion,
        acquisition: input.acquisition,
        createdAt: input.createdAt ?? new Date().toISOString(),
    };
    assertEditorialDescriptorMatchesBody(descriptor, input.body);
    return descriptor;
}
