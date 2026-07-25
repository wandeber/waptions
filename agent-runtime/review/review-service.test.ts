import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaBudgetManager } from '../../src/lib/media-byte-source/budget-manager';
import type {
    ManagedProcessPort,
    ManagedSourceLease,
    ManagedSourceRegistryPort,
    ProbedMediaMetadata,
} from '../media/contracts';
import { BoundedConcurrency } from '../media/concurrency';
import { createReviewArtifactKey } from './artifact-key';
import { buildReviewCommand, FfmpegReviewBackend } from './ffmpeg-review-backend';
import { FilesystemReviewArtifactPort } from './filesystem-artifact-port';
import type {
    ReviewArtifactPort,
    ReviewBackendPort,
    ReviewBackendResult,
    ReviewKind,
    StagedReviewArtifact,
} from './contracts';
import { ManagedMediaReviewService } from './review-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
        recursive: true,
        force: true,
    })));
});

describe('ManagedMediaReviewService', () => {
    it('creates bounded artifacts and returns explicit NO_AUDIO results', async () => {
        const replacement = new AbortController();
        const close = vi.fn(async () => undefined);
        const sources = sourceRegistry(baseMetadata(false), replacement, close);
        const artifacts = fakeArtifactPort();
        const backend: ReviewBackendPort = {
            algorithmVersion: 'test-backend-v1',
            run: vi.fn(async (request) => (
                request.kind === 'scene-cuts'
                    ? { structuredData: { sceneCutSeconds: [1.25] } }
                    : {}
            )),
        };
        const decoded = new MediaBudgetManager('review-pixels', 64 * 1024 * 1024);
        const pcm = new MediaBudgetManager('review-pcm', 2 * 1024 * 1024);
        const service = new ManagedMediaReviewService(
            sources,
            artifacts.port,
            backend,
            decoded,
            pcm,
            new BoundedConcurrency(2),
        );
        const kinds: ReviewKind[] = [
            'contact-sheet',
            'thumbnail-strip',
            'waveform',
            'audio-map',
            'silence-speech',
            'scene-cuts',
            'proxy',
        ];
        const results = await service.review({
            sourceId: 'source',
            kinds,
            ranges: [{ startSeconds: 0, endSeconds: 5 }],
        });

        expect(results.filter((result) => result.code === 'NO_AUDIO').map((result) => result.kind))
            .toEqual(['waveform', 'audio-map', 'silence-speech']);
        expect(backend.run).toHaveBeenCalledTimes(4);
        expect(artifacts.commits).toBe(4);
        expect(close).toHaveBeenCalledTimes(1);
        expect(service.diagnostics()).toMatchObject({
            jobsStarted: 4,
            jobsSucceeded: 4,
            noAudioResults: 3,
            artifactsPublished: 4,
        });
        expect(decoded.snapshot().peakBytes).toBeGreaterThan(0);
        decoded.assertDrained();
        pcm.assertDrained();
    });

    it('cancels the backend, discards staging, and releases budgets on source replacement', async () => {
        const replacement = new AbortController();
        const sources = sourceRegistry(baseMetadata(true), replacement, vi.fn(async () => undefined));
        const artifacts = fakeArtifactPort();
        const backend: ReviewBackendPort = {
            algorithmVersion: 'test-backend-v1',
            run: vi.fn((request) => new Promise<ReviewBackendResult>((_, reject) => {
                request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
                    once: true,
                });
            })),
        };
        const decoded = new MediaBudgetManager('review-pixels', 64 * 1024 * 1024);
        const pcm = new MediaBudgetManager('review-pcm', 2 * 1024 * 1024);
        const service = new ManagedMediaReviewService(
            sources,
            artifacts.port,
            backend,
            decoded,
            pcm,
            new BoundedConcurrency(2),
        );
        const pending = service.review({
            sourceId: 'source',
            kinds: ['waveform'],
            ranges: [{ startSeconds: 0, endSeconds: 2 }],
        });
        await vi.waitFor(() => expect(backend.run).toHaveBeenCalledTimes(1));
        replacement.abort(new DOMException('Source replaced.', 'AbortError'));
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(artifacts.discards).toBe(1);
        expect(service.diagnostics().jobsCancelled).toBe(1);
        decoded.assertDrained();
        pcm.assertDrained();
    });

    it('serializes jobs that share one inherited source descriptor', async () => {
        const replacement = new AbortController();
        const sources = sourceRegistry(baseMetadata(true), replacement, vi.fn(async () => undefined));
        const artifacts = fakeArtifactPort();
        let active = 0;
        let peakActive = 0;
        const releases: Array<() => void> = [];
        const backend: ReviewBackendPort = {
            algorithmVersion: 'test-backend-v1',
            run: vi.fn(async () => {
                active++;
                peakActive = Math.max(peakActive, active);
                await new Promise<void>((resolve) => releases.push(resolve));
                active--;
                return {};
            }),
        };
        const decoded = new MediaBudgetManager('review-pixels', 64 * 1024 * 1024);
        const pcm = new MediaBudgetManager('review-pcm', 2 * 1024 * 1024);
        const service = new ManagedMediaReviewService(
            sources,
            artifacts.port,
            backend,
            decoded,
            pcm,
            new BoundedConcurrency(2),
        );
        const request = {
            sourceId: 'source',
            kinds: ['contact-sheet'] as const,
            ranges: [{ startSeconds: 0, endSeconds: 1 }],
        };
        const first = service.review(request);
        const second = service.review(request);
        await vi.waitFor(() => expect(backend.run).toHaveBeenCalledTimes(1));
        releases.shift()?.();
        await vi.waitFor(() => expect(backend.run).toHaveBeenCalledTimes(2));
        releases.shift()?.();
        await Promise.all([first, second]);
        expect(peakActive).toBe(1);
        decoded.assertDrained();
        pcm.assertDrained();
    });

    it('cancels a same-source job while it is waiting for the inherited descriptor', async () => {
        const replacement = new AbortController();
        const sources = sourceRegistry(baseMetadata(true), replacement, vi.fn(async () => undefined));
        const artifacts = fakeArtifactPort();
        let releaseFirst: (() => void) | undefined;
        const backend: ReviewBackendPort = {
            algorithmVersion: 'test-backend-v1',
            run: vi.fn(async () => new Promise<void>((resolve) => {
                releaseFirst = resolve;
            }).then(() => ({}))),
        };
        const decoded = new MediaBudgetManager('review-pixels', 64 * 1024 * 1024);
        const pcm = new MediaBudgetManager('review-pcm', 2 * 1024 * 1024);
        const processConcurrency = new BoundedConcurrency(2);
        const service = new ManagedMediaReviewService(
            sources,
            artifacts.port,
            backend,
            decoded,
            pcm,
            processConcurrency,
        );
        const request = {
            sourceId: 'source',
            kinds: ['contact-sheet'] as const,
            ranges: [{ startSeconds: 0, endSeconds: 1 }],
        };
        const first = service.review(request);
        await vi.waitFor(() => expect(backend.run).toHaveBeenCalledTimes(1));
        const controller = new AbortController();
        const queued = service.review({ ...request, signal: controller.signal });
        controller.abort(new DOMException('Cancelled while queued.', 'AbortError'));

        await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
        expect(backend.run).toHaveBeenCalledTimes(1);
        releaseFirst?.();
        await first;
        decoded.assertDrained();
        pcm.assertDrained();
    });

    it('discards output when the immutable source changes during backend execution', async () => {
        const replacement = new AbortController();
        const assertCurrent = vi.fn(async () => {
            throw new Error('Source changed during review.');
        });
        const sources = sourceRegistry(
            baseMetadata(true),
            replacement,
            vi.fn(async () => undefined),
            assertCurrent,
        );
        const artifacts = fakeArtifactPort();
        const backend: ReviewBackendPort = {
            algorithmVersion: 'test-backend-v1',
            run: vi.fn(async () => ({})),
        };
        const decoded = new MediaBudgetManager('review-pixels', 64 * 1024 * 1024);
        const pcm = new MediaBudgetManager('review-pcm', 2 * 1024 * 1024);
        const service = new ManagedMediaReviewService(
            sources,
            artifacts.port,
            backend,
            decoded,
            pcm,
            new BoundedConcurrency(2),
        );

        await expect(service.review({
            sourceId: 'source',
            kinds: ['contact-sheet'],
            ranges: [{ startSeconds: 0, endSeconds: 1 }],
        })).rejects.toThrow('Source changed');
        expect(assertCurrent).toHaveBeenCalledTimes(1);
        expect(artifacts.commits).toBe(0);
        expect(artifacts.discards).toBe(1);
        decoded.assertDrained();
        pcm.assertDrained();
    });
});

describe('FilesystemReviewArtifactPort', () => {
    it('publishes canonical JSON through staged files and hashes without retaining the artifact', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-review-artifacts-'));
        temporaryDirectories.push(directory);
        const budget = new MediaBudgetManager('artifact-hash', 8 * 1024 * 1024);
        const port = new FilesystemReviewArtifactPort({
            grantId: 'internal-artifacts',
            ownership: 'coordinator-owned-private-directory',
            canonicalDirectory: directory,
            assertCurrent: async () => undefined,
        }, budget);
        const staged = await port.stage({
            contentKey: `sha256:${'a'.repeat(64)}`,
            kind: 'scene-cuts',
            extension: 'json',
            mediaType: 'application/json',
            maximumBytes: 1024,
        });
        await staged.writeJson({ z: 1, a: [2, 3] });
        const artifact = await staged.commit();
        expect(artifact).toMatchObject({
            kind: 'scene-cuts',
            mediaType: 'application/json',
            byteLength: 17,
        });
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

        const duplicate = await port.stage({
            contentKey: `sha256:${'a'.repeat(64)}`,
            kind: 'scene-cuts',
            extension: 'json',
            mediaType: 'application/json',
            maximumBytes: 1024,
        });
        await duplicate.writeJson({ z: 1, a: [2, 3] });
        await expect(duplicate.commit()).resolves.toEqual(artifact);

        const finalPath = join(
            directory,
            'objects',
            artifact.artifactId.slice(0, 2),
            `${artifact.artifactId}.json`,
        );
        await writeFile(finalPath, 'corrupt');
        const collision = await port.stage({
            contentKey: `sha256:${'a'.repeat(64)}`,
            kind: 'scene-cuts',
            extension: 'json',
            mediaType: 'application/json',
            maximumBytes: 1024,
        });
        await collision.writeJson({ z: 1, a: [2, 3] });
        await expect(collision.commit()).rejects.toThrow('does not match');
        await collision.discard();
        budget.assertDrained();
    });
});

describe('FFmpeg review command construction', () => {
    it('uses verified descriptor input, bounded frames, and explicit no-audio proxy output', () => {
        const metadata = baseMetadata(false);
        const parameters = {
            maximumFrames: 12,
            thumbnailWidth: 320,
            silenceThresholdDb: -40,
            minimumSilenceSeconds: 0.35,
            sceneThreshold: 0.35,
            proxyWidth: 1280,
        };
        for (const kind of [
            'contact-sheet',
            'thumbnail-strip',
            'waveform',
            'audio-map',
            'silence-speech',
            'scene-cuts',
            'proxy',
        ] as const) {
            const args = buildReviewCommand({
                kind,
                handle: {} as never,
                metadata,
                range: { startSeconds: 1, endSeconds: 3 },
                parameters,
                stagingPath: '/staging/artifact',
                maximumOutputBytes: 1024,
            });
            expect(args).toContain('{{VERIFIED_INPUT}}');
            expect(args).not.toContain('/source/path.mp4');
            expect(args).toContain('-threads');
            if (kind === 'scene-cuts') expect(args).toContain(String(parameters.maximumFrames));
            if (kind === 'audio-map') expect(args.join(' ')).toContain('asetnsamples=');
            if (kind === 'proxy') {
                expect(args).toContain('-an');
                expect(args).toContain('-fs');
            }
            if (kind === 'contact-sheet' || kind === 'thumbnail-strip' || kind === 'waveform') {
                expect(args).toContain('-fs');
            }
        }
    });

    it('maps analysis timestamps back into absolute source time', async () => {
        const processes: ManagedProcessPort = {
            run: vi.fn()
                .mockResolvedValueOnce({
                    exitCode: 0,
                    stdout: '',
                    stderr: '[showinfo] pts_time:1.25',
                })
                .mockResolvedValueOnce({
                    exitCode: 0,
                    stdout: [
                        'frame:0 pts_time:0.5',
                        'lavfi.astats.Overall.RMS_level=-18.75',
                    ].join('\n'),
                    stderr: '',
                }),
        };
        const backend = new FfmpegReviewBackend({
            processes,
            ffmpegExecutable: 'ffmpeg',
            toolchainVersion: 'test-6.1',
        });
        const common = {
            handle: {} as never,
            metadata: baseMetadata(true),
            range: { startSeconds: 10, endSeconds: 12 },
            parameters: {
                maximumFrames: 12,
                thumbnailWidth: 320,
                silenceThresholdDb: -40,
                minimumSilenceSeconds: 0.35,
                sceneThreshold: 0.35,
                proxyWidth: 1280,
            },
            stagingPath: '/staging/artifact',
            maximumOutputBytes: 1024,
        };
        await expect(backend.run({ ...common, kind: 'scene-cuts' })).resolves.toEqual({
            structuredData: { sceneCutSeconds: [11.25] },
        });
        await expect(backend.run({ ...common, kind: 'audio-map' })).resolves.toEqual({
            structuredData: { points: [{ seconds: 10.5, rmsDb: -18.75 }] },
        });
    });

    it('changes artifact keys when the managed backend toolchain changes', () => {
        const input = {
            sourceFingerprint: `sha256:${'d'.repeat(64)}`,
            kind: 'proxy' as const,
            range: { startSeconds: 0, endSeconds: 1 },
            parameters: {
                maximumFrames: 12,
                thumbnailWidth: 320,
                silenceThresholdDb: -40,
                minimumSilenceSeconds: 0.35,
                sceneThreshold: 0.35,
                proxyWidth: 1280,
            },
        };
        expect(createReviewArtifactKey({ ...input, backendVersion: 'ffmpeg:6.1' }))
            .not.toBe(createReviewArtifactKey({ ...input, backendVersion: 'ffmpeg:7.0' }));
    });
});

function sourceRegistry(
    metadata: ProbedMediaMetadata,
    replacement: AbortController,
    close: () => Promise<void>,
    assertCurrent: () => Promise<void> = async () => undefined,
): ManagedSourceRegistryPort {
    const lease: ManagedSourceLease = {
        descriptor: {
            sourceId: 'source',
            displayName: 'Source.mp4',
            identity: { fingerprint: `sha256:${'b'.repeat(64)}`, sizeBytes: 10 },
            metadata,
        },
        handle: {} as never,
        replacementSignal: replacement.signal,
        assertCurrent,
        read: async () => new Uint8Array(),
        close,
    };
    return {
        register: vi.fn(),
        registerBatch: vi.fn(),
        acquire: vi.fn(async () => lease),
    };
}

function fakeArtifactPort(): {
    port: ReviewArtifactPort;
    commits: number;
    discards: number;
} {
    const state = {
        commits: 0,
        discards: 0,
        port: null as unknown as ReviewArtifactPort,
    };
    state.port = {
        stage: vi.fn(async (request) => {
            const staged: StagedReviewArtifact = {
                stagingPath: `/staging/${request.kind}`,
                writeJson: vi.fn(async () => undefined),
                commit: vi.fn(async () => {
                    state.commits++;
                    return {
                        artifactId: `artifact-${state.commits}`,
                        contentKey: request.contentKey,
                        kind: request.kind,
                        mediaType: request.mediaType,
                        byteLength: 10,
                        sha256: 'c'.repeat(64),
                    };
                }),
                discard: vi.fn(async () => {
                    state.discards++;
                }),
            };
            return staged;
        }),
    };
    return state;
}

function baseMetadata(hasAudio: boolean): ProbedMediaMetadata {
    return {
        container: 'mov,mp4',
        durationSeconds: 10,
        bitrate: 1_000_000,
        video: {
            streamIndex: 0,
            codec: 'h264',
            width: 640,
            height: 360,
            frameRate: 30,
            durationSeconds: 10,
        },
        audio: hasAudio ? {
            streamIndex: 1,
            codec: 'aac',
            sampleRate: 48_000,
            channelCount: 2,
            durationSeconds: 10,
        } : null,
    };
}
