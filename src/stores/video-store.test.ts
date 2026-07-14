import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoSourceAsset } from '@/types/video';
import { useVideoStore } from './video-store';

const source = (id: string): VideoSourceAsset => ({
    id,
    originalName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    fingerprint: `fingerprint_${id}`,
    duration: 1,
    fps: 30,
    width: 1,
    height: 1,
    bitrate: null,
    hasAudio: true,
    file: {} as File,
});

describe('video source runtime handles', () => {
    beforeEach(() => {
        useVideoStore.setState({ sourceHandles: {}, ownedObjectUrls: {} });
        vi.restoreAllMocks();
    });

    it('revokes replaced and explicitly removed object URLs', () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        useVideoStore.getState().setSourceHandle('source_a', 'blob:first', true);
        useVideoStore.getState().setSourceHandle('source_a', 'blob:second', true);
        expect(revoke).toHaveBeenCalledWith('blob:first');

        useVideoStore.getState().removeSourceHandle('source_a');
        expect(revoke).toHaveBeenCalledWith('blob:second');
        expect(useVideoStore.getState().sourceHandles).toEqual({});
    });

    it('revokes handles removed by catalog synchronization and catalog clear', () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        useVideoStore.setState({
            sourceHandles: {
                source_a: { sourceId: 'source_a', objectUrl: 'blob:a' },
                source_b: { sourceId: 'source_b', objectUrl: 'blob:b' },
            },
            ownedObjectUrls: { source_a: true, source_b: true },
        });

        useVideoStore.getState().syncSourceCatalog([source('source_a')]);
        expect(revoke).toHaveBeenCalledWith('blob:b');
        expect(useVideoStore.getState().sourceHandles).toEqual({
            source_a: { sourceId: 'source_a', objectUrl: 'blob:a' },
        });

        useVideoStore.getState().clearSourceHandles();
        expect(revoke).toHaveBeenCalledWith('blob:a');
        expect(useVideoStore.getState().sourceHandles).toEqual({});
    });

    it('never revokes externally owned handles', () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        useVideoStore.getState().setSourceHandle('external', 'blob:external');

        useVideoStore.getState().removeSourceHandle('external');

        expect(revoke).not.toHaveBeenCalled();
    });
});
