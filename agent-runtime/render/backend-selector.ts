import {
    HeadlessRenderError,
    normalizeHeadlessRenderError,
    throwIfAborted,
    type HeadlessBackendSelectionRequest,
    type HeadlessRenderBackendPort,
    type HeadlessRenderBackendResult,
} from './contracts';

export class BoundedHeadlessRenderBackendSelector {
    constructor(
        private readonly primary: HeadlessRenderBackendPort,
        private readonly fallback: HeadlessRenderBackendPort,
    ) {
        if (primary.name !== 'chromium-webcodecs' || fallback.name !== 'ffmpeg') {
            throw new Error('Headless render backend order must be Chromium then FFmpeg.');
        }
    }

    async render(request: HeadlessBackendSelectionRequest): Promise<HeadlessRenderBackendResult> {
        throwIfAborted(request.signal);
        const primaryCapability = await this.primary.probe(request.plan, request.signal);
        throwIfAborted(request.signal);
        if (primaryCapability.supported) {
            try {
                return await this.primary.render(request);
            } catch (error) {
                const normalized = normalizeHeadlessRenderError(error);
                if (!normalized.retryableWithFallback) throw normalized;
                throwIfAborted(request.signal);
                await request.resetOutputForFallback();
                return this.renderFallback(
                    request,
                    `Chromium fallback: ${normalized.message}`,
                );
            }
        }
        return this.renderFallback(
            request,
            `Chromium unavailable: ${primaryCapability.reason ?? 'unknown capability failure'}`,
        );
    }

    private async renderFallback(
        request: HeadlessBackendSelectionRequest,
        warning: string,
    ): Promise<HeadlessRenderBackendResult> {
        throwIfAborted(request.signal);
        const capability = await this.fallback.probe(request.plan, request.signal);
        throwIfAborted(request.signal);
        if (!capability.supported) {
            throw new HeadlessRenderError(
                'CODEC_UNAVAILABLE',
                `No H.264/AAC MP4 backend is available. ${capability.reason ?? ''}`.trim(),
            );
        }
        const result = await this.fallback.render(request);
        return {
            ...result,
            warnings: [warning, ...result.warnings],
        };
    }
}
