export interface ContainRectangle {
    x: number;
    y: number;
    width: number;
    height: number;
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
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
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
