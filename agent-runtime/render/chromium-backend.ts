import {
    acquireVerifiedRenderMediaSources,
    type RenderMediaByteSourcePort,
    type ResolvedRenderPlanV1,
    type VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    normalizeHeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderBackendCapability,
    type HeadlessRenderBackendDiagnostics,
    type HeadlessRenderBackendPort,
    type HeadlessRenderBackendProgress,
    type HeadlessRenderBackendRequest,
    type HeadlessRenderBackendResult,
    type HeadlessRenderResourceBudgetPort,
    type HeadlessRenderResourceReservation,
    type HeadlessSourceRangeRead,
} from './contracts';
import {
    assertResourceReservation,
    getBackendResourceRequest,
} from './resource-budget';

export interface ChromiumWebCodecsCapabilityProbe {
    chromiumAvailable: boolean;
    webCodecs: boolean;
    h264Encoder: boolean;
    aacEncoder: boolean;
    mp4Muxer: boolean;
    /**
     * Keeps the fallback explicit when the raw worker-host contract is fulfilled by a
     * descriptor-bound deterministic encoder after Chromium has already composed the pixels.
     */
    implementation?: 'chromium-webcodecs' | 'deterministic-ffmpeg-raw-descriptor';
    reason?: string;
}

export interface ChromiumWebCodecsWorkerResult {
    warnings?: string[];
    sourceRangesRead: HeadlessSourceRangeRead[];
    diagnostics: HeadlessRenderBackendDiagnostics;
}

/**
 * Worker integration port owned by the coordinator/runtime package.
 *
 * Implementations load the immutable plan in a bounded Chromium worker, decode frames through the
 * media source port, call `renderResolvedPlanFrame`, mix audio through `renderAudioMixWindow`, and
 * stream encoded H.264/AAC bytes through the staged create-only output capability.
 */
export interface ChromiumWebCodecsWorkerPort {
    probe(signal?: AbortSignal): Promise<ChromiumWebCodecsCapabilityProbe>;
    render(request: {
        jobId: string;
        plan: ResolvedRenderPlanV1;
        outputCapability: import('./contracts').HeadlessStagedOutputCapability;
        mediaSources: VerifiedRenderMediaSourceSet;
        resourceReservation: HeadlessRenderResourceReservation;
        maximumReadChunkBytes: number;
        maximumCanvasFrames: number;
        maximumDecoderSessions: number;
        maximumDecodedPixelBytes: number;
        maximumAudioMixBytes: number;
        signal?: AbortSignal;
        onProgress?: (progress: HeadlessRenderBackendProgress) => void;
    }): Promise<ChromiumWebCodecsWorkerResult>;
}

export class ChromiumWebCodecsRenderBackend implements HeadlessRenderBackendPort {
    readonly name = 'chromium-webcodecs' as const;

    constructor(
        private readonly worker: ChromiumWebCodecsWorkerPort,
        private readonly budget: HeadlessRenderResourceBudgetPort,
        private readonly media: RenderMediaByteSourcePort,
    ) {
        if (budget.authority !== 'process-wide-decoded-memory-v1') {
            throw new Error('Chromium export requires the process-wide decoded-memory authority.');
        }
    }

    async probe(
        _plan: ResolvedRenderPlanV1,
        signal?: AbortSignal,
    ): Promise<HeadlessRenderBackendCapability> {
        throwIfAborted(signal);
        const capability = await this.worker.probe(signal);
        throwIfAborted(signal);
        const hasExactDescriptorFallback = capability.implementation
            === 'deterministic-ffmpeg-raw-descriptor';
        const supported = (capability.chromiumAvailable && capability.webCodecs
                || hasExactDescriptorFallback)
            && capability.h264Encoder
            && capability.aacEncoder
            && capability.mp4Muxer;
        return {
            supported,
            backend: this.name,
            resolvedPlanVersion: 1,
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            reason: supported ? undefined : capability.reason ?? 'Chromium WebCodecs MP4 support is incomplete.',
        };
    }

    async render(request: HeadlessRenderBackendRequest): Promise<HeadlessRenderBackendResult> {
        throwIfAborted(request.signal);
        const resourceRequest = getBackendResourceRequest(
            request.plan,
            this.name,
            request.limits,
        );
        const lease = await this.budget.acquire(
            `${request.jobId}:${this.name}`,
            resourceRequest,
            request.signal,
        );
        let mediaSources: VerifiedRenderMediaSourceSet | null = null;
        try {
            assertResourceReservation(lease.reservation, resourceRequest);
            mediaSources = await acquireVerifiedRenderMediaSources(
                this.media,
                request.plan.sourceSnapshotId,
                request.plan.sources,
                request.limits.maxReadChunkBytes,
                request.signal,
            );
            const result = await this.worker.render({
                jobId: request.jobId,
                plan: request.plan,
                outputCapability: request.outputCapability,
                mediaSources,
                resourceReservation: lease.reservation,
                maximumReadChunkBytes: request.limits.maxReadChunkBytes,
                maximumCanvasFrames: resourceRequest['canvas-frames'] ?? 0,
                maximumDecoderSessions: resourceRequest['video-decoder-sessions'] ?? 0,
                maximumDecodedPixelBytes: resourceRequest['decoded-pixel-bytes'] ?? 0,
                maximumAudioMixBytes: resourceRequest['audio-mix-bytes'] ?? 0,
                signal: request.signal,
                onProgress: (progress) => request.onProgress?.({
                    ...progress,
                    backend: this.name,
                }),
            });
            throwIfAborted(request.signal);
            validateBackendResult(request, result);
            return {
                backend: this.name,
                warnings: result.warnings ?? [],
                sourceRangesRead: result.sourceRangesRead,
                diagnostics: result.diagnostics,
            };
        } catch (error) {
            const normalized = normalizeHeadlessRenderError(error);
            if (normalized.code === 'CODEC_UNAVAILABLE' || normalized.code === 'BACKEND_UNAVAILABLE') {
                throw new HeadlessRenderError(
                    normalized.code,
                    normalized.message,
                    true,
                    { cause: normalized },
                );
            }
            throw normalized;
        } finally {
            try {
                await mediaSources?.close();
            } finally {
                lease.release();
            }
        }
    }
}

function validateBackendResult(
    request: HeadlessRenderBackendRequest,
    result: ChromiumWebCodecsWorkerResult,
): void {
    validateDiagnostics(request, result.diagnostics);
    validateSourceRanges(request.plan, result.sourceRangesRead);
}

export function validateDiagnostics(
    request: Pick<HeadlessRenderBackendRequest, 'limits'>,
    diagnostics: HeadlessRenderBackendDiagnostics,
): void {
    const checks: Array<[number, number, string]> = [
        [diagnostics.peakDecodedPixelBytes, request.limits.maxDecodedPixelBytes, 'decoded pixels'],
        [diagnostics.peakAudioMixBytes, request.limits.maxAudioMixBytes, 'audio mix'],
        [diagnostics.peakVideoDecoderSessions, request.limits.maxVideoDecoderSessions, 'video decoders'],
        [diagnostics.canvasFrames, request.limits.maxCanvasFrames, 'canvas frames'],
    ];
    if (diagnostics.peakBackendResidentBytes !== undefined) {
        checks.push([
            diagnostics.peakBackendResidentBytes,
            request.limits.maxBackendResidentBytes ?? Number.MAX_SAFE_INTEGER,
            'backend resident memory',
        ]);
    }
    if (diagnostics.peakScratchBytes !== undefined) {
        checks.push([
            diagnostics.peakScratchBytes,
            request.limits.maxScratchBytes ?? Number.MAX_SAFE_INTEGER,
            'backend scratch',
        ]);
    }
    if (diagnostics.peakBackendProcesses !== undefined) {
        checks.push([
            diagnostics.peakBackendProcesses,
            request.limits.maxBackendProcesses,
            'backend processes',
        ]);
    }
    checks.forEach(([value, maximum, label]) => {
        if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                `The backend exceeded the ${label} resource budget.`,
            );
        }
    });
}

export function validateSourceRanges(
    plan: ResolvedRenderPlanV1,
    ranges: readonly HeadlessSourceRangeRead[],
): void {
    const sourcesById = new Map(plan.sources.map((source) => [
        `${source.kind}:${source.sourceId}`,
        source,
    ]));
    ranges.forEach((range) => {
        const source = sourcesById.get(`${range.sourceKind}:${range.sourceId}`);
        if (!source) throw new HeadlessRenderError('SOURCE_CHANGED', 'A backend read an unknown source.');
        if (!['video', 'audio'].includes(range.sourceKind)
            || !['video-seconds', 'audio-output-samples'].includes(range.kind)
            || !Number.isFinite(range.start) || !Number.isFinite(range.end)
            || range.start < 0 || range.end < range.start) {
            throw new HeadlessRenderError('RENDER_FAILED', 'A backend reported an invalid source range.');
        }
        if (range.kind === 'video-seconds'
            && (range.sourceKind !== 'video'
                || source.kind !== 'video'
                || range.end > source.duration)) {
            throw new HeadlessRenderError(
                'SOURCE_CHANGED',
                'A video read exceeded the captured source identity.',
            );
        }
        if (range.kind === 'audio-output-samples'
            && (range.sourceKind !== source.kind
                || !Number.isSafeInteger(range.start)
                || !Number.isSafeInteger(range.end)
                || range.end > plan.outputEndSample)) {
            throw new HeadlessRenderError(
                'RENDER_FAILED',
                'An audio read exceeded the resolved output boundary.',
            );
        }
    });
}
