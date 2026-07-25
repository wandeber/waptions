import { describe, expect, it, vi } from 'vitest';
import {
    HeadlessExportService,
    cleanupInterruptedHeadlessExports,
    type HeadlessExportArtifactPort,
    type HeadlessExportPartial,
    type HeadlessMp4VerifierPort,
    type HeadlessRenderExecutionPort,
} from '../../../agent-runtime/export';
import {
    DEFAULT_HEADLESS_RENDER_LIMITS,
    HeadlessRenderError,
} from '../../../agent-runtime/render';
import {
    createEmptyDiagnostics,
    createHeadlessRenderSnapshotFixture,
} from './headless-render.test-fixtures';

const TARGET = {
    version: 1 as const,
    capabilityId: 'capability:export-test',
    grantId: 'grant:export-test',
};

const OUTPUT_CAPABILITY = {
    version: 1 as const,
    kind: 'create-only-staged-output' as const,
    capabilityId: TARGET.capabilityId,
    grantId: TARGET.grantId,
    stagingId: 'staging:export-test',
};

function createArtifactPort(partials: HeadlessExportPartial[] = []) {
    const lease = {
        outputCapability: OUTPUT_CAPABILITY,
        displayPath: '/exports/final.mp4',
        reset: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn(async (
            verifier: HeadlessMp4VerifierPort,
            signal?: AbortSignal,
        ) => verifier.inspect(OUTPUT_CAPABILITY, signal)),
        commit: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
        hashSha256: vi.fn().mockResolvedValue(`sha256:${'a'.repeat(64)}`),
        size: vi.fn().mockResolvedValue(12_345),
    };
    const acquireCreateOnly = vi
        .fn<HeadlessExportArtifactPort['acquireCreateOnly']>()
        .mockResolvedValue(lease);
    const removePartial = vi
        .fn<HeadlessExportArtifactPort['removePartial']>()
        .mockResolvedValue(undefined);
    const listPartials = vi
        .fn<HeadlessExportArtifactPort['listPartials']>()
        .mockResolvedValue(partials);
    return {
        acquireCreateOnly,
        removePartial,
        listPartials,
        lease,
    };
}

function createRenderer(
    implementation?: HeadlessRenderExecutionPort['render'],
) {
    const defaultImplementation: HeadlessRenderExecutionPort['render'] = async (request) => {
        request.onProgress?.({
            backend: 'chromium-webcodecs',
            stage: 'video',
            completedUnits: request.plan.contentEndFrame,
            totalUnits: request.plan.contentEndFrame,
        });
        request.onProgress?.({
            backend: 'chromium-webcodecs',
            stage: 'audio',
            completedUnits: request.plan.outputEndSample,
            totalUnits: request.plan.outputEndSample,
        });
        request.onProgress?.({
            backend: 'chromium-webcodecs',
            stage: 'muxing',
            completedUnits: 1,
            totalUnits: 1,
        });
        return {
            backend: 'chromium-webcodecs',
            warnings: [],
            sourceRangesRead: [],
            diagnostics: createEmptyDiagnostics(),
        };
    };
    return {
        render: vi.fn<HeadlessRenderExecutionPort['render']>(
            implementation ?? defaultImplementation,
        ),
    };
}

function createVerifier(
    overrides: Partial<Awaited<ReturnType<HeadlessMp4VerifierPort['inspect']>>> = {},
): HeadlessMp4VerifierPort & { inspect: ReturnType<typeof vi.fn> } {
    return {
        inspect: vi.fn().mockResolvedValue({
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            durationSeconds: 4,
            ...overrides,
        }),
    };
}

describe('headless export service', () => {
    it('renders, verifies, fsyncs, publishes, hashes, and reports deterministic progress', async () => {
        const renderer = createRenderer();
        const artifacts = createArtifactPort();
        const verifier = createVerifier();
        const progress = vi.fn();
        const service = new HeadlessExportService(renderer, artifacts, verifier);

        const result = await service.export({
            jobId: 'job_export',
            snapshot: createHeadlessRenderSnapshotFixture(),
            target: TARGET,
            limits: DEFAULT_HEADLESS_RENDER_LIMITS,
            onProgress: progress,
        });

        expect(result).toMatchObject({
            status: 'succeeded',
            path: '/exports/final.mp4',
            sha256: `sha256:${'a'.repeat(64)}`,
            bytes: 12_345,
            backend: 'chromium-webcodecs',
            videoCodec: 'h264',
            audioCodec: 'aac',
            durationSeconds: 4,
            capabilityId: TARGET.capabilityId,
            grantId: TARGET.grantId,
        });
        expect(artifacts.lease.sync).toHaveBeenCalledBefore(artifacts.lease.commit);
        expect(verifier.inspect).toHaveBeenCalledBefore(artifacts.lease.sync);
        expect(artifacts.lease.abort).not.toHaveBeenCalled();
        const updates = progress.mock.calls.map(([update]) => update);
        expect(updates.map((update) => update.sequence))
            .toEqual(updates.map((_, index) => index + 1));
        expect(updates.map((update) => update.fraction))
            .toEqual([...updates.map((update) => update.fraction)].sort((a, b) => a - b));
        expect(updates.at(-1)).toMatchObject({ stage: 'completed', fraction: 1 });
    });

    it('consumes the immutable plan captured before destination acquisition resolves', async () => {
        let releasePrepare!: () => void;
        const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
        const artifacts = createArtifactPort();
        const originalAcquire = artifacts.acquireCreateOnly;
        artifacts.acquireCreateOnly = vi.fn(async (
            jobId: string,
            target: typeof TARGET,
            signal?: AbortSignal,
        ) => {
            await prepareGate;
            return originalAcquire(jobId, target, signal);
        });
        const renderer = createRenderer();
        const service = new HeadlessExportService(renderer, artifacts, createVerifier());
        const snapshot = createHeadlessRenderSnapshotFixture();

        const pending = service.export({
            jobId: 'job_export',
            snapshot,
            target: TARGET,
        });
        snapshot.manifest.videoClips[0].timelineStartFrame = 100;
        snapshot.manifest.subtitleTracks[0].subtitles[0].text = 'Mutated late';
        releasePrepare();
        await pending;

        const plan = renderer.render.mock.calls[0][0].plan;
        expect(plan.videoSegments[0].outputStartFrame).toBe(0);
        expect(plan.subtitleTracks[0].subtitles[0].text).toBe('Visible');
    });

    it.each([
        [{ videoCodec: 'vp9' }, 'INVALID_OUTPUT'],
        [{ audioCodec: null }, 'INVALID_OUTPUT'],
        [{ durationSeconds: 4.2 }, 'INVALID_OUTPUT'],
    ])('rejects invalid MP4 verification %# and removes the partial', async (inspection, code) => {
        const artifacts = createArtifactPort();
        const service = new HeadlessExportService(
            createRenderer(),
            artifacts,
            createVerifier(inspection),
        );

        const result = await service.export({
            jobId: 'job_export',
            snapshot: createHeadlessRenderSnapshotFixture(),
            target: TARGET,
        });

        expect(result).toMatchObject({ status: 'failed', code });
        expect(artifacts.lease.commit).not.toHaveBeenCalled();
        expect(artifacts.lease.abort).toHaveBeenCalledOnce();
    });

    it('propagates cancellation, skips verification/publication, and cleans the partial', async () => {
        const controller = new AbortController();
        const artifacts = createArtifactPort();
        const renderer = createRenderer(async () => {
            controller.abort();
            throw new HeadlessRenderError('CANCELLED', 'Cancelled.');
        });
        const verifier = createVerifier();
        const service = new HeadlessExportService(renderer, artifacts, verifier);

        const result = await service.export({
            jobId: 'job_export',
            snapshot: createHeadlessRenderSnapshotFixture(),
            target: TARGET,
            signal: controller.signal,
        });

        expect(result).toEqual({
            status: 'cancelled',
            jobId: 'job_export',
            code: 'CANCELLED',
            message: 'Cancelled.',
        });
        expect(verifier.inspect).not.toHaveBeenCalled();
        expect(artifacts.lease.commit).not.toHaveBeenCalled();
        expect(artifacts.lease.abort).toHaveBeenCalledOnce();
    });

    it('cleans a renderer crash without hiding the primary failure', async () => {
        const artifacts = createArtifactPort();
        const renderer = createRenderer(async () => {
            throw new Error('Chromium crashed');
        });
        const service = new HeadlessExportService(renderer, artifacts, createVerifier());

        await expect(service.export({
            jobId: 'job_export',
            snapshot: createHeadlessRenderSnapshotFixture(),
            target: TARGET,
        })).resolves.toMatchObject({
            status: 'failed',
            code: 'RENDER_FAILED',
            message: 'Chromium crashed',
        });
        expect(artifacts.lease.abort).toHaveBeenCalledOnce();
    });

    it('treats create-only publication as the terminal cancellation boundary', async () => {
        const controller = new AbortController();
        const artifacts = createArtifactPort();
        artifacts.lease.commit.mockImplementation(async () => {
            controller.abort();
        });
        const service = new HeadlessExportService(
            createRenderer(),
            artifacts,
            createVerifier(),
        );

        await expect(service.export({
            jobId: 'job_export',
            snapshot: createHeadlessRenderSnapshotFixture(),
            target: TARGET,
            signal: controller.signal,
        })).resolves.toMatchObject({ status: 'succeeded' });
        expect(artifacts.lease.hashSha256).toHaveBeenCalledOnce();
        expect(artifacts.lease.abort).not.toHaveBeenCalled();
    });

    it('rejects raw-path fields instead of treating them as destination authority', async () => {
        const artifacts = createArtifactPort();
        const service = new HeadlessExportService(
            createRenderer(),
            artifacts,
            createVerifier(),
        );

        await expect(service.export({
            jobId: 'job_export',
            snapshot: createHeadlessRenderSnapshotFixture(),
            target: {
                ...TARGET,
                destinationPath: '/caller-controlled/output.mp4',
            } as typeof TARGET,
        })).resolves.toMatchObject({
            status: 'failed',
            code: 'INVALID_OUTPUT',
        });
        expect(artifacts.acquireCreateOnly).not.toHaveBeenCalled();
    });

    it('removes orphaned crash partials while preserving active or recent jobs', async () => {
        const artifacts = createArtifactPort([
            { jobId: 'orphan', partialId: 'partial:orphan', modifiedAtMs: 100 },
            { jobId: 'active', partialId: 'partial:active', modifiedAtMs: 100 },
            { jobId: 'recent', partialId: 'partial:recent', modifiedAtMs: 950 },
        ]);

        await expect(cleanupInterruptedHeadlessExports(
            artifacts,
            'recovery-scope:test',
            new Set(['active']),
            { nowMs: 1_000, olderThanMs: 100 },
        )).resolves.toEqual(['partial:orphan']);
        expect(artifacts.removePartial).toHaveBeenCalledOnce();
        expect(artifacts.removePartial).toHaveBeenCalledWith('partial:orphan');
    });
});
