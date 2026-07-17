import { describe, expect, it, vi } from 'vitest';
import type { AudioMixContributor } from './audio-mix-plan';
import {
    MAX_RETAINED_AUDIO_PCM_SAMPLES,
    MAX_RETAINED_AUDIO_SESSIONS,
    MediabunnyAudioDecoder,
    SequentialMediabunnyAudioReader,
    type MediabunnyDecodedSample,
} from './mediabunny-audio-decoder';
import {
    buildSanitizedAudioWindowPlan,
    materializeSanitizedAudioWindowRange,
} from './audio-sample-window';
import type { EditorDocumentV3 } from '@/types/video';

function makeFile(name: string): File {
    return new File(['media'], name, { type: 'application/octet-stream' });
}

function makeDocument(sampleCount = 12): EditorDocumentV3 {
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 }, width: 1920, height: 1080,
            audioSampleRate: 48_000, isFrameRateLocked: true, isCanvasSizeLocked: true,
        },
        subtitleTracks: [],
        videoSources: [{
            id: 'video', originalName: 'video.mp4', mimeType: 'video/mp4', size: 5,
            lastModified: 1, fingerprint: 'video-fingerprint', duration: sampleCount / 48_000,
            fps: 30, width: 1920, height: 1080, bitrate: null, hasAudio: true,
            file: makeFile('video.mp4'),
        }],
        videoClips: [],
        videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: [] }],
        audioSources: [{
            id: 'audio', originalName: 'audio.wav', mimeType: 'audio/wav', size: 5,
            lastModified: 1, fingerprint: 'audio-fingerprint', duration: sampleCount / 48_000,
            nativeSampleRate: 48_000, nativeSampleCount: sampleCount, nativeChannelCount: 1,
            bitrate: null, codec: 'pcm-s16', file: makeFile('audio.wav'),
        }],
        audioTracks: [], activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' }, transcriptionByTrackId: {},
    };
}

function makeSample(timestamp: number, values: number[][]): MediabunnyDecodedSample {
    return {
        timestamp,
        duration: values[0].length / 48_000,
        sampleRate: 48_000,
        numberOfFrames: values[0].length,
        numberOfChannels: values.length,
        copyTo(destination, options) {
            destination.set(values[options.planeIndex]);
        },
        close: vi.fn(),
    };
}

function makeContributor(
    source: AudioMixContributor['source'],
    totalSamples = 6,
): AudioMixContributor {
    return {
        id: 'contributor',
        kind: source.kind === 'audio-source' ? 'independent-audio' : 'embedded-video',
        trackId: source.kind === 'audio-source' ? 'track' : null,
        source,
        outputStartSample: 0,
        outputEndSample: totalSamples,
        sourceRange: {
            domain: 'seconds', startSeconds: 0, endSeconds: totalSamples / 48_000,
        },
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gainLinear: 1,
    };
}

function makeSession(
    samples: MediabunnyDecodedSample[] = [],
) {
    return {
        sampleRate: 48_000,
        channelCount: 1,
        codec: 'aac',
        samples: vi.fn((startSeconds: number, endSeconds: number) => {
            void startSeconds;
            void endSeconds;
            return (async function* () { for (const sample of samples) yield sample; })();
        }),
        dispose: vi.fn(() => undefined),
    };
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('MediabunnyAudioDecoder session cache', () => {
    it('preserves timestamp gaps, closes samples, and retains the source session for reuse', async () => {
        const first = makeSample(0, [[1, 2]]);
        const second = makeSample(4 / 48_000, [[3, 4]]);
        const session = makeSession([first, second]);
        const openSession = vi.fn(async () => session);
        const decoder = new MediabunnyAudioDecoder(openSession);
        decoder.setDocument(makeDocument(), 7);

        const decoded = await decoder.decode(
            makeContributor({ kind: 'video-source-audio', videoSourceId: 'video' }),
            { outputStartSample: 0, outputEndSample: 6, generation: 7 },
        );

        expect(Array.from(decoded.channels[0])).toEqual([1, 2, 0, 0, 3, 4, 0]);
        expect(Array.from(decoded.channels[1])).toEqual([1, 2, 0, 0, 3, 4, 0]);
        expect(first.close).toHaveBeenCalledOnce();
        expect(second.close).toHaveBeenCalledOnce();
        expect(openSession).toHaveBeenCalledOnce();
        expect(session.dispose).not.toHaveBeenCalled();
        decoder.dispose();
        decoder.dispose();
        expect(session.dispose).toHaveBeenCalledOnce();
    });

    it('opens adjacent bounded ranges from the same typed source only once', async () => {
        const samples = [
            makeSample(0, [[1, 1, 1, 1]]),
            makeSample(4 / 48_000, [[2, 2, 2, 2]]),
            makeSample(8 / 48_000, [[3, 3, 3, 3]]),
        ];
        const session = makeSession(samples);
        const openSession = vi.fn(async () => session);
        const decoder = new MediabunnyAudioDecoder(openSession);
        decoder.setDocument(makeDocument(), 1);
        const contributor = makeContributor(
            { kind: 'audio-source', audioSourceId: 'audio' },
            12,
        );

        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 1,
        });
        await decoder.decode(contributor, {
            outputStartSample: 6, outputEndSample: 12, generation: 1,
        });

        expect(openSession).toHaveBeenCalledOnce();
        expect(session.samples).toHaveBeenCalledOnce();
        expect(session.samples.mock.calls[0][0]).toBe(0);
        expect(session.samples.mock.calls[0][1]).toBe(Infinity);
        samples.forEach((sample) => expect(sample.close).toHaveBeenCalledOnce());
    });

    it('reuses one retained iterator for repeated timeline placements of the same source', async () => {
        const samples = [makeSample(0, [new Array<number>(12).fill(0.25)])];
        const session = makeSession(samples);
        const decoder = new MediabunnyAudioDecoder(vi.fn(async () => session));
        decoder.setDocument(makeDocument(), 1);
        const firstPlacement = makeContributor(
            { kind: 'audio-source', audioSourceId: 'audio' },
            6,
        );
        const secondPlacement = {
            ...makeContributor({ kind: 'audio-source', audioSourceId: 'audio' }, 6),
            id: 'second-placement',
            outputStartSample: 100,
            outputEndSample: 106,
        };

        await decoder.decode(firstPlacement, {
            outputStartSample: 0, outputEndSample: 6, generation: 1,
        });
        await decoder.decode(secondPlacement, {
            outputStartSample: 100, outputEndSample: 106, generation: 1,
        });

        expect(session.samples).toHaveBeenCalledOnce();
        expect(samples[0].close).toHaveBeenCalledOnce();
    });

    it('keeps long-file decoding bounded to the requested sequential window', async () => {
        const chunkSamples = 4_096;
        const totalSamples = chunkSamples * 100;
        let yieldedSamples = 0;
        const session = makeSession();
        session.samples.mockImplementation((startSeconds: number) => (async function* () {
            const firstChunk = Math.floor(startSeconds * 48_000 / chunkSamples);
            for (let chunk = firstChunk; chunk < 100; chunk += 1) {
                yieldedSamples += 1;
                yield makeSample(chunk * chunkSamples / 48_000, [
                    new Array<number>(chunkSamples).fill(chunk / 100),
                ]);
            }
        })());
        const decoder = new MediabunnyAudioDecoder(vi.fn(async () => session));
        decoder.setDocument(makeDocument(totalSamples), 1);
        const contributor = makeContributor(
            { kind: 'audio-source', audioSourceId: 'audio' },
            totalSamples,
        );

        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: chunkSamples, generation: 1,
        });

        // One padding sample reaches into the second codec packet, but the remaining 98 packets
        // stay undecoded until a later bounded request advances the retained iterator.
        expect(yieldedSamples).toBe(2);
        expect(session.samples).toHaveBeenCalledOnce();
    });

    it('restarts once for a backward seek outside the bounded PCM window', async () => {
        const chunkSamples = 4_096;
        const totalSamples = chunkSamples * 30;
        const session = makeSession();
        session.samples.mockImplementation((startSeconds: number) => (async function* () {
            const firstChunk = Math.floor(startSeconds * 48_000 / chunkSamples);
            for (let chunk = firstChunk; chunk < 30; chunk += 1) {
                yield makeSample(chunk * chunkSamples / 48_000, [
                    new Array<number>(chunkSamples).fill(chunk / 30),
                ]);
            }
        })());
        const decoder = new MediabunnyAudioDecoder(vi.fn(async () => session));
        decoder.setDocument(makeDocument(totalSamples), 1);
        const contributor = makeContributor(
            { kind: 'audio-source', audioSourceId: 'audio' },
            totalSamples,
        );

        for (let block = 0; block < 26; block += 1) {
            await decoder.decode(contributor, {
                outputStartSample: block * chunkSamples,
                outputEndSample: (block + 1) * chunkSamples,
                generation: 1,
            });
        }
        expect(session.samples).toHaveBeenCalledOnce();

        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: chunkSamples, generation: 2,
        });
        expect(session.samples).toHaveBeenCalledTimes(2);
    });

    it('serializes concurrent same-source requests behind one codec iterator', async () => {
        const pendingSample = createDeferred<IteratorResult<MediabunnyDecodedSample>>();
        const sample = makeSample(0, [new Array<number>(12).fill(0.5)]);
        let activeNextCalls = 0;
        let maximumNextCalls = 0;
        const next = vi.fn(async () => {
            activeNextCalls += 1;
            maximumNextCalls = Math.max(maximumNextCalls, activeNextCalls);
            const result = await pendingSample.promise;
            activeNextCalls -= 1;
            return result;
        });
        const session = makeSession();
        session.samples.mockImplementation(() => ({
            [Symbol.asyncIterator]() { return this; },
            next,
            return: vi.fn(async () => ({ value: undefined, done: true as const })),
            throw: vi.fn(async (error?: unknown) => { throw error; }),
            [Symbol.asyncDispose]: vi.fn(async () => undefined),
        }));
        const decoder = new MediabunnyAudioDecoder(vi.fn(async () => session));
        decoder.setDocument(makeDocument(), 1);
        const contributor = makeContributor({ kind: 'audio-source', audioSourceId: 'audio' }, 12);

        const first = decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 4, generation: 1,
        });
        const second = decoder.decode(contributor, {
            outputStartSample: 4, outputEndSample: 8, generation: 1,
        });
        await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
        pendingSample.resolve({ value: sample, done: false });
        await Promise.all([first, second]);

        expect(maximumNextCalls).toBe(1);
        expect(next).toHaveBeenCalledOnce();
        expect(session.samples).toHaveBeenCalledOnce();
        expect(sample.close).toHaveBeenCalledOnce();
    });

    it('closes an aborted iterator once while retaining its Input for the next request', async () => {
        const pendingResult = createDeferred<IteratorResult<MediabunnyDecodedSample>>();
        const iteratorReturn = vi.fn(async () => {
            pendingResult.resolve({ value: undefined, done: true });
            return { value: undefined, done: true as const };
        });
        const session = makeSession();
        session.samples.mockImplementation(() => ({
            [Symbol.asyncIterator]() { return this; },
            next: vi.fn(() => pendingResult.promise),
            return: iteratorReturn,
            throw: vi.fn(async (error?: unknown) => { throw error; }),
            [Symbol.asyncDispose]: vi.fn(async () => undefined),
        }));
        const decoder = new MediabunnyAudioDecoder(vi.fn(async () => session));
        decoder.setDocument(makeDocument(), 1);
        const controller = new AbortController();
        const contributor = makeContributor({ kind: 'audio-source', audioSourceId: 'audio' });
        const pendingDecode = decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 1,
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(session.samples).toHaveBeenCalledOnce());

        controller.abort();
        await expect(pendingDecode).rejects.toMatchObject({ name: 'AbortError' });

        expect(iteratorReturn).toHaveBeenCalledOnce();
        expect(session.dispose).not.toHaveBeenCalled();
    });

    it('discards copied PCM with an aborted iterator before repeated ranged restarts', async () => {
        const chunkSampleCount = MAX_RETAINED_AUDIO_PCM_SAMPLES / 2;
        const abortedStarts = [0, 1_024, 2_048];
        const iteratorReturns: Array<ReturnType<typeof vi.fn>> = [];
        const iteratorNexts: Array<ReturnType<typeof vi.fn>> = [];
        const copiedSamples: MediabunnyDecodedSample[] = [];
        let iteratorIndex = 0;
        const session = makeSession();
        session.samples.mockImplementation(() => {
            const currentIteratorIndex = iteratorIndex;
            iteratorIndex += 1;
            let packetIndex = 0;
            let pendingResult: ReturnType<
                typeof createDeferred<IteratorResult<MediabunnyDecodedSample>>
            > | null = null;
            const next = vi.fn((): Promise<IteratorResult<MediabunnyDecodedSample>> => {
                if (packetIndex === 0) {
                    packetIndex += 1;
                    const sample = makeSample(0, [
                        new Array<number>(chunkSampleCount).fill(0.25),
                    ]);
                    copiedSamples.push(sample);
                    return Promise.resolve({ value: sample, done: false });
                }
                if (currentIteratorIndex < abortedStarts.length) {
                    pendingResult = createDeferred<IteratorResult<MediabunnyDecodedSample>>();
                    return pendingResult.promise;
                }
                if (packetIndex === 1) {
                    packetIndex += 1;
                    const sample = makeSample(chunkSampleCount / 48_000, [
                        new Array<number>(chunkSampleCount).fill(0.75),
                    ]);
                    copiedSamples.push(sample);
                    return Promise.resolve({ value: sample, done: false });
                }
                return Promise.resolve({ value: undefined, done: true });
            });
            const iteratorReturn = vi.fn(async () => {
                pendingResult?.resolve({ value: undefined, done: true });
                return { value: undefined, done: true as const };
            });
            iteratorNexts.push(next);
            iteratorReturns.push(iteratorReturn);
            return {
                [Symbol.asyncIterator]() { return this; },
                next,
                return: iteratorReturn,
                throw: vi.fn(async (error?: unknown) => { throw error; }),
                [Symbol.asyncDispose]: vi.fn(async () => undefined),
            };
        });
        const reader = new SequentialMediabunnyAudioReader(session);

        for (let attempt = 0; attempt < abortedStarts.length; attempt += 1) {
            const controller = new AbortController();
            const pendingRead = reader.read(
                abortedStarts[attempt],
                90_000,
                controller.signal,
            );
            await vi.waitFor(() => expect(iteratorNexts[attempt]).toHaveBeenCalledTimes(2));
            controller.abort();
            await expect(pendingRead).rejects.toMatchObject({ name: 'AbortError' });
            expect(iteratorReturns[attempt]).toHaveBeenCalledOnce();
        }

        const requestedStart = 4_096;
        const requestedEnd = 90_000;
        const windows = await reader.read(requestedStart, requestedEnd);
        const ranges = windows.map((window) => ({
            start: Math.round(window.timestampSeconds * 48_000),
            end: Math.round((
                window.timestampSeconds + window.frameCount / window.sampleRate
            ) * 48_000),
        }));
        for (let index = 1; index < ranges.length; index += 1) {
            expect(ranges[index].start).toBeGreaterThanOrEqual(ranges[index - 1].end);
        }
        const retainedSampleCount = windows.reduce((total, window) => (
            total + Math.round(window.frameCount * 48_000 / window.sampleRate)
        ), 0);
        expect(retainedSampleCount).toBeLessThanOrEqual(MAX_RETAINED_AUDIO_PCM_SAMPLES);

        const plan = buildSanitizedAudioWindowPlan(windows, {
            nativeSampleRate: 48_000,
            declaredSampleCount: MAX_RETAINED_AUDIO_PCM_SAMPLES,
        });
        const [output] = materializeSanitizedAudioWindowRange(windows, plan, {
            startSample: requestedStart,
            endSample: requestedEnd,
            channelCount: 1,
        });
        expect(Array.from(output.subarray(0, chunkSampleCount - requestedStart)))
            .toEqual(new Array<number>(chunkSampleCount - requestedStart).fill(0.25));
        expect(Array.from(output.subarray(chunkSampleCount - requestedStart)))
            .toEqual(new Array<number>(requestedEnd - chunkSampleCount).fill(0.75));
        copiedSamples.forEach((sample) => expect(sample.close).toHaveBeenCalledOnce());

        reader.dispose();
        await vi.waitFor(() => expect(iteratorReturns.at(-1)).toHaveBeenCalledOnce());
    });

    it('keeps video-audio and imported-audio sessions distinct even when source IDs match', async () => {
        const document = makeDocument();
        document.videoSources[0].id = 'shared';
        document.audioSources[0].id = 'shared';
        const sessions = [makeSession(), makeSession()];
        const openedNames: string[] = [];
        const openSession = vi.fn(async (file: File) => {
            openedNames.push(file.name);
            return sessions[openedNames.length - 1];
        });
        const decoder = new MediabunnyAudioDecoder(openSession);
        decoder.setDocument(document, 1);

        await decoder.decode(
            makeContributor({ kind: 'video-source-audio', videoSourceId: 'shared' }),
            { outputStartSample: 0, outputEndSample: 6, generation: 1 },
        );
        await decoder.decode(
            makeContributor({ kind: 'audio-source', audioSourceId: 'shared' }),
            { outputStartSample: 0, outputEndSample: 6, generation: 1 },
        );

        expect(openedNames).toEqual(['video.mp4', 'audio.wav']);
        expect(openSession).toHaveBeenCalledTimes(2);
    });

    it('retains sessions across render generations and reopens only a replaced fingerprint', async () => {
        const sessions = [makeSession(), makeSession()];
        const openSession = vi.fn(async () => sessions[openSession.mock.calls.length - 1]);
        const decoder = new MediabunnyAudioDecoder(openSession);
        const document = makeDocument();
        const contributor = makeContributor({ kind: 'audio-source', audioSourceId: 'audio' });
        decoder.setDocument(document, 1);
        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 1,
        });

        document.revision = 2;
        decoder.setDocument(document, 2);
        expect(sessions[0].dispose).not.toHaveBeenCalled();
        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 2,
        });
        expect(openSession).toHaveBeenCalledOnce();

        document.audioSources[0].fingerprint = 'audio-fingerprint-v2';
        decoder.setDocument(document, 3);
        expect(sessions[0].dispose).toHaveBeenCalledOnce();
        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 3,
        });
        expect(openSession).toHaveBeenCalledTimes(2);
        expect(sessions[1].dispose).not.toHaveBeenCalled();
        decoder.dispose();
        expect(sessions[1].dispose).toHaveBeenCalledOnce();
    });

    it('defers document-driven Input disposal until its in-flight bounded read returns', async () => {
        const pendingSample = createDeferred<IteratorResult<MediabunnyDecodedSample>>();
        const session = makeSession();
        session.samples.mockImplementation(() => ({
            [Symbol.asyncIterator]() { return this; },
            next: vi.fn(() => pendingSample.promise),
            return: vi.fn(async () => ({ value: undefined, done: true as const })),
            throw: vi.fn(async (error?: unknown) => { throw error; }),
            [Symbol.asyncDispose]: vi.fn(async () => undefined),
        }));
        const decoder = new MediabunnyAudioDecoder(vi.fn(async () => session));
        const document = makeDocument();
        decoder.setDocument(document, 1);
        const pendingDecode = decoder.decode(
            makeContributor({ kind: 'audio-source', audioSourceId: 'audio' }),
            { outputStartSample: 0, outputEndSample: 6, generation: 1 },
        );
        await vi.waitFor(() => expect(session.samples).toHaveBeenCalledOnce());

        document.audioSources[0].fingerprint = 'audio-fingerprint-v2';
        decoder.setDocument(document, 2);
        expect(session.dispose).not.toHaveBeenCalled();

        pendingSample.resolve({
            value: makeSample(0, [new Array<number>(12).fill(0.5)]),
            done: false,
        });
        await pendingDecode;
        expect(session.dispose).toHaveBeenCalledOnce();
    });

    it('retains a session after request abort but invalidates it after a sink error', async () => {
        const abortedSample = makeSample(0, [[1, 2]]);
        const controller = new AbortController();
        const abortSession = makeSession();
        abortSession.samples.mockImplementation(() => (async function* () {
            controller.abort();
            yield abortedSample;
        })());
        const failingSample = makeSample(0, [[3, 4]]);
        const failingSession = makeSession();
        failingSession.samples.mockImplementation(() => (async function* () {
            yield failingSample;
            throw new Error('decoder failed');
        })());
        const recoveredSession = makeSession();
        const sessions = [abortSession, failingSession, recoveredSession];
        const openSession = vi.fn(async () => sessions[openSession.mock.calls.length - 1]);
        const decoder = new MediabunnyAudioDecoder(openSession);
        const document = makeDocument();
        const contributor = makeContributor({ kind: 'audio-source', audioSourceId: 'audio' });
        decoder.setDocument(document, 1);

        await expect(decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 1, signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(abortedSample.close).toHaveBeenCalledOnce();
        expect(abortSession.dispose).not.toHaveBeenCalled();
        // A request abort deliberately retains its reusable source session. Replacing that exact
        // source fingerprint is what transfers ownership and closes the old Input.
        document.audioSources[0].fingerprint = 'audio-fingerprint-v2';
        decoder.setDocument(document, 2);
        expect(abortSession.dispose).toHaveBeenCalledOnce();

        await expect(decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 2,
        })).rejects.toThrow('decoder failed');
        expect(failingSample.close).toHaveBeenCalledOnce();
        expect(failingSession.dispose).toHaveBeenCalledOnce();
        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 2,
        });
        expect(openSession).toHaveBeenCalledTimes(3);
        expect(recoveredSession.dispose).not.toHaveBeenCalled();
    });

    it('disposes only the typed source whose fingerprint changed', async () => {
        const videoSession = makeSession();
        const audioSession = makeSession();
        const replacementAudioSession = makeSession();
        const sessionsByName = new Map<string, ReturnType<typeof makeSession>[]>([
            ['video.mp4', [videoSession]],
            ['audio.wav', [audioSession, replacementAudioSession]],
        ]);
        const openSession = vi.fn(async (file: File) => sessionsByName.get(file.name)!.shift()!);
        const decoder = new MediabunnyAudioDecoder(openSession);
        const document = makeDocument();
        decoder.setDocument(document, 1);
        const videoContributor = makeContributor({
            kind: 'video-source-audio', videoSourceId: 'video',
        });
        const audioContributor = makeContributor({ kind: 'audio-source', audioSourceId: 'audio' });

        await decoder.decode(videoContributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 1,
        });
        await decoder.decode(audioContributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 1,
        });
        document.audioSources[0].fingerprint = 'audio-fingerprint-v2';
        decoder.setDocument(document, 2);

        expect(videoSession.dispose).not.toHaveBeenCalled();
        expect(audioSession.dispose).toHaveBeenCalledOnce();
        await decoder.decode(videoContributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 2,
        });
        await decoder.decode(audioContributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 2,
        });
        expect(openSession).toHaveBeenCalledTimes(3);
        expect(replacementAudioSession.dispose).not.toHaveBeenCalled();
    });

    it('evicts the least-recently-used dormant Input beyond the explicit session bound', async () => {
        const document = makeDocument(1);
        document.audioSources = Array.from(
            { length: MAX_RETAINED_AUDIO_SESSIONS + 1 },
            (_, index) => ({
                ...document.audioSources[0],
                id: `audio-${index}`,
                fingerprint: `fingerprint-${index}`,
                originalName: `audio-${index}.wav`,
                file: makeFile(`audio-${index}.wav`),
            }),
        );
        const sessions = document.audioSources.map(() => makeSession());
        const openSession = vi.fn(async () => sessions[openSession.mock.calls.length - 1]);
        const decoder = new MediabunnyAudioDecoder(openSession);
        decoder.setDocument(document, 1);

        for (let index = 0; index < document.audioSources.length; index += 1) {
            await decoder.decode(makeContributor({
                kind: 'audio-source', audioSourceId: `audio-${index}`,
            }, 1), {
                outputStartSample: 0, outputEndSample: 1, generation: 1,
            });
        }

        expect(openSession).toHaveBeenCalledTimes(MAX_RETAINED_AUDIO_SESSIONS + 1);
        expect(sessions[0].dispose).toHaveBeenCalledOnce();
        sessions.slice(1).forEach((session) => expect(session.dispose).not.toHaveBeenCalled());
    });
});
