import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { JobExecutionContext } from '../../jobs/durable-job-scheduler';
import { sha256CanonicalJson } from '../../../src/lib/editorial-transcription/canonical-json';
import {
    DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
} from '../../../src/lib/editorial-transcription/preferences';
import type {
    Sha256Digest,
} from '../../../src/types/editorial';
import {
    ManagedCredentialCapabilityAuthority,
    ManagedEndpointCapabilityAuthority,
} from './capabilities';
import type {
    CoreTranscriptionPublisher,
    ManagedChunkRecordV1,
    ManagedMergedWordV1,
    ManagedTranscriptManifestV1,
    ManagedTranscriptionCasPort,
    ManagedTranscriptionCheckpointV1,
    ManagedTranscriptionFactoryDependencies,
    ManagedTranscriptionJobInputV1,
    ManagedTranscriptionProviderPort,
    PreparedManagedCommitCapability,
    PreparedManagedCoverageUpdate,
} from './contracts';
import {
    ManagedTranscriptionError,
} from './errors';
import {
    createManagedTranscriptionJobHandlers,
    managedTranscriptionTerminalWrites,
    ManagedTranscriptionJobHandler,
    rejectManagedTranscriptionTerminalPublication,
} from './managed-transcription-job-handler';

describe('managed transcription job handler', () => {
    it('mints the source-of-truth local default and returns an ID-only editorial proposal', async () => {
        const fixture = createFixture();
        const issue = vi.spyOn(fixture.endpoints, 'issue');
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );
        const output = await handler.run(jobInput('editorial-transcription'), context());

        expect(issue).toHaveBeenCalledWith(expect.objectContaining({
            endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
            kind: 'local',
        }));
        expect(fixture.publisher.editorial).toHaveBeenCalledTimes(1);
        expect(fixture.publisher.subtitle).not.toHaveBeenCalled();
        expect(output.result.acquiredWindowCount).toBe(1);
        expect(output.terminalPublication.transcription.preparedCorePublication.kind)
            .toBe('editorial');
        const serialized = JSON.stringify(output.terminalPublication);
        expect(serialized).not.toContain(DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT);
        expect(serialized).not.toContain('provider-word-sentinel');
        expect(serialized).not.toContain('provider-secret-sentinel');
        await rejectManagedTranscriptionTerminalPublication(output.terminalPublication);
    });

    it('uses one global semaphore across independent editorial and subtitle publication paths', async () => {
        let active = 0;
        let peak = 0;
        const fixture = createFixture({
            provider: {
                transcribe: async () => {
                    active += 1;
                    peak = Math.max(peak, active);
                    await new Promise(resolve => setTimeout(resolve, 20));
                    active -= 1;
                    return providerTranscript();
                },
            },
        });
        const editorialHandlers = createManagedTranscriptionJobHandlers(fixture.dependencies);
        const subtitleHandlers = createManagedTranscriptionJobHandlers(fixture.dependencies);

        const [editorial, subtitle] = await Promise.all([
            editorialHandlers['editorial-transcription'].run(
                jobInput('editorial-transcription', { sourceId: 'source-editorial' }),
                context(),
            ),
            subtitleHandlers['subtitle-transcription'].run(
                jobInput('subtitle-transcription', {
                    sourceId: 'source-subtitle',
                    fingerprintCharacter: 'e',
                }),
                context(),
            ),
        ]);

        expect(peak).toBe(1);
        expect(fixture.publisher.editorial).toHaveBeenCalledTimes(1);
        expect(fixture.publisher.subtitle).toHaveBeenCalledTimes(1);
        expect(editorial.terminalPublication.transcription.kind).toBe(
            'editorial-transcription',
        );
        expect(subtitle.terminalPublication.transcription.kind).toBe(
            'subtitle-transcription',
        );
        await Promise.all([
            rejectManagedTranscriptionTerminalPublication(editorial.terminalPublication),
            rejectManagedTranscriptionTerminalPublication(subtitle.terminalPublication),
        ]);
    });

    it('lets an explicit capability win and keeps URLs, credentials and transcript bodies out of durable surfaces', async () => {
        const fixture = createFixture();
        const scope = { projectId: 'project-1', sessionEpoch: 'epoch-1' };
        const endpointId = await fixture.endpoints.issue({
            endpoint: 'http://localhost:45555/v1/audio/transcriptions',
            kind: 'local',
            scope,
            lifetimeMilliseconds: 10_000,
        });
        const credentialId = fixture.credentials.issue({
            secret: 'provider-secret-sentinel',
            scope,
            endpointCapabilityId: endpointId,
            lifetimeMilliseconds: 10_000,
        });
        const issue = vi.spyOn(fixture.endpoints, 'issue');
        issue.mockClear();
        const checkpoints: ManagedTranscriptionCheckpointV1[] = [];
        const input = {
            ...jobInput('editorial-transcription'),
            providerPolicy: {
                kind: 'managed-local-endpoint' as const,
                endpointCapabilityId: endpointId,
                credentialCapabilityId: credentialId,
            },
        };
        const output = await new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run(input, context({
            update: async (update) => {
                if (update.checkpoint) checkpoints.push(structuredClone(update.checkpoint));
            },
        }));

        expect(issue).not.toHaveBeenCalled();
        const durableSurfaces = JSON.stringify({
            input,
            checkpoints,
            result: output.result,
            terminal: output.terminalPublication,
            writes: managedTranscriptionTerminalWrites(output.terminalPublication),
        });
        expect(durableSurfaces).not.toContain('http://localhost:45555');
        expect(durableSurfaces).not.toContain('provider-secret-sentinel');
        expect(durableSurfaces).not.toContain('provider-word-sentinel');
        expect(durableSurfaces).not.toMatch(/authorization|bearer\s/i);
        await rejectManagedTranscriptionTerminalPublication(output.terminalPublication);
    });

    it('reuses a staged checkpoint chunk after a crash without a second provider request', async () => {
        const fixture = createFixture();
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );
        let checkpointValue: ManagedTranscriptionCheckpointV1 | undefined;
        const crashingContext = context({
            update: async (update) => {
                if (update.checkpoint) {
                    checkpointValue = structuredClone(update.checkpoint);
                    throw new Error('simulated coordinator crash');
                }
            },
        });
        await expect(handler.run(
            jobInput('editorial-transcription'),
            crashingContext,
        )).rejects.toThrow('simulated coordinator crash');
        expect(fixture.provider.transcribe).toHaveBeenCalledTimes(1);
        expect(checkpointValue).toBeDefined();

        const output = await handler.run(
            jobInput('editorial-transcription'),
            context({ checkpoint: checkpointValue }),
        );
        expect(fixture.provider.transcribe).toHaveBeenCalledTimes(1);
        expect(output.result.reusedWindowCount).toBeGreaterThanOrEqual(1);
        await rejectManagedTranscriptionTerminalPublication(output.terminalPublication);
    });

    it('replans a coverage CAS conflict and reuses provisional chunks', async () => {
        const fixture = createFixture({ coverageConflicts: 1 });
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );
        const output = await handler.run(jobInput('editorial-transcription'), context());

        expect(fixture.cas.prepareCalls).toBe(2);
        expect(fixture.provider.transcribe).toHaveBeenCalledTimes(1);
        expect(output.result.acquiredWindowCount).toBe(1);
        await rejectManagedTranscriptionTerminalPublication(output.terminalPublication);
    });

    it('fails closed after four CAS conflicts', async () => {
        const fixture = createFixture({ coverageConflicts: Number.POSITIVE_INFINITY });
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );

        await expect(handler.run(
            jobInput('editorial-transcription'),
            context(),
        )).rejects.toMatchObject({
            code: 'REVISION_CONFLICT',
            transcriptionCode: 'COVERAGE_CONFLICT',
        });
        expect(fixture.cas.prepareCalls).toBe(4);
        expect(fixture.provider.transcribe).toHaveBeenCalledTimes(1);
    });

    it('does not reset the four-attempt CAS budget after crash recovery', async () => {
        const fixture = createFixture({ coverageConflicts: Number.POSITIVE_INFINITY });
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );
        let checkpointValue: ManagedTranscriptionCheckpointV1 | undefined;
        await expect(handler.run(
            jobInput('editorial-transcription'),
            context({
                update: async (update) => {
                    if (!update.checkpoint) return;
                    checkpointValue = structuredClone(update.checkpoint);
                    if (update.checkpoint.casAttempt === 2) {
                        throw new Error('crash after two conflicts');
                    }
                },
            }),
        )).rejects.toThrow('crash after two conflicts');
        expect(fixture.cas.prepareCalls).toBe(2);

        await expect(handler.run(
            jobInput('editorial-transcription'),
            context({ checkpoint: checkpointValue }),
        )).rejects.toMatchObject({
            transcriptionCode: 'COVERAGE_CONFLICT',
        });
        expect(fixture.cas.prepareCalls).toBe(4);
        expect(fixture.provider.transcribe).toHaveBeenCalledTimes(1);
    });

    it('preserves each source CAS budget while an earlier source is replayed', async () => {
        const fixture = createFixture({
            coverageConflictsByFingerprintCharacter: {
                f: Number.POSITIVE_INFINITY,
            },
        });
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );
        const input = jobInput('editorial-transcription');
        const multiSourceInput = {
            ...input,
            sources: [...input.sources, sourceRequest('source-bad', 'f')],
        };
        let laterSourceCheckpoint: ManagedTranscriptionCheckpointV1 | undefined;
        await expect(handler.run(multiSourceInput, context({
            update: async (update) => {
                if (!update.checkpoint) return;
                laterSourceCheckpoint = structuredClone(update.checkpoint);
                if (
                    update.checkpoint.sourceIndex === 1
                    && update.checkpoint.casAttempt === 2
                ) {
                    throw new Error('crash on later source');
                }
            },
        }))).rejects.toThrow('crash on later source');

        let replayCheckpoint: ManagedTranscriptionCheckpointV1 | undefined;
        await expect(handler.run(multiSourceInput, context({
            checkpoint: laterSourceCheckpoint,
            update: async (update) => {
                if (!update.checkpoint) return;
                replayCheckpoint = structuredClone(update.checkpoint);
                if (update.checkpoint.sourceIndex === 0) {
                    throw new Error('crash while replaying earlier source');
                }
            },
        }))).rejects.toThrow('crash while replaying earlier source');
        expect(replayCheckpoint?.sources.find(
            source => source.sourceFingerprint === `sha256:${'f'.repeat(64)}`,
        )?.casAttempt).toBe(2);

        await expect(handler.run(
            multiSourceInput,
            context({ checkpoint: replayCheckpoint }),
        )).rejects.toMatchObject({ transcriptionCode: 'COVERAGE_CONFLICT' });
        expect(fixture.cas.prepareCallsFor(`sha256:${'f'.repeat(64)}`)).toBe(4);
        expect(fixture.provider.transcribe).toHaveBeenCalledTimes(2);
    });

    it('prepares no Core publication when any source in a multi-source job fails', async () => {
        const fixture = createFixture({
            decoderFailureSourceId: 'source-bad',
        });
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );
        const input = jobInput('editorial-transcription');
        const second = sourceRequest('source-bad', 'f');

        await expect(handler.run({
            ...input,
            sources: [...input.sources, second],
        }, context())).rejects.toThrow(ManagedTranscriptionError);
        expect(fixture.publisher.editorial).not.toHaveBeenCalled();
        expect(fixture.publisher.subtitle).not.toHaveBeenCalled();
        expect(fixture.cas.rejectedCoverage).toBe(1);
    });

    it('keeps stale distinct from caller cancellation', async () => {
        const staleFixture = createFixture({
            freshnessError: Object.assign(new Error('raw source changed'), {
                code: 'SOURCE_CHANGED',
            }),
        });
        const staleHandler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            staleFixture.dependencies,
        );
        let stale: unknown;
        try {
            await staleHandler.run(jobInput('editorial-transcription'), context());
        } catch (error) {
            stale = error;
        }
        expect(stale).toMatchObject({
            name: 'ManagedTranscriptionStaleError',
            code: 'SOURCE_CHANGED',
        });
        expect((stale as Error).name).not.toBe('AbortError');

        const cancelledFixture = createFixture();
        const cancelledHandler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            cancelledFixture.dependencies,
        );
        const controller = new AbortController();
        controller.abort();
        await expect(cancelledHandler.run(
            jobInput('editorial-transcription'),
            context({ signal: controller.signal }),
        )).rejects.toMatchObject({ name: 'AbortError' });
    });

    it.each(['NOT_FOUND', 'ENOENT'])(
        'maps a raw missing retained source (%s) to stale, never cancellation',
        async (code) => {
            const fixture = createFixture({
                sourceOpenError: Object.assign(new Error('missing retained source'), {
                    code,
                }),
            });

            await expect(new ManagedTranscriptionJobHandler(
                'editorial-transcription',
                fixture.dependencies,
            ).run(jobInput('editorial-transcription'), context())).rejects.toMatchObject({
                name: 'ManagedTranscriptionStaleError',
                transcriptionCode: 'SOURCE_CHANGED',
            });
        },
    );

    it('gives cancellation priority when a retained source concurrently disappears', async () => {
        const controller = new AbortController();
        const fixture = createFixture({
            sourceOpen: async (_projectId, _sourceId, signal) => new Promise(
                (_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(Object.assign(new Error('source disappeared'), {
                            code: 'NOT_FOUND',
                        }));
                    }, { once: true });
                },
            ),
        });
        const pending = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run(
            jobInput('editorial-transcription'),
            context({ signal: controller.signal }),
        );
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects browser-local honestly and expired explicit credentials after queue admission', async () => {
        const fixture = createFixture();
        const handler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        );
        await expect(handler.run({
            ...jobInput('editorial-transcription'),
            providerPolicy: { kind: 'browser-local' },
        }, context())).rejects.toMatchObject({
            transcriptionCode: 'HEADLESS_BROWSER_LOCAL_UNAVAILABLE',
        });

        let now = 1_000;
        const endpoints = new ManagedEndpointCapabilityAuthority({
            now: () => now,
            resolveLocalhost: async () => [{ address: '127.0.0.1', family: 4 }],
        });
        const scope = { projectId: 'project-1', sessionEpoch: 'epoch-1' };
        const endpointId = await endpoints.issue({
            endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
            kind: 'local',
            scope,
            lifetimeMilliseconds: 100,
        });
        const credentials = new ManagedCredentialCapabilityAuthority({ now: () => now });
        const credentialId = credentials.issue({
            secret: 'provider-secret-sentinel',
            scope,
            endpointCapabilityId: endpointId,
            lifetimeMilliseconds: 1,
        });
        now += 2;
        const expiredFixture = createFixture({ endpoints, credentials });
        const expiredHandler = new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            expiredFixture.dependencies,
        );
        await expect(expiredHandler.run({
            ...jobInput('editorial-transcription'),
            providerPolicy: {
                kind: 'managed-local-endpoint',
                endpointCapabilityId: endpointId,
                credentialCapabilityId: credentialId,
            },
        }, context())).rejects.toMatchObject({
            code: 'CAPABILITY_EXPIRED',
        });
        expect(expiredFixture.provider.transcribe).not.toHaveBeenCalled();
    });

    it('rechecks an explicit credential after decode and before provider I/O', async () => {
        const endpoints = new ManagedEndpointCapabilityAuthority({
            resolveLocalhost: async () => [{ address: '127.0.0.1', family: 4 }],
        });
        const credentials = new ManagedCredentialCapabilityAuthority();
        const scope = { projectId: 'project-1', sessionEpoch: 'epoch-1' };
        const endpointId = await endpoints.issue({
            endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
            kind: 'local',
            scope,
            lifetimeMilliseconds: 10_000,
        });
        const credentialId = credentials.issue({
            secret: 'provider-secret-sentinel',
            scope,
            endpointCapabilityId: endpointId,
            lifetimeMilliseconds: 10_000,
        });
        const fixture = createFixture({
            endpoints,
            credentials,
            decoder: {
                decode: async ({ window }) => {
                    credentials.revoke(credentialId);
                    return decodedWindow(
                        window.decoded.endSample - window.decoded.startSample,
                    );
                },
            },
        });

        await expect(new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run({
            ...jobInput('editorial-transcription'),
            providerPolicy: {
                kind: 'managed-local-endpoint',
                endpointCapabilityId: endpointId,
                credentialCapabilityId: credentialId,
            },
        }, context())).rejects.toMatchObject({
            transcriptionCode: 'CAPABILITY_EXPIRED',
        });
        expect(fixture.provider.transcribe).not.toHaveBeenCalled();
    });

    it.each([
        { endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT },
        { api_key: 'credential-sentinel' },
        { auth: 'credential-sentinel' },
        { provider_body: 'provider-body-sentinel' },
        { transcript: { text: 'transcript-body-sentinel' } },
    ])('rejects sensitive Core durable writes before returning a proposal', async (value) => {
        const fixture = createFixture({
            coreWrites: [{
                relativePath: 'metadata/transcription.json',
                value,
            }],
        });

        await expect(new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run(jobInput('editorial-transcription'), context())).rejects.toMatchObject({
            transcriptionCode: 'INVALID_INPUT',
        });
        expect(fixture.cas.rejectedCoverage).toBe(1);
    });

    it('maps the authoritative Core stale publication error without cancelling', async () => {
        const fixture = createFixture();
        fixture.publisher.editorial.mockRejectedValue(Object.assign(
            new Error('stale Core publication'),
            {
                name: 'StaleTranscriptionPublicationError',
                code: 'STALE_TRANSCRIPTION_PUBLICATION',
            },
        ));

        await expect(new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run(jobInput('editorial-transcription'), context())).rejects.toMatchObject({
            name: 'ManagedTranscriptionStaleError',
            transcriptionCode: 'DOCUMENT_STALE',
        });
        expect(fixture.cas.rejectedCoverage).toBe(1);
    });

    it('captures Core durable writes once before the terminal handoff', async () => {
        const fixture = createFixture();
        const durableWrites = vi.fn(() => [{
            relativePath: 'transcription/descriptors/editorial.json',
            value: { schemaVersion: 1, transcriptRecordId: `sha256:${'8'.repeat(64)}` },
            mode: 0o600,
        }]);
        fixture.publisher.editorial.mockResolvedValue({
            ...coreCapability('editorial'),
            durableWrites,
        });
        const output = await new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run(jobInput('editorial-transcription'), context());

        expect(durableWrites).toHaveBeenCalledTimes(1);
        managedTranscriptionTerminalWrites(output.terminalPublication);
        managedTranscriptionTerminalWrites(output.terminalPublication);
        expect(durableWrites).toHaveBeenCalledTimes(1);
        await rejectManagedTranscriptionTerminalPublication(output.terminalPublication);
    });

    it('surfaces retained source close failure on an otherwise successful acquisition', async () => {
        const fixture = createFixture({
            sourceCloseError: new Error('retained source close failed'),
        });

        await expect(new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run(jobInput('editorial-transcription'), context()))
            .rejects.toThrow('retained source close failed');
        expect(fixture.publisher.editorial).not.toHaveBeenCalled();
        expect(fixture.cas.rejectedCoverage).toBe(1);
    });

    it('publishes no terminal proposal when cancellation arrives during final preparation', async () => {
        const fixture = createFixture({
            coreRejectError: new Error('synchronous Core reject failed'),
        });
        const controller = new AbortController();

        await expect(new ManagedTranscriptionJobHandler(
            'editorial-transcription',
            fixture.dependencies,
        ).run(jobInput('editorial-transcription'), context({
            signal: controller.signal,
            update: async (update) => {
                if (update.stage === 'prepared') controller.abort();
            },
        }))).rejects.toMatchObject({ name: 'AbortError' });
        expect(fixture.cas.rejectedCoverage).toBe(1);
    });
});

function createFixture(options: {
    provider?: ManagedTranscriptionProviderPort;
    coverageConflicts?: number;
    coverageConflictsByFingerprintCharacter?: Readonly<Record<string, number>>;
    decoderFailureSourceId?: string;
    freshnessError?: Error;
    endpoints?: ManagedEndpointCapabilityAuthority;
    credentials?: ManagedCredentialCapabilityAuthority;
    decoder?: ManagedTranscriptionFactoryDependencies['decoder'];
    coreWrites?: readonly import('../../persistence/managed-filesystem-store').DurableWrite[];
    coreRejectError?: Error;
    sourceCloseError?: Error;
    sourceOpenError?: Error;
    sourceOpen?: ManagedTranscriptionFactoryDependencies['sources']['openRetainedSource'];
} = {}) {
    const endpoints = options.endpoints ?? new ManagedEndpointCapabilityAuthority({
        resolveLocalhost: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const credentials = options.credentials ?? new ManagedCredentialCapabilityAuthority();
    const cas = new InMemoryCas(
        options.coverageConflictsByFingerprintCharacter
            ? new Map(Object.entries(options.coverageConflictsByFingerprintCharacter).map(
                ([character, count]) => [
                    `sha256:${character.repeat(64)}` as Sha256Digest,
                    count,
                ],
            ))
            : options.coverageConflicts ?? 0,
    );
    const provider = options.provider ?? {
        transcribe: vi.fn(async () => providerTranscript()),
    };
    if (!('mock' in provider.transcribe)) {
        provider.transcribe = vi.fn(provider.transcribe.bind(provider));
    }
    const editorial = vi.fn(async () => coreCapability(
        'editorial',
        options.coreWrites,
        options.coreRejectError,
    ));
    const subtitle = vi.fn(async () => coreCapability(
        'subtitle',
        options.coreWrites,
        options.coreRejectError,
    ));
    const publisher = {
        editorial,
        subtitle,
        prepareEditorialPublication: editorial,
        prepareSubtitlePublication: subtitle,
    } satisfies CoreTranscriptionPublisher & {
        editorial: typeof editorial;
        subtitle: typeof subtitle;
    };
    const dependencies: ManagedTranscriptionFactoryDependencies = {
        endpoints,
        credentials,
        sources: {
            ...(options.sourceOpen
                ? { openRetainedSource: options.sourceOpen }
                : {
            openRetainedSource: async (_projectId, sourceId) => {
                if (options.sourceOpenError) throw options.sourceOpenError;
                const character = sourceId.includes('subtitle')
                    ? 'e'
                    : sourceId === 'source-bad'
                        ? 'f'
                        : 'd';
                return {
                    capabilityType: 'verified-read-handle',
                    grantId: `retained:${sourceId}`,
                    handle: {} as FileHandle,
                    identity: {
                        device: '1',
                        inode: sourceId,
                        size: 0,
                        modifiedMilliseconds: 1,
                    },
                    digest: `sha256:${character.repeat(64)}`,
                    verifyUnchanged: async () => undefined,
                    close: async () => {
                        if (options.sourceCloseError) throw options.sourceCloseError;
                    },
                };
            },
                }),
        },
        freshness: {
            assertCurrent: async () => {
                if (options.freshnessError) throw options.freshnessError;
            },
        },
        cas,
        publisher,
        provider,
        decoder: options.decoder ?? {
            decode: async ({ source, window }) => {
                if (source.sourceId === options.decoderFailureSourceId) {
                    throw new ManagedTranscriptionError(
                        'SOURCE_CHANGED',
                        true,
                        'The test source changed.',
                    );
                }
                return decodedWindow(
                    window.decoded.endSample - window.decoded.startSample,
                );
            },
        },
    };
    return {
        dependencies,
        endpoints,
        credentials,
        cas,
        provider: provider as { transcribe: ReturnType<typeof vi.fn> },
        publisher,
    };
}

class InMemoryCas implements ManagedTranscriptionCasPort {
    readonly chunks = new Map<Sha256Digest, ManagedChunkRecordV1>();
    readonly manifests = new Map<Sha256Digest, ManagedTranscriptManifestV1>();
    prepareCalls = 0;
    rejectedCoverage = 0;
    private readonly prepareCallsByFingerprint = new Map<Sha256Digest, number>();

    constructor(private remainingConflicts: number | Map<Sha256Digest, number>) {}

    prepareCallsFor(sourceFingerprint: Sha256Digest): number {
        return this.prepareCallsByFingerprint.get(sourceFingerprint) ?? 0;
    }

    async listCompatibleCoverage() {
        return { records: [] };
    }

    async getChunk(recordId: Sha256Digest) {
        return this.chunks.get(recordId) ?? null;
    }

    async stageChunk(record: ManagedChunkRecordV1) {
        this.chunks.set(record.recordId, structuredClone(record));
    }

    async stageMergedTranscript(input: Parameters<
        ManagedTranscriptionCasPort['stageMergedTranscript']
    >[0]) {
        const mergedWordsRecordId = `sha256:${'8'.repeat(64)}` as Sha256Digest;
        const body = {
            schemaVersion: 1 as const,
            sourceFingerprint: input.sourceFingerprint,
            sourceSampleCount: input.sourceSampleCount,
            language: input.language,
            speakerMode: input.speakerMode,
            canonicalModel: input.canonicalModel,
            coreCoverage: input.coreCoverage.map(value => ({ ...value })),
            chunkRecordIds: input.chunks.map(value => value.recordId),
            mergedWordsRecordId,
        };
        const manifest = {
            ...body,
            recordId: await sha256CanonicalJson(body),
        };
        this.manifests.set(manifest.recordId, manifest);
        return manifest;
    }

    async getManifest(recordId: Sha256Digest) {
        return this.manifests.get(recordId) ?? null;
    }

    async *iterateMergedWords(): AsyncIterable<ManagedMergedWordV1> {
        return;
    }

    async verifyRecord(recordId: Sha256Digest) {
        return this.chunks.has(recordId)
            || this.manifests.has(recordId)
            || recordId === `sha256:${'8'.repeat(64)}`;
    }

    async prepareCoverageUpdate(input: Parameters<
        ManagedTranscriptionCasPort['prepareCoverageUpdate']
    >[0]): Promise<PreparedManagedCoverageUpdate | null> {
        this.prepareCalls += 1;
        this.prepareCallsByFingerprint.set(
            input.sourceFingerprint,
            this.prepareCallsFor(input.sourceFingerprint) + 1,
        );
        const remaining = typeof this.remainingConflicts === 'number'
            ? this.remainingConflicts
            : this.remainingConflicts.get(input.sourceFingerprint) ?? 0;
        if (remaining > 0) {
            if (typeof this.remainingConflicts === 'number') {
                this.remainingConflicts -= 1;
            } else {
                this.remainingConflicts.set(input.sourceFingerprint, remaining - 1);
            }
            return null;
        }
        return {
            capabilityId: `coverage:${this.prepareCalls}:${input.record.recordId}`,
            projectId: input.projectId,
            kind: 'coverage',
            sourceFingerprint: input.sourceFingerprint,
            acquisitionProfileDigest: input.acquisitionProfileDigest,
            expectedCoverageRecordIds: input.expectedCoverageRecordIds,
            coverageRecordId: input.record.recordId,
            pinRecordIds: input.pinRecordIds,
            durableWrites: () => [],
            accept: () => undefined,
            reject: () => { this.rejectedCoverage += 1; },
        };
    }
}

function jobInput(
    kind: ManagedTranscriptionJobInputV1['kind'],
    options: {
        sourceId?: string;
        fingerprintCharacter?: string;
    } = {},
): ManagedTranscriptionJobInputV1 {
    return {
        schemaVersion: 1,
        kind,
        projectId: 'project-1',
        capturedState: {
            sessionId: 'session-1',
            projectId: 'project-1',
            sessionEpoch: 'epoch-1',
            sessionRevision: 1,
            documentRevision: 1,
            audioGraphRevision: 1,
            narrativeRevision: 1,
            eventCursor: 'event-1',
        },
        providerPolicy: { kind: 'managed-local-endpoint' },
        language: 'es',
        speakerMode: 'diarized',
        contextSamples: 0,
        sources: [sourceRequest(
            options.sourceId ?? 'source-1',
            options.fingerprintCharacter ?? 'd',
        )],
        targetIds: ['video-track-1'],
    };
}

function sourceRequest(sourceId: string, fingerprintCharacter: string) {
    return {
        sourceId,
        sourceFingerprint: `sha256:${fingerprintCharacter.repeat(64)}` as Sha256Digest,
        sourceSampleCount: 1_600,
        ranges: [{ startSample: 0, endSample: 1_600 }],
    };
}

function providerTranscript() {
    return {
        canonicalModel: 'qwen3-asr-1.7b',
        words: [{
            text: 'provider-word-sentinel',
            startSample: 100,
            endSample: 400,
            probability: 0.9,
            speaker: {
                providerSpeakerId: 'SPEAKER_00',
                evidenceKey: 'window:SPEAKER_00',
            },
        }],
        release: () => undefined,
    };
}

function coreCapability(
    kind: 'editorial' | 'subtitle',
    writes: readonly import('../../persistence/managed-filesystem-store').DurableWrite[] = [],
    rejectError?: Error,
): PreparedManagedCommitCapability {
    return {
        capabilityId: `core:${kind}:${crypto.randomUUID()}`,
        projectId: 'project-1',
        kind,
        durableWrites: () => writes,
        accept: () => undefined,
        reject: () => {
            if (rejectError) throw rejectError;
        },
    };
}

function decodedWindow(sampleCount: number) {
    return {
        sampleCount,
        hasAudioStream: true,
        wav: new Blob([new Uint8Array(44 + sampleCount * 2)]),
        release: () => undefined,
    };
}

function context(options: {
    signal?: AbortSignal;
    checkpoint?: ManagedTranscriptionCheckpointV1;
    update?: JobExecutionContext<ManagedTranscriptionCheckpointV1>['update'];
} = {}): JobExecutionContext<ManagedTranscriptionCheckpointV1> {
    return {
        signal: options.signal ?? new AbortController().signal,
        checkpoint: options.checkpoint,
        update: options.update ?? (async () => undefined),
    };
}
