import type {
    EditorialSpeakerMode,
    EditorialTranscriptDescriptorV1,
    EditorialTranscriptRecordBodyV1,
    Sha256Digest,
} from '@/types/editorial';
import {
    EditorialTranscriptInFlightRegistry,
    EditorialTranscriptRepository,
} from '@/lib/storage/editorial-transcript-repository';
import { sha256CanonicalJson } from './canonical-json';
import { createEditorialEndpointIdentityDigest } from './endpoint';
import { parseEditMaxEditorialTranscript } from './edit-max-parser';
import { prepareFullSourceEditorialPcmInWorker } from './full-source-pcm-client';
import type { PreparedFullSourceEditorialPcm } from './full-source-pcm';
import {
    createEditorialTranscriptDescriptor,
    createEditorialTranscriptRequestKey,
} from './identity';
import {
    ceilRationalSampleCount,
    normalizeRationalDuration,
    type RationalDuration,
} from './pcm';
import {
    normalizeEditorialLanguage,
    type EditorialTranscriptionPreferencesV1,
} from './preferences';
import { requestEditMaxEditorialTranscript } from './request';
import {
    createLocalNoAudioTranscriptRecord,
    type CanonicalEditorialTranscriptRecordV1,
} from './transcript-body';

export type EditorialTranscriptionProgressStage =
    | 'preparing-full-source-audio'
    | 'uploading-source'
    | 'transcribing-and-aligning'
    | 'validating-edit-timeline'
    | 'saving-transcript-cache';

export interface EditorialTranscriptionSource {
    sourceId: string;
    sourceFingerprint: string;
    file: File;
    declaredDuration: RationalDuration;
}

export interface EditorialTranscriptionConsumerGuard {
    projectId: string;
    persistenceGeneration: number;
    documentRevision: number;
    sessionId: string;
}

export interface EditorialTranscriptionPublicationGuard
extends EditorialTranscriptionConsumerGuard {
    sourceFingerprint: string;
    requestKey: Sha256Digest;
}

export interface EditorialTranscriptionProgress {
    stage: EditorialTranscriptionProgressStage;
    sourceIndex: number;
    sourceCount: number;
    cacheHit: boolean;
}

interface AcquiredEditorialRecord {
    recordId: Sha256Digest;
    body: EditorialTranscriptRecordBodyV1;
    acquisition: 'provider' | 'local-no-audio';
    createdAt: string;
}

interface PreparedEditorialSourceRequest {
    source: EditorialTranscriptionSource;
    declaredDuration: RationalDuration;
    sampleCount: number;
    language: string | null;
    speakerMode: EditorialSpeakerMode;
    endpointIdentityDigest: Sha256Digest;
    requestKey: Sha256Digest;
}

interface EditorialSourceRequestGroup {
    representative: PreparedEditorialSourceRequest;
}

/**
 * Signals that one durable source ID was supplied with contradictory source identity metadata.
 * Exact repeats are harmless and are deduplicated, but silently choosing between different
 * fingerprints or durations would make descriptor provenance depend on input order.
 */
export class EditorialTranscriptionSourceConflictError extends Error {
    constructor(sourceId: string) {
        super(`Editorial source ID "${sourceId}" has conflicting identity metadata.`);
        this.name = 'EditorialTranscriptionSourceConflictError';
    }
}

export interface EditorialTranscriptionCoordinatorDependencies {
    repository?: EditorialTranscriptRepository;
    requestRegistry?: EditorialTranscriptInFlightRegistry<AcquiredEditorialRecord>;
    wavRegistry?: EditorialTranscriptInFlightRegistry<PreparedFullSourceEditorialPcm>;
    preparePcm?: typeof prepareFullSourceEditorialPcmInWorker;
    requestTranscript?: typeof requestEditMaxEditorialTranscript;
    now?: () => Date;
}

/**
 * Non-UI editorial acquisition service. It owns no project graph and never writes history.
 *
 * Unique request profiles are processed sequentially to bound decoder and backend pressure.
 * Multiple durable source IDs may point at the same source fingerprint, so acquisition is
 * coalesced by requestKey while descriptor projection remains source-specific and input-ordered.
 * Request and WAV registries independently coalesce concurrent consumers, while reference-counted
 * abort keeps a shared job alive until its final subscriber cancels. A result may enter immutable
 * CAS after a consumer becomes stale, but guard revalidation prevents session pin/publication for
 * that stale project generation.
 */
export class EditorialTranscriptionCoordinator {
    private readonly repository: EditorialTranscriptRepository;
    private readonly requestRegistry: EditorialTranscriptInFlightRegistry<AcquiredEditorialRecord>;
    private readonly wavRegistry: EditorialTranscriptInFlightRegistry<PreparedFullSourceEditorialPcm>;
    private readonly preparePcm: typeof prepareFullSourceEditorialPcmInWorker;
    private readonly requestTranscript: typeof requestEditMaxEditorialTranscript;
    private readonly now: () => Date;

    constructor(dependencies: EditorialTranscriptionCoordinatorDependencies = {}) {
        this.repository = dependencies.repository ?? new EditorialTranscriptRepository();
        this.requestRegistry = dependencies.requestRegistry
            ?? new EditorialTranscriptInFlightRegistry<AcquiredEditorialRecord>();
        this.wavRegistry = dependencies.wavRegistry
            ?? new EditorialTranscriptInFlightRegistry<PreparedFullSourceEditorialPcm>();
        this.preparePcm = dependencies.preparePcm ?? prepareFullSourceEditorialPcmInWorker;
        this.requestTranscript = dependencies.requestTranscript ?? requestEditMaxEditorialTranscript;
        this.now = dependencies.now ?? (() => new Date());
    }

    /** Releases a mounted editor session after durable project/history pins take ownership. */
    async releaseSessionPins(projectId: string, sessionId: string): Promise<void> {
        await this.repository.clearSessionPins(projectId, sessionId);
    }

    async acquireSources(input: {
        sources: readonly EditorialTranscriptionSource[];
        preferences: EditorialTranscriptionPreferencesV1;
        apiKey?: string;
        guard: EditorialTranscriptionConsumerGuard;
        signal?: AbortSignal;
        regenerate?: boolean;
        isGuardCurrent(guard: EditorialTranscriptionPublicationGuard): boolean | Promise<boolean>;
        onProgress?(progress: EditorialTranscriptionProgress): void;
    }): Promise<EditorialTranscriptDescriptorV1[]> {
        const distinctSources = distinctBySourceId(input.sources);
        if (distinctSources.length === 0) return [];
        // These profile fields are common to the whole call. Computing them once guarantees that
        // every source request is grouped using exactly the same normalized provider identity.
        const language = normalizeEditorialLanguage(input.preferences.language);
        const speakerMode: EditorialSpeakerMode = input.preferences.detectSpeakers
            ? 'diarized'
            : 'none';
        const endpointIdentityDigest = await createEditorialEndpointIdentityDigest(
            input.preferences.endpoint,
        );
        const preparedSources: PreparedEditorialSourceRequest[] = [];
        for (const source of distinctSources) {
            throwIfAborted(input.signal);
            const declaredDuration = normalizeRationalDuration(source.declaredDuration);
            const sampleCount = ceilRationalSampleCount(declaredDuration, 16_000);
            const requestKey = await createEditorialTranscriptRequestKey({
                sourceFingerprint: source.sourceFingerprint,
                sampleCount,
                language,
                speakerMode,
                endpointIdentityDigest,
            });
            preparedSources.push({
                source,
                declaredDuration,
                sampleCount,
                language,
                speakerMode,
                endpointIdentityDigest,
                requestKey,
            });
        }

        // requestKey includes the source fingerprint, exact output sample count, normalized
        // language/speaker profile, endpoint identity and all frozen algorithm versions. It is
        // therefore the canonical boundary for sharing PCM/provider/CAS acquisition. The map
        // preserves the first requested occurrence, which also makes progress ordering stable.
        const requestGroups = new Map<Sha256Digest, EditorialSourceRequestGroup>();
        for (const prepared of preparedSources) {
            if (!requestGroups.has(prepared.requestKey)) {
                requestGroups.set(prepared.requestKey, { representative: prepared });
            }
        }
        const groups = Array.from(requestGroups.values());
        const acquiredByRequestKey = new Map<Sha256Digest, AcquiredEditorialRecord>();
        // Deliberately sequential: the local model and full-source WAV can both be memory-heavy,
        // while independently initiated projects still share requestKey jobs through the registry.
        for (let index = 0; index < groups.length; index += 1) {
            throwIfAborted(input.signal);
            const group = groups[index];
            const acquired = await this.acquireOne({
                prepared: group.representative,
                sourceIndex: index,
                sourceCount: groups.length,
                preferences: input.preferences,
                apiKey: input.apiKey,
                guard: input.guard,
                signal: input.signal,
                regenerate: input.regenerate === true,
                isGuardCurrent: input.isGuardCurrent,
                onProgress: input.onProgress,
            });
            acquiredByRequestKey.set(group.representative.requestKey, acquired);
            throwIfAborted(input.signal);
            for (const prepared of preparedSources) {
                if (!acquiredByRequestKey.has(prepared.requestKey)) continue;
                await assertCurrent(input.isGuardCurrent, {
                    ...input.guard,
                    sourceFingerprint: prepared.source.sourceFingerprint,
                    requestKey: prepared.requestKey,
                });
            }
            // Pin the cumulative complete acquisition prefix after every verified request group.
            // Different source IDs and even different requests can resolve to one content-addressed
            // body, so the pin set intentionally contains each immutable record ID only once.
            await this.repository.setSessionPins(
                input.guard.projectId,
                input.guard.sessionId,
                uniqueRecordIds(acquiredByRequestKey.values()),
            );
        }

        throwIfAborted(input.signal);
        // Descriptor projection happens only after every canonical acquisition has passed its
        // publication guard. This returns one descriptor per distinct requested sourceId without
        // repeating decode, provider, or CAS work for aliases of the same request profile.
        return preparedSources.map((prepared) => {
            const acquired = acquiredByRequestKey.get(prepared.requestKey);
            if (!acquired) throw new Error('Editorial transcript acquisition is unavailable.');
            return createEditorialTranscriptDescriptor({
                recordId: acquired.recordId,
                requestKey: prepared.requestKey,
                sourceId: prepared.source.sourceId,
                sourceFingerprint: prepared.source.sourceFingerprint,
                endpointIdentityDigest: prepared.endpointIdentityDigest,
                body: acquired.body,
                acquisition: acquired.acquisition,
                createdAt: acquired.createdAt,
            });
        });
    }

    private async acquireOne(input: {
        prepared: PreparedEditorialSourceRequest;
        sourceIndex: number;
        sourceCount: number;
        preferences: EditorialTranscriptionPreferencesV1;
        apiKey?: string;
        guard: EditorialTranscriptionConsumerGuard;
        signal?: AbortSignal;
        regenerate: boolean;
        isGuardCurrent(guard: EditorialTranscriptionPublicationGuard): boolean | Promise<boolean>;
        onProgress?(progress: EditorialTranscriptionProgress): void;
    }): Promise<AcquiredEditorialRecord> {
        const {
            source,
            declaredDuration,
            sampleCount,
            language,
            speakerMode,
            endpointIdentityDigest,
            requestKey,
        } = input.prepared;
        const publicationGuard: EditorialTranscriptionPublicationGuard = {
            ...input.guard,
            sourceFingerprint: source.sourceFingerprint,
            requestKey,
        };
        const indexed = await this.repository.getRequestDescriptor(requestKey);
        if (indexed && !input.regenerate) {
            input.onProgress?.({
                stage: 'saving-transcript-cache',
                sourceIndex: input.sourceIndex,
                sourceCount: input.sourceCount,
                cacheHit: true,
            });
            const body = await this.repository.getRecord(indexed.recordId, {
                descriptor: indexed,
                referenced: true,
            });
            if (!body) throw new Error('Editorial transcript cache record is unavailable.');
            await assertCurrent(input.isGuardCurrent, publicationGuard);
            return {
                recordId: indexed.recordId,
                body,
                acquisition: indexed.acquisition,
                createdAt: indexed.createdAt,
            };
        }

        const acquired = await this.requestRegistry.subscribe({
            requestKey,
            signal: input.signal,
            run: async (sharedSignal) => {
                input.onProgress?.({
                    stage: 'preparing-full-source-audio',
                    sourceIndex: input.sourceIndex,
                    sourceCount: input.sourceCount,
                    cacheHit: false,
                });
                const wavKey = await sha256CanonicalJson({
                    sourceFingerprint: source.sourceFingerprint,
                    pcmAlgorithmVersion: 1,
                    declaredDuration,
                });
                const prepared = await this.wavRegistry.subscribe({
                    requestKey: wavKey,
                    signal: sharedSignal,
                    run: signal => this.preparePcm({
                        file: source.file,
                        declaredDuration,
                        signal,
                    }),
                });
                if (prepared.sampleCount !== sampleCount) {
                    throw new Error('Editorial full-source PCM count changed unexpectedly.');
                }
                const createdAt = this.now().toISOString();
                let record: CanonicalEditorialTranscriptRecordV1;
                let acquisition: 'provider' | 'local-no-audio';
                if (!prepared.hasAudioStream) {
                    record = await createLocalNoAudioTranscriptRecord({
                        sourceFingerprint: source.sourceFingerprint,
                        sampleCount,
                        language,
                        speakerMode,
                    });
                    acquisition = 'local-no-audio';
                } else {
                    if (!prepared.wav) throw new Error('Editorial canonical WAV is unavailable.');
                    input.onProgress?.({
                        stage: 'uploading-source',
                        sourceIndex: input.sourceIndex,
                        sourceCount: input.sourceCount,
                        cacheHit: false,
                    });
                    input.onProgress?.({
                        stage: 'transcribing-and-aligning',
                        sourceIndex: input.sourceIndex,
                        sourceCount: input.sourceCount,
                        cacheHit: false,
                    });
                    const response = await this.requestTranscript({
                        endpoint: input.preferences.endpoint,
                        requestMode: input.preferences.requestMode,
                        wav: prepared.wav,
                        apiKey: input.apiKey,
                        language,
                        speakerMode,
                        signal: sharedSignal,
                    });
                    input.onProgress?.({
                        stage: 'validating-edit-timeline',
                        sourceIndex: input.sourceIndex,
                        sourceCount: input.sourceCount,
                        cacheHit: false,
                    });
                    record = await parseEditMaxEditorialTranscript(response, {
                        sourceFingerprint: source.sourceFingerprint,
                        sampleCount,
                        language,
                        speakerMode,
                    });
                    acquisition = 'provider';
                }
                await this.repository.putRecord(record);
                const indexDescriptor = createEditorialTranscriptDescriptor({
                    recordId: record.recordId,
                    requestKey,
                    sourceId: source.sourceId,
                    sourceFingerprint: source.sourceFingerprint,
                    endpointIdentityDigest,
                    body: record.body,
                    acquisition,
                    createdAt,
                });
                const published = await this.repository.compareAndSwapRequestIndex({
                    requestKey,
                    expectedRecordId: input.regenerate ? indexed?.recordId ?? null : null,
                    descriptor: indexDescriptor,
                });
                if (!published) {
                    // A concurrent valid writer won the request index. Returning this caller's
                    // losing body would make the descriptor disagree with the authoritative
                    // request cache even though CAS correctly refused the overwrite. Rehydrate
                    // and verify the winner instead; the losing immutable body stays unpinned and
                    // is eligible for ordinary GC.
                    const winner = await this.repository.getRequestDescriptor(requestKey);
                    if (!winner) {
                        throw new Error('Editorial request cache changed during CAS publication.');
                    }
                    const winnerBody = await this.repository.getRecord(winner.recordId, {
                        descriptor: winner,
                        referenced: true,
                    });
                    if (!winnerBody) {
                        throw new Error('Editorial request cache winner is unavailable.');
                    }
                    return {
                        recordId: winner.recordId,
                        body: winnerBody,
                        acquisition: winner.acquisition,
                        createdAt: winner.createdAt,
                    };
                }
                return {
                    recordId: record.recordId,
                    body: record.body,
                    acquisition,
                    createdAt,
                };
            },
        });
        input.onProgress?.({
            stage: 'saving-transcript-cache',
            sourceIndex: input.sourceIndex,
            sourceCount: input.sourceCount,
            cacheHit: false,
        });
        await assertCurrent(input.isGuardCurrent, publicationGuard);
        return {
            recordId: acquired.recordId,
            body: acquired.body,
            acquisition: acquired.acquisition,
            createdAt: acquired.createdAt,
        };
    }
}

/**
 * Preserves the first occurrence of each durable source ID. An exact identity repeat is common
 * when callers collect sources from several blocks, so it is deduplicated. Reusing the same ID for
 * a different fingerprint or normalized duration is rejected because no source-specific
 * descriptor could truthfully represent both inputs.
 */
function distinctBySourceId(
    sources: readonly EditorialTranscriptionSource[],
): EditorialTranscriptionSource[] {
    const distinct: EditorialTranscriptionSource[] = [];
    const bySourceId = new Map<string, EditorialTranscriptionSource>();
    for (const source of sources) {
        if (!source.sourceId || !source.sourceFingerprint) {
            throw new Error('Editorial source identity is required.');
        }
        const existing = bySourceId.get(source.sourceId);
        if (!existing) {
            bySourceId.set(source.sourceId, source);
            distinct.push(source);
            continue;
        }
        const existingDuration = normalizeRationalDuration(existing.declaredDuration);
        const repeatedDuration = normalizeRationalDuration(source.declaredDuration);
        if (existing.sourceFingerprint !== source.sourceFingerprint
            || existingDuration.numerator !== repeatedDuration.numerator
            || existingDuration.denominator !== repeatedDuration.denominator) {
            throw new EditorialTranscriptionSourceConflictError(source.sourceId);
        }
    }
    return distinct;
}

function uniqueRecordIds(records: Iterable<AcquiredEditorialRecord>): Sha256Digest[] {
    return Array.from(new Set(Array.from(records, record => record.recordId)));
}

async function assertCurrent(
    check: (guard: EditorialTranscriptionPublicationGuard) => boolean | Promise<boolean>,
    guard: EditorialTranscriptionPublicationGuard,
): Promise<void> {
    if (!(await check(guard))) {
        throw new DOMException('Editorial transcription result is stale.', 'AbortError');
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Editorial transcription was cancelled.', 'AbortError');
}
