import { describe, expect, it } from 'vitest';
import type {
    Sha256Digest,
    TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import {
    createTranscriptionCoverageRecordV2,
    planIncrementalTranscriptionCoverage,
} from './range-coverage';
import { createRangeTranscriptChunkRecord } from './range-orchestrator';
import {
    IndexedRangeTranscriptionRepository,
    type RangeTranscriptionRepositoryDriver,
} from './range-repository';

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}`;

class MemoryDriver implements RangeTranscriptionRepositoryDriver {
    chunks = new Map<Sha256Digest, unknown>();
    coverage = new Map<Sha256Digest, unknown>();

    async getChunk(recordId: Sha256Digest) {
        return this.chunks.get(recordId) ?? null;
    }
    async putChunkIfAbsent(record: { recordId: Sha256Digest }) {
        const existing = this.chunks.get(record.recordId) ?? null;
        if (existing === null) this.chunks.set(record.recordId, structuredClone(record));
        return existing;
    }
    async getCoverage(recordId: Sha256Digest) {
        return this.coverage.get(recordId) ?? null;
    }
    async putCoverageIfAbsent(record: TranscriptionCoverageRecordV2) {
        const existing = this.coverage.get(record.recordId) ?? null;
        if (existing === null) this.coverage.set(record.recordId, structuredClone(record));
        return existing;
    }
    async listCoverage() {
        return Array.from(this.coverage.values());
    }
    async compareAndSwapCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
        expectedRecordIds: readonly Sha256Digest[];
        record: TranscriptionCoverageRecordV2;
    }) {
        const currentRecordIds = Array.from(this.coverage.values())
            .filter((value): value is TranscriptionCoverageRecordV2 => (
                typeof value === 'object'
                && value !== null
                && (value as TranscriptionCoverageRecordV2).sourceFingerprint === input.sourceFingerprint
                && (value as TranscriptionCoverageRecordV2).acquisitionProfileDigest
                    === input.acquisitionProfileDigest
            ))
            .map(value => value.recordId)
            .sort();
        const swapped = JSON.stringify(currentRecordIds) === JSON.stringify(input.expectedRecordIds);
        const existingRecord = this.coverage.get(input.record.recordId) ?? null;
        if (swapped && existingRecord === null) {
            this.coverage.set(input.record.recordId, structuredClone(input.record));
        }
        return { swapped, existingRecord };
    }
}

describe('range transcription repository', () => {
    it('stores immutable verified chunks and coverage without accepting secret-shaped extras', async () => {
        const driver = new MemoryDriver();
        const repository = new IndexedRangeTranscriptionRepository(driver);
        const profile = {
            sourceFingerprint: 'source',
            sourceSampleRate: 16_000,
            sourceSampleCount: 160_000,
            coreCoverage: [{ startSample: 10, endSample: 20 }],
            contextSamples: 0,
            language: 'es',
            speakerMode: 'none' as const,
            endpointIdentityDigest: digest('a'),
            requestedModel: 'qwen-1.7b-edit-max',
            responseSchema: 'edit-max-v1',
            pcmAlgorithmVersion: 1,
            providerProfileVersion: 1,
        };
        const plan = await planIncrementalTranscriptionCoverage({ profile });
        const chunk = await createRangeTranscriptChunkRecord({
            sourceFingerprint: 'source',
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            window: plan.acquisitionWindows[0],
            localWords: [{
                text: 'hello',
                startSample: 0,
                endSample: 1,
                probability: 0.9,
                speaker: null,
            }],
        });
        const coverage = await createTranscriptionCoverageRecordV2({
            sourceFingerprint: profile.sourceFingerprint,
            sourceSampleRate: profile.sourceSampleRate,
            sourceSampleCount: profile.sourceSampleCount,
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            endpointIdentityDigest: profile.endpointIdentityDigest,
            contextSamples: profile.contextSamples,
            requestedModel: profile.requestedModel,
            responseSchema: profile.responseSchema,
            pcmAlgorithmVersion: profile.pcmAlgorithmVersion,
            providerProfileVersion: profile.providerProfileVersion,
            language: profile.language,
            speakerMode: profile.speakerMode,
            coreCoverage: profile.coreCoverage,
            acquisitionWindows: [{
                ...plan.acquisitionWindows[0],
                chunkRecordIds: [chunk.recordId],
            }],
            mergedTranscriptRecordId: digest('b'),
        });

        await repository.putChunk(chunk);
        await repository.putCoverage(coverage);
        await expect(repository.getChunk(chunk.recordId)).resolves.toEqual(chunk);
        await expect(repository.getCoverage(coverage.recordId)).resolves.toEqual(coverage);

        await expect(repository.putChunk({
            ...chunk,
            apiKey: 'must-not-persist',
        } as typeof chunk)).rejects.toThrow('unsupported fields');
        await expect(repository.putCoverage({
            ...coverage,
            endpoint: 'http://secret.invalid',
        } as TranscriptionCoverageRecordV2)).rejects.toThrow('unsupported fields');
    });

    it('publishes a coverage family only when its observed record set still matches', async () => {
        const driver = new MemoryDriver();
        const repository = new IndexedRangeTranscriptionRepository(driver);
        const profile = {
            sourceFingerprint: 'source',
            sourceSampleRate: 16_000,
            sourceSampleCount: 160_000,
            coreCoverage: [{ startSample: 10, endSample: 20 }],
            contextSamples: 0,
            language: 'es',
            speakerMode: 'none' as const,
            endpointIdentityDigest: digest('a'),
            requestedModel: 'qwen-1.7b-edit-max',
            responseSchema: 'edit-max-v1',
            pcmAlgorithmVersion: 1,
            providerProfileVersion: 1,
        };
        const plan = await planIncrementalTranscriptionCoverage({ profile });
        const coverage = await createTranscriptionCoverageRecordV2({
            sourceFingerprint: profile.sourceFingerprint,
            sourceSampleRate: profile.sourceSampleRate,
            sourceSampleCount: profile.sourceSampleCount,
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            endpointIdentityDigest: profile.endpointIdentityDigest,
            contextSamples: profile.contextSamples,
            requestedModel: profile.requestedModel,
            responseSchema: profile.responseSchema,
            pcmAlgorithmVersion: profile.pcmAlgorithmVersion,
            providerProfileVersion: profile.providerProfileVersion,
            language: profile.language,
            speakerMode: profile.speakerMode,
            coreCoverage: profile.coreCoverage,
            acquisitionWindows: [],
            mergedTranscriptRecordId: digest('b'),
        });

        await expect(repository.compareAndSwapCoverage({
            sourceFingerprint: profile.sourceFingerprint,
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            expectedRecordIds: [],
            record: coverage,
        })).resolves.toBe(true);
        await expect(repository.compareAndSwapCoverage({
            sourceFingerprint: profile.sourceFingerprint,
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            expectedRecordIds: [],
            record: coverage,
        })).resolves.toBe(false);
        await expect(repository.compareAndSwapCoverage({
            sourceFingerprint: profile.sourceFingerprint,
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            expectedRecordIds: [coverage.recordId],
            record: coverage,
        })).resolves.toBe(true);
    });
});
