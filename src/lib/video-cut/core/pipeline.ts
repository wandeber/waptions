import { FrameSource } from './frame-source';
import { CutDetector } from './detector';
import { ScoredBoundary, Cut } from './types';
import { PeakPicker, PeakPickerConfig } from './peak-picker';
import { AnalysisFrame } from './frame';

export interface PipelineConfig extends PeakPickerConfig {
    analysisWidth?: number;
}

export class CutDetectionPipeline {
    constructor(
        private source: FrameSource,
        private detector: CutDetector,
        private config: PipelineConfig
    ) { }

    async run(onProgress?: (progress: number) => void): Promise<Cut[]> {
        const fps = this.source.getFps();
        const duration = this.source.getDurationSec();
        const scoredBoundaries: ScoredBoundary[] = [];

        this.detector.init({
            fps,
            width: this.config.analysisWidth ?? 320,
            height: 0 // Will be determined by source/adapter
        });

        let prevFrame: AnalysisFrame | null = null;
        let processedCount = 0;
        const startTime = performance.now();

        console.log(`[CutDetection] Starting pipeline: ${duration}s, ${fps}fps`);

        for await (const currFrame of this.source.frames()) {
            if (prevFrame) {
                const { score } = this.detector.score(prevFrame, currFrame);
                scoredBoundaries.push({
                    boundaryIndex: currFrame.index,
                    timeSec: currFrame.timeSec,
                    score
                });
            }
            prevFrame = currFrame;
            processedCount++;

            if (onProgress && duration > 0) {
                onProgress(currFrame.timeSec / duration);
            }
        }

        const endTime = performance.now();
        const elapsedSec = (endTime - startTime) / 1000;
        const effectiveFps = processedCount / elapsedSec;

        console.log(`[CutDetection] Processed ${processedCount} frames in ${elapsedSec.toFixed(2)}s (${effectiveFps.toFixed(2)} fps)`);

        const picker = new PeakPicker(this.config, this.detector.id);
        const cuts = picker.pick(scoredBoundaries);

        console.log(`[CutDetection] Found ${cuts.length} cuts (candidates: ${scoredBoundaries.filter(b => b.score >= this.config.minScore).length})`);

        return cuts;
    }
}
