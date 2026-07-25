import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
    CanonicalToolCall,
    CoordinatorResult,
    JsonObject,
    StateToken,
} from '../../mcp/contracts';
import type { WaptionsToolName } from '../../mcp/constants';
import {
    loadCommittedCoreSemanticSchemaBundle,
} from '../../mcp/core-schema-loader';
import { ToolSchemaValidator } from '../../mcp/schema-validator';
import { canonicalDigest, canonicalJson } from '../../persistence/canonical-json';
import type { ManagedCoordinatorAdapter } from '../../server/coordinator-adapter';
import { createEmptyManagedCoreSnapshot } from '../core-editor-port';
import { createProductionManagedRuntime } from '../production-runtime';

const roots: string[] = [];
const schemas = loadCommittedCoreSemanticSchemaBundle();
const validator = new ToolSchemaValidator();
const connectionId = 'production-composition-test';
const terminalJobStates = new Set([
    'succeeded',
    'failed',
    'cancelled',
    'stale',
]);

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => (
        rm(root, { recursive: true, force: true })
    )));
});

describe('production managed runtime composition', () => {
    it('executes every delegated authority, deep diagnostics and editor render across restart', async () => {
        const dataRoot = await mkdtemp(join(tmpdir(), 'waptions-production-runtime-'));
        const mediaRoot = await mkdtemp(join(tmpdir(), 'waptions-production-media-'));
        const outputRoot = await mkdtemp(join(tmpdir(), 'waptions-production-output-'));
        roots.push(dataRoot, mediaRoot, outputRoot);
        const mediaPath = join(mediaRoot, 'voice.mp4');
        await createVideoFixture(mediaPath);
        const options = runtimeOptions(dataRoot);

        const first = await createProductionManagedRuntime(options);
        expect(first.authority).toMatchObject({
            httpBridgeEndpoint: { host: 'localhost', port: 59941 },
        });

        const opened = await invoke(first.adapter, 'waptions_session_open', {
            apiVersion: '2026-07-25',
            action: 'create',
            projectId: 'composition-project',
            idempotencyKey: 'open-composition',
            name: 'Production composition',
        });
        let state = successState(opened);

        const importRequest = {
            ...mutationBase(state, 'import-inline-project'),
            source: {
                kind: 'inline-manifest',
                manifest: jsonObject(
                    createEmptyManagedCoreSnapshot(
                        state.projectId,
                        state.sessionEpoch,
                        'Production composition',
                    ).state.snapshot.manifest,
                ),
            },
        } satisfies JsonObject;
        const imported = await invoke(
            first.adapter,
            'waptions_project_import',
            importRequest,
        );
        assertUsable(imported);
        state = successState(imported);
        expect(jobFrom(imported)).toMatchObject({
            kind: 'bundle-import',
            state: 'succeeded',
        });

        const readGrant = await invoke(first.adapter, 'waptions_path_grant', {
            ...mutationBase(state, 'grant-media-root'),
            action: {
                kind: 'add',
                grantKind: 'read-root',
                path: mediaRoot,
                allowCreate: false,
                confirmAuthorityExpansion: true,
            },
        });
        state = successState(readGrant);
        const grantId = stringField(
            objectItems(readGrant, 'grants')[0],
            'grantId',
        );

        const probed = await invoke(first.adapter, 'waptions_media_probe', {
            apiVersion: '2026-07-25',
            sessionId: state.sessionId,
            grantId,
            paths: [mediaPath],
            hashPolicy: 'always',
        });
        assertUsable(probed);
        const media = objectItems(probed, 'media');
        expect(media).toHaveLength(1);
        expect(media[0]).toMatchObject({
            displayName: 'voice.mp4',
            mediaClass: 'video',
            metadata: {
                videoStreams: [
                    expect.objectContaining({
                        codec: 'h264',
                        width: 160,
                        height: 90,
                    }),
                ],
                audioStreams: [
                    expect.objectContaining({
                        codec: 'aac',
                        sampleRate: 48_000,
                        channels: 1,
                    }),
                ],
            },
        });
        const handleId = stringField(
            objectItems(probed, 'handles')[0],
            'handleId',
        );

        const mediaImportRequest = {
            ...mutationBase(state, 'import-probed-media'),
            mediaHandles: [handleId],
            placement: {
                kind: 'place',
                ordering: 'natural',
                timelineStartFrame: 0,
            },
        } satisfies JsonObject;
        const mediaImport = await invoke(
            first.adapter,
            'waptions_media_import',
            mediaImportRequest,
        );
        assertUsable(mediaImport);
        state = successState(mediaImport);
        const sourceId = stringItems(mediaImport, 'sourceIds')[0];
        expect(sourceId).toBeTruthy();

        const edited = await invoke(first.adapter, 'waptions_edit_apply', {
            ...mutationBase(state, 'proof-edit-project-name'),
            operations: [{
                operationId: 'proof-edit-project-name-operation',
                type: 'project.set-name',
                payload: { name: 'Production composition edited' },
            }],
        });
        assertUsable(edited);
        state = successState(edited);
        const undone = await invoke(first.adapter, 'waptions_history_apply', {
            ...mutationBase(state, 'proof-undo-project-name'),
            action: { kind: 'undo' },
        });
        assertUsable(undone);
        state = successState(undone);
        const redone = await invoke(first.adapter, 'waptions_history_apply', {
            ...mutationBase(state, 'proof-redo-project-name'),
            action: { kind: 'redo' },
        });
        assertUsable(redone);
        state = successState(redone);

        const tracks = await invoke(first.adapter, 'waptions_timeline_query', {
            apiVersion: '2026-07-25',
            sessionId: state.sessionId,
            entityKind: 'tracks',
        });
        const videoTrack = objectItems(tracks, 'items').find(
            (item) => item.kind === 'video-track',
        );
        if (!videoTrack) throw new Error('Expected the imported video track.');
        const videoTrackId = stringField(videoTrack, 'trackId');

        const review = await invoke(first.adapter, 'waptions_media_review', {
            ...mutationBase(state, 'review-waveform'),
            sourceIds: [sourceId],
            reviewKind: 'waveform-audio-map',
            maximumSamples: 32,
        });
        assertUsable(review);
        state = successState(review);
        const reviewJob = await waitForJob(
            first.adapter,
            state.sessionId,
            stringData(review, 'jobId'),
        );
        expect(reviewJob.state).toBe('succeeded');
        expect(reviewJob.resultArtifactIds).toEqual([
            expect.any(String),
            expect.any(String),
        ]);

        const release = await invoke(first.adapter, 'waptions_media_release', {
            ...mutationBase(state, 'review-release-plan'),
            mode: 'release-runtime',
            dryRun: true,
        });
        assertUsable(release);
        state = successState(release);
        expect(data(release)).toMatchObject({
            mode: 'release-runtime',
            dryRun: true,
            releasedIds: [],
            retainedRoots: expect.arrayContaining([
                expect.objectContaining({
                    sourceId,
                    rootKind: 'document-or-history',
                    rootId: sourceId,
                }),
            ]),
        });

        const transcription = await invoke(
            first.adapter,
            'waptions_transcription_start',
            {
                ...mutationBase(state, 'start-editorial-transcription'),
                transcriptionKind: 'editorial',
                targetTrackIds: [videoTrackId],
                language: 'es',
                speakerMode: 'none',
                providerPolicy: {
                    kind: 'managed-local-endpoint',
                },
            },
        );
        assertUsable(transcription);
        state = successState(transcription);
        const transcriptionJobId = stringData(transcription, 'jobId');
        const transcriptionJob = await readJob(
            first.adapter,
            state.sessionId,
            transcriptionJobId,
        );
        if (!terminalJobStates.has(stringField(transcriptionJob, 'state'))) {
            const cancelled = await invoke(first.adapter, 'waptions_job_cancel', {
                ...mutationBase(state, 'cancel-editorial-transcription'),
                jobId: transcriptionJobId,
                reason: 'Production composition test completed the start boundary.',
            });
            assertUsable(cancelled);
            state = successState(cancelled);
        }
        await waitForJob(first.adapter, state.sessionId, transcriptionJobId);

        const outputPath = join(outputRoot, 'proof.json');
        const outputGrant = await invoke(first.adapter, 'waptions_path_grant', {
            ...mutationBase(state, 'grant-proof-output'),
            action: {
                kind: 'add',
                grantKind: 'write-destination',
                path: outputPath,
                outputName: 'proof.json',
                allowCreate: true,
                confirmAuthorityExpansion: true,
            },
        });
        state = successState(outputGrant);
        const destination = objectField(data(outputGrant), 'destination');
        const exported = await invoke(first.adapter, 'waptions_export_start', {
            ...mutationBase(state, 'export-proof-record'),
            exportKind: 'proof-record',
            destination,
        });
        assertUsable(exported);
        state = successState(exported);
        const exportJob = await waitForJob(
            first.adapter,
            state.sessionId,
            stringData(exported, 'jobId'),
        );
        expect(exportJob).toMatchObject({
            kind: 'export:proof-record',
            state: 'succeeded',
            resultArtifactIds: [expect.any(String)],
        });

        const rendered = await invoke(first.adapter, 'waptions_editor_render', {
            ...mutationBase(state, 'render-production-editor'),
            viewId: 'production-view',
            presentation: 'inline',
            capabilityTtlSeconds: 30,
        });
        assertUsable(rendered);
        state = successState(rendered);
        expect(data(rendered)).toMatchObject({
            resourceUri: options.appResource.uri,
            mimeType: options.appResource.mimeType,
            viewId: 'production-view',
            presentation: 'inline',
        });
        expect(rendered.ok && rendered.privateMeta).toMatchObject({
            bridge: {
                capabilityToken: expect.any(String),
            },
        });

        const validated = await invoke(first.adapter, 'waptions_project_validate', {
            apiVersion: '2026-07-25',
            sessionId: state.sessionId,
            scopes: ['all'],
            deep: true,
        });
        assertUsable(validated);
        expect(data(validated)).toMatchObject({
            valid: true,
            issues: [],
        });

        const diagnostics = await invoke(first.adapter, 'waptions_diagnostics_get', {
            apiVersion: '2026-07-25',
            sessionId: state.sessionId,
            sections: ['all'],
        });
        assertUsable(diagnostics);
        expect(data(diagnostics)).toMatchObject({
            diagnosticsRevision: expect.any(Number),
            currentBytes: expect.any(Number),
            peakBytes: expect.any(Number),
            queueLengths: expect.any(Object),
            evictions: expect.any(Number),
            cancellations: expect.any(Number),
            lateResultDisposals: expect.any(Number),
            leakedResourceAssertions: [],
        });
        expect(first.authority.canGracefullyShutdown()).toBe(true);
        await first.adapter.close?.();

        const restarted = await createProductionManagedRuntime(options);
        const recovered = await invoke(restarted.adapter, 'waptions_session_open', {
            apiVersion: '2026-07-25',
            action: 'recover',
            projectId: 'composition-project',
            idempotencyKey: 'recover-composition',
        });
        state = successState(recovered);

        const replayedImport = await invoke(
            restarted.adapter,
            'waptions_project_import',
            importRequest,
        );
        assertUsable(replayedImport);
        expect(replayedImport).toMatchObject({
            ok: true,
            replayed: true,
        });
        // The original probe handle belonged to the stopped runtime. Replay must therefore win
        // before the importer attempts to resolve or pin it in the recovered process.
        const replayedMediaImport = await invoke(
            restarted.adapter,
            'waptions_media_import',
            mediaImportRequest,
        );
        expect(replayedMediaImport).toMatchObject({
            ok: true,
            replayed: true,
            data: {
                sourceIds: [sourceId],
            },
        });

        const recoveredValidation = await invoke(
            restarted.adapter,
            'waptions_project_validate',
            {
                apiVersion: '2026-07-25',
                sessionId: state.sessionId,
                scopes: ['all'],
                deep: true,
            },
        );
        assertUsable(recoveredValidation);
        expect(data(recoveredValidation)).toMatchObject({
            valid: true,
            issues: [],
        });

        const reconnectProofPath = join(outputRoot, 'proof-after-reconnect.json');
        const reconnectProofGrant = await invoke(
            restarted.adapter,
            'waptions_path_grant',
            {
                ...mutationBase(state, 'grant-proof-after-reconnect'),
                action: {
                    kind: 'add',
                    grantKind: 'write-destination',
                    path: reconnectProofPath,
                    outputName: 'proof-after-reconnect.json',
                    allowCreate: true,
                    confirmAuthorityExpansion: true,
                },
            },
        );
        state = successState(reconnectProofGrant);
        const reconnectProofExport = await invoke(
            restarted.adapter,
            'waptions_export_start',
            {
                ...mutationBase(state, 'export-proof-after-reconnect'),
                exportKind: 'proof-record',
                destination: objectField(
                    data(reconnectProofGrant),
                    'destination',
                ),
            },
        );
        state = successState(reconnectProofExport);
        expect(await waitForJob(
            restarted.adapter,
            state.sessionId,
            stringData(reconnectProofExport, 'jobId'),
        )).toMatchObject({ state: 'succeeded' });
        const reconnectProof = JSON.parse(
            await readFile(reconnectProofPath, 'utf8'),
        ) as {
            value?: {
                operations?: readonly {
                    toolName: string;
                    idempotencyKey: string;
                    requestDigest: string;
                }[];
            };
        };
        expect(reconnectProof.value?.operations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                toolName: 'waptions_project_import',
                idempotencyKey: 'import-inline-project',
            }),
            expect.objectContaining({
                toolName: 'waptions_edit_apply',
                idempotencyKey: 'proof-edit-project-name',
            }),
            expect.objectContaining({
                toolName: 'waptions_history_apply',
                idempotencyKey: 'proof-undo-project-name',
            }),
            expect.objectContaining({
                toolName: 'waptions_history_apply',
                idempotencyKey: 'proof-redo-project-name',
            }),
            expect.objectContaining({
                toolName: 'waptions_session_open',
                idempotencyKey: 'recover-composition',
            }),
        ]));

        const bundlePath = join(outputRoot, 'composition-round-trip.waptions.zip');
        const bundleGrant = await invoke(restarted.adapter, 'waptions_path_grant', {
            ...mutationBase(state, 'grant-round-trip-bundle'),
            action: {
                kind: 'add',
                grantKind: 'write-destination',
                path: bundlePath,
                outputName: 'composition-round-trip.waptions.zip',
                allowCreate: true,
                confirmAuthorityExpansion: true,
            },
        });
        state = successState(bundleGrant);
        const bundleExport = await invoke(restarted.adapter, 'waptions_export_start', {
            ...mutationBase(state, 'export-round-trip-bundle'),
            exportKind: 'portable-bundle',
            destination: objectField(data(bundleGrant), 'destination'),
        });
        state = successState(bundleExport);
        expect(await waitForJob(
            restarted.adapter,
            state.sessionId,
            stringData(bundleExport, 'jobId'),
        )).toMatchObject({
            kind: 'export:portable-bundle',
            state: 'succeeded',
        });

        const targetOpened = await invoke(restarted.adapter, 'waptions_session_open', {
            apiVersion: '2026-07-25',
            action: 'create',
            projectId: 'composition-bundle-target',
            idempotencyKey: 'open-composition-bundle-target',
            name: 'Composition bundle target',
        });
        let targetState = successState(targetOpened);
        const bundleReadGrant = await invoke(restarted.adapter, 'waptions_path_grant', {
            ...mutationBase(targetState, 'grant-round-trip-bundle-read'),
            action: {
                kind: 'add',
                grantKind: 'read-root',
                path: outputRoot,
                allowCreate: false,
                confirmAuthorityExpansion: true,
            },
        });
        targetState = successState(bundleReadGrant);
        const bundleImport = await invoke(restarted.adapter, 'waptions_project_import', {
            ...mutationBase(targetState, 'import-round-trip-bundle'),
            source: {
                kind: 'bundle-path',
                grantId: stringField(
                    objectItems(bundleReadGrant, 'grants')[0],
                    'grantId',
                ),
                path: bundlePath,
            },
        });
        targetState = successState(bundleImport);
        expect(jobFrom(bundleImport)).toMatchObject({
            kind: 'bundle-import',
            state: 'succeeded',
        });
        const targetTimeline = await invoke(restarted.adapter, 'waptions_timeline_query', {
            apiVersion: '2026-07-25',
            sessionId: targetState.sessionId,
            entityKind: 'clips',
        });
        expect(objectItems(targetTimeline, 'items')).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceId }),
        ]));
        const targetValidation = await invoke(restarted.adapter, 'waptions_project_validate', {
            apiVersion: '2026-07-25',
            sessionId: targetState.sessionId,
            scopes: ['all'],
            deep: true,
        });
        expect(data(targetValidation)).toMatchObject({
            valid: true,
            issues: [],
        });
        expect(restarted.authority.canGracefullyShutdown()).toBe(true);
        await restarted.adapter.close?.();
    }, 90_000);
});

function runtimeOptions(dataRoot: string) {
    const buildHash = 'a'.repeat(64);
    return {
        dataRoot,
        appResource: {
            uri: `ui://waptions/editor/v1/${buildHash}/index.html`,
            mimeType: 'text/html;profile=mcp-app' as const,
            buildHash,
        },
    };
}

async function invoke(
    adapter: ManagedCoordinatorAdapter,
    toolName: WaptionsToolName,
    request: JsonObject,
): Promise<CoordinatorResult> {
    const schema = schemas.toolSchemas[toolName];
    validator.register(toolName, schema.inputSchema);
    expect(validator.validateInput(toolName, request)).toMatchObject({
        valid: true,
    });
    const canonicalRequest = canonicalJson(request);
    const base: CanonicalToolCall = {
        toolName,
        request,
        canonicalRequest,
        requestHash: canonicalDigest(request) as `sha256:${string}`,
    };
    const context = {
        signal: new AbortController().signal,
        connectionId,
    };
    let result: CoordinatorResult;
    if (toolName === 'waptions_session_open') {
        result = await adapter.executeSessionOpen({
            ...base,
            mutation: true,
            identity: {
                idempotencyKey: stringField(request, 'idempotencyKey'),
            },
        }, context);
    } else if ('idempotencyKey' in request) {
        const mutation = {
            ...base,
            mutation: true as const,
            identity: {
                sessionId: stringField(request, 'sessionId'),
                sessionEpoch: stringField(request, 'sessionEpoch'),
                idempotencyKey: stringField(request, 'idempotencyKey'),
                expected: objectField(request, 'expected') as never,
            },
        };
        const scope = await adapter.resolveReceiptScope(mutation, context);
        if (!scope.ok) {
            result = scope;
        } else {
            result = await adapter.executeMutation({
                ...mutation,
                receiptScope: scope.scope,
            }, context);
        }
    } else {
        result = await adapter.executeRead({
            ...base,
            mutation: false,
        }, context);
    }
    const canonicalOutput = result.ok && result.privateMeta
        ? Object.fromEntries(
            Object.entries(result).filter(([key]) => key !== 'privateMeta'),
        )
        : result;
    expect(
        validator.validateOutput(schema.outputSchema, canonicalOutput),
        `${toolName} returned a non-canonical output: ${JSON.stringify(result)}`,
    ).toBe(true);
    expect(result.ok ? undefined : result.error.code).not.toBe(
        'COORDINATOR_UNAVAILABLE',
    );
    return result;
}

async function waitForJob(
    adapter: ManagedCoordinatorAdapter,
    sessionId: string,
    jobId: string,
): Promise<JsonObject> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
        const job = await readJob(adapter, sessionId, jobId);
        if (terminalJobStates.has(stringField(job, 'state'))) return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Managed job ${jobId} did not reach a terminal state.`);
}

async function readJob(
    adapter: ManagedCoordinatorAdapter,
    sessionId: string,
    jobId: string,
): Promise<JsonObject> {
    const result = await invoke(adapter, 'waptions_job_get', {
        apiVersion: '2026-07-25',
        sessionId,
        jobId,
    });
    assertUsable(result);
    return objectField(data(result), 'job');
}

function mutationBase(state: StateToken, idempotencyKey: string): JsonObject {
    return {
        apiVersion: '2026-07-25',
        sessionId: state.sessionId,
        sessionEpoch: state.sessionEpoch,
        expected: {
            sessionRevision: state.sessionRevision,
            documentRevision: state.documentRevision,
            audioGraphRevision: state.audioGraphRevision,
            ...(state.narrativeRevision === undefined
                ? {}
                : { narrativeRevision: state.narrativeRevision }),
        },
        idempotencyKey,
    };
}

function successState(result: CoordinatorResult): StateToken {
    assertUsable(result);
    if (!result.state) throw new Error('Expected a stateful result.');
    return result.state;
}

function assertUsable(
    result: CoordinatorResult,
): asserts result is Extract<CoordinatorResult, { ok: true }> {
    if (!result.ok) {
        throw new Error(JSON.stringify(result.error));
    }
}

function data(
    result: CoordinatorResult,
): JsonObject {
    assertUsable(result);
    return result.data;
}

function jobFrom(result: CoordinatorResult): JsonObject {
    return objectField(data(result), 'job');
}

function stringData(result: CoordinatorResult, key: string): string {
    return stringField(data(result), key);
}

function objectItems(result: CoordinatorResult, key: string): JsonObject[] {
    const value = data(result)[key];
    if (
        !Array.isArray(value)
        || value.some(
            (item) => !item || typeof item !== 'object' || Array.isArray(item),
        )
    ) {
        throw new Error(`Expected ${key} to be an object array.`);
    }
    return value as JsonObject[];
}

function stringItems(result: CoordinatorResult, key: string): string[] {
    const value = data(result)[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`Expected ${key} to be a string array.`);
    }
    return value as string[];
}

function objectField(
    value: Readonly<Record<string, unknown>>,
    key: string,
): JsonObject {
    const field = value[key];
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new Error(`Expected ${key} to be an object.`);
    }
    return field as JsonObject;
}

function stringField(
    value: Readonly<Record<string, unknown>>,
    key: string,
): string {
    const field = value[key];
    if (typeof field !== 'string' || field.length === 0) {
        throw new Error(`Expected ${key} to be a non-empty string.`);
    }
    return field;
}

function jsonObject(value: unknown): JsonObject {
    const parsed: unknown = JSON.parse(canonicalJson(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected canonical JSON to contain an object.');
    }
    return parsed as JsonObject;
}

async function createVideoFixture(outputPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const process = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=blue:s=160x90:r=25:d=1',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000:duration=1',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-shortest',
            '-movflags',
            '+faststart',
            outputPath,
        ], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const stderr: Buffer[] = [];
        process.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        process.once('error', reject);
        process.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(
                `ffmpeg fixture failed (${code ?? signal}): ${
                    Buffer.concat(stderr).toString('utf8')
                }`,
            ));
        });
    });
}
