import { AnalysisFrame } from './frame';

export interface FrameSource {
    getFps(): number;
    getDurationSec(): number;
    frames(): AsyncIterable<AnalysisFrame>;
    close(): Promise<void>;
}
