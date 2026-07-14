import { describe, expect, it } from 'vitest';
import type { AudioSourceAsset, VideoSourceAssetV3 } from '@/types/video';
import {
    getAudioMediaCacheKey,
    getEditorMediaAssetKey,
    getWaveformRepositoryKey,
    resolveAudioMediaAsset,
} from './media-asset-ref';

const videoAsset = { id: 'shared', hasAudio: true } as VideoSourceAssetV3;
const audioAsset = { id: 'shared' } as AudioSourceAsset;

describe('typed media asset keys', () => {
    it('isolates editor assets and decoded audio streams with the same bare ID', () => {
        expect(getEditorMediaAssetKey({ kind: 'video-source', asset: videoAsset }))
            .toBe('video-source:shared');
        expect(getEditorMediaAssetKey({ kind: 'audio-source', asset: audioAsset }))
            .toBe('audio-source:shared');
        expect(getAudioMediaCacheKey({ kind: 'video-source-audio', asset: videoAsset }))
            .toBe('video-source-audio:shared');
        expect(getAudioMediaCacheKey({ kind: 'audio-source', asset: audioAsset }))
            .toBe('audio-source:shared');
    });

    it('resolves both audio media reference kinds without crossing catalogs', () => {
        expect(resolveAudioMediaAsset(
            { kind: 'video-source-audio', videoSourceId: 'shared' },
            [videoAsset],
            [audioAsset],
        )).toEqual({ kind: 'video-source-audio', asset: videoAsset });
        expect(resolveAudioMediaAsset(
            { kind: 'audio-source', audioSourceId: 'shared' },
            [videoAsset],
            [audioAsset],
        )).toEqual({ kind: 'audio-source', asset: audioAsset });
    });

    it('does not expose embedded audio for a silent video source', () => {
        expect(resolveAudioMediaAsset(
            { kind: 'video-source-audio', videoSourceId: 'silent' },
            [{ ...videoAsset, id: 'silent', hasAudio: false }],
            [],
        )).toBeNull();
    });

    it('keys derived waveforms by typed fingerprint, algorithm, and resolution', () => {
        const video = { ...videoAsset, fingerprint: 'same:file|fingerprint' };
        const audio = { ...audioAsset, fingerprint: 'same:file|fingerprint' };

        expect(getWaveformRepositoryKey(
            { kind: 'video-source-audio', asset: video },
            2,
            4_000,
        )).toBe('waveform:video-source-audio:same%3Afile%7Cfingerprint:v2:r4000');
        expect(getWaveformRepositoryKey(
            { kind: 'audio-source', asset: audio },
            2,
            4_000,
        )).toBe('waveform:audio-source:same%3Afile%7Cfingerprint:v2:r4000');
        expect(getWaveformRepositoryKey(
            { kind: 'audio-source', asset: { ...audio, id: 'another-project-id' } },
            2,
            4_000,
        )).toBe(getWaveformRepositoryKey(
            { kind: 'audio-source', asset: audio },
            2,
            4_000,
        ));
    });
});
