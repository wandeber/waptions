import type {
    HeadlessRenderBackendName,
    HeadlessRenderBackendProgress,
} from './contracts';

export type HeadlessExportProgressStage =
    | 'planning'
    | 'video'
    | 'audio'
    | 'muxing'
    | 'verifying'
    | 'committing'
    | 'completed';

export interface HeadlessExportProgressUpdate {
    sequence: number;
    stage: HeadlessExportProgressStage;
    fraction: number;
    backend?: HeadlessRenderBackendName;
    completedUnits?: number;
    totalUnits?: number;
}

const STAGE_RANGES: Readonly<Record<
    HeadlessExportProgressStage,
    readonly [number, number]
>> = {
    planning: [0, 0.03],
    video: [0.03, 0.72],
    audio: [0.72, 0.9],
    muxing: [0.9, 0.96],
    verifying: [0.96, 0.99],
    committing: [0.99, 0.999],
    completed: [1, 1],
};

export interface HeadlessExportProgressReporter {
    reportStage(stage: 'planning' | 'verifying' | 'committing' | 'completed', ratio?: number): void;
    reportBackend(backend: HeadlessRenderBackendName, progress: HeadlessRenderBackendProgress): void;
    current(): HeadlessExportProgressUpdate;
}

/** Produces finite, monotonic, sequence-numbered progress across retries and backend fallback. */
export function createHeadlessExportProgressReporter(
    onProgress?: (progress: HeadlessExportProgressUpdate) => void,
): HeadlessExportProgressReporter {
    let sequence = 0;
    let lastFraction = 0;
    let last: HeadlessExportProgressUpdate = {
        sequence,
        stage: 'planning',
        fraction: 0,
    };

    const publish = (
        stage: HeadlessExportProgressStage,
        ratio: number,
        details: Partial<HeadlessExportProgressUpdate> = {},
    ): void => {
        const [start, end] = STAGE_RANGES[stage];
        const boundedRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
        const fraction = Math.max(lastFraction, start + (end - start) * boundedRatio);
        const next: HeadlessExportProgressUpdate = {
            sequence: ++sequence,
            stage,
            fraction,
            ...details,
        };
        lastFraction = fraction;
        last = next;
        onProgress?.(next);
    };

    return {
        reportStage(stage, ratio = 1) {
            publish(stage, ratio);
        },
        reportBackend(backend, progress) {
            const totalUnits = Number.isFinite(progress.totalUnits) && progress.totalUnits > 0
                ? progress.totalUnits
                : 1;
            const completedUnits = Number.isFinite(progress.completedUnits)
                ? Math.min(totalUnits, Math.max(0, progress.completedUnits))
                : 0;
            publish(
                progress.stage,
                completedUnits / totalUnits,
                {
                    backend,
                    completedUnits,
                    totalUnits,
                },
            );
        },
        current: () => last,
    };
}
