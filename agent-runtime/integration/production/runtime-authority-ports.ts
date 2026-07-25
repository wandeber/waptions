import { createResolvedRenderPlan } from '../../../src/lib/render-plan';
import type {
    ManagedCoreAssetAuthority,
    ManagedCoreCommand,
    ManagedCoreEditorState,
    ManagedCoreResult,
} from '../core-editor-port';
import type { ManagedCoordinator } from '../../coordinator/managed-coordinator';
import { canonicalDigest } from '../../persistence/canonical-json';
import type {
    ProductionDeepValidationPorts,
    ProductionRuntimeAuthorityPorts,
    ProductionValidationFinding,
} from './contracts';
import type {
    PathGrantMediaAdapter,
} from '../media/path-grant-media-adapter';
import type {
    ProductionResourceBudget,
    ProductionRuntimeMetrics,
} from './resource-budget';
import type {
    ProductionTranscriptionRuntime,
} from './transcription-runtime';

type ProductionCoordinator = ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

/**
 * Binds deep validation and diagnostics to the same recovered authorities used
 * by Core, jobs and rendering. No validator opens a caller-provided path.
 */
export function createProductionRuntimeAuthorityPorts(input: {
    readonly coordinator: ProductionCoordinator;
    readonly mediaAssets: ManagedCoreAssetAuthority;
    readonly media: PathGrantMediaAdapter;
    readonly budget: ProductionResourceBudget;
    readonly metrics: ProductionRuntimeMetrics;
    readonly transcription: ProductionTranscriptionRuntime;
}): ProductionRuntimeAuthorityPorts {
    return {
        validation: createValidationPorts(input),
        diagnostics: {
            resourceBudget: {
                snapshot: () => {
                    // Review and render reservations both acquire this single
                    // process authority, so its counters are the exhaustive
                    // byte view rather than render-only category counters.
                    const snapshot =
                        input.coordinator.decodedMemoryBudget.snapshot();
                    return {
                        currentBytes: snapshot.currentBytes,
                        peakBytes: snapshot.peakBytes,
                    };
                },
            },
            decodedMemory: input.coordinator.decodedMemoryBudget,
            decoderLeases: {
                snapshot: () => {
                    const resources = input.budget.snapshot();
                    return {
                        reservedPixelBytes:
                            resources.current['decoded-pixel-bytes'],
                        leasedPixelBytes:
                            resources.current['decoded-pixel-bytes'],
                        leaseCount:
                            resources.current['video-decoder-sessions'],
                    };
                },
            },
            decoderSessions: {
                snapshot: () => ({
                    activeSessions:
                        input.budget.snapshot()
                            .current['video-decoder-sessions'],
                }),
            },
            jobQueues: {
                snapshot: (projectId) => {
                    const queues: Record<string, number> = {};
                    for (const job of input.coordinator.jobs.list(projectId)) {
                        queues[job.state] = (queues[job.state] ?? 0) + 1;
                    }
                    return queues;
                },
            },
            cacheMetrics: input.metrics,
        },
    };
}

function createValidationPorts(input: {
    readonly coordinator: ProductionCoordinator;
    readonly mediaAssets: ManagedCoreAssetAuthority;
    readonly media: PathGrantMediaAdapter;
    readonly transcription: ProductionTranscriptionRuntime;
}): ProductionDeepValidationPorts {
    return {
        hydration: {
            validate: async (request) => {
                try {
                    const project = input.coordinator.getProject(
                        request.projectId,
                    );
                    await input.mediaAssets.resolve({
                        projectId: request.projectId,
                        head: project.envelope.editor,
                        videoSourceIds:
                            request.manifest.videoSourceDescriptors.map(
                                (source) => source.id,
                            ),
                        audioSourceIds:
                            request.manifest.audioSourceDescriptors.map(
                                (source) => source.id,
                            ),
                    });
                    return [];
                } catch {
                    return [finding('manifest-hydration-missing')];
                }
            },
        },
        sources: {
            validate: async (request) => {
                const project = input.coordinator.getProject(
                    request.projectId,
                );
                const findings: ProductionValidationFinding[] = [];
                for (const source of project.envelope.sourceRegistry) {
                    if (source.releasedAt) continue;
                    request.context.signal.throwIfAborted();
                    let opened:
                        | Awaited<ReturnType<
                            ProductionCoordinator['openRetainedSource']
                        >>
                        | undefined;
                    try {
                        opened = await input.coordinator.openRetainedSource(
                            request.projectId,
                            source.sourceId,
                        );
                        await opened.verifyUnchanged();
                    } catch {
                        findings.push(finding(
                            'source-stale',
                            source.sourceId,
                        ));
                    } finally {
                        await opened?.close().catch(() => undefined);
                    }
                }
                return findings;
            },
        },
        historyWal: {
            validate: async (request) => {
                const [persisted, receipts, events] = await Promise.all([
                    input.coordinator.store.readProject(request.projectId),
                    input.coordinator.store.readNamespace(
                        request.projectId,
                        'receipts',
                    ),
                    input.coordinator.store.readNamespace(
                        request.projectId,
                        'events',
                    ),
                ]);
                const current = input.coordinator.getProject(
                    request.projectId,
                ).envelope;
                if (
                    !persisted
                    || canonicalDigest(persisted.editor)
                        !== canonicalDigest(current.editor)
                    || persisted.sessionRevision !== current.sessionRevision
                    || persisted.receiptRevision < receipts.length
                    || persisted.eventSequence < events.length
                ) {
                    return [finding('history-wal-mismatch')];
                }
                return [];
            },
        },
        transcriptPins: {
            validate: async (request) => {
                const project = input.coordinator.getProject(
                    request.projectId,
                );
                return input.transcription.validateTranscriptPins({
                    projectId: request.projectId,
                    editor: project.envelope.editor,
                    signal: request.context.signal,
                });
            },
        },
        renderability: {
            validate: async (request) => {
                try {
                    createResolvedRenderPlan({
                        version: 1,
                        snapshotId: canonicalDigest({
                            projectId: request.projectId,
                            state: request.state,
                            manifest: request.manifest,
                        }),
                        manifest: structuredClone(request.manifest),
                        sourceIdentities: [
                            ...request.manifest.videoSourceDescriptors.map(
                                (descriptor) => sourceIdentity(
                                    descriptor,
                                    'video',
                                    input.media,
                                ),
                            ),
                            ...request.manifest.audioSourceDescriptors.map(
                                (descriptor) => sourceIdentity(
                                    descriptor,
                                    'audio',
                                    input.media,
                                ),
                            ),
                        ],
                    });
                    return [];
                } catch {
                    return [finding('render-plan-invalid')];
                }
            },
        },
    };
}

function sourceIdentity(
    descriptor: {
        readonly id: string;
        readonly fingerprint: string;
        readonly size: number;
        readonly lastModified: number;
    },
    kind: 'video' | 'audio',
    media: PathGrantMediaAdapter,
) {
    const record = media.getBySourceId(descriptor.id);
    if (!record || record.class !== kind) {
        throw new Error('The render source authority is unavailable.');
    }
    return {
        sourceId: descriptor.id,
        kind,
        byteSourceCapabilityId: record.handle.capabilityId,
        fingerprint: descriptor.fingerprint,
        size: descriptor.size,
        lastModified: descriptor.lastModified,
    };
}

function finding(
    code: string,
    subjectId?: string,
): ProductionValidationFinding {
    return subjectId === undefined ? { code } : { code, subjectId };
}
