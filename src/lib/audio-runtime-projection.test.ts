import { describe, expect, it } from 'vitest';
import { buildTimelineAudioRuntimeSnapshot } from './audio-runtime-projection';
import { defaultAnimationStyle } from '@/components/video-editor/subtitle-editor/types';
import type { EditorDocumentV3 } from '@/types/video';

function makeDocument(): EditorDocumentV3 {
    const file = new File(['media'], 'clip.mp4', { type: 'video/mp4' });
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
            id: 'video', originalName: 'clip.mp4', mimeType: 'video/mp4', size: file.size,
            lastModified: 1, fingerprint: 'video-v1', duration: 1, fps: 30, width: 1920,
            height: 1080, bitrate: null, hasAudio: true, file,
        }],
        videoClips: [{
            id: 'clip', sourceId: 'video', sourceStart: 0, sourceEnd: 1,
            audio: {
                linkState: 'linked', muted: false, gainDb: 0,
                fadeInFrames: 0, fadeOutFrames: 0,
            },
        }],
        audioSources: [], audioTracks: [], activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' }, transcriptionByTrackId: {},
    };
}

describe('timeline audio runtime projection', () => {
    it('ignores revision, selection, and subtitle metadata while preserving content end', () => {
        const first = makeDocument();
        const second = structuredClone(first);
        second.revision = 99;
        second.audioGraphRevision = 42;
        second.transientSelection = { kind: 'video-clip', clipId: 'clip' };
        second.subtitleTracks = [{
            id: 'captions', name: 'Renamed captions', isVisible: true, isLocked: false,
            style: defaultAnimationStyle,
            timingDomain: 'absolute',
            subtitles: [{ id: 'subtitle', startTime: 0, endTime: 2, text: 'Changed' }],
        }];

        const before = buildTimelineAudioRuntimeSnapshot(first, 48_000);
        const after = buildTimelineAudioRuntimeSnapshot(second, 96_000);

        expect(after.sourceCatalogKey).toBe(before.sourceCatalogKey);
        expect(after.audibleMixKey).toBe(before.audibleMixKey);
        expect(after.contentEndSample).toBe(96_000);
    });

    it('separates source replacement from mix controls and includes both in audible semantics', () => {
        const original = buildTimelineAudioRuntimeSnapshot(makeDocument(), 48_000);
        const gainEdit = makeDocument();
        gainEdit.videoClips[0].audio!.gainDb = -6;
        const gainSnapshot = buildTimelineAudioRuntimeSnapshot(gainEdit, 48_000);
        expect(gainSnapshot.sourceCatalogKey).toBe(original.sourceCatalogKey);
        expect(gainSnapshot.audibleMixKey).not.toBe(original.audibleMixKey);

        const replacement = makeDocument();
        replacement.videoSources[0].fingerprint = 'video-v2';
        const replacementSnapshot = buildTimelineAudioRuntimeSnapshot(replacement, 48_000);
        expect(replacementSnapshot.sourceCatalogKey).not.toBe(original.sourceCatalogKey);
        expect(replacementSnapshot.audibleMixKey).not.toBe(original.audibleMixKey);
    });

    it('does not reset the audible mix when an unused source is imported', () => {
        const document = makeDocument();
        const before = buildTimelineAudioRuntimeSnapshot(document, 48_000);
        document.audioSources.push({
            id: 'unused', originalName: 'unused.wav', mimeType: 'audio/wav', size: 1,
            lastModified: 1, fingerprint: 'unused-v1', duration: 1, nativeSampleRate: 48_000,
            nativeSampleCount: 48_000, nativeChannelCount: 1, bitrate: null, codec: 'pcm',
            file: new File(['a'], 'unused.wav'),
        });
        const after = buildTimelineAudioRuntimeSnapshot(document, 48_000);

        expect(after.sourceCatalogKey).not.toBe(before.sourceCatalogKey);
        expect(after.audibleMixKey).toBe(before.audibleMixKey);
    });
});
