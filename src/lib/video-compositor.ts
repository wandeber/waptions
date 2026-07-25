export interface ContainRectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}

type VideoCompositorContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Paints the deterministic visual value for project gaps and media tails. */
export function clearVideoFrameToBlack(
    context: VideoCompositorContext,
    targetWidth: number,
    targetHeight: number,
    backgroundColor = '#000000',
): void {
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, Math.max(1, targetWidth), Math.max(1, targetHeight));
}

export function getContainRectangle(
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number,
): ContainRectangle {
    const safeSourceWidth = Math.max(1, sourceWidth);
    const safeSourceHeight = Math.max(1, sourceHeight);
    const safeTargetWidth = Math.max(1, targetWidth);
    const safeTargetHeight = Math.max(1, targetHeight);
    const sourceRatio = safeSourceWidth / safeSourceHeight;
    const targetRatio = safeTargetWidth / safeTargetHeight;
    // Anchor one dimension to the exact target edge instead of multiplying both by a floating
    // scale. Besides being clearer, this avoids tiny negative offsets at equal aspect ratios.
    const width = sourceRatio >= targetRatio ? safeTargetWidth : safeTargetHeight * sourceRatio;
    const height = sourceRatio >= targetRatio ? safeTargetWidth / sourceRatio : safeTargetHeight;
    return {
        x: (safeTargetWidth - width) / 2,
        y: (safeTargetHeight - height) / 2,
        width,
        height,
    };
}

/**
 * Shared preview/export contain operation. Decoders preserve the source aspect ratio; only this
 * compositor decides letterboxing, preventing a sink-level contain followed by a second contain.
 */
export function drawContainedVideoFrame(
    context: VideoCompositorContext,
    frame: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number,
): ContainRectangle {
    const rectangle = getContainRectangle(
        sourceWidth,
        sourceHeight,
        targetWidth,
        targetHeight,
    );
    context.drawImage(frame, rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    return rectangle;
}

/**
 * Paints one complete output frame.
 *
 * Clearing happens before the optional draw so a null winning V4 placement, a shorter source, or
 * an audio/subtitle tail can never expose pixels retained from the previous project frame.
 */
export function drawContainedVideoFrameOrBlack(
    context: VideoCompositorContext,
    frame: CanvasImageSource | null,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number,
    backgroundColor = '#000000',
): ContainRectangle | null {
    clearVideoFrameToBlack(context, targetWidth, targetHeight, backgroundColor);
    return frame
        ? drawContainedVideoFrame(
            context,
            frame,
            sourceWidth,
            sourceHeight,
            targetWidth,
            targetHeight,
        )
        : null;
}
