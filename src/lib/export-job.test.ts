import { describe, expect, it, vi } from 'vitest';
import { createEditorDocumentV4Fixture } from '@/types/editorial.test-fixtures';
import type { EditorDocumentV3, VideoClipV4 } from '@/types/video';
import {
    awaitExportPhase,
    createExportDocumentSnapshot,
    createExportProgressReporter,
    createExportRuntimeSnapshot,
    estimateExportOutputBytes,
} from './export-job';
import { resolveVideoFrameRuntimePlacementAtFrame } from './video-frame-plan';

function makeDocument(): EditorDocumentV3 {
    const file = new File(['media'], 'media.mp4', { type: 'video/mp4' });
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 },
            width: 1920,
            height: 1080,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        subtitleTracks: [],
        videoSources: [{
            id: 'video', originalName: 'media.mp4', mimeType: 'video/mp4', size: file.size,
            lastModified: file.lastModified, fingerprint: 'fingerprint', duration: 10, fps: 30,
            width: 1920, height: 1080, bitrate: 10_000_000, hasAudio: true, file,
        }],
        videoClips: [{
            id: 'clip', sourceId: 'video', sourceStart: 0, sourceEnd: 10,
            audio: {
                linkState: 'linked', muted: false, gainDb: 0,
                fadeInFrames: 0, fadeOutFrames: 0,
            },
        }],
        videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: ['clip'] }],
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

describe('export job contracts', () => {
    it('captures one validated immutable V4 placement plan before live graph changes', () => {
        const audio = {
            linkState: 'linked' as const,
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        };
        const clips: VideoClipV4[] = [{
            id: 'lower', sourceId: 'video_source_editorial', trackId: 'lower_track',
            timelineStartFrame: 0, sourceStart: 0, sourceEnd: 3, audio,
        }, {
            id: 'top', sourceId: 'video_source_editorial', trackId: 'top_track',
            timelineStartFrame: 30, sourceStart: 3, sourceEnd: 4, audio: { ...audio },
        }];
        const document = createEditorDocumentV4Fixture({
            videoTracks: [
                { id: 'top_track', name: 'Top', visible: true, locked: false },
                { id: 'lower_track', name: 'Lower', visible: true, locked: false },
            ],
            videoClips: clips,
            editorialTranscriptDescriptors: [],
            narrative: null,
        });

        const snapshot = createExportRuntimeSnapshot(document);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.document)).toBe(true);
        expect(Object.isFrozen(snapshot.videoPlan)).toBe(true);
        expect(resolveVideoFrameRuntimePlacementAtFrame(snapshot.videoPlan, 35)?.placement.clip.id)
            .toBe('top');

        document.videoTracks[0].visible = false;
        document.videoClips[1].timelineStartFrame = 120;
        document.videoClips[1].audio!.muted = true;
        expect(resolveVideoFrameRuntimePlacementAtFrame(snapshot.videoPlan, 35)?.placement.clip.id)
            .toBe('top');
        expect(snapshot.document.videoClips[1]).toMatchObject({
            timelineStartFrame: 30,
            audio: { muted: false },
        });
    });

    it('rejects an invalid V4 graph before producing an export plan', () => {
        const document = createEditorDocumentV4Fixture({
            videoClips: [{
                ...createEditorDocumentV4Fixture().videoClips[0],
                id: 'first',
            }, {
                ...createEditorDocumentV4Fixture().videoClips[0],
                id: 'overlap',
                timelineStartFrame: 1,
            }],
            editorialTranscriptDescriptors: [],
            narrative: null,
        });

        expect(() => createExportRuntimeSnapshot(document)).toThrow(/invalid V4 editor graph/i);
    });

    it('captures a deeply immutable graph while preserving File identity', () => {
        const document = makeDocument();
        const snapshot = createExportDocumentSnapshot(document);

        expect(snapshot).not.toBe(document);
        expect(snapshot.videoSources[0].file).toBe(document.videoSources[0].file);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.videoClips)).toBe(true);
        expect(Object.isFrozen(snapshot.videoClips[0].audio)).toBe(true);

        document.videoClips[0].sourceEnd = 3;
        document.videoClips[0].audio!.muted = true;
        expect(snapshot.videoClips[0].sourceEnd).toBe(10);
        expect(snapshot.videoClips[0].audio?.muted).toBe(false);
    });

    it('estimates audio inclusion without exceeding the same timeline content boundary', () => {
        const document = makeDocument();
        const silent = estimateExportOutputBytes(document, { quality: 'high', includeAudio: false });
        const withAudio = estimateExportOutputBytes(document, { quality: 'high', includeAudio: true });
        expect(withAudio).toBeGreaterThan(silent);
        expect(withAudio - silent).toBeGreaterThan(100_000);
    });

    it('reports clamped monotonic progress and ignores non-finite values', () => {
        const onProgress = vi.fn();
        const report = createExportProgressReporter(onProgress);
        report(0.4);
        report(0.2);
        report(Number.NaN);
        report(2);
        expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([0.4, 0.4, 1]);
    });

    it('rejects a pending phase promptly when the caller aborts', async () => {
        const controller = new AbortController();
        let resolve!: (value: string) => void;
        const operation = new Promise<string>((nextResolve) => { resolve = nextResolve; });
        const result = awaitExportPhase(operation, controller.signal);
        controller.abort();

        await expect(result).rejects.toMatchObject({ name: 'AbortError' });
        // The original operation remains observed after cancellation and can settle without an
        // unhandled rejection or any attempt to revise the already-delivered result.
        resolve('late');
        await Promise.resolve();
    });
});
