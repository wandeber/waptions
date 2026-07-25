import { spawnSync } from 'node:child_process';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createHeadlessRenderSnapshotFixture,
} from '../../../src/lib/headless-render/headless-render.test-fixtures';
import { createResolvedRenderPlan } from '../../../src/lib/render-plan';
import { PathGrantAuthority } from '../../path-grants/path-grant-authority';
import { NodeFfmpegWebmRenderPort } from './node-webm-renderer';
import { PathGrantOutputAuthority } from './path-grant-output-authority';

const FFMPEG_AVAILABLE = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const ENCODERS_AVAILABLE = FFMPEG_AVAILABLE
    && /(?:^|\s)libx264(?:\s|$)/m.test(runTool('ffmpeg', ['-hide_banner', '-encoders']))
    && /(?:^|\s)libvpx-vp9(?:\s|$)/m.test(runTool('ffmpeg', ['-hide_banner', '-encoders']))
    && /(?:^|\s)libopus(?:\s|$)/m.test(runTool('ffmpeg', ['-hide_banner', '-encoders']));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe.skipIf(!ENCODERS_AVAILABLE)('managed WebM system FFmpeg integration', () => {
    it('transcodes a resolved-plan scratch render to verified VP9/Opus without early publication', async () => {
        const root = await mkdtemp(join(tmpdir(), 'waptions-webm-render-'));
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        const scratchPath = join(root, 'scratch.mp4');
        const target = join(root, 'output.webm');
        const snapshot = createHeadlessRenderSnapshotFixture();
        snapshot.manifest.subtitleTracks = [];
        snapshot.manifest.activeSubtitleTrackId = null;
        const plan = createResolvedRenderPlan(snapshot);
        runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', `color=c=green:s=64x36:r=30:d=${plan.contentEndFrame / 30}`,
            '-f', 'lavfi',
            '-i', 'anullsrc=r=48000:cl=stereo',
            '-frames:v', String(plan.contentEndFrame),
            '-af', `atrim=end_sample=${plan.outputEndSample},asetpts=N/SR/TB`,
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-threads:v', '1',
            '-c:a', 'aac',
            '-ar', '48000',
            '-ac', '2',
            '-shortest',
            '-y',
            scratchPath,
        ]);
        const paths = new PathGrantAuthority({
            privateCopyRoot: join(root, 'private'),
            authoritySecret: Buffer.alloc(32, 21),
        });
        const scope = { sessionId: 'session-webm', sessionEpoch: 'epoch-webm' };
        const grant = await paths.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const outputs = new PathGrantOutputAuthority();
        const destination = {
            schemaVersion: 1 as const,
            destinationId: 'destination-webm',
            grantId: grant.grantId,
            stagingHandleId: 'staging-webm',
            mode: 'create-only' as const,
            outputName: 'output.webm',
            verifiedParentIdentity: 'verified-parent',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        outputs.register(destination, await paths.stageCreate(grant.grantId, scope));
        const lease = outputs.acquireDestination(destination);
        const renderer = new NodeFfmpegWebmRenderPort({
            render: async ({ plan: requestedPlan }) => {
                expect(requestedPlan.planId).toBe(plan.planId);
                const handle = await open(scratchPath, 'r');
                const identity = await handle.stat({ bigint: true });
                let closed = false;
                return {
                    fileDescriptor: handle.fd,
                    planId: plan.planId,
                    backend: 'ffmpeg',
                    warnings: [],
                    sourceRangesRead: [],
                    diagnostics: {
                        peakDecodedPixelBytes: 1024,
                        peakAudioMixBytes: 1024,
                        peakVideoDecoderSessions: 1,
                        canvasFrames: 0,
                    },
                    assertCurrent: async () => {
                        if (closed) throw new Error('Scratch render is closed.');
                        const current = await handle.stat({ bigint: true });
                        if (current.dev !== identity.dev
                            || current.ino !== identity.ino
                            || current.size !== identity.size) {
                            throw new Error('Scratch render changed.');
                        }
                    },
                    close: async () => {
                        if (closed) return;
                        closed = true;
                        await handle.close();
                    },
                };
            },
        }, outputs);

        const result = await renderer.render({
            jobId: 'job-webm',
            plan,
            outputCapability: lease.renderCapability,
        });

        expect(result).toMatchObject({
            videoCodec: 'vp9',
            audioCodec: 'opus',
            durationSeconds: expect.closeTo(plan.contentEndFrame / 30, 1),
            diagnostics: {
                peakBackendProcesses: 1,
            },
        });
        const hashed = await lease.hash();
        const candidate = lease.candidate({
            contentDigest: hashed.digest,
            byteLength: hashed.bytes,
        });
        await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
        const publication = await candidate.preparePublication();
        await publication.accept();
        await expect(access(target)).resolves.toBeUndefined();
    }, 60_000);
});

function toolAvailable(executable: string): boolean {
    return spawnSync(executable, ['-version'], {
        stdio: 'ignore',
        timeout: 5_000,
    }).status === 0;
}

function runTool(executable: string, args: readonly string[]): string {
    const result = spawnSync(executable, [...args], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
    });
    if (result.status !== 0) {
        throw new Error(`${executable} failed (${result.status}): ${result.stderr}`);
    }
    return result.stdout;
}
