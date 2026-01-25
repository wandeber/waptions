import { AnalysisFrame } from './frame';

export interface DetectorScore {
    score: number;
    detectorId: string;
}

export interface CutDetector {
    id: string;
    init(params: { fps: number; width: number; height: number }): void;
    score(prev: AnalysisFrame, curr: AnalysisFrame): DetectorScore;
}
