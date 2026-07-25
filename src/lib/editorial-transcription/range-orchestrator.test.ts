import { describe, expect, it, vi } from 'vitest';
import type {
    HalfOpenSampleRange,
    Sha256Digest,
    TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import { sha256CanonicalJson } from './canonical-json';
import {
    RangeTranscriptionCoordinator,
    type RangeTranscriptChunkRecordV2,
    type RangeTranscriptionRepository,
} from './range-orchestrator';

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}`;

class MemoryRepository implements RangeTranscriptionRepository {
    readonly coverage: TranscriptionCoverageRecordV2[] = [];
    readonly chunks = new Map<Sha256Digest, RangeTranscriptChunkRecordV2>();

    async listCompatibleCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
    }) {
        return this.coverage.filter(record => (
            record.sourceFingerprint === input.sourceFingerprint
            && record.acquisitionProfileDigest === input.acquisitionProfileDigest
        ));
    }

    async getChunk(recordId: Sha256Digest) {
        return this.chunks.get(recordId) ?? null;
    }

    async putChunk(record: RangeTranscriptChunkRecordV2) {
        this.chunks.set(record.recordId, record);
    }

    async putCoverage(record: TranscriptionCoverageRecordV2) {
        this.coverage.push(record);
    }

    async compareAndSwapCoverage(input: {
        sourceFingerprint: string;
        acquisitionProfileDigest: Sha256Digest;
        expectedRecordIds: readonly Sha256Digest[];
        record: TranscriptionCoverageRecordV2;
    }) {
        const currentRecordIds = (await this.listCompatibleCoverage(input))
            .map(record => record.recordId)
            .sort();
        if (JSON.stringify(currentRecordIds) !== JSON.stringify(input.expectedRecordIds)) {
            return false;
        }
        if (!this.coverage.some(record => record.recordId === input.record.recordId)) {
            this.coverage.push(input.record);
        }
        return true;
    }
}

const profile = (coreCoverage: HalfOpenSampleRange[], sourceFingerprint = 'source-a') => ({
    sourceFingerprint,
    sourceSampleRate: 16_000,
    sourceSampleCount: 160_000,
    coreCoverage,
    contextSamples: 0,
    language: 'es',
    speakerMode: 'none' as const,
    endpointIdentityDigest: digest('a'),
    requestedModel: 'qwen-1.7b-edit-max',
    responseSchema: 'edit-max-v1',
    pcmAlgorithmVersion: 1,
    providerProfileVersion: 1,
});

describe('range transcription coordinator', () => {
    it('acquires only newly uncovered gaps and publishes one cumulative coverage record', async () => {
        const repository = new MemoryRepository();
        const decodeWindow = vi.fn(async ({ window }) => (
            new Int16Array(window.decoded.endSample - window.decoded.startSample)
        ));
        const publish = vi.fn(async ({ coverageRecord, expectedCoverageRecordIds }) => (
            repository.compareAndSwapCoverage({
                sourceFingerprint: coverageRecord.sourceFingerprint,
                acquisitionProfileDigest: coverageRecord.acquisitionProfileDigest,
                expectedRecordIds: expectedCoverageRecordIds,
                record: coverageRecord,
            })
        ));
        const coordinator = new RangeTranscriptionCoordinator({
            repository,
            decodeWindow,
            transcribeWindow: async ({ window }) => [{
                text: `word-${window.core.startSample}`,
                startSample: window.core.startSample - window.decoded.startSample,
                endSample: window.core.endSample - window.decoded.startSample,
                probability: 0.9,
                speaker: null,
            }],
            buildMergedRecord: async ({ merged }) => ({
                recordId: await sha256CanonicalJson(merged),
            }),
            isPublicationCurrent: () => true,
            publish,
        });

        const first = await coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }]),
            signal: new AbortController().signal,
        });
        const second = await coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 30 }]),
            signal: new AbortController().signal,
        });

        expect(first.acquiredWindowCount).toBe(1);
        expect(second.acquiredWindowCount).toBe(1);
        expect(decodeWindow.mock.calls.map(call => call[0].window.core)).toEqual([
            { startSample: 10, endSample: 20 },
            { startSample: 20, endSample: 30 },
        ]);
        expect(second.coverageRecord?.coreCoverage).toEqual([
            { startSample: 10, endSample: 30 },
        ]);
        expect(publish).toHaveBeenCalledTimes(2);
    });

    it('reuses compatible V1 full-source coverage without decoding, rewriting, or publishing', async () => {
        const repository = new MemoryRepository();
        const decodeWindow = vi.fn();
        const publish = vi.fn();
        const isPublicationCurrent = vi.fn(() => true);
        const coordinator = new RangeTranscriptionCoordinator({
            repository,
            decodeWindow,
            transcribeWindow: vi.fn(),
            buildMergedRecord: vi.fn(),
            isPublicationCurrent,
            publish,
        });

        const result = await coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }]),
            compatibleV1FullSource: { recordId: digest('f') },
            signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
            coverageRecord: null,
            reusedV1RecordId: digest('f'),
            acquiredWindowCount: 0,
        });
        expect(isPublicationCurrent).toHaveBeenCalledOnce();
        expect(decodeWindow).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it('rejects stale V1 reuse before returning the cached record', async () => {
        const coordinator = new RangeTranscriptionCoordinator({
            repository: new MemoryRepository(),
            decodeWindow: vi.fn(),
            transcribeWindow: vi.fn(),
            buildMergedRecord: vi.fn(),
            isPublicationCurrent: () => false,
            publish: vi.fn(),
        });

        await expect(coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }]),
            compatibleV1FullSource: { recordId: digest('f') },
            signal: new AbortController().signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('does not reuse coverage after source replacement', async () => {
        const repository = new MemoryRepository();
        const decodeWindow = vi.fn(async ({ window }) => (
            new Int16Array(window.decoded.endSample - window.decoded.startSample)
        ));
        const coordinator = new RangeTranscriptionCoordinator({
            repository,
            decodeWindow,
            transcribeWindow: async ({ window }) => [{
                text: 'word',
                startSample: 0,
                endSample: window.core.endSample - window.core.startSample,
                probability: null,
                speaker: null,
            }],
            buildMergedRecord: async ({ merged }) => ({
                recordId: await sha256CanonicalJson(merged),
            }),
            isPublicationCurrent: () => true,
            publish: async ({ coverageRecord, expectedCoverageRecordIds }) => (
                repository.compareAndSwapCoverage({
                    sourceFingerprint: coverageRecord.sourceFingerprint,
                    acquisitionProfileDigest: coverageRecord.acquisitionProfileDigest,
                    expectedRecordIds: expectedCoverageRecordIds,
                    record: coverageRecord,
                })
            ),
        });
        await coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }], 'source-a'),
            signal: new AbortController().signal,
        });
        await coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }], 'source-b'),
            signal: new AbortController().signal,
        });

        expect(decodeWindow).toHaveBeenCalledTimes(2);
    });

    it('retries a lost coverage CAS without decoding the same window again', async () => {
        const repository = new MemoryRepository();
        const decodeWindow = vi.fn(async ({ window }) => (
            new Int16Array(window.decoded.endSample - window.decoded.startSample)
        ));
        let publishAttempt = 0;
        const coordinator = new RangeTranscriptionCoordinator({
            repository,
            decodeWindow,
            transcribeWindow: async ({ window }) => [{
                text: 'word',
                startSample: 0,
                endSample: window.core.endSample - window.core.startSample,
                probability: null,
                speaker: null,
            }],
            buildMergedRecord: async ({ merged }) => ({
                recordId: await sha256CanonicalJson(merged),
            }),
            isPublicationCurrent: () => true,
            publish: async ({ coverageRecord, expectedCoverageRecordIds }) => {
                publishAttempt += 1;
                if (publishAttempt === 1) {
                    await repository.putCoverage(coverageRecord);
                    return false;
                }
                return repository.compareAndSwapCoverage({
                    sourceFingerprint: coverageRecord.sourceFingerprint,
                    acquisitionProfileDigest: coverageRecord.acquisitionProfileDigest,
                    expectedRecordIds: expectedCoverageRecordIds,
                    record: coverageRecord,
                });
            },
        });

        const result = await coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }]),
            signal: new AbortController().signal,
        });

        expect(result.acquiredWindowCount).toBe(1);
        expect(decodeWindow).toHaveBeenCalledOnce();
        expect(publishAttempt).toBe(2);
    });

    it('may retain verified chunks but never publishes after cancellation or a stale guard', async () => {
        const repository = new MemoryRepository();
        const publish = vi.fn();
        const stale = new RangeTranscriptionCoordinator({
            repository,
            decodeWindow: async ({ window }) => (
                new Int16Array(window.decoded.endSample - window.decoded.startSample)
            ),
            transcribeWindow: async () => [{
                text: 'word',
                startSample: 0,
                endSample: 1,
                probability: null,
                speaker: null,
            }],
            buildMergedRecord: async ({ merged }) => ({
                recordId: await sha256CanonicalJson(merged),
            }),
            isPublicationCurrent: () => false,
            publish,
        });

        await expect(stale.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }]),
            signal: new AbortController().signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(repository.chunks.size).toBe(1);
        expect(repository.coverage).toHaveLength(0);
        expect(publish).not.toHaveBeenCalled();

        const cancelledController = new AbortController();
        cancelledController.abort();
        await expect(stale.acquire({
            profile: profile([{ startSample: 30, endSample: 40 }]),
            signal: cancelledController.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(publish).not.toHaveBeenCalled();
    });

    it('rejects a guard that becomes stale immediately after the coverage CAS', async () => {
        const repository = new MemoryRepository();
        const isPublicationCurrent = vi.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const coordinator = new RangeTranscriptionCoordinator({
            repository,
            decodeWindow: async ({ window }) => (
                new Int16Array(window.decoded.endSample - window.decoded.startSample)
            ),
            transcribeWindow: async () => [{
                text: 'word',
                startSample: 0,
                endSample: 1,
                probability: null,
                speaker: null,
            }],
            buildMergedRecord: async ({ merged }) => ({
                recordId: await sha256CanonicalJson(merged),
            }),
            isPublicationCurrent,
            publish: async ({ coverageRecord, expectedCoverageRecordIds }) => (
                repository.compareAndSwapCoverage({
                    sourceFingerprint: coverageRecord.sourceFingerprint,
                    acquisitionProfileDigest: coverageRecord.acquisitionProfileDigest,
                    expectedRecordIds: expectedCoverageRecordIds,
                    record: coverageRecord,
                })
            ),
        });

        await expect(coordinator.acquire({
            profile: profile([{ startSample: 10, endSample: 20 }]),
            signal: new AbortController().signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(repository.coverage).toHaveLength(1);
        expect(isPublicationCurrent).toHaveBeenCalledTimes(2);
    });
});
