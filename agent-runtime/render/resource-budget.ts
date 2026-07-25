import type { ResolvedRenderPlanV1 } from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    type HeadlessRenderBackendName,
    type HeadlessRenderLimitsV1,
    type HeadlessRenderResourceRequest,
    type HeadlessRenderResourceReservation,
    type HeadlessRenderResourceKind,
} from './contracts';

/**
 * Calculates the reservation submitted to the injected process-wide decoded-memory authority.
 *
 * No budget manager is instantiated in this package. Preview, review, Chromium, and FFmpeg must
 * all inject the same coordinator-owned authority so two individually valid pools cannot exceed
 * the global cap together.
 */
export function getBackendResourceRequest(
    plan: ResolvedRenderPlanV1,
    backend: HeadlessRenderBackendName,
    limits: HeadlessRenderLimitsV1,
): HeadlessRenderResourceRequest {
    const canvasFrames = Math.min(2, limits.maxCanvasFrames);
    const decoderSessions = Math.min(
        backend === 'chromium-webcodecs' ? 2 : 1,
        limits.maxVideoDecoderSessions,
    );
    const outputFrameBytes = checkedMultiply(
        plan.renderProfile.width,
        plan.renderProfile.height,
        4,
    );
    const maximumSourceFrameBytes = plan.videoSegments.reduce(
        (maximum, segment) => segment.kind === 'video'
            ? Math.max(
                    maximum,
                    checkedMultiply(segment.sourceWidth, segment.sourceHeight, 4),
                )
            : maximum,
        0,
    );
    const decodedPixelBytes = checkedAdd(
        checkedMultiply(outputFrameBytes, canvasFrames),
        checkedMultiply(maximumSourceFrameBytes, decoderSessions),
    );
    if (decodedPixelBytes > limits.maxDecodedPixelBytes) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The configured decoded-pixel limit cannot hold the bounded render canvas pool.',
        );
    }
    return {
        'audio-mix-bytes': Math.min(
            32 * 1024 * 1024,
            limits.maxAudioMixBytes,
        ),
        'backend-processes': 1,
        'canvas-frames': canvasFrames,
        'decoded-pixel-bytes': decodedPixelBytes,
        'export-jobs': 1,
        'video-decoder-sessions': decoderSessions,
    };
}

export function assertResourceReservation(
    reservation: HeadlessRenderResourceReservation,
    request: HeadlessRenderResourceRequest,
): void {
    const kinds: HeadlessRenderResourceKind[] = [
        'audio-mix-bytes',
        'backend-processes',
        'canvas-frames',
        'decoded-pixel-bytes',
        'export-jobs',
        'video-decoder-sessions',
    ];
    if (reservation.authority !== 'process-wide-decoded-memory-v1'
        || !/^[A-Za-z0-9:_-]{1,256}$/.test(reservation.reservationId)
        || kinds.some((kind) => reservation.granted[kind] !== (request[kind] ?? 0))) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The process-wide resource authority returned an invalid reservation.',
        );
    }
}

function checkedMultiply(...values: number[]): number {
    const result = values.reduce((product, value) => product * value, 1);
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The render frame allocation does not fit in a safe integer.',
        );
    }
    return result;
}

function checkedAdd(...values: number[]): number {
    const result = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The render memory reservation does not fit in a safe integer.',
        );
    }
    return result;
}
