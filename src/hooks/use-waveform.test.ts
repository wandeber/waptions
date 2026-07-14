import { describe, expect, it } from 'vitest';
import type { AudioSourceAsset } from '@/types/video';
import type { AudioMediaAsset } from '@/lib/media-asset-ref';
import type { WaveformPeaks } from '@/lib/video-waveform';
import {
    loadRequestedWaveforms,
    type WaveformRepositoryReader,
} from './use-waveform';

const media = (id: string): AudioMediaAsset => ({
    kind: 'audio-source',
    asset: {
        id,
        originalName: `${id}.wav`,
        mimeType: 'audio/wav',
        size: 1,
        lastModified: 1,
        fingerprint: `${id}-fingerprint`,
        duration: 1,
        nativeSampleRate: 48_000,
        nativeSampleCount: 48_000,
        nativeChannelCount: 1,
        bitrate: null,
        codec: null,
        file: new File([id], `${id}.wav`),
    } satisfies AudioSourceAsset,
});

const peaks = (value: number): WaveformPeaks => ({
    duration: 1,
    sampleRate: 48_000,
    bucketCount: 1_000,
    min: new Float32Array(1_000).fill(-value),
    max: new Float32Array(1_000).fill(value),
});

describe('loadRequestedWaveforms', () => {
    it('publishes an immediate repository snapshot without starting a request', async () => {
        const source = media('cached');
        const cached = peaks(0.4);
        let requests = 0;
        const repository: WaveformRepositoryReader = {
            peek: () => cached,
            request: async () => {
                requests += 1;
                return cached;
            },
        };
        const snapshots: ReadonlyMap<string, WaveformPeaks>[] = [];

        await loadRequestedWaveforms({
            repository,
            projectMedia: [source],
            requestedMedia: [],
            signal: new AbortController().signal,
            onSnapshot: (snapshot) => snapshots.push(snapshot),
            onError: () => undefined,
        });

        expect(requests).toBe(0);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].get('audio-source:cached')).toBe(cached);
    });

    it('rejects late progress and completion after a project generation aborts', async () => {
        const source = media('old-project');
        let progress: ((value: WaveformPeaks) => void) | undefined;
        let resolveRequest: (value: WaveformPeaks | null) => void = () => undefined;
        const repository: WaveformRepositoryReader = {
            peek: () => null,
            request: (_media, options) => {
                progress = options?.onProgress;
                return new Promise((resolve) => {
                    resolveRequest = resolve;
                });
            },
        };
        const controller = new AbortController();
        const snapshots: ReadonlyMap<string, WaveformPeaks>[] = [];
        const loading = loadRequestedWaveforms({
            repository,
            projectMedia: [source],
            requestedMedia: [source],
            signal: controller.signal,
            onSnapshot: (snapshot) => snapshots.push(snapshot),
            onError: () => undefined,
        });
        expect(snapshots).toHaveLength(1);

        controller.abort();
        progress?.(peaks(0.2));
        resolveRequest(peaks(1));
        await loading;

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].size).toBe(0);
    });

    it('publishes progressive peaks before replacing them with the repository result', async () => {
        const source = media('progress');
        const partial = peaks(0.2);
        const complete = peaks(0.8);
        let stored: WaveformPeaks | null = null;
        const repository: WaveformRepositoryReader = {
            peek: () => stored,
            request: async (_media, options) => {
                options?.onProgress?.(partial);
                stored = complete;
                return complete;
            },
        };
        const values: Array<WaveformPeaks | undefined> = [];

        await loadRequestedWaveforms({
            repository,
            projectMedia: [source],
            requestedMedia: [source],
            signal: new AbortController().signal,
            onSnapshot: (snapshot) => values.push(snapshot.get('audio-source:progress')),
            onError: () => undefined,
        });

        expect(values).toEqual([undefined, partial, complete]);
    });
});
