import { useSyncExternalStore } from 'react';
import type { VideoFrameTargetResolution } from './video-runtime-types';

type ResolutionListener = () => void;

let currentResolution: VideoFrameTargetResolution | null = null;
const listeners = new Set<ResolutionListener>();

const getSnapshot = () => currentResolution;

/**
 * Publishes the actual preview backing size to warmup consumers.
 *
 * The viewport and background renderer are intentionally separate React leaves, so this tiny
 * external store prevents speculative decoding from falling back to a 1280px target before the
 * visible 640px (or smaller) editor panel has reported its measured size.
 */
export function setPreviewTargetResolution(resolution: VideoFrameTargetResolution | null): void {
    const normalized = resolution ? {
        width: Math.max(1, Math.round(resolution.width)),
        height: Math.max(1, Math.round(resolution.height)),
    } : null;
    if (currentResolution?.width === normalized?.width
        && currentResolution?.height === normalized?.height) return;
    currentResolution = normalized;
    Array.from(listeners).forEach((listener) => listener());
}

export function getPreviewTargetResolution(): VideoFrameTargetResolution | null {
    return getSnapshot();
}

export function usePreviewTargetResolution(): VideoFrameTargetResolution | null {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot,
        getSnapshot,
    );
}
