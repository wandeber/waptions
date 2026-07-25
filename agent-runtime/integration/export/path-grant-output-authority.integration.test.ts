import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFfprobeMp4Verifier } from '../../export/node-ffprobe-verifier';
import { PathGrantAuthority } from '../../path-grants/path-grant-authority';
import { PathGrantOutputAuthority } from './path-grant-output-authority';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const hasFfmpeg = await commandAvailable('ffmpeg') && await commandAvailable('ffprobe');

describe.skipIf(!hasFfmpeg)('path-grant output FFmpeg integration', () => {
    it('renders and verifies H.264/AAC with synthesized silent audio without publishing early', async () => {
        const root = await mkdtemp(join(tmpdir(), 'waptions-output-ffmpeg-'));
        cleanups.push(() => rm(root, { recursive: true, force: true }));
        const target = join(root, 'silent.mp4');
        const paths = new PathGrantAuthority({
            privateCopyRoot: join(root, 'private'),
            authoritySecret: Buffer.alloc(32, 2),
        });
        const scope = { sessionId: 'session-1', sessionEpoch: 'epoch-1' };
        const grant = await paths.create(
            scope.sessionId,
            scope.sessionEpoch,
            'create-only-destination',
            target,
        );
        const outputs = new PathGrantOutputAuthority();
        const destination = {
            schemaVersion: 1 as const,
            destinationId: 'destination-ffmpeg',
            grantId: grant.grantId,
            stagingHandleId: 'stage-ffmpeg',
            mode: 'create-only' as const,
            outputName: 'silent.mp4',
            verifiedParentIdentity: 'parent-identity',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        outputs.register(destination, await paths.stageCreate(grant.grantId, scope));
        const lease = outputs.acquireDestination(destination);
        const output = await outputs.acquire(lease.renderCapability, 'read-write');
        try {
            await runFfmpeg(output.fileDescriptor);
            await output.sync();
        } finally {
            await output.close();
        }
        const inspection = await new NodeFfprobeMp4Verifier(outputs).inspect(
            lease.renderCapability,
        );
        expect(inspection).toMatchObject({
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            pixelFormat: 'yuv420p',
            audioSampleRate: 48_000,
            audioChannels: 2,
            videoFrameCount: 5,
        });
        const hashed = await lease.hash();
        const candidate = lease.candidate({
            contentDigest: hashed.digest,
            byteLength: hashed.bytes,
        });
        await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
        const publication = await candidate.preparePublication();
        await publication.accept();
        await expect(access(target, constants.R_OK)).resolves.toBeUndefined();
    });
});

async function commandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn(command, ['-version'], { stdio: 'ignore' });
        child.once('error', () => resolve(false));
        child.once('close', (code) => resolve(code === 0));
    });
}

async function runFfmpeg(outputFd: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', [
            '-hide_banner',
            '-nostdin',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'color=c=black:s=64x36:r=30:d=0.1666667',
            '-f', 'lavfi',
            '-i', 'anullsrc=r=48000:cl=stereo',
            '-frames:v', '5',
            '-af', 'atrim=end_sample=8000,asetpts=N/SR/TB',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-ar', '48000',
            '-ac', '2',
            '-f', 'mp4',
            '-y', '/dev/fd/3',
        ], {
            stdio: ['ignore', 'ignore', 'pipe', outputFd],
        });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg failed (${code}): ${stderr}`));
        });
    });
}
