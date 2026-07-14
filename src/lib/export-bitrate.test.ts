import { describe, expect, it } from 'vitest';
import type { VideoClip, VideoSourceDescriptor } from '@/types/video';
import { calculateActiveTimelineBitrate } from './export-bitrate';

const source = (id: string, bitrate: number | null): VideoSourceDescriptor => ({
    id,
    originalName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1,
    fingerprint: `fingerprint-${id}`,
    duration: 20,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate,
    hasAudio: true,
});

const clip = (id: string, sourceId: string, sourceStart: number, sourceEnd: number): VideoClip => ({
    id,
    sourceId,
    sourceStart,
    sourceEnd,
});

describe('active timeline export bitrate', () => {
    it('excludes append-only orphan sources', () => {
        expect(calculateActiveTimelineBitrate(
            [source('used', 2_000_000), source('orphan', 40_000_000)],
            [clip('used-clip', 'used', 4, 6)],
        )).toBe(2_000_000);
    });

    it('weights trimmed and repeated placements by their active duration', () => {
        expect(calculateActiveTimelineBitrate(
            [source('low', 2_000_000), source('high', 8_000_000)],
            [
                clip('low-first', 'low', 1, 2),
                clip('high', 'high', 3, 6),
                clip('low-reused', 'low', 8, 9),
            ],
        )).toBe(5_600_000);
    });
});
