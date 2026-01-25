import { CutDetector, DetectorScore } from '../core/detector';
import { AnalysisFrame } from '../core/frame';

export interface HistogramHsvConfig {
    binsH: number;
    binsS: number;
    binsV: number;
    gridSize: number; // e.g. 3 for 3x3
}

export class HistogramHsvDetector implements CutDetector {
    id = 'histogram-hsv-grid';
    private config: HistogramHsvConfig;
    private prevHistograms: Float32Array[] | null = null;

    constructor(config?: Partial<HistogramHsvConfig>) {
        this.config = {
            binsH: config?.binsH ?? 16, // Reduced bins count because we have multiple histograms
            binsS: config?.binsS ?? 8,
            binsV: config?.binsV ?? 8,
            gridSize: config?.gridSize ?? 3
        };
    }

    init(): void {
        this.prevHistograms = null;
    }

    score(prev: AnalysisFrame, curr: AnalysisFrame): DetectorScore {
        const h1 = this.prevHistograms || this.calculateGridHistograms(prev);
        const h2 = this.calculateGridHistograms(curr);

        this.prevHistograms = h2;

        let totalDistance = 0;
        for (let i = 0; i < h1.length; i++) {
            totalDistance += this.calculateBhattacharyya(h1[i], h2[i]);
        }

        const averageDistance = totalDistance / h1.length;

        return {
            score: averageDistance,
            detectorId: this.id
        };
    }

    private calculateGridHistograms(frame: AnalysisFrame): Float32Array[] {
        const { rgba, width, height } = frame;
        const { binsH, binsS, binsV, gridSize } = this.config;
        const histSize = binsH * binsS * binsV;

        const histograms: Float32Array[] = Array.from({ length: gridSize * gridSize }, () => new Float32Array(histSize));
        const cellWidth = width / gridSize;
        const cellHeight = height / gridSize;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixelIdx = (y * width + x) * 4;
                const r = rgba[pixelIdx] / 255;
                const g = rgba[pixelIdx + 1] / 255;
                const b = rgba[pixelIdx + 2] / 255;

                const [h, s, v] = this.rgbToHsv(r, g, b);

                const hBin = Math.min(binsH - 1, Math.floor((h / 360) * binsH));
                const sBin = Math.min(binsS - 1, Math.floor(s * binsS));
                const vBin = Math.min(binsV - 1, Math.floor(v * binsV));

                const gridX = Math.min(gridSize - 1, Math.floor(x / cellWidth));
                const gridY = Math.min(gridSize - 1, Math.floor(y / cellHeight));
                const gridIdx = gridY * gridSize + gridX;

                const histIdx = hBin + binsH * (sBin + binsS * vBin);
                histograms[gridIdx][histIdx]++;
            }
        }

        // Normalize each histogram
        for (let i = 0; i < histograms.length; i++) {
            const hist = histograms[i];
            const pixelsInCell = (width / gridSize) * (height / gridSize);
            for (let j = 0; j < hist.length; j++) {
                hist[j] /= pixelsInCell;
            }
        }

        return histograms;
    }

    private rgbToHsv(r: number, g: number, b: number): [number, number, number] {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const diff = max - min;
        let h = 0;
        const s = max === 0 ? 0 : diff / max;
        const v = max;

        if (diff !== 0) {
            if (max === r) {
                h = 60 * ((g - b) / diff + (g < b ? 6 : 0));
            } else if (max === g) {
                h = 60 * ((b - r) / diff + 2);
            } else {
                h = 60 * ((r - g) / diff + 4);
            }
        }

        return [h, s, v];
    }

    private calculateBhattacharyya(h1: Float32Array, h2: Float32Array): number {
        let bc = 0;
        for (let i = 0; i < h1.length; i++) {
            bc += Math.sqrt(h1[i] * h2[i]);
        }
        return Math.sqrt(Math.max(0, 1 - bc));
    }
}
