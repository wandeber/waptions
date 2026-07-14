import { describe, expect, it } from 'vitest';
import type { AudioSourceAsset } from '@/types/video';
import {
    getWaveformRepositoryKey,
    type AudioMediaAsset,
    type WaveformRepositoryKey,
} from '@/lib/media-asset-ref';
import type { WaveformPersistentCache } from '@/lib/storage/waveform-cache';
import {
    getWaveformBucketCount,
    type WaveformPeaks,
} from '@/lib/video-waveform';
import {
    createLegacySourceUpgradeFingerprint,
    createVideoSourceFingerprint,
} from '@/lib/video-timeline';
import {
    WaveformRepository,
    type WaveformRepositoryExtractor,
} from './waveform-repository';

const source = (
    id: string,
    fingerprint = `v2_0123456789abcdef_${id}`,
    file = new File([id], `${id}.wav`, { type: 'audio/wav' }),
): AudioMediaAsset => ({
    kind: 'audio-source',
    asset: {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint,
        duration: 1,
        nativeSampleRate: 48_000,
        nativeSampleCount: 48_000,
        nativeChannelCount: 1,
        bitrate: null,
        codec: null,
        file,
    } satisfies AudioSourceAsset,
});

const peaks = (value: number): WaveformPeaks => ({
    duration: 1,
    sampleRate: 48_000,
    bucketCount: 1_000,
    min: new Float32Array(1_000).fill(-value),
    max: new Float32Array(1_000).fill(value),
});

class MemoryPersistentCache implements WaveformPersistentCache {
    readonly values = new Map<WaveformRepositoryKey, WaveformPeaks>();
    gets = 0;
    puts = 0;

    async get(key: WaveformRepositoryKey): Promise<WaveformPeaks | null> {
        this.gets += 1;
        return this.values.get(key) ?? null;
    }

    async put(key: WaveformRepositoryKey, value: WaveformPeaks): Promise<void> {
        this.puts += 1;
        this.values.set(key, value);
    }
}

interface DeferredExtraction {
    extractor: WaveformRepositoryExtractor;
    starts: number;
    signal: AbortSignal | null;
    progress: ((peaks: WaveformPeaks) => void) | null;
    resolve: (peaks: WaveformPeaks | null) => void;
}

function deferredExtraction(): DeferredExtraction {
    let resolvePromise: (peaks: WaveformPeaks | null) => void = () => undefined;
    const state: DeferredExtraction = {
        starts: 0,
        signal: null,
        progress: null,
        resolve: (value) => resolvePromise(value),
        extractor: async (_file, _duration, signal, onProgress) => {
            state.starts += 1;
            state.signal = signal;
            state.progress = onProgress;
            return new Promise((resolve) => {
                resolvePromise = resolve;
            });
        },
    };
    return state;
}

describe('WaveformRepository', () => {
    it('serves a repeated request from memory without another lookup or decoder', async () => {
        const persistent = new MemoryPersistentCache();
        let decoderStarts = 0;
        const repository = new WaveformRepository({
            persistentCache: persistent,
            extract: async () => {
                decoderStarts += 1;
                return peaks(0.3);
            },
        });
        const media = source('memory');

        const first = await repository.request(media);
        const second = await repository.request(media);

        expect(second).toBe(first);
        expect(persistent.gets).toBe(1);
        expect(decoderStarts).toBe(1);
    });

    it('resolves subscribers before a slow persistent write and clears in-flight state', async () => {
        let putStarted = 0;
        const persistent: WaveformPersistentCache = {
            get: async () => null,
            put: async () => {
                putStarted += 1;
                await new Promise<void>(() => undefined);
            },
        };
        const controller = new AbortController();
        const repository = new WaveformRepository({
            persistentCache: persistent,
            extract: async () => peaks(0.45),
        });

        await expect(repository.request(source('slow-write'), {
            signal: controller.signal,
        })).resolves.toEqual(peaks(0.45));

        expect(putStarted).toBe(1);
        expect(repository.getDebugState().inFlight).toBe(0);
        expect(controller.signal.aborted).toBe(false);
    });

    it('observes a rejected background write without rejecting decoded subscribers', async () => {
        const repository = new WaveformRepository({
            persistentCache: {
                get: async () => null,
                put: async () => {
                    throw new DOMException('Synthetic quota failure.', 'QuotaExceededError');
                },
            },
            extract: async () => peaks(0.55),
        });

        await expect(repository.request(source('rejected-write'))).resolves.toEqual(peaks(0.55));
        await Promise.resolve();
        expect(repository.getDebugState().inFlight).toBe(0);
    });

    it('uses a persistent hit on startup without starting a decoder', async () => {
        const persistent = new MemoryPersistentCache();
        let decoderStarts = 0;
        const repository = new WaveformRepository({
            persistentCache: persistent,
            extract: async () => {
                decoderStarts += 1;
                return peaks(1);
            },
        });
        const media = source('persistent');
        const stored = peaks(0.4);
        persistent.values.set(repository.getKey(media), stored);

        await expect(repository.request(media)).resolves.toBe(stored);
        expect(decoderStarts).toBe(0);
        expect(repository.peek(media)).toBe(stored);
    });

    it('reloads a decoded persistent entry without starting a second decoder', async () => {
        const persistent = new MemoryPersistentCache();
        const media = source('reload');
        let firstDecoderStarts = 0;
        const firstRepository = new WaveformRepository({
            persistentCache: persistent,
            extract: async () => {
                firstDecoderStarts += 1;
                return peaks(0.6);
            },
        });
        await firstRepository.request(media);
        await new Promise((resolve) => setTimeout(resolve, 0));

        let reloadedDecoderStarts = 0;
        const reloadedRepository = new WaveformRepository({
            persistentCache: persistent,
            extract: async () => {
                reloadedDecoderStarts += 1;
                return peaks(1);
            },
        });
        const reloaded = await reloadedRepository.request(media);

        expect(firstDecoderStarts).toBe(1);
        expect(reloadedDecoderStarts).toBe(0);
        expect(reloaded?.max[0]).toBeCloseTo(0.6);
    });

    it('isolates upgraded legacy blobs and reuses only the same project/source after reload', async () => {
        const persistent = new MemoryPersistentCache();
        const firstFile = new File(['aaaa'], 'same.wav', { type: 'audio/wav', lastModified: 7 });
        const secondFile = new File(['bbbb'], 'same.wav', { type: 'audio/wav', lastModified: 7 });
        const firstMedia = source(
            'same-source',
            createLegacySourceUpgradeFingerprint(firstFile, {
                projectId: 'project-a',
                kind: 'audio-source',
                sourceId: 'same-source',
            }),
            firstFile,
        );
        const replacementMedia = source(
            'same-source',
            createLegacySourceUpgradeFingerprint(secondFile, {
                projectId: 'project-b',
                kind: 'audio-source',
                sourceId: 'same-source',
            }),
            secondFile,
        );
        let decoderStarts = 0;
        const repository = new WaveformRepository({
            persistentCache: persistent,
            extract: async (file) => {
                decoderStarts += 1;
                return peaks(file === firstFile ? 0.25 : 0.75);
            },
        });

        const first = await repository.request(firstMedia);
        const replacement = await repository.request(replacementMedia);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(first?.max[0]).toBeCloseTo(0.25);
        expect(replacement?.max[0]).toBeCloseTo(0.75);
        expect(decoderStarts).toBe(2);
        expect(repository.getKey(firstMedia)).not.toBe(repository.getKey(replacementMedia));

        const reloadedFile = new File(['aaaa'], 'same.wav', {
            type: 'audio/wav',
            lastModified: 7,
        });
        const reloadedMedia = source('same-source', firstMedia.asset.fingerprint, reloadedFile);
        const reloadedRepository = new WaveformRepository({
            persistentCache: persistent,
            extract: async () => {
                throw new Error('Persistent reload must not start a decoder.');
            },
        });
        await expect(reloadedRepository.request(reloadedMedia)).resolves.toBe(first);
    });

    it('never reads metadata-only legacy waveform entries from the old algorithm cache', async () => {
        const persistent = new MemoryPersistentCache();
        const legacyFile = new File(['old!'], 'legacy.wav', {
            type: 'audio/wav',
            lastModified: 3,
        });
        const legacyFingerprint = createVideoSourceFingerprint(legacyFile);
        const media = source('legacy', legacyFingerprint, legacyFile);
        const oldKey = getWaveformRepositoryKey(
            media,
            2,
            getWaveformBucketCount(media.asset.duration),
        );
        persistent.values.set(oldKey, peaks(0.1));
        const repository = new WaveformRepository({
            persistentCache: persistent,
            legacyIdentityFactory: () => 'legacy-session-a',
            extract: async () => peaks(0.9),
        });

        const result = await repository.request(media);

        expect(result?.max[0]).toBeCloseTo(0.9);
        expect(repository.getKey(media)).not.toBe(oldKey);
        expect(persistent.gets).toBe(0);
        expect(persistent.puts).toBe(0);
    });

    it('deduplicates lookup and extraction across concurrent subscribers', async () => {
        const extraction = deferredExtraction();
        const persistent = new MemoryPersistentCache();
        const repository = new WaveformRepository({ persistentCache: persistent, extract: extraction.extractor });
        const media = source('shared', 'v2_0123456789abcdef_shared-import');

        const first = repository.request(media);
        const second = repository.request(source(
            'other-id',
            'v2_0123456789abcdef_shared-import',
        ));
        await Promise.resolve();
        expect(persistent.gets).toBe(1);
        expect(extraction.starts).toBe(1);

        const result = peaks(0.8);
        extraction.resolve(result);
        await expect(Promise.all([first, second])).resolves.toEqual([result, result]);
        expect(persistent.puts).toBe(1);
    });

    it('keeps shared work alive until its final subscriber aborts', async () => {
        const extraction = deferredExtraction();
        const repository = new WaveformRepository({
            persistentCache: new MemoryPersistentCache(),
            extract: extraction.extractor,
        });
        const media = source('abort');
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = repository.request(media, { signal: firstController.signal });
        const second = repository.request(media, { signal: secondController.signal });
        await Promise.resolve();

        firstController.abort();
        await expect(first).resolves.toBeNull();
        expect(extraction.signal?.aborted).toBe(false);

        secondController.abort();
        await expect(second).resolves.toBeNull();
        expect(extraction.signal?.aborted).toBe(true);
        expect(repository.getDebugState().inFlight).toBe(0);
        extraction.resolve(null);
    });

    it('fans progressive snapshots out only to active subscribers', async () => {
        const extraction = deferredExtraction();
        const repository = new WaveformRepository({
            persistentCache: new MemoryPersistentCache(),
            extract: extraction.extractor,
        });
        const media = source('progress');
        const cancelled = new AbortController();
        const activeProgress: WaveformPeaks[] = [];
        const cancelledProgress: WaveformPeaks[] = [];
        const active = repository.request(media, { onProgress: (value) => activeProgress.push(value) });
        const leaving = repository.request(media, {
            signal: cancelled.signal,
            onProgress: (value) => cancelledProgress.push(value),
        });
        await Promise.resolve();
        cancelled.abort();
        await leaving;

        const partial = peaks(0.2);
        extraction.progress?.(partial);
        expect(activeProgress).toEqual([partial]);
        expect(cancelledProgress).toEqual([]);

        const complete = peaks(1);
        extraction.resolve(complete);
        await expect(active).resolves.toBe(complete);
    });

    it('enforces a strict memory LRU and includes fingerprint changes in invalidation', async () => {
        const repository = new WaveformRepository({
            memoryMaxBytes: 16_000,
            persistentCache: new MemoryPersistentCache(),
            extract: async (_file) => peaks(_file.name === 'a.wav' ? 0.1 : 0.5),
        });
        const first = source('a');
        const second = source('b');
        const third = source('c');
        await repository.request(first);
        await repository.request(second);
        expect(repository.peek(first)).not.toBeNull();
        await repository.request(third);

        expect(repository.getDebugState()).toEqual({
            memoryBytes: 16_000,
            memoryEntries: 2,
            inFlight: 0,
        });
        expect(repository.peek(first)).not.toBeNull();
        expect(repository.peek(second)).toBeNull();
        expect(repository.peek(third)).not.toBeNull();
        expect(repository.getKey(first)).toContain(':v3:r1000');
        expect(repository.getKey(source('a', 'changed-fingerprint'))).not.toBe(repository.getKey(first));
    });
});
