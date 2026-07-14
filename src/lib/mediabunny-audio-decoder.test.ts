import { describe, expect, it, vi } from 'vitest';
import type { AudioMixContributor } from './audio-mix-plan';
import {
    MediabunnyAudioDecoder,
    type MediabunnyDecodedSample,
} from './mediabunny-audio-decoder';
import type { EditorDocumentV3 } from '@/types/video';

function makeFile(name: string): File {
    return new File(['media'], name, { type: 'application/octet-stream' });
}

function makeDocument(): EditorDocumentV3 {
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
            lastModified: 1, fingerprint: 'video-fingerprint', duration: 12 / 48_000,
            fps: 30, width: 1920, height: 1080, bitrate: null, hasAudio: true,
            file: makeFile('video.mp4'),
        }],
        videoClips: [],
        audioSources: [{
            id: 'audio', originalName: 'audio.wav', mimeType: 'audio/wav', size: 5,
            lastModified: 1, fingerprint: 'audio-fingerprint', duration: 12 / 48_000,
            nativeSampleRate: 48_000, nativeSampleCount: 12, nativeChannelCount: 1,
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
        const session = makeSession();
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
        expect(session.samples).toHaveBeenCalledTimes(2);
        expect(session.samples.mock.calls[0][0]).toBe(0);
        expect(session.samples.mock.calls[1][0]).toBeGreaterThan(0);
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

    it('disposes sessions on a generation change and reopens on the next decode', async () => {
        const sessions = [makeSession(), makeSession()];
        const openSession = vi.fn(async () => sessions[openSession.mock.calls.length - 1]);
        const decoder = new MediabunnyAudioDecoder(openSession);
        const document = makeDocument();
        const contributor = makeContributor({ kind: 'audio-source', audioSourceId: 'audio' });
        decoder.setDocument(document, 1);
        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 1,
        });

        decoder.setDocument(document, 2);
        expect(sessions[0].dispose).toHaveBeenCalledOnce();
        await decoder.decode(contributor, {
            outputStartSample: 0, outputEndSample: 6, generation: 2,
        });
        expect(openSession).toHaveBeenCalledTimes(2);
        expect(sessions[1].dispose).not.toHaveBeenCalled();
        decoder.dispose();
        expect(sessions[1].dispose).toHaveBeenCalledOnce();
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
        // A new generation intentionally drops the retained aborted session before testing a real
        // decoder failure, matching how seek/edit cancellation is used by the engine.
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
});
