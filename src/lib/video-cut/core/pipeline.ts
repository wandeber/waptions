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

            if (onProgress && duration > 0) {
                onProgress(currFrame.timeSec / duration);
            }
        }

        const picker = new PeakPicker(this.config, this.detector.id);
        const cuts = picker.pick(scoredBoundaries);

        return cuts;
    }
}
