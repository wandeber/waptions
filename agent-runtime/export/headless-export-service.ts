import {
    createResolvedRenderPlan,
    framesPerSecond,
} from '../../src/lib/render-plan';
import {
    DEFAULT_HEADLESS_RENDER_LIMITS,
    HeadlessRenderError,
    normalizeHeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderLimitsV1,
} from '../render/contracts';
import {
    createHeadlessExportProgressReporter,
} from '../render/progress';
import type {
    HeadlessExportArtifactPort,
    HeadlessExportRequest,
    HeadlessExportResult,
    HeadlessExportSuccess,
    HeadlessExportTargetLease,
    HeadlessMp4Inspection,
    HeadlessMp4VerifierPort,
    HeadlessRenderExecutionPort,
} from './contracts';

export class HeadlessExportService {
    constructor(
        private readonly renderer: HeadlessRenderExecutionPort,
        private readonly artifacts: HeadlessExportArtifactPort,
        private readonly verifier: HeadlessMp4VerifierPort,
    ) {}

    async export(request: HeadlessExportRequest): Promise<HeadlessExportResult> {
        // Snapshot validation, cloning, and plan resolution intentionally happen before the first
        // await. Later UI/coordinator mutations cannot alter frames, audio, subtitles, or duration.
        let plan;
        let limits: HeadlessRenderLimitsV1;
        try {
            validateJobId(request.jobId);
            validateTarget(request.target);
            limits = validateLimits(request.limits ?? DEFAULT_HEADLESS_RENDER_LIMITS);
            plan = createResolvedRenderPlan(request.snapshot);
            if (request.snapshot.manifest.videoClips.length === 0) {
                throw new HeadlessRenderError(
                    'INVALID_SNAPSHOT',
                    'The timeline has no video clips.',
                );
            }
        } catch (error) {
            return failureResult(request.jobId, normalizeHeadlessRenderError(error));
        }

        const progress = createHeadlessExportProgressReporter(request.onProgress);
        let destination: HeadlessExportTargetLease | null = null;
        let committed = false;

        try {
            throwIfAborted(request.signal);
            progress.reportStage('planning', 1);
            destination = await this.artifacts.acquireCreateOnly(
                request.jobId,
                request.target,
                request.signal,
            );
            const renderResult = await this.renderer.render({
                jobId: request.jobId,
                plan,
                outputCapability: destination.outputCapability,
                limits,
                signal: request.signal,
                onProgress: (backendProgress) => progress.reportBackend(
                    backendProgress.backend ?? 'chromium-webcodecs',
                    backendProgress,
                ),
                resetOutputForFallback: () => destination!.reset(request.signal),
            });
            throwIfAborted(request.signal);
            progress.reportStage('verifying', 0);
            const inspection = await destination.inspect(this.verifier, request.signal);
            validateInspection(plan, inspection);
            progress.reportStage('verifying', 1);
            throwIfAborted(request.signal);
            await destination.sync(request.signal);
            progress.reportStage('committing', 0);
            await destination.commit(request.signal);
            committed = true;
            progress.reportStage('committing', 1);
            const [sha256, bytes] = await Promise.all([
                destination.hashSha256(),
                destination.size(),
            ]);
            progress.reportStage('completed', 1);
            const success: HeadlessExportSuccess = {
                status: 'succeeded',
                jobId: request.jobId,
                planId: plan.planId,
                path: destination.displayPath,
                capabilityId: request.target.capabilityId,
                grantId: request.target.grantId,
                sha256,
                bytes,
                backend: renderResult.backend,
                videoCodec: 'h264',
                audioCodec: 'aac',
                durationSeconds: inspection.durationSeconds,
                warnings: renderResult.warnings,
                sourceRangesRead: renderResult.sourceRangesRead,
                diagnostics: renderResult.diagnostics,
            };
            return success;
        } catch (error) {
            return failureResult(request.jobId, normalizeHeadlessRenderError(error));
        } finally {
            if (destination && !committed) {
                try {
                    await destination.abort();
                } catch {
                    // The durable job record retains the partial path. Startup recovery retries
                    // exact cleanup without turning a primary render failure into a different one.
                }
            }
        }
    }
}

export async function cleanupInterruptedHeadlessExports(
    artifacts: HeadlessExportArtifactPort,
    recoveryScopeId: string,
    activeJobIds: ReadonlySet<string>,
    options: {
        olderThanMs?: number;
        nowMs?: number;
        signal?: AbortSignal;
    } = {},
): Promise<string[]> {
    const olderThanMs = options.olderThanMs ?? 0;
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
        throw new RangeError('olderThanMs must be a non-negative finite number.');
    }
    throwIfAborted(options.signal);
    const partials = await artifacts.listPartials(recoveryScopeId, options.signal);
    const removed: string[] = [];
    for (const partial of partials) {
        throwIfAborted(options.signal);
        if (activeJobIds.has(partial.jobId)
            || nowMs - partial.modifiedAtMs < olderThanMs) continue;
        await artifacts.removePartial(partial.partialId);
        removed.push(partial.partialId);
    }
    return removed.sort();
}

function validateInspection(
    plan: ReturnType<typeof createResolvedRenderPlan>,
    inspection: HeadlessMp4Inspection,
): void {
    if (inspection.container !== 'mp4'
        || !['h264', 'avc', 'avc1'].includes(inspection.videoCodec.toLowerCase())
        || inspection.audioCodec?.toLowerCase() !== 'aac') {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'The rendered artifact is not H.264/AAC MP4.',
        );
    }
    const expectedDuration = plan.contentEndFrame / framesPerSecond(plan.renderProfile.fps);
    const tolerance = 1 / framesPerSecond(plan.renderProfile.fps);
    if (!Number.isFinite(inspection.durationSeconds)
        || Math.abs(inspection.durationSeconds - expectedDuration) > tolerance + Number.EPSILON) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'The MP4 duration differs from the resolved render boundary by more than one frame.',
        );
    }
}

function failureResult(jobId: string, error: HeadlessRenderError): HeadlessExportResult {
    return {
        status: error.code === 'CANCELLED' ? 'cancelled' : 'failed',
        jobId,
        code: error.code,
        message: error.message,
    };
}

function validateJobId(jobId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'Headless export jobId must be a safe opaque identifier.',
        );
    }
}

function validateTarget(target: HeadlessExportRequest['target']): void {
    if (target.version !== 1
        || !isOpaqueId(target.capabilityId)
        || !isOpaqueId(target.grantId)
        || Object.keys(target).sort().join(',') !== 'capabilityId,grantId,version') {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'Export requires a validated create-only staged capability and grantId.',
        );
    }
}

function isOpaqueId(value: string): boolean {
    return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(value);
}

function validateLimits(limits: HeadlessRenderLimitsV1): HeadlessRenderLimitsV1 {
    const values = Object.entries(limits).filter(([key]) => key !== 'version');
    if (limits.version !== 1 || values.some(([, value]) => (
        !Number.isSafeInteger(value) || value <= 0
    ))) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'Headless render limits must be positive safe integers.',
        );
    }
    return Object.freeze({ ...limits });
}
