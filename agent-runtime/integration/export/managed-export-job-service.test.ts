import {
    access,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createHeadlessRenderSnapshotFixture,
} from '../../../src/lib/headless-render/headless-render.test-fixtures';
import { inspectProjectBundleZipBlob } from '../../../src/lib/project-bundle-zip';
import { PathGrantAuthority } from '../../path-grants/path-grant-authority';
import { canonicalJson } from '../../persistence/canonical-json';
import { ManagedFilesystemStore } from '../../persistence/managed-filesystem-store';
import { ArtifactRegistry } from '../../artifacts/artifact-registry';
import { testEnvelope } from '../../testing/runtime-test-helpers';
import { ProductionManagedExportJobService } from './managed-export-job-service';
import { PathGrantOutputAuthority } from './path-grant-output-authority';
import type {
    ManagedExportRequest,
    ManagedExportTerminalProposal,
    ManagedProofEvidenceV1,
    ManagedReferenceSnapshotV1,
    ManagedStreamingEntry,
} from './contracts';
import type { StagedOutputPublication } from '../../path-grants/path-grant-authority';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function fixture(outputName: string) {
    const root = await mkdtemp(join(tmpdir(), 'waptions-managed-export-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const target = join(root, outputName);
    const paths = new PathGrantAuthority({
        privateCopyRoot: join(root, 'private'),
        authoritySecret: Buffer.alloc(32, 6),
    });
    const scope = { sessionId: 'session-1', sessionEpoch: 'epoch-1' };
    const grant = await paths.create(
        scope.sessionId,
        scope.sessionEpoch,
        'create-only-destination',
        target,
    );
    const staged = await paths.stageCreate(grant.grantId, scope);
    const outputs = new PathGrantOutputAuthority();
    const store = new ManagedFilesystemStore(join(root, 'runtime'));
    await store.initialize();
    await store.createProject(testEnvelope('project-1', scope.sessionId));
    const artifacts = new ArtifactRegistry(store, Buffer.alloc(32, 4));
    const destination = {
        schemaVersion: 1 as const,
        destinationId: 'destination-1',
        grantId: grant.grantId,
        stagingHandleId: 'staging-1',
        mode: 'create-only' as const,
        outputName,
        verifiedParentIdentity: 'parent-identity',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    outputs.register(destination, staged);
    const service = new ProductionManagedExportJobService(
        outputs,
        artifacts,
        { render: async () => { throw new Error('render not used'); } },
        { inspect: async () => { throw new Error('verifier not used'); } },
        { render: async () => { throw new Error('webm not used'); } },
    );
    return {
        root,
        target,
        paths,
        scope,
        grant,
        outputs,
        store,
        artifacts,
        destination,
        service,
    };
}

function baseRequest(
    destination: Awaited<ReturnType<typeof fixture>>['destination'],
): Omit<ManagedExportRequest, 'exportKind' | 'material'> {
    return {
        projectId: 'project-1',
        jobId: 'job-1',
        destination,
    };
}

async function commitTerminalProposal(
    test: Awaited<ReturnType<typeof fixture>>,
    proposal: ManagedExportTerminalProposal,
    publication: StagedOutputPublication,
) {
    const envelope = (await test.store.readProject('project-1'))!;
    await test.store.transact({
        baseSessionRevision: envelope.sessionRevision,
        envelope: {
            ...envelope,
            sessionRevision: envelope.sessionRevision + 1,
            artifactRevision: envelope.artifactRevision + 1,
        },
        writes: [
            publication.registryWrite,
            proposal.artifacts[0]!.registryWrite,
        ],
    });
    proposal.artifacts[0]!.accept();
    await publication.accept();
    return test.artifacts.get(
        'project-1',
        proposal.artifacts[0]!.record.artifactId,
    );
}

function bytesEntry(name: string, value: string): ManagedStreamingEntry {
    const bytes = Buffer.from(value);
    return {
        name,
        byteLength: bytes.byteLength,
        stream: async function* () {
            yield bytes;
        },
        revalidate: async () => undefined,
    };
}

function state() {
    return {
        sessionId: 'session-1',
        projectId: 'project-1',
        sessionEpoch: 'epoch-1',
        sessionRevision: 4,
        documentRevision: 3,
        audioGraphRevision: 2,
        eventCursor: 'event-4',
    };
}

function referenceSnapshot(): ManagedReferenceSnapshotV1 {
    return {
        schemaVersion: 1,
        apiVersion: '2026-07-25',
        runtimeVersion: '1.0.0',
        schemaBundleDigest: `sha256:${'a'.repeat(64)}`,
        state: state(),
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        manifest: createHeadlessRenderSnapshotFixture().manifest,
        sources: [],
        transcriptRecordIds: [],
        historyEntryIds: [],
    };
}

function proof(): ManagedProofEvidenceV1 {
    return {
        schemaVersion: 1,
        runtimeVersion: '1.0.0',
        pluginVersion: '1.0.0',
        schemaBundleDigest: `sha256:${'c'.repeat(64)}`,
        state: state(),
        sources: [{
            sourceId: 'source-1',
            displayName: 'clip.mp4',
            mediaClass: 'video',
            contentDigest: `sha256:${'d'.repeat(64)}`,
            byteLength: 100,
            descriptorFingerprint: 'fingerprint-1',
            probe: {
                containerFormats: ['mp4'],
                durationUs: 1_000_000,
                videoStreams: [{
                    index: 0,
                    codec: 'h264',
                    width: 16,
                    height: 16,
                    frameRate: { numerator: 30, denominator: 1 },
                }],
                audioStreams: [],
                primaryVideoStreamIndex: 0,
            },
        }],
        operations: [{
            toolName: 'waptions_edit_apply',
            idempotencyKey: 'operation-1',
            requestDigest: `sha256:${'e'.repeat(64)}`,
            resultingSessionRevision: 4,
            jobIds: [],
            artifactIds: [],
        }],
        editSummary: { clips: 1 },
        undoRedoEvidence: { passed: true },
        reconnectEvidence: { passed: true },
        memoryCaps: { decodedBytes: 1024 },
    };
}

describe('production managed export service', () => {
    it.each([
        ['mp4-h264-aac' as const, 'render.mp4', 'video/mp4'],
        ['webm' as const, 'render.webm', 'video/webm'],
    ])('returns an unpublished terminal candidate for %s', async (
        exportKind,
        outputName,
        mediaType,
    ) => {
        const test = await fixture(outputName);
        const writeOutput = async (
            capability: Parameters<typeof test.outputs.acquire>[0],
            bytes: Uint8Array,
        ) => {
            const handle = await test.outputs.acquire(capability, 'read-write');
            try {
                expect(writeSync(handle.fileDescriptor, bytes, 0, bytes.byteLength, 0))
                    .toBe(bytes.byteLength);
                await handle.sync();
            } finally {
                await handle.close();
            }
        };
        const snapshot = createHeadlessRenderSnapshotFixture();
        const service = new ProductionManagedExportJobService(
            test.outputs,
            test.artifacts,
            {
                render: async (request) => {
                    await writeOutput(request.outputCapability, Buffer.from('managed-mp4'));
                    return {
                        backend: 'ffmpeg',
                        warnings: [],
                        sourceRangesRead: [],
                        diagnostics: {
                            peakDecodedPixelBytes: 1024,
                            peakAudioMixBytes: 1024,
                            peakVideoDecoderSessions: 1,
                            canvasFrames: 0,
                        },
                    };
                },
            },
            {
                inspect: async () => ({
                    container: 'mp4',
                    videoCodec: 'h264',
                    audioCodec: 'aac',
                    pixelFormat: 'yuv420p',
                    audioSampleRate: 48_000,
                    audioChannels: 2,
                    audioChannelLayout: 'stereo',
                    videoFrameCount: 120,
                    videoDurationSeconds: 4,
                    audioDurationSeconds: 4,
                    durationSeconds: 4,
                }),
            },
            {
                render: async (request) => {
                    await writeOutput(request.outputCapability, Buffer.from('managed-webm'));
                    return {
                        planId: request.plan.planId,
                        backend: 'ffmpeg',
                        warnings: [],
                        sourceRangesRead: [],
                        diagnostics: {
                            peakDecodedPixelBytes: 1024,
                            peakAudioMixBytes: 1024,
                            peakVideoDecoderSessions: 1,
                            canvasFrames: 0,
                        },
                        durationSeconds: 4,
                        videoCodec: 'vp9',
                        audioCodec: 'opus',
                    };
                },
            },
        );

        const proposal = await service.prepare({
            ...baseRequest(test.destination),
            exportKind,
            material: { renderSnapshot: snapshot },
        });

        expect(proposal.jobResult).toMatchObject({
            jobKind: `export:${exportKind}`,
            exportKind,
            mediaType,
            codecs: exportKind === 'webm'
                ? { video: 'vp9', audio: 'opus' }
                : { video: 'h264', audio: 'aac' },
        });
        expect(proposal.jobKind).toBe(`export:${exportKind}`);
        expect(proposal.artifacts).toHaveLength(1);
        expect(proposal.events.map((event) => event.type)).toEqual([
            'artifact.created',
            'job.changed',
        ]);
        expect(proposal.artifacts[0]!.record).toMatchObject({
            kind: `export:${exportKind}`,
            mediaType,
            digest: proposal.jobResult.contentDigest,
            byteLength: proposal.jobResult.byteLength,
        });
        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });
        const publication = await proposal.outputs[0]!.preparePublication();
        const stored = await commitTerminalProposal(test, proposal, publication);
        await expect(access(test.target)).resolves.toBeUndefined();
        expect(stored.digest).toBe(proposal.jobResult.contentDigest);
        expect(await test.artifacts.readRange(
            'project-1',
            stored.artifactId,
            0,
            Math.min(4, stored.byteLength),
        )).toMatchObject({ totalBytes: stored.byteLength });
    });

    it('keeps a portable bundle private until coordinator publication and supports rollback', async () => {
        const test = await fixture('project.waptions');
        const proposal = await test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'portable-bundle',
            material: {
                portableBundle: {
                    entries: [
                        bytesEntry('sources/video/source.mp4', 'video'),
                        bytesEntry('metadata.json', '{"version":"4.1"}'),
                    ],
                },
            },
        });

        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.stringify(proposal.jobResult)).not.toMatch(
            /grantId|capability|stagingHandleId|canonicalPath/,
        );
        const publication = await proposal.outputs[0]!.preparePublication();
        const archive = new Blob([await readFile(test.target)]);
        const entries = await inspectProjectBundleZipBlob(archive, 16);
        expect(entries.map((entry) => entry.name)).toEqual([
            'metadata.json',
            'sources/video/source.mp4',
        ]);

        await Promise.all([
            publication.reject(),
            proposal.artifacts[0]!.reject(),
        ]);
        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('publishes a portable bundle and its retrievable artifact in one terminal commit', async () => {
        const test = await fixture('retrievable.waptions');
        const proposal = await test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'portable-bundle',
            material: {
                portableBundle: {
                    entries: [bytesEntry('metadata.json', '{"version":4}')],
                },
            },
        });
        const publication = await proposal.outputs[0]!.preparePublication();
        const artifact = await commitTerminalProposal(test, proposal, publication);

        expect(artifact).toMatchObject({
            kind: 'export:portable-bundle',
            digest: proposal.jobResult.contentDigest,
            byteLength: proposal.jobResult.byteLength,
        });
        expect(await readFile(test.target)).toEqual(
            (await test.artifacts.readRange(
                'project-1',
                artifact.artifactId,
                0,
                artifact.byteLength,
            )).bytes,
        );
    });

    it('publishes a reference snapshot only at the terminal boundary and accepts it durably', async () => {
        const test = await fixture('snapshot.json');
        const proposal = await test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'reference-snapshot',
            material: { referenceSnapshot: referenceSnapshot() },
        });
        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });

        const publication = await proposal.outputs[0]!.preparePublication();
        const artifact = await commitTerminalProposal(test, proposal, publication);
        const parsed = JSON.parse(await readFile(test.target, 'utf8'));
        expect(parsed).toMatchObject({
            kind: 'reference-snapshot',
            contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        expect(artifact.kind).toBe('export:reference-snapshot');
    });

    it('writes JSON or Markdown proof without private authority and rejects forbidden projections', async () => {
        const test = await fixture('edit.proof.md');
        const proposal = await test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'proof-record',
            material: { proof: proof() },
        });
        const publication = await proposal.outputs[0]!.preparePublication();
        const artifact = await commitTerminalProposal(test, proposal, publication);
        const markdown = await readFile(test.target, 'utf8');
        expect(markdown).toContain('# Waptions proof record');
        expect(markdown).toContain('"operations"');
        expect(markdown).toContain('"memoryCaps"');
        expect(markdown).not.toMatch(/grantId|capability|https?:|\/Users\//);
        const canonicalBlock = /## Canonical proof envelope\n\n(`{3,})json\n([^\n]+)\n\1/
            .exec(markdown);
        expect(canonicalBlock).not.toBeNull();
        const canonicalEnvelope = JSON.parse(canonicalBlock![2]!) as {
            contentDigest: string;
            value: ManagedProofEvidenceV1;
        };
        expect(canonicalEnvelope.value).toEqual(proof());
        expect(canonicalEnvelope.contentDigest).toBe(`sha256:${createHash('sha256')
            .update(canonicalJson(canonicalEnvelope.value, 64 * 1024 * 1024))
            .digest('hex')}`);
        expect(artifact.kind).toBe('export:proof-record');

        const invalid = await fixture('invalid.proof.json');
        await expect(invalid.service.prepare({
            ...baseRequest(invalid.destination),
            exportKind: 'proof-record',
            material: {
                proof: {
                    ...proof(),
                    editSummary: { clips: '/private/source.mp4' } as never,
                },
            },
        })).rejects.toThrow(/forbidden (?:authority field|path or URL)/i);
        await expect(access(invalid.target)).rejects.toMatchObject({ code: 'ENOENT' });

        const injected = await fixture('injected.proof.json');
        await expect(injected.service.prepare({
            ...baseRequest(injected.destination),
            exportKind: 'proof-record',
            material: {
                proof: {
                    ...proof(),
                    undoRedoEvidence: {
                        passed: 'CUSTOM+LOCAL://private/session',
                    } as never,
                },
            },
        })).rejects.toThrow(/forbidden (?:authority field|path or URL)/i);
        await expect(access(injected.target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([
        ['parent traversal', '../metadata.json'],
        ['absolute path', '/metadata.json'],
        ['Windows separator', 'sources\\clip.mp4'],
        ['non-NFC name', 'sources/cafe\u0301.mp4'],
    ])('rejects unsafe portable bundle entry names: %s', async (_label, entryName) => {
        const test = await fixture('unsafe.waptions');
        await expect(test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'portable-bundle',
            material: {
                portableBundle: {
                    entries: [
                        bytesEntry('metadata.json', '{}'),
                        bytesEntry(entryName, 'unsafe'),
                    ],
                },
            },
        })).rejects.toThrow(/unsafe|Unicode alias/i);
        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects case-folded and compatibility-normalized bundle aliases', async () => {
        const test = await fixture('aliased.waptions');
        await expect(test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'portable-bundle',
            material: {
                portableBundle: {
                    entries: [
                        bytesEntry('metadata.json', '{}'),
                        bytesEntry('sources/A.mp4', 'first'),
                        bytesEntry('sources/Ａ.mp4', 'second'),
                    ],
                },
            },
        })).rejects.toThrow(/Unicode alias/i);
        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fails a create-only collision at coordinator publication and leaves staged bytes abortable', async () => {
        const test = await fixture('collision.json');
        const proposal = await test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'reference-snapshot',
            material: { referenceSnapshot: referenceSnapshot() },
        });
        await writeFile(test.target, 'hostile-existing-output');

        await expect(proposal.outputs[0]!.preparePublication()).rejects.toMatchObject({
            code: 'WRITE_DESTINATION_NOT_GRANTED',
        });
        await Promise.all([
            proposal.outputs[0]!.abort(),
            proposal.artifacts[0]!.reject(),
        ]);
        expect(await readFile(test.target, 'utf8')).toBe('hostile-existing-output');
    });

    it('rejects staging mutation between handler completion and terminal publication', async () => {
        const test = await fixture('mutated-snapshot.json');
        const proposal = await test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'reference-snapshot',
            material: { referenceSnapshot: referenceSnapshot() },
        });
        const handle = await test.outputs.acquire({
            version: 1,
            kind: 'create-only-staged-output',
            capabilityId: test.destination.destinationId,
            grantId: test.destination.grantId,
            stagingId: test.destination.stagingHandleId,
        }, 'read-write');
        try {
            expect(writeSync(handle.fileDescriptor, Buffer.from('X'), 0, 1, 0)).toBe(1);
            await handle.sync();
        } finally {
            await handle.close();
        }

        await expect(proposal.outputs[0]!.preparePublication()).rejects.toMatchObject({
            code: 'PATH_IDENTITY_CHANGED',
        });
        await Promise.all([
            proposal.outputs[0]!.abort(),
            proposal.artifacts[0]!.reject(),
        ]);
        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('cancels bundle streaming without exposing a partial destination', async () => {
        const test = await fixture('cancelled.waptions');
        const controller = new AbortController();
        const entry: ManagedStreamingEntry = {
            name: 'metadata.json',
            byteLength: 8,
            stream: async function* () {
                yield Buffer.from('1234');
                controller.abort(new DOMException('Cancelled', 'AbortError'));
                yield Buffer.from('5678');
            },
            revalidate: async () => undefined,
        };
        await expect(test.service.prepare({
            ...baseRequest(test.destination),
            exportKind: 'portable-bundle',
            material: { portableBundle: { entries: [entry] } },
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        await expect(access(test.target)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
