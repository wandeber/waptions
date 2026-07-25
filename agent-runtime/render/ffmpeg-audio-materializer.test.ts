import { fstatSync, readSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    materializeCanonicalAudio,
} from './ffmpeg-audio-materializer';
import { createNodeFfmpegPlanFixture } from './node-ffmpeg.test-fixtures';
import {
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
} from './node-ffmpeg-process';

describe('canonical audio-first scratch materialization', () => {
    it('creates exact private f32le stereo silence when no contributors exist', async () => {
        const plan = createNodeFfmpegPlanFixture();
        const result = await materializeCanonicalAudio({
            plan,
            mediaSources: {
                snapshotId: plan.sourceSnapshotId,
                identities: plan.sources,
                get: vi.fn(),
                close: vi.fn(),
            },
            sourceHandles: { acquire: vi.fn() },
            processes: new NodeBoundedFfmpegProcessRunner(),
            tracker: new NodeBackendProcessTracker(1, 1024 * 1024),
            ffmpegExecutable: 'ffmpeg',
            ffprobeExecutable: 'ffprobe',
            processLimits: {
                maximumProcesses: 1,
                maximumResidentBytes: 1024 * 1024,
                maximumStderrBytes: 1024,
                maximumProgressBytes: 1024,
                timeoutMs: 1_000,
                killGraceMs: 100,
            },
            maximumAudioMixBytes: 1024 * 1024,
            maximumScratchBytes: 1024 * 1024,
        });
        try {
            const expectedBytes = plan.outputEndSample * 2 * 4;
            expect(result.scratch.byteLength).toBe(expectedBytes);
            expect(result.peakScratchBytes).toBe(expectedBytes);
            expect(fstatSync(result.scratch.fileDescriptor).mode & 0o777).toBe(0o600);
            const bytes = Buffer.alloc(expectedBytes);
            const read = readSync(
                result.scratch.fileDescriptor,
                bytes,
                0,
                bytes.byteLength,
                0,
            );
            expect(read).toBe(expectedBytes);
            expect(bytes.every((byte) => byte === 0)).toBe(true);
            expect(result.sourceRangesRead).toEqual([]);
        } finally {
            await result.scratch.close();
        }
        expect(() => fstatSync(result.scratch.fileDescriptor)).toThrow();
    });

    it('rejects a logical PCM file above maxScratchBytes before allocation', async () => {
        const plan = createNodeFfmpegPlanFixture();
        await expect(materializeCanonicalAudio({
            plan,
            mediaSources: {
                snapshotId: plan.sourceSnapshotId,
                identities: plan.sources,
                get: vi.fn(),
                close: vi.fn(),
            },
            sourceHandles: { acquire: vi.fn() },
            processes: new NodeBoundedFfmpegProcessRunner(),
            tracker: new NodeBackendProcessTracker(1, 1024 * 1024),
            ffmpegExecutable: 'ffmpeg',
            ffprobeExecutable: 'ffprobe',
            processLimits: {
                maximumProcesses: 1,
                maximumResidentBytes: 1024 * 1024,
                maximumStderrBytes: 1024,
                maximumProgressBytes: 1024,
                timeoutMs: 1_000,
                killGraceMs: 100,
            },
            maximumAudioMixBytes: 1024,
            maximumScratchBytes: 1,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    });
});
