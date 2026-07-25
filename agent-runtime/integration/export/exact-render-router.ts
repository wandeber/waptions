import type {
    HeadlessRenderBackendPort,
} from '../../render/contracts';
import type { HeadlessRenderExecutionPort } from '../../export/contracts';

/**
 * FFmpeg is the normal resolved-plan backend. Chromium is selected only when visible subtitle
 * composition requires the exact browser renderer; it is never used merely as a generic primary.
 */
export class ExactCompositionRenderRouter implements HeadlessRenderExecutionPort {
    constructor(
        private readonly ffmpeg: HeadlessRenderBackendPort,
        private readonly chromium: HeadlessRenderBackendPort,
    ) {
        if (ffmpeg.name !== 'ffmpeg' || chromium.name !== 'chromium-webcodecs') {
            throw new Error('Exact render routing requires FFmpeg and Chromium backends.');
        }
    }

    async render(request: Parameters<HeadlessRenderExecutionPort['render']>[0]) {
        const backend = request.plan.subtitleTracks.length > 0
            ? this.chromium
            : this.ffmpeg;
        const capability = await backend.probe(request.plan, request.signal);
        if (!capability.supported) {
            const { HeadlessRenderError } = await import('../../render/contracts');
            throw new HeadlessRenderError(
                'CODEC_UNAVAILABLE',
                `${backend.name} cannot render the resolved plan: ${capability.reason ?? 'unsupported'}`,
            );
        }
        return backend.render({
            jobId: request.jobId,
            plan: request.plan,
            outputCapability: request.outputCapability,
            limits: request.limits,
            signal: request.signal,
            onProgress: request.onProgress,
        });
    }
}
