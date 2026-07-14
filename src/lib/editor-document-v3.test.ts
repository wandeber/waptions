import { describe, expect, it } from 'vitest';
import type { SubtitleTrack } from '@/types/timeline';
import type {
    AudioClip,
    AudioSourceAsset,
    EditorDocumentV3,
    VideoSourceAssetV3,
} from '@/types/video';
import { createDefaultRenderProfile } from './render-profile';
import { getEditorAudioGraphSignature, validateEditorDocumentV3 } from './editor-document-v3';

const makeFile = (name: string, type: string, size = 1_024, lastModified = 123): File => ({
    name,
    type,
    size,
    lastModified,
} as File);

const makeVideoSource = (overrides: Partial<VideoSourceAssetV3> = {}): VideoSourceAssetV3 => {
    const file = overrides.file ?? makeFile('video.mp4', 'video/mp4');
    return {
        id: 'video_source_a',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: 'video_fingerprint',
        duration: 10,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        hasAudio: true,
        file,
        ...overrides,
    };
};

const makeAudioSource = (overrides: Partial<AudioSourceAsset> = {}): AudioSourceAsset => {
    const file = overrides.file ?? makeFile('voice.wav', 'audio/wav');
    return {
        id: 'audio_source_a',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: 'audio_fingerprint',
        duration: 10,
        nativeSampleRate: 48_000,
        nativeSampleCount: 480_000,
        nativeChannelCount: 2,
        bitrate: 1_536_000,
        codec: 'pcm_s16le',
        file,
        ...overrides,
    };
};

const makeImportedClip = (overrides: Partial<AudioClip> = {}): AudioClip => ({
    id: 'audio_clip_a',
    source: { kind: 'audio-source', audioSourceId: 'audio_source_a' },
    timelineStartFrame: 0,
    sourceStartSample: 0,
    sourceEndSample: 48_000,
    muted: false,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...overrides,
} as AudioClip);

const makeDocument = (overrides: Partial<EditorDocumentV3> = {}): EditorDocumentV3 => {
    const subtitleTrack = {
        id: 'subtitle_track_a',
        name: 'Subtitles',
        style: {} as SubtitleTrack['style'],
        subtitles: [{ id: 'subtitle_a', startTime: 0, endTime: 1, text: 'Hello' }],
        isVisible: true,
        isLocked: false,
        timingDomain: 'video-ripple' as const,
    };
    return {
        version: 3,
        revision: 2,
        audioGraphRevision: 1,
        renderProfile: createDefaultRenderProfile(),
        subtitleTracks: [subtitleTrack],
        videoSources: [makeVideoSource()],
        videoClips: [{
            id: 'video_clip_a',
            sourceId: 'video_source_a',
            sourceStart: 0,
            sourceEnd: 2,
            audio: { linkState: 'linked', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 },
        }],
        audioSources: [makeAudioSource()],
        audioTracks: [{
            id: 'audio_track_a',
            name: 'Voiceover',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [makeImportedClip()],
        }],
        activeSubtitleTrackId: subtitleTrack.id,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
        ...overrides,
    };
};

describe('v3 editor graph validation', () => {
    it('accepts linked, detached, and imported audio without a synthetic video-audio lane', () => {
        expect(validateEditorDocumentV3(makeDocument())).toEqual({ valid: true, issues: [] });
        const detached = makeDocument();
        detached.videoClips[0].audio!.linkState = 'detached';
        detached.audioTracks[0].clips.push({
            id: 'detached_clip',
            source: { kind: 'video-source-audio', videoSourceId: 'video_source_a' },
            timelineStartFrame: 60,
            sourceStart: 2,
            sourceEnd: 3,
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        });
        expect(validateEditorDocumentV3(detached)).toEqual({ valid: true, issues: [] });
        expect('videoAudioLane' in detached).toBe(false);
    });

    it('enforces the null/settings invariant against resolved source audio capability', () => {
        const missingSettings = makeDocument();
        missingSettings.videoClips[0].audio = null;
        expect(validateEditorDocumentV3(missingSettings).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-mix-controls',
            path: 'videoClips[0].audio',
        }));

        const silentSource = makeDocument({ videoSources: [makeVideoSource({ hasAudio: false })] });
        expect(validateEditorDocumentV3(silentSource).valid).toBe(false);
        silentSource.videoClips[0].audio = null;
        expect(validateEditorDocumentV3(silentSource)).toEqual({ valid: true, issues: [] });
    });

    it('uses typed references and validates domain-specific crop and fade bounds', () => {
        const invalid = makeDocument();
        invalid.audioTracks[0].clips = [
            makeImportedClip({ sourceEndSample: 480_001, fadeInSamples: 10 }),
            {
                id: 'detached_bad',
                source: { kind: 'video-source-audio', videoSourceId: 'missing_video' },
                timelineStartFrame: 60,
                sourceStart: 0,
                sourceEnd: 1,
                muted: false,
                gainDb: 0,
                fadeInFrames: 20,
                fadeOutFrames: 20,
            },
        ];
        expect(validateEditorDocumentV3(invalid).issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'invalid-clip-bounds',
            'missing-source',
        ]));
    });

    it('allows the same ID in distinct namespaces while rejecting duplicates inside one namespace', () => {
        const sameNamespaceNames = makeDocument();
        sameNamespaceNames.videoSources[0].id = 'shared';
        sameNamespaceNames.videoClips[0].sourceId = 'shared';
        sameNamespaceNames.videoClips[0].id = 'shared';
        sameNamespaceNames.audioSources[0].id = 'shared';
        const imported = sameNamespaceNames.audioTracks[0].clips[0];
        if (imported.source.kind === 'audio-source') imported.source.audioSourceId = 'shared';
        imported.id = 'shared';
        sameNamespaceNames.audioTracks[0].id = 'shared';
        expect(validateEditorDocumentV3(sameNamespaceNames).valid).toBe(true);

        sameNamespaceNames.audioTracks.push({ ...sameNamespaceNames.audioTracks[0], clips: [] });
        expect(validateEditorDocumentV3(sameNamespaceNames).issues).toContainEqual(expect.objectContaining({
            code: 'duplicate-id',
            path: 'audioTracks[1].id',
        }));
    });

    it('validates audio graph revisions and rejects mismatched non-stale transcription provenance', () => {
        const document = makeDocument();
        const signature = getEditorAudioGraphSignature(document);
        document.transcriptionByTrackId.subtitle_track_a = {
            raw: [{ id: 'raw_a', startTime: 0, endTime: 1, text: 'Hello' }],
            groups: { sentence_a: [{ id: 'raw_a', startTime: 0, endTime: 1, text: 'Hello' }] },
            containerIds: ['sentence_a'],
            sourceDocumentRevision: 2,
            sourceAudioGraphRevision: 1,
            sourceAudioGraphSignature: signature,
            stale: false,
        };
        expect(validateEditorDocumentV3(document)).toEqual({ valid: true, issues: [] });

        document.transcriptionByTrackId.subtitle_track_a.sourceAudioGraphSignature = 'outdated';
        expect(validateEditorDocumentV3(document).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-transcription-provenance',
        }));
        document.transcriptionByTrackId.subtitle_track_a.stale = true;
        expect(validateEditorDocumentV3(document).valid).toBe(true);

        document.transcriptionByTrackId.subtitle_track_a.sourceAudioGraphRevision = 2;
        expect(validateEditorDocumentV3(document).valid).toBe(false);
    });

    it('excludes gain, fades, names, and locks from the transcription audio graph signature', () => {
        const document = makeDocument();
        const signature = getEditorAudioGraphSignature(document);
        document.audioTracks[0].name = 'Renamed voiceover';
        document.audioTracks[0].locked = true;
        document.audioTracks[0].gainDb = -7;
        document.videoClips[0].audio!.gainDb = -8;
        document.videoClips[0].audio!.fadeInFrames = 3;
        document.videoClips[0].audio!.fadeOutFrames = 4;
        const importedClip = document.audioTracks[0].clips[0];
        importedClip.gainDb = -9;
        if ('fadeInSamples' in importedClip) {
            importedClip.fadeInSamples = 1_000;
            importedClip.fadeOutSamples = 2_000;
        }
        expect(getEditorAudioGraphSignature(document)).toBe(signature);
    });

    it('changes the transcription signature for every transcription-relevant graph mutation', () => {
        const expectChange = (mutate: (document: EditorDocumentV3) => void): void => {
            const document = makeDocument();
            const signature = getEditorAudioGraphSignature(document);
            mutate(document);
            expect(getEditorAudioGraphSignature(document)).not.toBe(signature);
        };

        expectChange((document) => { document.renderProfile.fps = { numerator: 24, denominator: 1 }; });
        expectChange((document) => { document.videoClips[0].sourceStart = 0.1; });
        expectChange((document) => { document.videoClips[0].audio!.linkState = 'detached'; });
        expectChange((document) => { document.videoClips[0].audio!.muted = true; });
        expectChange((document) => { document.videoSources[0].fingerprint = 'different_video'; });
        expectChange((document) => { document.audioTracks[0].muted = true; });
        expectChange((document) => { document.audioTracks[0].solo = true; });
        expectChange((document) => { document.audioTracks[0].clips[0].timelineStartFrame = 2; });
        expectChange((document) => {
            const clip = document.audioTracks[0].clips[0];
            if ('sourceStartSample' in clip) clip.sourceStartSample = 1;
        });
        expectChange((document) => { document.audioTracks[0].clips[0].muted = true; });
        expectChange((document) => { document.audioSources[0].fingerprint = 'different_audio'; });

        const ordered = makeDocument();
        ordered.audioTracks.push({
            id: 'empty_track',
            name: 'Empty',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [],
        });
        const orderedSignature = getEditorAudioGraphSignature(ordered);
        ordered.audioTracks.reverse();
        expect(getEditorAudioGraphSignature(ordered)).not.toBe(orderedSignature);

        const orderedVideo = makeDocument();
        orderedVideo.videoClips.push({
            ...orderedVideo.videoClips[0],
            id: 'video_clip_b',
            sourceStart: 3,
            sourceEnd: 4,
        });
        const orderedVideoSignature = getEditorAudioGraphSignature(orderedVideo);
        orderedVideo.videoClips.reverse();
        expect(getEditorAudioGraphSignature(orderedVideo)).not.toBe(orderedVideoSignature);

        const emptySolo = makeDocument();
        emptySolo.audioTracks.push({
            id: 'empty_track',
            name: 'Empty',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [],
        });
        const emptySoloSignature = getEditorAudioGraphSignature(emptySolo);
        emptySolo.audioTracks[1].solo = true;
        expect(getEditorAudioGraphSignature(emptySolo)).not.toBe(emptySoloSignature);
    });

    it('checks exact output-sample overlap and track gain', () => {
        const touching = makeDocument();
        touching.audioTracks[0].clips.push(makeImportedClip({ id: 'audio_clip_b', timelineStartFrame: 30 }));
        expect(validateEditorDocumentV3(touching).valid).toBe(true);

        touching.audioTracks[0].clips[1].timelineStartFrame = 29;
        touching.audioTracks[0].gainDb = 12.1;
        expect(validateEditorDocumentV3(touching).issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'overlapping-clips',
            'invalid-mix-controls',
        ]));
    });

    it('uses the same nearest-frame duration rule while validating detached clips', () => {
        const document = makeDocument();
        document.audioTracks[0].clips = [{
            id: 'short_detached',
            source: { kind: 'video-source-audio', videoSourceId: 'video_source_a' },
            timelineStartFrame: 0,
            sourceStart: 0,
            sourceEnd: 1.4 / 30,
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        }, {
            id: 'touching_detached',
            source: { kind: 'video-source-audio', videoSourceId: 'video_source_a' },
            timelineStartFrame: 1,
            sourceStart: 1,
            sourceEnd: 1 + 1.4 / 30,
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        }];
        expect(validateEditorDocumentV3(document).valid).toBe(true);
    });
});
