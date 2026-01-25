import { ScoredBoundary, Cut } from './types';

export interface PeakPickerConfig {
    minScore: number;
    localMaxWindowFrames: number;
    cooldownFrames: number;
}

export class PeakPicker {
    constructor(private config: PeakPickerConfig, private detectorId: string) { }

    pick(scores: ScoredBoundary[]): Cut[] {
        const cuts: Cut[] = [];
        const { minScore, localMaxWindowFrames, cooldownFrames } = this.config;

        for (let i = 0; i < scores.length; i++) {
            const current = scores[i];

            if (current.score < minScore) continue;

            // Search for local maximum in [i - w, i + w]
            let isLocalMax = true;
            const start = Math.max(0, i - localMaxWindowFrames);
            const end = Math.min(scores.length - 1, i + localMaxWindowFrames);

            for (let j = start; j <= end; j++) {
                if (scores[j].score > current.score) {
                    isLocalMax = false;
                    break;
                }
            }

            if (isLocalMax) {
                cuts.push({
                    frameIndex: current.boundaryIndex,
                    timeSec: current.timeSec,
                    score: current.score,
                    detectorId: this.detectorId
                });
                // Skip cooldownFrames
                i += cooldownFrames;
            }
        }

        return cuts;
    }
}
