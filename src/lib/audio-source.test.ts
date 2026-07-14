import { describe, expect, it } from 'vitest';
import {
    createAudioSourceAsset,
    createFullLengthImportedAudioClip,
    getAudioSourceMetadataFromInspection,
} from './audio-source';
import { doesMediaSourceFingerprintMatch } from './video-source';

const file = {
    name: 'music.wav',
    type: 'audio/wav',
    size: 48_000,
    lastModified: 456,
} as File;

describe('audio source construction', () => {
    it('derives a deterministic native sample domain from inspected metadata', () => {
        const metadata = getAudioSourceMetadataFromInspection({
            duration: 1.00001,
            video: null,
            audio: {
                sampleRate: 48_000,
                numberOfChannels: 2,
                codec: 'pcm-s16',
                bitrate: 1_536_000,
            },
        });
        const asset = createAudioSourceAsset(file, metadata, { sourceId: 'audio_source' });

        expect(asset).toMatchObject({
            id: 'audio_source',
            duration: 1,
            nativeSampleRate: 48_000,
            nativeSampleCount: 48_000,
            nativeChannelCount: 2,
            codec: 'pcm-s16',
            bitrate: 1_536_000,
        });
        expect(asset.fingerprint).toMatch(/^v2_/);
        expect(doesMediaSourceFingerprintMatch(asset.fingerprint, file)).toBe(true);
    });

    it('keeps the native sample domain non-empty for a zero-duration source', () => {
        const asset = createAudioSourceAsset(file, {
            duration: 0,
            sampleRate: 44_100,
            numberOfChannels: 1,
            codec: null,
            bitrate: null,
        }, { sourceId: 'audio_source' });

        expect(asset.nativeSampleCount).toBe(1);
        expect(asset.duration).toBe(1 / 44_100);
    });

    it('rounds reported duration to the canonical native sample clock', () => {
        const asset = createAudioSourceAsset(file, {
            duration: 2.4 / 48_000,
            sampleRate: 48_000,
            numberOfChannels: 1,
            codec: null,
            bitrate: null,
        }, { sourceId: 'audio_source' });

        expect(asset.nativeSampleCount).toBe(2);
        expect(asset.duration).toBe(2 / 48_000);
    });

    it.each([
        48_000.5,
        0,
        -48_000,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ])('rejects invalid native sample rate %s', (sampleRate) => {
        expect(() => createAudioSourceAsset(file, {
            duration: 1,
            sampleRate,
            numberOfChannels: 2,
            codec: null,
            bitrate: null,
        }, { sourceId: 'audio_source' })).toThrow('positive safe integer');
    });

    it.each([
        1.5,
        0,
        -1,
        Number.MAX_SAFE_INTEGER + 1,
    ])('rejects invalid native channel count %s', (numberOfChannels) => {
        expect(() => createAudioSourceAsset(file, {
            duration: 1,
            sampleRate: 48_000,
            numberOfChannels,
            codec: null,
            bitrate: null,
        }, { sourceId: 'audio_source' })).toThrow('positive safe integer');
    });

    it.each([
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ])('normalizes invalid bitrate %s to null', (bitrate) => {
        const asset = createAudioSourceAsset(file, {
            duration: 1,
            sampleRate: 48_000,
            numberOfChannels: 2,
            codec: null,
            bitrate,
        }, { sourceId: 'audio_source' });

        expect(asset.bitrate).toBeNull();
    });

    it('rounds a finite nonnegative bitrate to a safe persisted integer', () => {
        const asset = createAudioSourceAsset(file, {
            duration: 1,
            sampleRate: 48_000,
            numberOfChannels: 2,
            codec: null,
            bitrate: 127_999.6,
        }, { sourceId: 'audio_source' });

        expect(asset.bitrate).toBe(128_000);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
        'rejects invalid reported duration %s',
        (duration) => {
            expect(() => createAudioSourceAsset(file, {
                duration,
                sampleRate: 48_000,
                numberOfChannels: 2,
                codec: null,
                bitrate: null,
            }, { sourceId: 'audio_source' })).toThrow('non-negative and finite');
        },
    );

    it('rejects a native sample count beyond the safe integer range', () => {
        expect(() => createAudioSourceAsset(file, {
            duration: Number.MAX_SAFE_INTEGER,
            sampleRate: 48_000,
            numberOfChannels: 2,
            codec: null,
            bitrate: null,
        }, { sourceId: 'audio_source' })).toThrow('sample count exceeds');
    });

    it('creates a full-length independently editable clip at a frame placement', () => {
        const asset = createAudioSourceAsset(file, {
            duration: 2,
            sampleRate: 48_000,
            numberOfChannels: 2,
            codec: 'pcm-s16',
            bitrate: null,
        }, { sourceId: 'audio_source' });

        expect(createFullLengthImportedAudioClip(asset, 90, 'audio_clip')).toEqual({
            id: 'audio_clip',
            source: { kind: 'audio-source', audioSourceId: 'audio_source' },
            timelineStartFrame: 90,
            sourceStartSample: 0,
            sourceEndSample: 96_000,
            muted: false,
            gainDb: 0,
            fadeInSamples: 0,
            fadeOutSamples: 0,
        });
    });

    it('rejects inspection without a primary audio track', () => {
        expect(() => getAudioSourceMetadataFromInspection({
            duration: 1,
            video: { width: 1, height: 1, fps: 30, codec: null },
            audio: null,
        })).toThrow('No audio track found');
    });
});
