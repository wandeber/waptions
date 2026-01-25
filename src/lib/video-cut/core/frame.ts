export interface AnalysisFrame {
    index: number;
    timeSec: number;
    width: number;
    height: number;
    rgba: Uint8ClampedArray; // Output of Canvas ImageData (4 bytes per pixel)
}
