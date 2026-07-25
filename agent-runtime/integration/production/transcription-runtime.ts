import { join } from 'node:path';
import type { TranscriptionCoverageRecordV2 } from '../../../src/types/editorial';
import {
    createCanonicalEditorialTranscriptRecord,
    verifyCanonicalEditorialTranscriptRecord,
} from '../../../src/lib/editorial-transcription/transcript-body';
import {
    createTranscriptionCoverageRecordV2,
    verifyTranscriptionCoverageRecordV2,
} from '../../../src/lib/editorial-transcription/range-coverage';
import type {
    RangeTranscriptChunkRecordV2,
} from '../../../src/lib/editorial-transcription/range-orchestrator';
import {
    sha256CanonicalJson,
} from '../../../src/lib/editorial-transcription/canonical-json';
import type { EditorManifestV4 } from '../../../src/types/video';
import {
    createEditorialTranscriptDescriptorV2,
} from '../../../src/lib/editorial-transcription/identity';
import {
    getCanonicalEditorAudioGraphSignature,
    getStableValueSignature,
} from '../../../src/lib/audio-graph-signature';
import {
    createDescriptorAssetHydration,
    manifestToPlanningDocument,
} from '../../../src/lib/editor-engine/editor-command-planner';
import type {
    EditorialTranscriptionPublicationHydration,
    EditorialTranscriptionPublicationRequest,
    SubtitleTranscriptionPublicationRequest,
} from '../../../src/lib/editor-engine';
import type { ManagedCoordinator } from '../../coordinator/managed-coordinator';
import { managedError } from '../../coordinator/errors';
import type { DurableJobScheduler } from '../../jobs/durable-job-scheduler';
import type { CanonicalToolCall, CoordinatorResult } from '../../mcp/contracts';
import type { CoordinatorCallContext } from '../../server/coordinator-adapter';
import type {
    ManagedCoreCommand,
    ManagedCoreEditorState,
    ManagedCoreResult,
} from '../core-editor-port';
import {
    ManagedCredentialCapabilityAuthority,
    ManagedEndpointCapabilityAuthority,
} from '../transcription/capabilities';
import type {
    ManagedChunkRecordV1,
    ManagedTranscriptionCasPort,
    ManagedMergedWordV1,
    ManagedTranscriptionSourceResult,
    PreparedManagedCoverageUpdate,
    PreparedManagedCommitCapability,
} from '../transcription/contracts';
import { FilesystemManagedTranscriptionCas } from '../transcription/filesystem-cas';
import {
    createManagedTranscriptionIntegration,
} from '../transcription/transcription-tool-service';

type ProductionCoordinator = ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

export interface ProductionTranscriptionRuntime {
    registerJobHandlers(scheduler: DurableJobScheduler): void;
    start(
        call: CanonicalToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult>;
    prepareImportedRanges(input: {
        readonly projectId: string;
        readonly manifest: EditorManifestV4;
        readonly records: readonly Readonly<Record<string, unknown>>[];
        readonly signal: AbortSignal;
    }): Promise<PreparedImportedRanges>;
    validateTranscriptPins(input: {
        readonly projectId: string;
        readonly editor: import('../../coordinator/managed-editor-port')
            .ManagedEditorSnapshot<ManagedCoreEditorState>;
        readonly signal: AbortSignal;
    }): Promise<readonly TranscriptionValidationFinding[]>;
}

interface PreparedImportedRanges {
    readonly manifest: EditorManifestV4;
    readonly writes: readonly import(
        '../../persistence/managed-filesystem-store'
    ).DurableWrite[];
    accept(): Promise<void>;
    reject(): Promise<void>;
}

interface TranscriptionValidationFinding {
    readonly code: string;
    readonly subjectId?: string;
}

export async function createProductionTranscriptionRuntime(
    dataRoot: string,
    coordinator: ProductionCoordinator,
): Promise<ProductionTranscriptionRuntime> {
    const endpoints = new ManagedEndpointCapabilityAuthority();
    const credentials = new ManagedCredentialCapabilityAuthority();
    const pendingCoverage = new Map<string, TranscriptionCoverageRecordV2>();
    const filesystemCas = new FilesystemManagedTranscriptionCas({
        root: join(dataRoot, 'coordinator', 'transcription-cas'),
        coverageHeads: {
            readCoverageFamily: async (input) => {
                const records = await coordinator.store.readNamespace<
                    TranscriptionCoverageRecordV2
                >(input.projectId, 'transcription/coverage');
                return records.filter((record) => (
                    record.sourceFingerprint === input.sourceFingerprint
                    && record.acquisitionProfileDigest === input.acquisitionProfileDigest
                ));
            },
        },
    });
    await filesystemCas.initialize();
    const cas = new Proxy(filesystemCas, {
        get(target, property, receiver) {
            if (property !== 'prepareCoverageUpdate') {
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return async (
                input: Parameters<ManagedTranscriptionCasPort['prepareCoverageUpdate']>[0],
            ) => {
                const prepared = await target.prepareCoverageUpdate(input);
                if (prepared) pendingCoverage.set(input.record.recordId, input.record);
                return prepared;
            };
        },
    }) as ManagedTranscriptionCasPort;
    coordinator.configureTranscriptionPublicationAuthority({
        prepare: async (input) => {
            if (input.publication.kind === 'subtitle') {
                return {
                    writes: [],
                    verify: () => true,
                };
            }
            const writes = input.publication.records.map((record) => ({
                relativePath:
                    `transcription/editorial-records/${record.recordId.slice(7)}.json`,
                value: {
                    recordId: record.recordId,
                    body: structuredClone(record.body),
                },
            }));
            return {
                writes,
                verify: async () => {
                    const current = await coordinator.store.readNamespace<
                        TranscriptionCoverageRecordV2
                    >(input.projectId, 'transcription/coverage');
                    const currentIds = new Set(
                        current.map((record) => record.recordId),
                    );
                    return input.publication.records.every((record) => (
                        record.expectedCoverageRecordIds.every(
                            (recordId) => currentIds.has(recordId),
                        )
                    ));
                },
            };
        },
    });
    const dependencies = {
        endpoints,
        credentials,
        sources: {
            openRetainedSource: (
                projectId: string,
                sourceId: string,
                _signal: AbortSignal,
            ) => {
                void _signal;
                return coordinator.openRetainedSource(projectId, sourceId);
            },
        },
        freshness: {
            assertCurrent: async (input: {
                projectId: string;
                capturedState: import('../../mcp/contracts').StateToken;
                sources: readonly { sourceId: string; sourceFingerprint: string }[];
            }) => {
                const current = coordinator.getProject(input.projectId);
                if (
                    current.state.sessionRevision !== input.capturedState.sessionRevision
                    || current.state.documentRevision !== input.capturedState.documentRevision
                    || current.state.audioGraphRevision !== input.capturedState.audioGraphRevision
                ) {
                    throw managedError(
                        'SESSION_REVISION_CONFLICT',
                        'The transcription source state changed.',
                        true,
                    );
                }
                for (const source of input.sources) {
                    const retained = current.envelope.sourceRegistry.find(
                        (candidate) => candidate.sourceId === source.sourceId
                            && !candidate.releasedAt,
                    );
                    if (!retained || retained.digest !== source.sourceFingerprint) {
                        throw managedError(
                            'SOURCE_CHANGED',
                            'A transcription source changed.',
                            true,
                        );
                    }
                }
            },
        },
        cas,
        publisher: {
            prepareEditorialPublication: async (input: {
                projectId: string;
                capturedState: import('../../mcp/contracts').StateToken;
                sources: readonly ManagedTranscriptionSourceResult[];
                signal: AbortSignal;
            }) => prepareEditorialPublication(
                coordinator,
                filesystemCas,
                pendingCoverage,
                input,
            ),
            prepareSubtitlePublication: async (input: {
                projectId: string;
                capturedState: import('../../mcp/contracts').StateToken;
                targetIds: readonly string[];
                sources: readonly ManagedTranscriptionSourceResult[];
                signal: AbortSignal;
            }) => prepareSubtitlePublication(
                coordinator,
                filesystemCas,
                pendingCoverage,
                input,
            ),
        },
    };

    const integration = createManagedTranscriptionIntegration({
        coordinator,
        core: {
            planStart: async (input) => {
                input.signal.throwIfAborted();
                const project = coordinator.getProject(input.projectId);
                if (
                    project.state.sessionEpoch !== input.capturedState.sessionEpoch
                    || project.state.sessionRevision
                        !== input.capturedState.sessionRevision
                ) {
                    throw managedError(
                        'SESSION_REVISION_CONFLICT',
                        'The transcription source state changed.',
                        true,
                    );
                }
                const manifest =
                    project.envelope.editor.state.snapshot.manifest;
                const targetIds = authorizeTranscriptionTargets(
                    manifest,
                    input.transcriptionKind,
                    input.targetTrackIds,
                );
                const selectedSources = transcriptionSourceIds(
                    manifest,
                    input.transcriptionKind,
                    targetIds,
                );
                const activeRegistry = new Map(
                    project.envelope.sourceRegistry
                        .filter((source) => source.releasedAt === undefined)
                        .map((source) => [source.sourceId, source]),
                );
                const descriptors = new Map([
                    ...manifest.videoSourceDescriptors,
                    ...manifest.audioSourceDescriptors,
                ].map((descriptor) => [descriptor.id, descriptor]));
                const sources = (
                    selectedSources.size > 0
                        ? [...selectedSources]
                        : [...activeRegistry.keys()]
                ).map((sourceId) => {
                    const source = activeRegistry.get(sourceId);
                    const descriptor = descriptors.get(sourceId);
                    if (!source || !descriptor || descriptor.duration <= 0) {
                        throw managedError(
                            'SOURCE_CHANGED',
                            'An authorized transcription source is unavailable.',
                            true,
                        );
                    }
                    return {
                        sourceId,
                        sourceFingerprint:
                            source.digest as `sha256:${string}`,
                        sourceSampleCount: Math.max(
                            1,
                            Math.round(descriptor.duration * 16_000),
                        ),
                    };
                });
                return { targetIds, sources };
            },
        },
        endpoints,
        credentials,
        jobDependencies: dependencies,
    });

    return {
        registerJobHandlers: (scheduler) => {
            integration.install(scheduler);
        },
        start: integration.handler,
        prepareImportedRanges: (input) => prepareImportedRanges({
            ...input,
            coordinator,
            cas,
        }),
        validateTranscriptPins: (input) => validateTranscriptPins({
            ...input,
            coordinator,
            cas,
        }),
    };
}

async function prepareImportedRanges(input: {
    readonly projectId: string;
    readonly manifest: EditorManifestV4;
    readonly records: readonly Readonly<Record<string, unknown>>[];
    readonly signal: AbortSignal;
    readonly coordinator: ProductionCoordinator;
    readonly cas: ManagedTranscriptionCasPort;
}): Promise<PreparedImportedRanges> {
    if (input.records.length === 0) {
        return {
            manifest: structuredClone(input.manifest),
            writes: [],
            accept: async () => undefined,
            reject: async () => undefined,
        };
    }
    const coverageById = new Map<string, TranscriptionCoverageRecordV2>();
    const chunksById = new Map<string, RangeTranscriptChunkRecordV2>();
    for (const record of input.records) {
        if ('acquisitionWindows' in record) {
            const coverage = record as unknown as TranscriptionCoverageRecordV2;
            await verifyTranscriptionCoverageRecordV2(coverage);
            coverageById.set(coverage.recordId, coverage);
        } else {
            const chunk = record as unknown as RangeTranscriptChunkRecordV2;
            chunksById.set(chunk.recordId, chunk);
        }
    }
    const manifest = structuredClone(input.manifest);
    const preparedCoverage: PreparedManagedCoverageUpdate[] = [];
    const familyKeys = new Set<string>();
    try {
        for (const descriptor of manifest.editorialTranscriptDescriptors) {
            if (descriptor.version !== 2) continue;
            input.signal.throwIfAborted();
            const coverage = coverageById.get(descriptor.coverageRecordId);
            if (!coverage) {
                throw managedError(
                    'SOURCE_CHANGED',
                    'Imported editorial coverage is unavailable.',
                );
            }
            const familyKey =
                `${descriptor.sourceFingerprint}\0${descriptor.acquisitionProfileDigest}`;
            if (familyKeys.has(familyKey)) {
                throw managedError(
                    'INVALID_REQUEST',
                    'Imported coverage contains a duplicate acquisition family.',
                );
            }
            familyKeys.add(familyKey);
            const convertedByOriginalId = new Map<
                string,
                ManagedChunkRecordV1
            >();
            for (const originalId of coverage.acquisitionWindows.flatMap(
                (window) => window.chunkRecordIds,
            )) {
                const original = chunksById.get(originalId);
                if (!original) {
                    throw managedError(
                        'SOURCE_CHANGED',
                        'Imported editorial coverage has a missing chunk.',
                    );
                }
                const body = {
                    schemaVersion: 1 as const,
                    sourceFingerprint: original.sourceFingerprint as
                        `sha256:${string}`,
                    acquisitionProfileDigest:
                        original.acquisitionProfileDigest,
                    windowId: original.windowId,
                    decoded: structuredClone(original.decoded),
                    canonicalModel: descriptor.canonicalModel,
                    words: structuredClone(original.words),
                };
                const converted: ManagedChunkRecordV1 = {
                    ...body,
                    recordId: await sha256CanonicalJson(body),
                };
                await input.cas.stageChunk(converted, input.signal);
                convertedByOriginalId.set(originalId, converted);
            }
            const acquisitionWindows = coverage.acquisitionWindows.map(
                (window) => ({
                    ...structuredClone(window),
                    chunkRecordIds: window.chunkRecordIds.map((recordId) => (
                        convertedByOriginalId.get(recordId)!.recordId
                    )),
                }),
            );
            const mergedManifest = await input.cas.stageMergedTranscript({
                sourceFingerprint: coverage.sourceFingerprint as
                    `sha256:${string}`,
                acquisitionProfileDigest:
                    coverage.acquisitionProfileDigest,
                sourceSampleCount: coverage.sourceSampleCount,
                language: descriptor.language,
                speakerMode: descriptor.speakerMode,
                canonicalModel: descriptor.canonicalModel,
                coreCoverage: coverage.coreCoverage,
                chunks: [...convertedByOriginalId.values()].map((chunk) => ({
                    recordId: chunk.recordId,
                    windowId: chunk.windowId,
                    decoded: chunk.decoded,
                })),
                signal: input.signal,
            });
            const {
                recordId: _originalCoverageId,
                version: _version,
                mergeAlgorithmVersion,
                ...coverageBody
            } = coverage;
            void _originalCoverageId;
            void _version;
            const convertedCoverage =
                await createTranscriptionCoverageRecordV2({
                    ...coverageBody,
                    mergeAlgorithmVersion,
                    acquisitionWindows,
                });
            const current = await input.cas.listCompatibleCoverage({
                projectId: input.projectId,
                sourceFingerprint: convertedCoverage.sourceFingerprint as
                    `sha256:${string}`,
                acquisitionProfileDigest:
                    convertedCoverage.acquisitionProfileDigest,
            });
            const prepared = await input.cas.prepareCoverageUpdate({
                projectId: input.projectId,
                sourceFingerprint: convertedCoverage.sourceFingerprint as
                    `sha256:${string}`,
                acquisitionProfileDigest:
                    convertedCoverage.acquisitionProfileDigest,
                expectedCoverageRecordIds: current.records.map(
                    (record) => record.recordId,
                ),
                record: convertedCoverage,
                pinRecordIds: [
                    ...convertedByOriginalId.values(),
                ].map((chunk) => chunk.recordId).concat([
                    mergedManifest.recordId,
                    mergedManifest.mergedWordsRecordId,
                ]),
                signal: input.signal,
            });
            if (!prepared) {
                throw managedError(
                    'REVISION_CONFLICT',
                    'Imported coverage changed while it was prepared.',
                    true,
                );
            }
            preparedCoverage.push(prepared);
            descriptor.coverageRecordId = convertedCoverage.recordId;
        }
        return {
            manifest,
            writes: preparedCoverage.flatMap((prepared) => (
                prepared.durableWrites()
            )),
            accept: async () => {
                for (const prepared of preparedCoverage) {
                    await prepared.accept();
                }
            },
            reject: async () => {
                await Promise.allSettled(
                    preparedCoverage.map((prepared) => prepared.reject()),
                );
            },
        };
    } catch (error) {
        await Promise.allSettled(
            preparedCoverage.map((prepared) => prepared.reject()),
        );
        throw error;
    }
}

async function validateTranscriptPins(input: {
    readonly projectId: string;
    readonly editor: import('../../coordinator/managed-editor-port')
        .ManagedEditorSnapshot<ManagedCoreEditorState>;
    readonly signal: AbortSignal;
    readonly coordinator: ProductionCoordinator;
    readonly cas: ManagedTranscriptionCasPort;
}): Promise<readonly TranscriptionValidationFinding[]> {
    const findings: TranscriptionValidationFinding[] = [];
    const [records, coverage, pins] = await Promise.all([
        input.coordinator.store.readNamespace<{
            recordId?: string;
            body?: unknown;
        }>(input.projectId, 'transcription/editorial-records'),
        input.coordinator.store.readNamespace<TranscriptionCoverageRecordV2>(
            input.projectId,
            'transcription/coverage',
        ),
        input.coordinator.store.readNamespace<{
            recordIds?: readonly string[];
        }>(input.projectId, 'transcription/pins'),
    ]);
    const recordsById = new Map(records.map((record) => [
        record.recordId,
        record,
    ]));
    const coverageById = new Map(coverage.map((record) => [
        record.recordId,
        record,
    ]));
    const pinnedTranscriptIds = new Set([
        ...input.editor.transcriptRecordIds,
        ...input.editor.state.transcriptPins.historyRecordIds,
        ...input.editor.state.transcriptPins.redoRecordIds,
    ]);
    for (const recordId of pinnedTranscriptIds) {
        const record = recordsById.get(recordId);
        try {
            if (!record?.body) throw new Error('missing record');
            await verifyCanonicalEditorialTranscriptRecord(
                record.body,
                recordId as `sha256:${string}`,
            );
        } catch {
            findings.push({
                code: 'transcript-record-missing',
                subjectId: recordId,
            });
        }
    }
    for (const descriptor of input.editor.state.snapshot.manifest
        .editorialTranscriptDescriptors) {
        if (descriptor.version !== 2) continue;
        const record = coverageById.get(descriptor.coverageRecordId);
        try {
            if (!record) throw new Error('missing coverage');
            await verifyTranscriptionCoverageRecordV2(record);
            for (const chunkId of record.acquisitionWindows.flatMap(
                (window) => window.chunkRecordIds,
            )) {
                if (!await input.cas.verifyRecord(chunkId, input.signal)) {
                    findings.push({
                        code: 'transcript-chunk-missing',
                        subjectId: chunkId,
                    });
                }
            }
        } catch {
            findings.push({
                code: 'transcript-coverage-corrupt',
                subjectId: descriptor.coverageRecordId,
            });
        }
    }
    for (const recordId of pins.flatMap((pin) => pin.recordIds ?? [])) {
        if (
            !/^sha256:[a-f0-9]{64}$/u.test(recordId)
            || !await input.cas.verifyRecord(
                recordId as `sha256:${string}`,
                input.signal,
            )
        ) {
            findings.push({
                code: 'transcript-cas-record-corrupt',
                subjectId: recordId,
            });
        }
    }
    return findings;
}

function authorizeTranscriptionTargets(
    manifest: import('../../../src/types/video').EditorManifestV4,
    kind: 'editorial' | 'subtitle',
    requested: readonly string[],
): readonly string[] {
    const allowed = new Set(kind === 'subtitle'
        ? manifest.subtitleTracks.map((track) => track.id)
        : [
            ...manifest.videoTracks.map((track) => track.id),
            ...manifest.audioTracks.map((track) => track.id),
        ]);
    if (
        requested.length === 0
        || new Set(requested).size !== requested.length
        || requested.some((targetId) => !allowed.has(targetId))
    ) {
        throw managedError(
            'NOT_FOUND',
            'A transcription target track was not found.',
        );
    }
    return [...requested];
}

function transcriptionSourceIds(
    manifest: import('../../../src/types/video').EditorManifestV4,
    kind: 'editorial' | 'subtitle',
    targetIds: readonly string[],
): Set<string> {
    if (kind === 'subtitle') return new Set();
    const targets = new Set(targetIds);
    return new Set([
        ...manifest.videoClips
            .filter((clip) => targets.has(clip.trackId))
            .map((clip) => clip.sourceId),
        ...manifest.audioTracks
            .filter((track) => targets.has(track.id))
            .flatMap((track) => track.clips.map((clip) => (
                clip.source.kind === 'audio-source'
                    ? clip.source.audioSourceId
                    : clip.source.videoSourceId
            ))),
    ]);
}

async function prepareEditorialPublication(
    coordinator: ProductionCoordinator,
    cas: FilesystemManagedTranscriptionCas,
    coverageById: ReadonlyMap<string, TranscriptionCoverageRecordV2>,
    input: {
        projectId: string;
        capturedState: import('../../mcp/contracts').StateToken;
        sources: readonly ManagedTranscriptionSourceResult[];
        signal: AbortSignal;
    },
): Promise<PreparedManagedCommitCapability> {
    const publications: EditorialTranscriptionPublicationRequest['publications'] = [];
    const records: EditorialTranscriptionPublicationHydration['records'] = [];
    for (const source of input.sources) {
        const material = await sourceMaterial(cas, coverageById, source, input.signal);
        publications.push({
            descriptor: createEditorialTranscriptDescriptorV2({
                recordId: material.body.recordId,
                coverageRecord: material.coverage,
                requestKey: source.requestKey,
                sourceId: source.sourceId,
                sourceFingerprint: source.sourceFingerprint,
                endpointIdentityDigest: material.coverage.endpointIdentityDigest,
                body: material.body.body,
                acquisition: 'provider',
            }),
            expectedCoverageRecordIds: source.coverageRecordId
                ? [source.coverageRecordId]
                : [],
        });
        records.push({
            recordId: material.body.recordId,
            body: material.body.body,
            coverageRecord: material.coverage,
            currentCoverageRecordIds: [],
            availableChunkRecordIds: material.coverage.acquisitionWindows.flatMap(
                (window) => window.chunkRecordIds,
            ),
        });
    }
    return coordinator.prepareEditorialTranscriptionPublication(
        input.projectId,
        {
            apiVersion: '2026-07-25',
            toolName: 'waptions_transcription_publish_editorial',
            sessionEpoch: input.capturedState.sessionEpoch,
            expected: expected(input.capturedState),
            idempotencyKey: `managed-editorial:${input.sources.map((source) => (
                source.mergedRecordId.slice(7, 23)
            )).join(':')}`,
            publications,
        },
        { records },
    );
}

async function prepareSubtitlePublication(
    coordinator: ProductionCoordinator,
    cas: FilesystemManagedTranscriptionCas,
    coverageById: ReadonlyMap<string, TranscriptionCoverageRecordV2>,
    input: {
        projectId: string;
        capturedState: import('../../mcp/contracts').StateToken;
        targetIds: readonly string[];
        sources: readonly ManagedTranscriptionSourceResult[];
        signal: AbortSignal;
    },
): Promise<PreparedManagedCommitCapability> {
    const project = coordinator.getProject(input.projectId);
    const manifest = project.envelope.editor.state.snapshot.manifest;
    const words = [];
    for (const source of input.sources) {
        words.push(...(await sourceMaterial(cas, coverageById, source, input.signal)).body.body.words);
    }
    const text = words.map((word) => word.text).join(' ').slice(0, 16_000);
    const startTime = (words[0]?.editableStartSample ?? 0) / 16_000;
    const endTime = Math.max(
        startTime + 0.001,
        (words.at(-1)?.editableEndSample ?? 1) / 16_000,
    );
    const document = manifestToPlanningDocument(
        manifest,
        createDescriptorAssetHydration(manifest),
    );
    const request: SubtitleTranscriptionPublicationRequest = {
        apiVersion: '2026-07-25',
        toolName: 'waptions_transcription_publish_subtitles',
        sessionEpoch: input.capturedState.sessionEpoch,
        expected: expected(input.capturedState),
        idempotencyKey: `managed-subtitle:${input.sources.map((source) => (
            source.mergedRecordId.slice(7, 23)
        )).join(':')}`,
        sourceAnchor: {
            audioGraphSignature: getCanonicalEditorAudioGraphSignature(document),
            activeSubtitleTrackId: manifest.activeSubtitleTrackId,
        },
        publications: input.targetIds.map((targetId, index) => {
            const track = manifest.subtitleTracks.find((candidate) => candidate.id === targetId);
            if (!track) throw managedError('NOT_FOUND', 'A subtitle target track was not found.');
            const provenance = manifest.transcriptionByTrackId[targetId];
            const cue = {
                id: `managed-subtitle-${index}`,
                startTime,
                endTime,
                text,
            };
            return {
                kind: 'single-track' as const,
                targetTrackId: targetId,
                targetAnchors: [{
                    trackId: targetId,
                    trackSignature: getStableValueSignature(track),
                    provenanceSignature: provenance
                        ? getStableValueSignature(provenance)
                        : null,
                }],
                payload: {
                    subtitles: [cue],
                    transcription: {
                        raw: [cue],
                        groups: { managed: [cue] },
                        containerIds: ['managed'],
                    },
                },
                metadata: {
                    provider: 'managed-endpoint',
                    generatedAt: new Date().toISOString(),
                },
            };
        }),
    };
    return coordinator.prepareSubtitleTranscriptionPublication(input.projectId, request);
}

async function sourceMaterial(
    cas: FilesystemManagedTranscriptionCas,
    coverageById: ReadonlyMap<string, TranscriptionCoverageRecordV2>,
    source: ManagedTranscriptionSourceResult,
    signal: AbortSignal,
) {
    const manifest = await cas.getManifest(source.mergedRecordId);
    const coverage = coverageById.get(source.coverageRecordId);
    if (!manifest || !coverage) {
        throw managedError('SOURCE_CHANGED', 'Managed transcription CAS material is unavailable.');
    }
    const mergedWords: ManagedMergedWordV1[] = [];
    for await (const word of cas.iterateMergedWords(manifest.mergedWordsRecordId, signal)) {
        mergedWords.push(word);
    }
    const labels = Array.from(new Set(
        mergedWords.flatMap((word) => word.speaker ? [word.speaker.providerSpeakerId] : []),
    ));
    const body = await createCanonicalEditorialTranscriptRecord({
        sourceFingerprint: manifest.sourceFingerprint,
        sampleCount: manifest.sourceSampleCount,
        canonicalModel: manifest.canonicalModel,
        language: manifest.language,
        speakerMode: manifest.speakerMode,
        noAudioStream: false,
        words: mergedWords.map((word) => ({
            text: word.text,
            alignedStartSample: word.startSample,
            alignedEndSample: word.endSample,
            editableStartSample: word.startSample,
            editableEndSample: word.endSample,
            probability: word.probability,
            speakerLabel: word.speaker?.providerSpeakerId ?? null,
        })),
        speechRegions: [],
        editBoundaries: [],
        speakers: labels.map((label) => {
            const speakerWords = mergedWords.filter(
                (word) => word.speaker?.providerSpeakerId === label,
            );
            return {
                label,
                segments: speakerWords.length > 0
                    ? [{
                        startSample: speakerWords[0]!.startSample,
                        endSample: speakerWords.at(-1)!.endSample,
                    }]
                    : [],
            };
        }),
    });
    return { body, coverage };
}

function expected(state: import('../../mcp/contracts').StateToken) {
    return {
        sessionRevision: state.sessionRevision,
        documentRevision: state.documentRevision,
        audioGraphRevision: state.audioGraphRevision,
        ...(state.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: state.narrativeRevision }),
    };
}
