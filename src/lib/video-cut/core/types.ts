export interface Cut {
    frameIndex: number;
    timeSec: number;
    score: number;
    detectorId: string;
}

export interface ScoredBoundary {
    boundaryIndex: number; // Frontiera prev -> curr, normalmente igual a curr.index
    timeSec: number;
    score: number;
}
