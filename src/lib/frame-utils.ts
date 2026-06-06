const DEFAULT_FPS = 30;

export function normalizeFps(fps?: number | null): number {
    return typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
}

export function timeToFrameIndex(time: number, fps?: number | null): number {
    const normalizedFps = normalizeFps(fps);
    const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    return Math.round(safeTime * normalizedFps);
}

export function frameIndexToTime(frameIndex: number, fps?: number | null): number {
    const normalizedFps = normalizeFps(fps);
    const safeIndex = Number.isFinite(frameIndex) ? Math.max(0, Math.round(frameIndex)) : 0;
    return safeIndex / normalizedFps;
}

export function frameDuration(fps?: number | null): number {
    return 1 / normalizeFps(fps);
}
