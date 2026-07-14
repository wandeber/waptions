import type { Page } from '@playwright/test';

interface AudioFrequencyWindow {
  startSeconds: number;
  durationSeconds: number;
  frequenciesHz: readonly number[];
}

export interface AudioFrequencyAnalysis {
  rms: number;
  magnitudes: Record<string, number>;
}

/**
 * Decodes an exported artifact with Chromium's Web Audio codec stack and measures known tones.
 *
 * The export round trip already requires Chromium to decode the generated WebM for reimport and
 * visual sampling. Reusing that trusted browser boundary avoids executing an install-time fetched
 * media binary while still inspecting real decoded PCM rather than merely checking for a stream.
 */
export async function analyzeArtifactAudioFrequencies(
  page: Page,
  artifactBytes: readonly number[],
  windows: readonly AudioFrequencyWindow[],
): Promise<AudioFrequencyAnalysis[]> {
  return page.evaluate(async ({ encodedBytes, analysisWindows }) => {
    const audioContext = new AudioContext();
    try {
      const encodedAudio = Uint8Array.from(encodedBytes);
      const decodedAudio = await audioContext.decodeAudioData(encodedAudio.buffer);
      if (decodedAudio.length === 0 || decodedAudio.numberOfChannels === 0) {
        throw new Error('Chromium decoded no PCM samples from the exported audio stream.');
      }

      const channels = Array.from(
        { length: decodedAudio.numberOfChannels },
        (_, channelIndex) => decodedAudio.getChannelData(channelIndex),
      );
      const readMonoSample = (sampleIndex: number) => {
        let sample = 0;
        for (const channel of channels) sample += channel[sampleIndex];
        return sample / channels.length;
      };

      return analysisWindows.map((window) => {
        const firstSample = Math.round(window.startSeconds * decodedAudio.sampleRate);
        const sampleCount = Math.round(window.durationSeconds * decodedAudio.sampleRate);
        if (firstSample < 0 || sampleCount < 2 || firstSample + sampleCount > decodedAudio.length) {
          throw new Error(
            `Audio analysis window ${window.startSeconds}-${window.startSeconds + window.durationSeconds}s is out of bounds.`,
          );
        }

        let mean = 0;
        for (let index = 0; index < sampleCount; index += 1) {
          mean += readMonoSample(firstSample + index);
        }
        mean /= sampleCount;

        let squaredSum = 0;
        let hannWeightSum = 0;
        const frequencyAccumulators = window.frequenciesHz.map((frequencyHz) => ({
          frequencyHz,
          real: 0,
          imaginary: 0,
        }));
        for (let index = 0; index < sampleCount; index += 1) {
          const sample = readMonoSample(firstSample + index) - mean;
          squaredSum += sample * sample;
          // The Hann window suppresses codec-boundary leakage, and normalization keeps the
          // resulting magnitude comparable with the decoded PCM amplitude.
          const weight = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (sampleCount - 1));
          hannWeightSum += weight;
          for (const accumulator of frequencyAccumulators) {
            const angle = (2 * Math.PI * accumulator.frequencyHz * index) / decodedAudio.sampleRate;
            accumulator.real += sample * weight * Math.cos(angle);
            accumulator.imaginary -= sample * weight * Math.sin(angle);
          }
        }

        return {
          rms: Math.sqrt(squaredSum / sampleCount),
          magnitudes: Object.fromEntries(frequencyAccumulators.map((accumulator) => [
            String(accumulator.frequencyHz),
            (2 * Math.hypot(accumulator.real, accumulator.imaginary)) / hannWeightSum,
          ])),
        };
      });
    } finally {
      await audioContext.close();
    }
  }, { encodedBytes: artifactBytes, analysisWindows: windows });
}
