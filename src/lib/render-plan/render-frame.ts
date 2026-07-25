import type { ResolvedRenderPlanV1 } from './render-plan';
import { resolveRenderPlanVideoFrame } from './render-plan';
import { framesToSeconds } from '../render-profile';
import { renderSubtitles } from '../subtitle-renderer';
import { drawContainedVideoFrame } from '../video-compositor';

export interface DecodedResolvedVideoFrame {
    sourceId: string;
    image: CanvasImageSource;
}

/**
 * Shared Chromium composition entry point for preview/export parity.
 *
 * A decoded frame is optional for gaps or decode exhaustion. Filling first preserves the durable
 * V4 background across gaps and audio/subtitle tails; subtitle tracks are visibility-resolved.
 */
export function renderResolvedPlanFrame(
    context: CanvasRenderingContext2D,
    plan: ResolvedRenderPlanV1,
    frameIndex: number,
    decodedFrame: DecodedResolvedVideoFrame | null,
): void {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= plan.contentEndFrame) {
        throw new RangeError('Resolved render frame index is outside the output boundary.');
    }
    const request = resolveRenderPlanVideoFrame(plan, frameIndex);
    context.fillStyle = plan.backgroundColor;
    context.fillRect(0, 0, plan.renderProfile.width, plan.renderProfile.height);
    if (request && decodedFrame) {
        if (decodedFrame.sourceId !== request.sourceId) {
            throw new Error('Decoded frame source does not match the resolved render plan.');
        }
        drawContainedVideoFrame(
            context,
            decodedFrame.image,
            request.sourceWidth,
            request.sourceHeight,
            plan.renderProfile.width,
            plan.renderProfile.height,
        );
    }
    const projectTime = framesToSeconds(frameIndex, plan.renderProfile.fps);
    plan.subtitleTracks.forEach((track) => renderSubtitles(
        context,
        track.subtitles,
        track.style,
        projectTime,
        plan.renderProfile.width,
        plan.renderProfile.height,
    ));
}
