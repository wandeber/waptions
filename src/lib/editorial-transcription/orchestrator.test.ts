import { describe, expect, it, vi } from 'vitest';
import type {
    EditorialTranscriptDescriptorV1,
    EditorialTranscriptRecordBodyV1,
    Sha256Digest,
    TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import { EditorialTranscriptRepository } from '@/lib/storage/editorial-transcript-repository';
import { createEditorialEndpointIdentityDigest } from './endpoint';
import {
    createEditorialTranscriptDescriptor,
    createEditorialTranscriptRequestKey,
} from './identity';
import {
    EditorialTranscriptionCoordinator,
    EditorialTranscriptionSourceConflictError,
    type EditorialTranscriptionSource,
} from './orchestrator';
import type { EditorialTranscriptionPreferencesV1 } from './preferences';
import {
    createCanonicalEditorialTranscriptRecord,
    type CanonicalEditorialTranscriptRecordV1,
} from './transcript-body';
import pointAnchorE2eFixture from '../../../e2e/fixtures/editorial/edit-max-v1-point-anchor.json';
import type {
    RangeTranscriptChunkRecordV2,
    RangeTranscriptionRepository,
} from './range-orchestrator';

const preferences: EditorialTranscriptionPreferencesV1 = {
    version: 1,
    endpoint: 'http://localhost:43556/v1/audio/transcriptions',
    requestMode: 'browser',
    language: null,
    detectSpeakers: false,
};

class CoordinatorRepository extends EditorialTranscriptRepository {
    readonly records = new Map<Sha256Digest, EditorialTranscriptRecordBodyV1>();
    readonly requests = new Map<Sha256Digest, EditorialTranscriptDescriptorV1>();
    readonly sessionPinWrites: Sha256Digest[][] = [];
    readonly clearedSessions: string[][] = [];
    casOverride?: (
        input: Parameters<EditorialTranscriptRepository['compareAndSwapRequestIndex']>[0],
    ) => boolean;

    override async putRecord(record: CanonicalEditorialTranscriptRecordV1): Promise<void> {
        this.records.set(record.recordId, record.body);
    }

    override async getRecord(recordId: Sha256Digest): Promise<EditorialTranscriptRecordBodyV1 | null> {
        return this.records.get(recordId) ?? null;
    }

    override async getRequestDescriptor(
        requestKey: Sha256Digest,
    ): Promise<EditorialTranscriptDescriptorV1 | null> {
        return this.requests.get(requestKey) ?? null;
    }

    override async compareAndSwapRequestIndex(
        input: Parameters<EditorialTranscriptRepository['compareAndSwapRequestIndex']>[0],
    ): Promise<boolean> {
        if (this.casOverride) return this.casOverride(input);
        const current = this.requests.get(input.requestKey);
        if ((current?.recordId ?? null) !== input.expectedRecordId) return false;
        this.requests.set(input.requestKey, input.descriptor);
        return true;
    }

    override async setSessionPins(
        _projectId: string,
        _sessionId: string,
        recordIds: readonly Sha256Digest[],
    ): Promise<void> {
        this.sessionPinWrites.push([...recordIds]);
    }

    override async clearSessionPins(projectId: string, sessionId: string): Promise<void> {
        this.clearedSessions.push([projectId, sessionId]);
    }
}

class CoordinatorRangeRepository implements RangeTranscriptionRepository {
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

function source(sourceId: string, sourceFingerprint: string): EditorialTranscriptionSource {
    return {
        sourceId,
        sourceFingerprint,
        file: new File([new Uint8Array()], `${sourceId}.mp4`, { type: 'video/mp4' }),
        declaredDuration: { numerator: 1, denominator: 1 },
    };
}

async function providerRecord(
    sourceFingerprint: string,
    canonicalModel: string,
): Promise<CanonicalEditorialTranscriptRecordV1> {
    return createCanonicalEditorialTranscriptRecord({
        sourceFingerprint,
        sampleCount: 16_000,
        canonicalModel,
        language: null,
        speakerMode: 'none',
        noAudioStream: false,
        words: [],
        speechRegions: [],
        editBoundaries: [],
        speakers: [],
    });
}

function silentProviderResponse(canonicalModel: string): unknown {
    return {
        model: canonicalModel,
        text: '',
        words: [],
        editing: {
            schema_version: 1,
            profile: 'edit-max-v1',
            requested_model: 'qwen-1.7b-edit-max',
            canonical_model: canonicalModel,
            timeline: {
                sample_rate_hz: 16_000,
                sample_count: 16_000,
                duration: 1,
                time_origin: 'decoded_audio_start',
            },
            speech_regions: [],
            edit_boundaries: [],
        },
    };
}

describe('editorial transcription coordinator', () => {
    it('publishes and reuses the canonical CAS record for an evidence-backed point-anchor', async () => {
        const repository = new CoordinatorRepository();
        const preparePcm = vi.fn(async () => ({
            sampleRateHz: 16_000 as const,
            sampleCount: 32_000,
            hasAudioStream: true,
            wav: new Blob([new Uint8Array(44)], { type: 'audio/wav' }),
        }));
        const requestTranscript = vi.fn(async () => structuredClone(pointAnchorE2eFixture));
        const coordinator = new EditorialTranscriptionCoordinator({
            repository,
            preparePcm,
            requestTranscript,
            now: () => new Date('2026-07-25T00:00:00.000Z'),
        });
        const inputSource = {
            ...source('source-point-anchor', 'fingerprint-point-anchor'),
            declaredDuration: { numerator: 2, denominator: 1 },
        };
        const acquisition = {
            sources: [inputSource],
            preferences,
            guard: {
                projectId: 'project-point-anchor',
                persistenceGeneration: 1,
                documentRevision: 1,
                sessionId: 'session-point-anchor',
            },
            isGuardCurrent: () => true,
        };

        const [first] = await coordinator.acquireSources(acquisition);
        const [cached] = await coordinator.acquireSources(acquisition);
        const body = repository.records.get(first.recordId);

        expect(body?.words.map((word) => [
            word.alignedStartSample,
            word.alignedEndSample,
            word.editableStartSample,
            word.editableEndSample,
        ])).toEqual([
            [4_000, 12_000, 4_000, 12_000],
            [12_000, 12_001, 12_000, 12_001],
            [12_000, 24_000, 12_001, 24_000],
        ]);
        expect(cached.recordId).toBe(first.recordId);
        expect(repository.requests.get(first.requestKey)?.recordId).toBe(first.recordId);
        expect(preparePcm).toHaveBeenCalledTimes(1);
        expect(requestTranscript).toHaveBeenCalledTimes(1);
    });

    it('returns and pins the authoritative request-index winner after losing CAS', async () => {
        const repository = new CoordinatorRepository();
        const inputSource = source('source-a', 'fingerprint-a');
        const endpointIdentityDigest = await createEditorialEndpointIdentityDigest(preferences.endpoint);
        const requestKey = await createEditorialTranscriptRequestKey({
            sourceFingerprint: inputSource.sourceFingerprint,
            sampleCount: 16_000,
            language: null,
            speakerMode: 'none',
            endpointIdentityDigest,
        });
        const oldRecord = await providerRecord(inputSource.sourceFingerprint, 'old-model');
        const winnerRecord = await providerRecord(inputSource.sourceFingerprint, 'winner-model');
        const oldDescriptor = createEditorialTranscriptDescriptor({
            recordId: oldRecord.recordId,
            requestKey,
            sourceId: inputSource.sourceId,
            sourceFingerprint: inputSource.sourceFingerprint,
            endpointIdentityDigest,
            body: oldRecord.body,
            acquisition: 'provider',
            createdAt: '2026-07-22T00:00:00.000Z',
        });
        const winnerDescriptor = createEditorialTranscriptDescriptor({
            recordId: winnerRecord.recordId,
            requestKey,
            sourceId: 'concurrent-source',
            sourceFingerprint: inputSource.sourceFingerprint,
            endpointIdentityDigest,
            body: winnerRecord.body,
            acquisition: 'provider',
            createdAt: '2026-07-22T00:00:01.000Z',
        });
        repository.records.set(oldRecord.recordId, oldRecord.body);
        repository.records.set(winnerRecord.recordId, winnerRecord.body);
        repository.requests.set(requestKey, oldDescriptor);
        repository.casOverride = (input) => {
            expect(input.expectedRecordId).toBe(oldRecord.recordId);
            repository.requests.set(requestKey, winnerDescriptor);
            return false;
        };
        const requestTranscript = vi.fn(async () => silentProviderResponse('loser-model'));
        const coordinator = new EditorialTranscriptionCoordinator({
            repository,
            preparePcm: async () => ({
                sampleRateHz: 16_000,
                sampleCount: 16_000,
                hasAudioStream: true,
                wav: new Blob([new Uint8Array(44)], { type: 'audio/wav' }),
            }),
            requestTranscript,
            now: () => new Date('2026-07-22T00:00:02.000Z'),
        });

        const [descriptor] = await coordinator.acquireSources({
            sources: [inputSource],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 4,
                documentRevision: 8,
                sessionId: 'session-a',
            },
            regenerate: true,
            isGuardCurrent: () => true,
        });

        expect(requestTranscript).toHaveBeenCalledTimes(1);
        expect(descriptor.recordId).toBe(winnerRecord.recordId);
        expect(descriptor.sourceId).toBe(inputSource.sourceId);
        expect(descriptor.canonicalModel).toBe('winner-model');
        expect(repository.sessionPinWrites).toEqual([[winnerRecord.recordId]]);
    });

    it('pins unique records cumulatively while preserving requested source order', async () => {
        const repository = new CoordinatorRepository();
        const requestTranscript = vi.fn();
        const preparePcm = vi.fn(async () => ({
            sampleRateHz: 16_000 as const,
            sampleCount: 16_000,
            hasAudioStream: false,
            wav: null,
        }));
        const coordinator = new EditorialTranscriptionCoordinator({
            repository,
            preparePcm,
            requestTranscript,
        });

        const descriptors = await coordinator.acquireSources({
            sources: [
                source('source-b', 'fingerprint-shared'),
                source('source-c', 'fingerprint-c'),
                source('source-a', 'fingerprint-shared'),
            ],
            preferences: { ...preferences, language: ' ES ' },
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 4,
                documentRevision: 8,
                sessionId: 'session-a',
            },
            isGuardCurrent: () => true,
        });

        expect(preparePcm).toHaveBeenCalledTimes(2);
        expect(requestTranscript).not.toHaveBeenCalled();
        expect(descriptors.map(descriptor => descriptor.sourceId)).toEqual([
            'source-b',
            'source-c',
            'source-a',
        ]);
        expect(descriptors[2].recordId).toBe(descriptors[0].recordId);
        expect(descriptors[2].requestKey).toBe(descriptors[0].requestKey);
        expect(descriptors.every(descriptor => descriptor.language === 'es')).toBe(true);
        expect(repository.sessionPinWrites).toEqual([
            [descriptors[0].recordId],
            [descriptors[0].recordId, descriptors[1].recordId],
        ]);
        await coordinator.releaseSessionPins('project-a', 'session-a');
        expect(repository.clearedSessions).toEqual([['project-a', 'session-a']]);
    });

    it('deduplicates an exact repeated source ID but rejects conflicting identity metadata', async () => {
        const repository = new CoordinatorRepository();
        const preparePcm = vi.fn(async () => ({
            sampleRateHz: 16_000 as const,
            sampleCount: 16_000,
            hasAudioStream: false,
            wav: null,
        }));
        const coordinator = new EditorialTranscriptionCoordinator({ repository, preparePcm });
        const repeatedSource = source('source-a', 'fingerprint-a');
        const equivalentRepeat = {
            ...source('source-a', 'fingerprint-a'),
            declaredDuration: { numerator: 2, denominator: 2 },
        };

        const descriptors = await coordinator.acquireSources({
            sources: [repeatedSource, equivalentRepeat],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 4,
                documentRevision: 8,
                sessionId: 'session-a',
            },
            isGuardCurrent: () => true,
        });

        expect(descriptors.map(descriptor => descriptor.sourceId)).toEqual(['source-a']);
        expect(preparePcm).toHaveBeenCalledTimes(1);
        expect(repository.sessionPinWrites).toEqual([[descriptors[0].recordId]]);

        await expect(coordinator.acquireSources({
            sources: [repeatedSource, source('source-a', 'fingerprint-b')],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 4,
                documentRevision: 8,
                sessionId: 'session-a',
            },
            isGuardCurrent: () => true,
        })).rejects.toBeInstanceOf(EditorialTranscriptionSourceConflictError);
        expect(preparePcm).toHaveBeenCalledTimes(1);
    });

    it('cancels one shared acquisition for source aliases without publishing session pins', async () => {
        const repository = new CoordinatorRepository();
        const controller = new AbortController();
        let resolveStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        const preparePcm = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<never>((
            _resolve,
            reject,
        ) => {
            resolveStarted();
            if (!signal) {
                reject(new Error('Expected the coordinator to provide a cancellation signal.'));
                return;
            }
            signal.addEventListener('abort', () => {
                reject(new DOMException('Editorial PCM preparation was cancelled.', 'AbortError'));
            }, { once: true });
        }));
        const requestTranscript = vi.fn();
        const coordinator = new EditorialTranscriptionCoordinator({
            repository,
            preparePcm,
            requestTranscript,
        });
        const acquisition = coordinator.acquireSources({
            sources: [
                source('source-a', 'fingerprint-shared'),
                source('source-b', 'fingerprint-shared'),
            ],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 4,
                documentRevision: 8,
                sessionId: 'session-a',
            },
            signal: controller.signal,
            isGuardCurrent: () => true,
        });

        await started;
        controller.abort();

        await expect(acquisition).rejects.toMatchObject({ name: 'AbortError' });
        expect(preparePcm).toHaveBeenCalledTimes(1);
        expect(requestTranscript).not.toHaveBeenCalled();
        expect(repository.sessionPinWrites).toEqual([]);
    });

    it('rejects large legacy full-source requests before allocating PCM', async () => {
        const preparePcm = vi.fn();
        const coordinator = new EditorialTranscriptionCoordinator({
            repository: new CoordinatorRepository(),
            preparePcm,
        });
        await expect(coordinator.acquireSources({
            sources: [{
                ...source('legacy-source', 'legacy-fingerprint'),
                declaredDuration: { numerator: 31, denominator: 1 },
            }],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 1,
                documentRevision: 1,
                sessionId: 'session-a',
            },
            isGuardCurrent: () => true,
        })).rejects.toThrow('limited to 30 seconds');
        expect(preparePcm).not.toHaveBeenCalled();
    });

    it('uses bounded V2 acquisition for the managed range path', async () => {
        const repository = new CoordinatorRepository();
        const rangeRepository = new CoordinatorRangeRepository();
        const preparePcm = vi.fn();
        const requestTranscript = vi.fn();
        const coordinator = new EditorialTranscriptionCoordinator({
            repository,
            rangeRepository,
            preparePcm,
            requestTranscript,
        });
        const [descriptor] = await coordinator.acquireSources({
            sources: [{
                ...source('range-source', 'range-fingerprint'),
                coreCoverage: [{ startSample: 4_000, endSample: 8_000 }],
                hasAudio: false,
            }],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 1,
                documentRevision: 1,
                sessionId: 'session-a',
            },
            isGuardCurrent: () => true,
        });

        expect(descriptor).toMatchObject({
            version: 2,
            sourceId: 'range-source',
            acquisition: 'local-no-audio',
        });
        expect(rangeRepository.coverage).toHaveLength(1);
        expect(rangeRepository.coverage[0].coreCoverage).toEqual([
            { startSample: 4_000, endSample: 8_000 },
        ]);
        expect(preparePcm).not.toHaveBeenCalled();
        expect(requestTranscript).not.toHaveBeenCalled();
    });

    it('keeps cumulative session pins while acquiring multiple ranged sources', async () => {
        const repository = new CoordinatorRepository();
        const coordinator = new EditorialTranscriptionCoordinator({
            repository,
            rangeRepository: new CoordinatorRangeRepository(),
            preparePcm: vi.fn(),
            requestTranscript: vi.fn(),
        });

        const descriptors = await coordinator.acquireSources({
            sources: [
                {
                    ...source('range-a', 'range-fingerprint-a'),
                    coreCoverage: [{ startSample: 4_000, endSample: 8_000 }],
                    hasAudio: false,
                },
                {
                    ...source('range-b', 'range-fingerprint-b'),
                    coreCoverage: [{ startSample: 8_000, endSample: 12_000 }],
                    hasAudio: false,
                },
            ],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 1,
                documentRevision: 1,
                sessionId: 'session-a',
            },
            isGuardCurrent: () => true,
        });

        expect(descriptors).toHaveLength(2);
        expect(repository.sessionPinWrites.at(-1)).toEqual([
            descriptors[0].recordId,
            descriptors[1].recordId,
        ]);
    });

    it('reuses a compatible V1 full-source record for a managed range without rewriting it', async () => {
        const repository = new CoordinatorRepository();
        const rangeRepository = new CoordinatorRangeRepository();
        const cached = await providerRecord('range-fingerprint', 'qwen-1.7b-edit-max');
        const endpointIdentityDigest = await createEditorialEndpointIdentityDigest(preferences.endpoint);
        const requestKey = await createEditorialTranscriptRequestKey({
            sourceFingerprint: 'range-fingerprint',
            sampleCount: 16_000,
            language: null,
            speakerMode: 'none',
            endpointIdentityDigest,
        });
        repository.records.set(cached.recordId, cached.body);
        repository.requests.set(requestKey, createEditorialTranscriptDescriptor({
            recordId: cached.recordId,
            requestKey,
            sourceId: 'original-source-id',
            sourceFingerprint: 'range-fingerprint',
            endpointIdentityDigest,
            body: cached.body,
            acquisition: 'provider',
            createdAt: '2026-07-25T00:00:00.000Z',
        }));
        const preparePcm = vi.fn();
        const requestTranscript = vi.fn();
        const coordinator = new EditorialTranscriptionCoordinator({
            repository,
            rangeRepository,
            preparePcm,
            requestTranscript,
        });

        const [descriptor] = await coordinator.acquireSources({
            sources: [{
                ...source('range-source', 'range-fingerprint'),
                coreCoverage: [{ startSample: 4_000, endSample: 8_000 }],
                hasAudio: true,
            }],
            preferences,
            guard: {
                projectId: 'project-a',
                persistenceGeneration: 1,
                documentRevision: 1,
                sessionId: 'session-a',
            },
            isGuardCurrent: () => true,
        });

        expect(descriptor).toMatchObject({
            version: 1,
            recordId: cached.recordId,
            requestKey,
            sourceId: 'range-source',
        });
        expect(rangeRepository.coverage).toHaveLength(0);
        expect(repository.records.size).toBe(1);
        expect(repository.sessionPinWrites).toEqual([[cached.recordId]]);
        expect(preparePcm).not.toHaveBeenCalled();
        expect(requestTranscript).not.toHaveBeenCalled();
    });
});
