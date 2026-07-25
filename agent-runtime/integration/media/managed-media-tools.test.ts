import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditorMediaImportRequest } from '../../../src/lib/editor-engine/editor-engine-types';
import { PathGrantAuthority } from '../../path-grants/path-grant-authority';
import type { MediaDiagnosticsPort } from '../../media/ports';
import { ManagedMediaProbeService } from '../../media/probe';
import type {
    BoundedMediaProcessPort,
    ManagedMediaProcessRequest,
} from '../../media/process-port';
import { ManagedMediaToolService } from './managed-media-tools';
import { PathGrantMediaAdapter } from './path-grant-media-adapter';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

class FixtureProcess implements BoundedMediaProcessPort {
    async execute(request: ManagedMediaProcessRequest) {
        if (request.operation.kind !== 'probe') throw new Error('Fixture supports probe only.');
        const audioOnly = request.source.displayName.endsWith('.wav');
        const stdout = Buffer.from(JSON.stringify({
            streams: audioOnly
                ? [{
                    index: 0,
                    codec_type: 'audio',
                    codec_name: 'pcm_s16le',
                    sample_rate: '48000',
                    channels: 2,
                    duration: '1',
                    bit_rate: '1536000',
                }]
                : [{
                    index: 0,
                    codec_type: 'video',
                    codec_name: 'h264',
                    pix_fmt: 'yuv420p',
                    width: 1920,
                    height: 1080,
                    avg_frame_rate: '30000/1001',
                    duration: '1',
                    bit_rate: '5000000',
                }],
            format: {
                format_name: audioOnly ? 'wav' : 'mov,mp4',
                duration: '1',
                size: String(request.source.snapshot.byteLength),
            },
        }));
        return {
            kind: 'probe' as const,
            stdout,
            accounting: {
                input: {
                    totalBytes: 1,
                    maxChunkBytes: 1,
                    ranges: [{ start: 0, endExclusive: 1 }],
                },
                outputBytes: 0,
                stdoutBytes: stdout.byteLength,
                stderrBytes: 0,
                maxBufferedBytes: Math.min(stdout.byteLength, 1024),
                peakResidentBytes: 1024,
                decodedRanges: [],
            },
        };
    }
}

const diagnostics: MediaDiagnosticsPort = { record: () => undefined };

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'waptions-managed-media-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const inputs = join(root, 'inputs');
    await mkdir(inputs);
    const authority = new PathGrantAuthority({
        privateCopyRoot: join(root, 'private'),
        authoritySecret: Buffer.alloc(32, 7),
    });
    const scope = { sessionId: 'session-1', sessionEpoch: 'epoch-1' };
    const grant = await authority.create(
        scope.sessionId,
        scope.sessionEpoch,
        'read-root',
        inputs,
    );
    const adapter = new PathGrantMediaAdapter(authority);
    const probes = new ManagedMediaProbeService(
        adapter,
        adapter,
        new FixtureProcess(),
        diagnostics,
    );
    return { root, inputs, authority, scope, grant, adapter, probes };
}

function requestBase(): Omit<EditorMediaImportRequest, 'sources' | 'placement'> {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_media_import',
        sessionEpoch: 'epoch-1',
        expected: {
            sessionRevision: 0,
            documentRevision: 0,
            audioGraphRevision: 0,
        },
        idempotencyKey: 'import-1',
    };
}

describe('managed media tool integration', () => {
    it('probes synchronously without jobs and imports mixed media in canonical natural order', async () => {
        const test = await fixture();
        const video = join(test.inputs, 'clip-10.mp4');
        const audio = join(test.inputs, 'clip-2.wav');
        await Promise.all([
            writeFile(video, Buffer.from('video-bytes')),
            writeFile(audio, Buffer.from('audio-bytes')),
        ]);
        let captured: EditorMediaImportRequest | undefined;
        const service = new ManagedMediaToolService(test.adapter, test.probes, {
            importMedia: async ({ request, hydration, revalidate, commitAuthority }) => {
                captured = request;
                await revalidate();
                commitAuthority();
                expect(hydration.videoSources).toHaveLength(1);
                expect(hydration.audioSources).toHaveLength(1);
                return {
                    ok: true,
                    sourceIds: [
                        ...request.sources.audioSourceDescriptors.map((source) => source.id),
                        ...request.sources.videoSourceDescriptors.map((source) => source.id),
                    ],
                    placedClipIds: ['clip-video', 'clip-audio'],
                } as never;
            },
        });
        const probed = await service.probe({
            operationId: 'probe-1',
            sessionId: test.scope.sessionId,
            sessionEpoch: test.scope.sessionEpoch,
            grantId: test.grant.grantId,
            paths: [video, audio],
        });

        expect(probed.jobIds).toEqual([]);
        expect(probed.handles).toHaveLength(2);
        expect(probed.media).toEqual(expect.arrayContaining([
            expect.objectContaining({
                displayName: 'clip-2.wav',
                mediaClass: 'audio',
                metadata: expect.objectContaining({
                    durationUs: 1_000_000,
                    audioStreams: [expect.objectContaining({
                        sampleRate: 48_000,
                        channels: 2,
                    })],
                }),
            }),
            expect.objectContaining({
                displayName: 'clip-10.mp4',
                mediaClass: 'video',
                metadata: expect.objectContaining({
                    videoStreams: [expect.objectContaining({
                        codec: 'h264',
                        width: 1920,
                        height: 1080,
                    })],
                }),
            }),
        ]));
        expect(JSON.stringify(probed)).not.toContain(test.root);
        const imported = await service.import({
            request: requestBase(),
            mediaHandles: probed.handles.map((handle) => handle.handleId),
            placement: {
                kind: 'place',
                ordering: 'natural',
                timelineStartFrame: 0,
            },
        });

        expect(imported.result.ok).toBe(true);
        expect(captured?.sources.audioSourceDescriptors[0]?.originalName).toBe('clip-2.wav');
        expect(captured?.sources.videoSourceDescriptors[0]?.originalName).toBe('clip-10.mp4');
        expect(captured?.sources.videoSourceDescriptors[0]?.hasAudio).toBe(false);
        expect(captured?.sources.audioSourceDescriptors[0]).toMatchObject({
            nativeSampleRate: 48_000,
            nativeChannelCount: 2,
            nativeSampleCount: 48_000,
        });

        const videoRecord = test.adapter.get(probed.handles[0]!.handleId)!;
        const restarted = new PathGrantMediaAdapter(test.authority);
        restarted.restoreCommitted({
            grantId: test.grant.grantId,
            scope: test.scope,
            record: videoRecord,
        });
        await rm(video);
        const retained = await restarted.open(videoRecord.handle.handleId);
        try {
            const bytes = Buffer.alloc(videoRecord.registeredIdentity.byteLength);
            const read = await retained.fileHandle.read(bytes, 0, bytes.byteLength, 0);
            expect(bytes.subarray(0, read.bytesRead).toString()).toBe('video-bytes');
        } finally {
            await retained.close();
        }
        const revokedWhileOpen = await restarted.open(videoRecord.handle.handleId);
        const processHandle = restarted.resolveProcessHandle(revokedWhileOpen.handleId);
        test.authority.revoke(test.grant.grantId, test.scope);
        await expect(revokedWhileOpen.assertCurrent()).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
        await expect(processHandle.assertCurrent()).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
        await revokedWhileOpen.close();
        await expect(restarted.open(videoRecord.handle.handleId)).rejects.toMatchObject({
            code: 'PATH_NOT_GRANTED',
        });
    });

    it('fails closed when a grant is revoked after probe and before Core commit', async () => {
        const test = await fixture();
        const video = join(test.inputs, 'source.mp4');
        await writeFile(video, Buffer.from('video-source'));
        const service = new ManagedMediaToolService(test.adapter, test.probes, {
            importMedia: async ({ revalidate }) => {
                await revalidate();
                throw new Error('unreachable');
            },
        });
        const probed = await service.probe({
            operationId: 'probe-revoke',
            sessionId: test.scope.sessionId,
            sessionEpoch: test.scope.sessionEpoch,
            grantId: test.grant.grantId,
            paths: [video],
        });
        test.authority.revoke(test.grant.grantId, test.scope);

        await expect(service.import({
            request: requestBase(),
            mediaHandles: [probed.handles[0]!.handleId],
            placement: { kind: 'register-only' },
        })).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
    });

    it('rejects a symlink candidate before ffprobe and never returns a handle', async () => {
        const test = await fixture();
        const real = join(test.inputs, 'real.mp4');
        const linked = join(test.inputs, 'linked.mp4');
        await writeFile(real, Buffer.from('source'));
        await symlink(real, linked);
        const service = new ManagedMediaToolService(test.adapter, test.probes, {
            importMedia: async () => {
                throw new Error('not used');
            },
        });

        await expect(service.probe({
            operationId: 'probe-symlink',
            sessionId: test.scope.sessionId,
            sessionEpoch: test.scope.sessionEpoch,
            grantId: test.grant.grantId,
            paths: [linked],
        })).rejects.toBeDefined();
    });
});
