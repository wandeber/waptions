import { describe, expect, it } from 'vitest';
import {
    createMediaSourceFingerprint,
    createVideoSourceAsset,
    getVideoSourceMetadataFromInspection,
} from './video-source';
import { createVideoSourceFingerprint } from './video-timeline';

const file = {
    name: 'camera.MOV',
    type: 'video/quicktime',
    size: 3_000_000,
    lastModified: 123,
} as File;

describe('video source construction', () => {
    it('keeps the existing descriptor contract and shared fingerprint algorithm', () => {
        const metadata = getVideoSourceMetadataFromInspection(file, {
            duration: 3,
            video: { width: 1920, height: 1080, fps: 30, codec: 'avc' },
            audio: { sampleRate: 48_000, numberOfChannels: 2, codec: 'aac', bitrate: 128_000 },
        });
        const asset = createVideoSourceAsset(file, metadata, { sourceId: 'video_source' });

        expect(asset).toMatchObject({
            id: 'video_source',
            originalName: 'camera.MOV',
            mimeType: 'video/quicktime',
            duration: 3,
            fps: 30,
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            hasAudio: true,
        });
        expect(asset).not.toHaveProperty('nativeSampleRate');
        expect(asset.fingerprint).toBe(createVideoSourceFingerprint(file));
        expect(createMediaSourceFingerprint(file)).toBe(createVideoSourceFingerprint(file));
    });

    it('rejects inspection metadata without primary video', () => {
        expect(() => getVideoSourceMetadataFromInspection(file, {
            duration: 3,
            video: null,
            audio: { sampleRate: 48_000, numberOfChannels: 2, codec: 'aac', bitrate: null },
        })).toThrow('No video track found');
    });
});
