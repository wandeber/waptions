import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimationStyle, SubtitleTrack } from '@/types/timeline';
import type {
    AudioClip,
    AudioSourceAsset,
    AudioTrack,
    EditorManifestV4,
    VideoSourceAsset,
} from '@/types/video';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { createVideoSourceFingerprint } from '@/lib/video-timeline';
import { getEditorAudioGraphSignature, validateEditorManifestV3 } from '@/lib/editor-document-v3';
import {
    createDiarizationJobGuard,
    DIARIZATION_PROVENANCE_EXTENSION_KEY,
    getDiarizationProvenanceV1,
} from '@/lib/diarization-provenance';
import {
    createTimelinePersistencePayload,
    setTimelinePersistenceBinding,
    useTimelineStore,
} from './timeline-store';
import { useVideoStore } from './video-store';
import { useProjectStore } from './project-store';

const style = {} as AnimationStyle;

const subtitleTrack = (id = 'captions'): SubtitleTrack => ({
    id,
    name: 'Captions',
    style,
    subtitles: [],
    isVisible: true,
    isLocked: false,
});

const videoSource = (id = 'video_source', duration = 4, hasAudio = true): VideoSourceAsset => {
    const file = {
        name: `${id}.mp4`,
        type: 'video/mp4',
        size: 1_024,
        lastModified: 123,
    } as File;
    return {
        id,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: createVideoSourceFingerprint(file),
        duration,
        fps: 30,
        width: 1920,
        height: 1080,
        bitrate: null,
        hasAudio,
        file,
    };
};

const audioSource = (id = 'audio_source', duration = 2): AudioSourceAsset => ({
    id,
    originalName: `${id}.wav`,
    mimeType: 'audio/wav',
    size: 2_048,
    lastModified: 456,
    fingerprint: `fingerprint_${id}`,
    duration,
    nativeSampleRate: 48_000,
    nativeSampleCount: Math.round(duration * 48_000),
    nativeChannelCount: 2,
    bitrate: 1_536_000,
    codec: 'pcm_s16le',
    file: { name: `${id}.wav`, type: 'audio/wav', size: 2_048, lastModified: 456 } as File,
});

const independentClip = (
    id: string,
    sourceId: string,
    timelineStartFrame = 0,
    sourceStartSample = 0,
    sourceEndSample = 48_000,
): AudioClip => ({
    id,
    source: { kind: 'audio-source', audioSourceId: sourceId },
    timelineStartFrame,
    sourceStartSample,
    sourceEndSample,
    muted: false,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
});

const audioTrack = (id: string, clips: AudioClip[] = [], locked = false): AudioTrack => ({
    id,
    name: id,
    muted: false,
    solo: false,
    locked,
    gainDb: 0,
    clips,
});

const diarizedSpeaker = (sourceSpeakerLabel: string, id: string) => {
    const subtitle = { id, startTime: 0, endTime: 1, text: sourceSpeakerLabel };
    const containerId = `${id}-group`;
    return {
        sourceSpeakerLabel,
        subtitles: [subtitle],
        transcription: {
            raw: [subtitle],
            groups: { [containerId]: [subtitle] },
            containerIds: [containerId],
        },
    };
};

const diarizationMetadata = {
    provider: 'custom-openai-compatible',
    model: 'whisper-1',
    generatedAt: '2026-07-17T20:00:00.000Z',
};

const appendVideo = () => {
    const source = videoSource();
    useTimelineStore.getState().appendMixedMediaCandidate({
        videoSources: [source],
        videoClips: [{ id: 'video_clip', sourceId: source.id, sourceStart: 0, sourceEnd: 4 }],
    });
};

const resetStores = () => {
    setTimelinePersistenceBinding(null);
    useVideoStore.setState({ sourceHandles: {}, ownedObjectUrls: {}, isLoading: false });
    useTimelineStore.getState().resetEditorDocument();
    useTimelineStore.setState({
        history: [],
        redoStack: [],
        tracks: [],
        activeTrackId: null,
        transcriptionByTrackId: {},
        rawTranscription: null,
        transcriptionGroups: null,
        transcriptionContainerIds: null,
    });
};

describe('timeline store media and compatibility actions', () => {
    beforeEach(resetStores);

    it('persists video lanes and moves clips vertically as one history transaction without timing or audio changes', async () => {
        const source = videoSource('lane_source', 4, true);
        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [source],
            videoClips: [
                { id: 'clip_a', sourceId: source.id, sourceStart: 0, sourceEnd: 2 },
                { id: 'clip_b', sourceId: source.id, sourceStart: 2, sourceEnd: 4 },
            ],
        });
        expect(useTimelineStore.getState().videoTracks).toEqual([{
            id: 'video_track_1', name: 'Video 1', visible: true, locked: false, clipIds: ['clip_a', 'clip_b'],
        }]);

        useTimelineStore.getState().addVideoTrack('Upper video', 'video_track_2');
        useTimelineStore.setState({ history: [], redoStack: [], historySequence: 0, historyBytes: 0 });
        const before = useTimelineStore.getState();
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        before.moveVideoClipToTrack('clip_b', 'video_track_2');
        const moved = useTimelineStore.getState();

        expect(moved.videoTracks).toEqual([
            { id: 'video_track_1', name: 'Video 1', visible: true, locked: false, clipIds: ['clip_a'] },
            { id: 'video_track_2', name: 'Upper video', visible: true, locked: false, clipIds: ['clip_b'] },
        ]);
        expect(moved.videoClips).toEqual(before.videoClips.map((clip) => clip.id === 'clip_b'
            ? { ...clip, trackId: 'video_track_2' }
            : clip));
        expect(moved.audioGraphRevision).toBe(before.audioGraphRevision);
        expect(moved.contentBoundaryRevision).toBe(before.contentBoundaryRevision);
        expect(moved.transcriptionByTrackId).toBe(before.transcriptionByTrackId);
        expect(moved.history).toHaveLength(1);
        expect(enqueue).toHaveBeenCalledTimes(1);

        moved.moveVideoClipToTrack('clip_b', 'video_track_2');
        expect(useTimelineStore.getState().revision).toBe(moved.revision);
        expect(enqueue).toHaveBeenCalledTimes(1);

        await moved.undo();
        expect(useTimelineStore.getState().videoTracks).toEqual(before.videoTracks);
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().videoTracks).toEqual(moved.videoTracks);
    });

    it('couples video lane membership to split, delete, reorder, and create-and-move pruning', () => {
        const source = videoSource('coupled_source', 4, false);
        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [source],
            videoClips: [
                { id: 'clip_a', sourceId: source.id, sourceStart: 0, sourceEnd: 2 },
                { id: 'clip_b', sourceId: source.id, sourceStart: 2, sourceEnd: 4 },
            ],
        });
        useTimelineStore.getState().splitVideoClip('clip_a', 1, 'clip_right');
        expect(useTimelineStore.getState().videoTracks[0].clipIds).toEqual(['clip_a', 'clip_right', 'clip_b']);

        useTimelineStore.getState().addVideoTrack('Second', 'video_track_2');
        useTimelineStore.getState().moveVideoClipToTrack('clip_b', 'video_track_2');
        useTimelineStore.getState().reorderVideoClips(['clip_b', 'clip_a', 'clip_right']);
        expect(useTimelineStore.getState().videoTracks).toEqual([
            { id: 'video_track_1', name: 'Video 1', visible: true, locked: false, clipIds: ['clip_a', 'clip_right'] },
            { id: 'video_track_2', name: 'Second', visible: true, locked: false, clipIds: ['clip_b'] },
        ]);

        const historyCountBeforeCreateAndMove = useTimelineStore.getState().history.length;
        const newTrackId = useTimelineStore.getState().moveVideoClipToNewTrack(
            'clip_b',
            2,
            'video_track_3',
            'Third',
        );
        expect(newTrackId).toBe('video_track_3');
        expect(useTimelineStore.getState().history).toHaveLength(historyCountBeforeCreateAndMove + 1);
        expect(useTimelineStore.getState().videoTracks.map((track) => track.id)).toEqual([
            'video_track_1', 'video_track_3',
        ]);

        useTimelineStore.getState().deleteVideoClip('clip_b');
        expect(useTimelineStore.getState().videoTracks).toEqual([{
            id: 'video_track_1', name: 'Video 1', visible: true, locked: false, clipIds: ['clip_a', 'clip_right'],
        }]);
    });

    it('atomically replaces an emptied sole lane and preserves one lane after deleting its clip', () => {
        appendVideo();
        const before = useTimelineStore.getState();

        before.moveVideoClipToNewTrack('video_clip', 1, 'replacement_lane', 'Replacement');
        const moved = useTimelineStore.getState();
        expect(moved.videoTracks).toEqual([{
            id: 'replacement_lane', name: 'Replacement', visible: true, locked: false, clipIds: ['video_clip'],
        }]);
        expect(moved.videoClips).toEqual(before.videoClips.map((clip) => ({
            ...clip,
            trackId: 'replacement_lane',
        })));
        expect(moved.audioGraphRevision).toBe(before.audioGraphRevision);
        expect(moved.contentBoundaryRevision).toBe(before.contentBoundaryRevision);

        moved.deleteVideoClip('video_clip');
        expect(useTimelineStore.getState().videoTracks).toEqual([{
            id: 'replacement_lane', name: 'Replacement', visible: true, locked: false, clipIds: [],
        }]);
    });

    it('detaches linked video audio atomically and undo/redo restores one complete graph step', async () => {
        appendVideo();
        useTimelineStore.setState({ history: [], redoStack: [] });
        const before = useTimelineStore.getState();

        before.detachVideoClipAudio('video_clip', { trackId: 'detached_track', clipId: 'detached_clip' });
        const detached = useTimelineStore.getState();

        expect(detached.videoClips[0].audio?.linkState).toBe('detached');
        expect(detached.audioTracks).toMatchObject([{
            id: 'detached_track',
            name: 'Audio from video_source.mp4',
            clips: [{
                id: 'detached_clip',
                timelineStartFrame: 0,
                source: { kind: 'video-source-audio', videoSourceId: 'video_source' },
                sourceStart: 0,
                sourceEnd: 4,
            }],
        }]);
        expect(detached.revision).toBe(before.revision + 1);
        expect(detached.audioGraphRevision).toBe(before.audioGraphRevision + 1);
        expect(detached.history).toHaveLength(1);
        expect(validateEditorManifestV3(detached.buildEditorManifest())).toEqual({ valid: true, issues: [] });

        await detached.undo();
        const undone = useTimelineStore.getState();
        expect(undone.videoClips[0].audio?.linkState).toBe('linked');
        expect(undone.audioTracks).toEqual([]);
        expect(undone.audioGraphRevision).toBeGreaterThan(detached.audioGraphRevision);

        await undone.redo();
        expect(useTimelineStore.getState().videoClips[0].audio?.linkState).toBe('detached');
        expect(useTimelineStore.getState().audioTracks[0].clips[0].id).toBe('detached_clip');
    });

    it('keeps detached audio independent and repeated detach remains a strict no-op after deletion', () => {
        appendVideo();
        const store = useTimelineStore.getState();
        store.detachVideoClipAudio('video_clip', { trackId: 'detached_track', clipId: 'detached_clip' });
        useTimelineStore.getState().deleteAudioClip('detached_clip');
        const beforeRepeat = useTimelineStore.getState();

        beforeRepeat.detachVideoClipAudio('video_clip', { trackId: 'other_track', clipId: 'other_clip' });
        expect(useTimelineStore.getState().revision).toBe(beforeRepeat.revision);
        expect(useTimelineStore.getState().audioTracks.flatMap((track) => track.clips)).toEqual([]);

        beforeRepeat.trimVideoClip('video_clip', 1, 3);
        expect(useTimelineStore.getState().audioTracks.flatMap((track) => track.clips)).toEqual([]);
    });

    it('splits linked clips as linked and detached clips as detached without editing independent audio', () => {
        appendVideo();
        useTimelineStore.getState().splitVideoClip('video_clip', 2, 'linked_right');
        expect(useTimelineStore.getState().videoClips.map((clip) => clip.audio?.linkState)).toEqual(['linked', 'linked']);

        useTimelineStore.getState().detachVideoClipAudio('linked_right', {
            trackId: 'detached_track',
            clipId: 'detached_clip',
        });
        useTimelineStore.getState().splitVideoClip('linked_right', 3, 'detached_right');
        const state = useTimelineStore.getState();
        expect(state.videoClips.slice(1).map((clip) => clip.audio?.linkState)).toEqual(['detached', 'detached']);
        expect(state.audioTracks[0].clips).toHaveLength(1);
        expect(state.audioTracks[0].clips[0].id).toBe('detached_clip');
    });

    it.each([
        { linkState: 'linked' as const, detach: false },
        { linkState: 'detached' as const, detach: true },
    ])('redistributes $linkState video fades away from the artificial split seam', ({ linkState, detach }) => {
        appendVideo();
        useTimelineStore.getState().updateVideoClipAudio('video_clip', {
            fadeInFrames: 50,
            fadeOutFrames: 70,
        });
        if (detach) {
            useTimelineStore.getState().detachVideoClipAudio('video_clip', {
                trackId: 'detached_track',
                clipId: 'detached_clip',
            });
        }

        useTimelineStore.getState().splitVideoClip('video_clip', 1, 'right_clip');

        const state = useTimelineStore.getState();
        expect(state.videoClips.map((clip) => clip.audio)).toMatchObject([
            { linkState, fadeInFrames: 30, fadeOutFrames: 0 },
            { linkState, fadeInFrames: 0, fadeOutFrames: 70 },
        ]);
        expect(validateEditorManifestV3(state.buildEditorManifest())).toEqual({ valid: true, issues: [] });
    });

    it.each([
        { linkState: 'linked' as const, detach: false },
        { linkState: 'detached' as const, detach: true },
    ])('clamps $linkState video fades deterministically after trim', ({ linkState, detach }) => {
        appendVideo();
        useTimelineStore.getState().updateVideoClipAudio('video_clip', {
            muted: true,
            gainDb: -4,
            fadeInFrames: 80,
            fadeOutFrames: 40,
        });
        if (detach) {
            useTimelineStore.getState().detachVideoClipAudio('video_clip', {
                trackId: 'detached_track',
                clipId: 'detached_clip',
            });
        }

        useTimelineStore.getState().trimVideoClip('video_clip', 1, 2);

        const state = useTimelineStore.getState();
        expect(state.videoClips[0].audio).toEqual({
            linkState,
            muted: true,
            gainDb: -4,
            fadeInFrames: 20,
            fadeOutFrames: 10,
        });
        expect(validateEditorManifestV3(state.buildEditorManifest())).toEqual({ valid: true, issues: [] });
    });

    it('treats boundary and duplicate video splits as strict terminal no-ops', () => {
        appendVideo();
        useTimelineStore.setState({ history: [], redoStack: [] });
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const before = useTimelineStore.getState();

        before.splitVideoClip('video_clip', 0, 'boundary_right');
        before.splitVideoClip('video_clip', 4, 'end_right');
        before.splitVideoClip('video_clip', 2, 'video_clip');

        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().history).toEqual([]);
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('treats boundary and duplicate audio splits as strict terminal no-ops', () => {
        appendVideo();
        const source = audioSource();
        useTimelineStore.getState().appendMixedMediaCandidate({
            audioSources: [source],
            audioTracks: [audioTrack('audio_track', [independentClip('audio_clip', source.id)])],
        });
        useTimelineStore.setState({ history: [], redoStack: [] });
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const before = useTimelineStore.getState();

        before.splitAudioClip('audio_clip', 0, 'boundary_right');
        before.splitAudioClip('audio_clip', 30, 'end_right');
        before.splitAudioClip('audio_clip', 15, 'audio_clip');

        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().history).toEqual([]);
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('rejects audio-first projects but imports a mixed batch in one history and revision step', () => {
        const audio = audioSource();
        expect(() => useTimelineStore.getState().appendMixedMediaCandidate({ audioSources: [audio] }))
            .toThrow('Import a video first to establish the project frame rate and canvas size.');

        const video = videoSource();
        const before = useTimelineStore.getState();
        before.appendMixedMediaCandidate({
            videoSources: [video],
            videoClips: [{ id: 'video_clip', sourceId: video.id, sourceStart: 0, sourceEnd: 4 }],
            audioSources: [audio],
            insertionFrame: 45,
        });
        const state = useTimelineStore.getState();
        expect(state.renderProfile.isFrameRateLocked).toBe(true);
        expect(state.audioTracks).toHaveLength(1);
        expect(state.audioTracks[0].clips[0]).toMatchObject({
            timelineStartFrame: 45,
            sourceStartSample: 0,
            sourceEndSample: audio.nativeSampleCount,
        });
        expect(state.history).toHaveLength(1);
        expect(state.revision).toBe(before.revision + 1);
    });

    it('derives exact runtime FPS from the canonical imported profile across undo and redo', async () => {
        const video = { ...videoSource(), fps: 24_000 / 1_001 };

        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [video],
            videoClips: [{ id: 'video_clip', sourceId: video.id, sourceStart: 0, sourceEnd: 4 }],
        });
        expect(useTimelineStore.getState()).toMatchObject({
            projectFps: 24_000 / 1_001,
            renderProfile: { fps: { numerator: 24_000, denominator: 1_001 } },
        });

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState()).toMatchObject({
            projectFps: 30,
            renderProfile: { fps: { numerator: 30, denominator: 1 } },
        });
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState()).toMatchObject({
            projectFps: 24_000 / 1_001,
            renderProfile: { fps: { numerator: 24_000, denominator: 1_001 } },
        });
    });

    it('caps patch history at five hundred commands and shares that budget with redo', async () => {
        useTimelineStore.getState().setTracks([subtitleTrack()], { resetHistory: true, skipSave: true });
        for (let index = 1; index <= 510; index += 1) {
            useTimelineStore.getState().addSubtitleToTrack('captions', {
                startTime: index,
                endTime: index + 0.5,
                text: `${index}`,
            });
        }

        expect(useTimelineStore.getState().history).toHaveLength(500);
        expect(useTimelineStore.getState().history[0].label).toBe('Add subtitle');
        for (let index = 0; index < 40; index += 1) await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().history).toHaveLength(460);
        expect(useTimelineStore.getState().redoStack).toHaveLength(40);
        expect(useTimelineStore.getState().history.length + useTimelineStore.getState().redoStack.length)
            .toBe(500);
    });

    it('preserves redo through no-op previews and invalidates it only on a changed commit', async () => {
        useTimelineStore.getState().setTracks([subtitleTrack()], { resetHistory: true, skipSave: true });
        useTimelineStore.getState().updateTrackName('captions', 'Changed');
        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().redoStack).toHaveLength(1);

        useTimelineStore.getState().updateTrackName('captions', 'Captions');
        useTimelineStore.getState().setIsDragging(true, { label: 'Move subtitles' });
        useTimelineStore.getState().setIsDragging(false);
        expect(useTimelineStore.getState().redoStack).toHaveLength(1);

        useTimelineStore.getState().updateTrackName('captions', 'Committed branch');
        expect(useTimelineStore.getState().redoStack).toEqual([]);
    });

    it('keeps video and audio source IDs in independent typed namespaces', () => {
        const sharedId = 'shared_source';
        const video = videoSource(sharedId);
        const audio = audioSource(sharedId);

        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [video],
            videoClips: [{ id: 'video_clip', sourceId: sharedId, sourceStart: 0, sourceEnd: 4 }],
            audioSources: [audio],
        });

        expect(useTimelineStore.getState().videoSources[0].id).toBe(sharedId);
        expect(useTimelineStore.getState().audioSources[0].id).toBe(sharedId);
    });

    it('keeps imported source catalogs outside undo while restoring their editable graph', async () => {
        const video = videoSource();
        const audio = audioSource();
        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [video],
            videoClips: [{ id: 'video_clip', sourceId: video.id, sourceStart: 0, sourceEnd: 4 }],
            audioSources: [audio],
        });

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState()).toMatchObject({
            videoSources: [{ id: video.id }],
            audioSources: [{ id: audio.id }],
            videoClips: [],
            audioTracks: [],
        });

        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().videoClips).toHaveLength(1);
        expect(useTimelineStore.getState().audioTracks).toHaveLength(1);
    });

    it('enforces same-track collisions and locks while allowing cross-track moves', () => {
        appendVideo();
        const source = audioSource();
        useTimelineStore.getState().appendMixedMediaCandidate({
            audioSources: [source],
            audioTracks: [
                audioTrack('track_a', [independentClip('clip_a', source.id, 0)]),
                audioTrack('track_b', [independentClip('clip_b', source.id, 60)]),
            ],
        });

        const beforeCollision = useTimelineStore.getState().revision;
        useTimelineStore.getState().moveAudioClip('clip_b', 'track_a', 15);
        expect(useTimelineStore.getState().revision).toBe(beforeCollision);

        useTimelineStore.getState().moveAudioClip('clip_b', 'track_a', 60);
        expect(useTimelineStore.getState().audioTracks.find((track) => track.id === 'track_a')?.clips)
            .toHaveLength(2);

        useTimelineStore.getState().setAudioTrackLocked('track_a', true);
        const beforeLockedMove = useTimelineStore.getState().revision;
        useTimelineStore.getState().moveAudioClip('clip_b', 'track_b', 90);
        expect(useTimelineStore.getState().revision).toBe(beforeLockedMove);
    });

    it('invalidates provenance only for the declared audio graph controls', () => {
        appendVideo();
        useTimelineStore.getState().setTracks([subtitleTrack()], { resetHistory: true, skipSave: true });
        useTimelineStore.getState().setTrackTranscriptionState('captions', {
            raw: [],
            groups: {},
            containerIds: [],
        });
        const fresh = useTimelineStore.getState();
        const graphRevision = fresh.audioGraphRevision;

        fresh.updateVideoClipAudio('video_clip', { gainDb: -3, fadeInFrames: 2 });
        expect(useTimelineStore.getState().audioGraphRevision).toBe(graphRevision);
        expect(useTimelineStore.getState().transcriptionByTrackId.captions.stale).toBe(false);

        useTimelineStore.getState().updateVideoClipAudio('video_clip', { muted: true });
        expect(useTimelineStore.getState().audioGraphRevision).toBe(graphRevision + 1);
        expect(useTimelineStore.getState().transcriptionByTrackId.captions.stale).toBe(true);
    });

    it('clamps linked video fades to the nearest canonical frame count', () => {
        const source = videoSource('fractional_video', 1.01);
        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [source],
            videoClips: [{
                id: 'fractional_clip',
                sourceId: source.id,
                sourceStart: 0,
                sourceEnd: 1.01,
            }],
        });

        useTimelineStore.getState().updateVideoClipAudio('fractional_clip', {
            fadeInFrames: 100,
            fadeOutFrames: 100,
        });

        const audio = useTimelineStore.getState().videoClips[0].audio!;
        expect(audio.fadeInFrames + audio.fadeOutFrames).toBe(30);
    });

    it('accepts transcription after unrelated lane edits but rejects target or graph changes', () => {
        appendVideo();
        useTimelineStore.getState().setTracks([
            subtitleTrack('target'),
            subtitleTrack('other'),
        ], { resetHistory: true, skipSave: true });
        const transcription = { raw: [], groups: {}, containerIds: [] };

        const unrelatedGuard = useTimelineStore.getState().createTranscriptionGuard('target')!;
        useTimelineStore.getState().updateTrackName('other', 'Other renamed');
        expect(useTimelineStore.getState().replaceTrackWithTranscription(
            'target',
            [{ id: 'generated', text: 'Generated', startTime: 0, endTime: 1 }],
            transcription,
            unrelatedGuard,
        )).toBe(true);

        const gainGuard = useTimelineStore.getState().createTranscriptionGuard('target')!;
        useTimelineStore.getState().updateVideoClipAudio('video_clip', { gainDb: -6, fadeInFrames: 2 });
        expect(useTimelineStore.getState().replaceTrackWithTranscription(
            'target',
            [{ id: 'generated_gain', text: 'Generated after gain', startTime: 0, endTime: 1 }],
            transcription,
            gainGuard,
        )).toBe(true);

        const targetGuard = useTimelineStore.getState().createTranscriptionGuard('target')!;
        useTimelineStore.getState().updateTrackName('target', 'Target renamed');
        expect(useTimelineStore.getState().replaceTrackWithTranscription(
            'target', [], transcription, targetGuard,
        )).toBe(false);

        const graphGuard = useTimelineStore.getState().createTranscriptionGuard('target')!;
        useTimelineStore.getState().updateVideoClipAudio('video_clip', { muted: true });
        expect(useTimelineStore.getState().replaceTrackWithTranscription(
            'target', [], transcription, graphGuard,
        )).toBe(false);
    });

    it('creates a diarized speaker set as one durable history and persistence transaction', async () => {
        const originalTarget = {
            ...subtitleTrack('target'),
            name: 'Interview captions',
            timingDomain: 'absolute' as const,
            isVisible: false,
            isLocked: true,
            subtitles: [{ id: 'old-subtitle', startTime: 0, endTime: 2, text: 'Old' }],
        };
        useTimelineStore.getState().setTracks([
            originalTarget,
            subtitleTrack('unrelated'),
        ], { resetHistory: true, skipSave: true });
        useTimelineStore.setState({
            selectedSubtitleIds: ['old-subtitle'],
            lastSelectedId: 'old-subtitle',
            transientSelection: { kind: 'subtitles', trackId: 'target', subtitleIds: ['old-subtitle'] },
        });
        const beforeTracks = structuredClone(useTimelineStore.getState().tracks);
        const before = useTimelineStore.getState().buildEditorDocument();
        const guard = createDiarizationJobGuard(before, 'target')!;
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const randomUUID = vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('set-generated')
            .mockReturnValueOnce('speaker-track-2')
            .mockReturnValueOnce('speaker-track-3');

        expect(useTimelineStore.getState().replaceTrackSetWithDiarizedTranscription(
            'target',
            [
                diarizedSpeaker('SPEAKER_00', 'speaker-a'),
                diarizedSpeaker('SPEAKER_01', 'speaker-b'),
                diarizedSpeaker('SPEAKER_02', 'speaker-c'),
            ],
            diarizationMetadata,
            guard,
        )).toBe(true);
        randomUUID.mockRestore();

        const applied = useTimelineStore.getState();
        expect(applied.tracks.map((track) => track.id)).toEqual([
            'target', 'speaker-track-2', 'speaker-track-3', 'unrelated',
        ]);
        expect(applied.tracks.slice(0, 3).map((track) => track.subtitles[0].text)).toEqual([
            'SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02',
        ]);
        expect(applied.tracks[0]).toMatchObject({
            id: 'target', name: 'Interview captions', isVisible: false, isLocked: true, timingDomain: 'absolute',
        });
        expect(applied.tracks[1]).toMatchObject({
            id: 'speaker-track-2', name: 'Speaker 2', isVisible: false, isLocked: true, timingDomain: 'absolute',
        });
        const extensions = applied.tracks.slice(0, 3).map((track) => (
            getDiarizationProvenanceV1(applied.transcriptionByTrackId[track.id])
        ));
        expect(extensions).toEqual([
            expect.objectContaining({ setId: 'set-generated', targetTrackId: 'target', speakerOrdinal: 0 }),
            expect.objectContaining({ setId: 'set-generated', targetTrackId: 'target', speakerOrdinal: 1 }),
            expect.objectContaining({ setId: 'set-generated', targetTrackId: 'target', speakerOrdinal: 2 }),
        ]);
        expect(Object.values(applied.transcriptionByTrackId).every((entry) => entry.stale === false)).toBe(true);
        expect(applied.selectedSubtitleIds).toEqual([]);
        expect(applied.lastSelectedId).toBeNull();
        expect(applied.transientSelection).toEqual({ kind: 'none' });
        expect(applied.history).toHaveLength(1);
        expect(applied.history[0].label).toBe('Replace subtitles with diarized transcription');
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(validateEditorManifestV3(applied.buildEditorManifest())).toEqual({ valid: true, issues: [] });
        const appliedTracks = structuredClone(applied.tracks);
        const appliedProvenance = structuredClone(applied.transcriptionByTrackId);

        await applied.undo();
        expect(useTimelineStore.getState().tracks).toEqual(beforeTracks);
        expect(useTimelineStore.getState().transcriptionByTrackId).toEqual({});
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().tracks).toEqual(appliedTracks);
        expect(useTimelineStore.getState().transcriptionByTrackId).toEqual(appliedProvenance);
    });

    it('reuses speaker track identities across same-size, grow, and shrink reruns', () => {
        useTimelineStore.getState().setTracks([
            subtitleTrack('target'),
            subtitleTrack('unrelated'),
        ], { resetHistory: true, skipSave: true });
        const randomUUID = vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('stable-set')
            .mockReturnValueOnce('stable-speaker-2')
            .mockReturnValueOnce('stable-speaker-3');

        const run = (speakers: ReturnType<typeof diarizedSpeaker>[]) => {
            const state = useTimelineStore.getState();
            const guard = createDiarizationJobGuard(state.buildEditorDocument(), state.activeTrackId!)!;
            return state.replaceTrackSetWithDiarizedTranscription(
                state.activeTrackId!, speakers, diarizationMetadata, guard,
            );
        };
        expect(run([
            diarizedSpeaker('A', 'first-a'),
            diarizedSpeaker('B', 'first-b'),
        ])).toBe(true);
        const firstIds = useTimelineStore.getState().tracks.slice(0, 2).map((track) => track.id);

        const provenanceWithUnknownExtension = structuredClone(
            useTimelineStore.getState().transcriptionByTrackId,
        );
        provenanceWithUnknownExtension.target.extensions!.futureProviderData = { retained: ['yes'] };
        provenanceWithUnknownExtension.target.stale = true;
        useTimelineStore.setState({ transcriptionByTrackId: provenanceWithUnknownExtension });
        expect(run([
            diarizedSpeaker('RENAMED_A', 'second-a'),
            diarizedSpeaker('RENAMED_B', 'second-b'),
        ])).toBe(true);
        expect(useTimelineStore.getState().tracks.slice(0, 2).map((track) => track.id)).toEqual(firstIds);
        expect(useTimelineStore.getState().transcriptionByTrackId.target.extensions?.futureProviderData)
            .toEqual({ retained: ['yes'] });
        expect(useTimelineStore.getState().transcriptionByTrackId.target.stale).toBe(false);

        expect(run([
            diarizedSpeaker('A', 'third-a'),
            diarizedSpeaker('B', 'third-b'),
            diarizedSpeaker('C', 'third-c'),
        ])).toBe(true);
        expect(useTimelineStore.getState().tracks.slice(0, 3).map((track) => track.id)).toEqual([
            ...firstIds, 'stable-speaker-3',
        ]);

        expect(run([diarizedSpeaker('A', 'fourth-a')])).toBe(true);
        const shrunk = useTimelineStore.getState();
        expect(shrunk.tracks.map((track) => track.id)).toEqual(['target', 'unrelated']);
        expect(Object.keys(shrunk.transcriptionByTrackId)).toEqual(['target']);
        expect(getDiarizationProvenanceV1(shrunk.transcriptionByTrackId.target)).toMatchObject({
            setId: 'stable-set', targetTrackId: 'target', speakerOrdinal: 0,
        });
        randomUUID.mockRestore();
    });

    it('promotes a selected nonzero member to the anchor without duplicates or orphan provenance', () => {
        useTimelineStore.getState().setTracks([
            subtitleTrack('target'),
            subtitleTrack('unrelated'),
        ], { resetHistory: true, skipSave: true });
        const randomUUID = vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('promoted-set')
            .mockReturnValueOnce('member-two')
            .mockReturnValueOnce('member-three');
        const initialState = useTimelineStore.getState();
        const initialGuard = createDiarizationJobGuard(initialState.buildEditorDocument(), 'target')!;
        expect(initialState.replaceTrackSetWithDiarizedTranscription(
            'target',
            [
                diarizedSpeaker('A', 'initial-a'),
                diarizedSpeaker('B', 'initial-b'),
                diarizedSpeaker('C', 'initial-c'),
            ],
            diarizationMetadata,
            initialGuard,
        )).toBe(true);
        useTimelineStore.getState().setActiveTrackId('member-two');
        const rerunState = useTimelineStore.getState();
        const rerunGuard = createDiarizationJobGuard(rerunState.buildEditorDocument(), 'member-two')!;
        expect(rerunState.replaceTrackSetWithDiarizedTranscription(
            'member-two',
            [diarizedSpeaker('B', 'rerun-b'), diarizedSpeaker('A', 'rerun-a')],
            diarizationMetadata,
            rerunGuard,
        )).toBe(true);
        randomUUID.mockRestore();

        const promoted = useTimelineStore.getState();
        expect(promoted.activeTrackId).toBe('member-two');
        expect(promoted.tracks.map((track) => track.id)).toEqual(['member-two', 'target', 'unrelated']);
        expect(new Set(promoted.tracks.map((track) => track.id)).size).toBe(promoted.tracks.length);
        expect(Object.keys(promoted.transcriptionByTrackId).sort()).toEqual(['member-two', 'target']);
        expect(Object.entries(promoted.transcriptionByTrackId).map(([trackId, entry]) => ({
            trackId,
            extension: getDiarizationProvenanceV1(entry),
        }))).toEqual(expect.arrayContaining([
            expect.objectContaining({
                trackId: 'member-two',
                extension: expect.objectContaining({ targetTrackId: 'member-two', speakerOrdinal: 0 }),
            }),
            expect.objectContaining({
                trackId: 'target',
                extension: expect.objectContaining({ targetTrackId: 'member-two', speakerOrdinal: 1 }),
            }),
        ]));
    });

    it('rejects stale diarization guards before allocating IDs or publishing partial state', () => {
        useTimelineStore.getState().setTracks([
            subtitleTrack('target'),
            subtitleTrack('unrelated'),
        ], { resetHistory: true, skipSave: true });
        const guard = createDiarizationJobGuard(
            useTimelineStore.getState().buildEditorDocument(),
            'target',
        )!;
        useTimelineStore.getState().updateTrackName('target', 'Changed during request');
        const before = useTimelineStore.getState();
        const randomUUID = vi.spyOn(crypto, 'randomUUID');

        expect(before.replaceTrackSetWithDiarizedTranscription(
            'target',
            [diarizedSpeaker('A', 'stale-a'), diarizedSpeaker('B', 'stale-b')],
            diarizationMetadata,
            guard,
        )).toBe(false);
        expect(randomUUID).not.toHaveBeenCalled();
        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().history).toHaveLength(before.history.length);
        expect(useTimelineStore.getState().transcriptionByTrackId).toEqual(before.transcriptionByTrackId);
        randomUUID.mockRestore();
    });

    it('applies around an unrelated durable edit without relying on the global revision', () => {
        useTimelineStore.getState().setTracks([
            subtitleTrack('target'),
            subtitleTrack('unrelated'),
        ], { resetHistory: true, skipSave: true });
        const guard = createDiarizationJobGuard(
            useTimelineStore.getState().buildEditorDocument(),
            'target',
        )!;
        useTimelineStore.getState().updateTrackName('unrelated', 'Edited during request');
        const unrelatedId = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('added-during-request');
        useTimelineStore.getState().addTrack('Added during request');
        unrelatedId.mockRestore();
        // Adding a lane makes it active; returning to the original target keeps this an unrelated
        // graph change while still satisfying the explicit active-track publication guard.
        useTimelineStore.getState().setActiveTrackId('target');
        const afterUnrelatedRevision = useTimelineStore.getState().revision;
        const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('unrelated-safe-set');

        expect(useTimelineStore.getState().replaceTrackSetWithDiarizedTranscription(
            'target',
            [diarizedSpeaker('A', 'unrelated-safe-a')],
            diarizationMetadata,
            guard,
        )).toBe(true);
        randomUUID.mockRestore();
        expect(useTimelineStore.getState().revision).toBe(afterUnrelatedRevision + 1);
        expect(useTimelineStore.getState().tracks.find((track) => track.id === 'unrelated')?.name)
            .toBe('Edited during request');
        expect(useTimelineStore.getState().tracks.some((track) => track.id === 'added-during-request'))
            .toBe(true);
        expect(useTimelineStore.getState().activeTrackId).toBe('target');
    });

    it('rejects publication after the active subtitle track changes without any durable side effect', () => {
        useTimelineStore.getState().setTracks([
            subtitleTrack('target'),
            subtitleTrack('other'),
        ], { resetHistory: true, skipSave: true });
        const guard = createDiarizationJobGuard(
            useTimelineStore.getState().buildEditorDocument(),
            'target',
        )!;
        useTimelineStore.getState().setActiveTrackId('other');
        const before = useTimelineStore.getState();
        const beforeTracks = structuredClone(before.tracks);
        const beforeHistory = structuredClone(before.history);
        const beforeRedo = structuredClone(before.redoStack);
        const beforeProvenance = structuredClone(before.transcriptionByTrackId);
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const randomUUID = vi.spyOn(crypto, 'randomUUID');

        expect(before.replaceTrackSetWithDiarizedTranscription(
            'target',
            [diarizedSpeaker('A', 'active-changed-a')],
            diarizationMetadata,
            guard,
        )).toBe(false);
        randomUUID.mockRestore();

        const rejected = useTimelineStore.getState();
        expect(rejected.tracks).toEqual(beforeTracks);
        expect(rejected.activeTrackId).toBe('other');
        expect(rejected.revision).toBe(before.revision);
        expect(rejected.history).toEqual(beforeHistory);
        expect(rejected.redoStack).toEqual(beforeRedo);
        expect(rejected.transcriptionByTrackId).toEqual(beforeProvenance);
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('does not overwrite an unknown future diarization extension on the selected target', () => {
        useTimelineStore.getState().setTracks([
            subtitleTrack('target'),
        ], { resetHistory: true, skipSave: true });
        const guard = createDiarizationJobGuard(
            useTimelineStore.getState().buildEditorDocument(),
            'target',
        )!;
        const current = useTimelineStore.getState();
        useTimelineStore.setState({
            transcriptionByTrackId: {
                target: {
                    raw: [],
                    groups: {},
                    containerIds: [],
                    sourceDocumentRevision: current.revision,
                    sourceAudioGraphRevision: current.audioGraphRevision,
                    sourceAudioGraphSignature: getEditorAudioGraphSignature(current.buildEditorDocument()),
                    stale: false,
                    extensions: {
                        [DIARIZATION_PROVENANCE_EXTENSION_KEY]: { version: 2, opaque: 'retain-me' },
                    },
                },
            },
        });
        const before = useTimelineStore.getState();
        const randomUUID = vi.spyOn(crypto, 'randomUUID');

        expect(before.replaceTrackSetWithDiarizedTranscription(
            'target',
            [diarizedSpeaker('A', 'future-a')],
            diarizationMetadata,
            guard,
        )).toBe(false);
        expect(randomUUID).not.toHaveBeenCalled();
        expect(useTimelineStore.getState().transcriptionByTrackId).toEqual(before.transcriptionByTrackId);
        randomUUID.mockRestore();
    });

    it('builds and enqueues a typed V4 manifest with both source kinds', () => {
        const calls: Array<{ manifest: EditorManifestV4; assets: readonly EditorPersistentAsset[] }> = [];
        setTimelinePersistenceBinding({
            projectId: 'project',
            generation: 1,
            enqueue: () => undefined,
            enqueueV4: (manifest, assets) => calls.push({ manifest, assets }),
        });
        const video = videoSource();
        const audio = audioSource();

        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [video],
            videoClips: [{ id: 'video_clip', sourceId: video.id, sourceStart: 0, sourceEnd: 4 }],
            audioSources: [audio],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].manifest).toMatchObject({ version: 4, revision: useTimelineStore.getState().revision });
        expect(calls[0].assets.map((entry) => entry.kind)).toEqual(['video-source', 'audio-source']);
        expect(useTimelineStore.getState().buildEditorDocument().version).toBe(3);
    });

    it('does not create history, revisions, or writes for locked/no-op operations', () => {
        appendVideo();
        const source = audioSource();
        useTimelineStore.getState().appendMixedMediaCandidate({
            audioSources: [source],
            audioTracks: [audioTrack('locked_track', [independentClip('locked_clip', source.id)], true)],
        });
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const before = useTimelineStore.getState();

        before.trimAudioClip('locked_clip', 'right', 15);
        before.deleteAudioClip('locked_clip');
        before.renameAudioTrack('locked_track', 'Changed');
        before.setTracks(structuredClone(before.tracks));

        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().history).toHaveLength(before.history.length);
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('finalizes representative durable commands exactly once and transient commands zero times', async () => {
        const video = videoSource();
        const audio = audioSource();
        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [video],
            videoClips: [{ id: 'video_clip', sourceId: video.id, sourceStart: 0, sourceEnd: 4 }],
            audioSources: [audio],
            audioTracks: [audioTrack('imported_track', [independentClip('imported_clip', audio.id)])],
        });
        useTimelineStore.setState({
            tracks: [{
                ...subtitleTrack(),
                subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'Before' }],
            }],
            activeTrackId: 'captions',
            history: [],
            redoStack: [],
        });
        useTimelineStore.getState().addAudioTrack('Target', 'target_track');
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });

        const expectSingleDurableStep = (command: () => void) => {
            const before = useTimelineStore.getState();
            const beforeHistory = before.history.length;
            enqueue.mockClear();
            command();
            expect(useTimelineStore.getState().revision).toBe(before.revision + 1);
            expect(useTimelineStore.getState().history).toHaveLength(beforeHistory + 1);
            expect(enqueue).toHaveBeenCalledTimes(1);
        };

        expectSingleDurableStep(() => useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { text: 'After' },
        ));
        // Continuous style widgets send only their terminal value to the store. One such terminal
        // must therefore map to one history entry, one revision, and one persistence enqueue.
        expectSingleDurableStep(() => useTimelineStore.getState().updateTrackStyle(
            'captions', { strokeWidth: 6.5 },
        ));
        expectSingleDurableStep(() => useTimelineStore.getState().updateTrackStyle(
            'captions', { textColor: '#123456' },
        ));
        expectSingleDurableStep(() => useTimelineStore.getState().trimVideoClip('video_clip', 0.5, 4));
        expectSingleDurableStep(() => useTimelineStore.getState().detachVideoClipAudio(
            'video_clip', { trackId: 'detached_track', clipId: 'detached_clip' },
        ));
        expectSingleDurableStep(() => useTimelineStore.getState().moveAudioClip(
            'imported_clip', 'target_track', 30,
        ));

        enqueue.mockClear();
        const beforeSelection = useTimelineStore.getState();
        beforeSelection.selectAudioClip('target_track', 'imported_clip');
        beforeSelection.setIsDragging(true, { label: 'Move subtitles' });
        expect(useTimelineStore.getState().revision).toBe(beforeSelection.revision);
        expect(enqueue).not.toHaveBeenCalled();
        useTimelineStore.getState().setIsDragging(false);

        enqueue.mockClear();
        const beforeUndoRevision = useTimelineStore.getState().revision;
        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().revision).toBe(beforeUndoRevision + 1);
        expect(enqueue).toHaveBeenCalledTimes(1);

        enqueue.mockClear();
        const beforeRedoRevision = useTimelineStore.getState().revision;
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().revision).toBe(beforeRedoRevision + 1);
        expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('folds subtitle drag previews into one terminal durable mutation', () => {
        useTimelineStore.setState({
            tracks: [{
                ...subtitleTrack(),
                subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'Drag me' }],
            }],
            activeTrackId: 'captions',
            history: [],
            redoStack: [],
        });
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const before = useTimelineStore.getState();

        before.setIsDragging(true, { label: 'Move subtitles' });
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 1, endTime: 2 }, { skipHistory: true },
        );
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 2, endTime: 3 }, { skipHistory: true },
        );

        expect(useTimelineStore.getState()).toMatchObject({
            revision: before.revision,
            history: [],
        });
        expect(enqueue).not.toHaveBeenCalled();

        useTimelineStore.getState().setIsDragging(false);
        expect(useTimelineStore.getState()).toMatchObject({
            revision: before.revision + 1,
            tracks: [{ subtitles: [{ startTime: 2, endTime: 3 }] }],
        });
        expect(useTimelineStore.getState().history).toHaveLength(1);
        expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('rebases a subtitle drag over interleaved durable edits with chronological undo history', async () => {
        useTimelineStore.setState({
            tracks: [{
                ...subtitleTrack(),
                subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'Before' }],
            }],
            activeTrackId: 'captions',
            history: [],
            redoStack: [],
        });
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const initialRevision = useTimelineStore.getState().revision;

        useTimelineStore.getState().setIsDragging(true, { label: 'Move subtitles' });
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 2, endTime: 3 }, { skipHistory: true },
        );
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { text: 'Concurrent' },
        );
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 3, endTime: 4 }, { skipHistory: true },
        );
        useTimelineStore.getState().setIsDragging(false);

        expect(useTimelineStore.getState()).toMatchObject({
            revision: initialRevision + 2,
            tracks: [{ subtitles: [{ startTime: 3, endTime: 4, text: 'Concurrent' }] }],
        });
        expect(useTimelineStore.getState().history).toHaveLength(2);
        expect(enqueue).toHaveBeenCalledTimes(2);

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0]).toMatchObject({
            startTime: 0,
            endTime: 1,
            text: 'Concurrent',
        });
        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().tracks[0].subtitles[0]).toMatchObject({
            startTime: 0,
            endTime: 1,
            text: 'Before',
        });
    });

    it('discards timing previews before undo and redo and ignores late pointer moves and releases', async () => {
        useTimelineStore.setState({
            tracks: [
                {
                    ...subtitleTrack(),
                    subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'Timed' }],
                },
                subtitleTrack('secondary'),
            ],
            activeTrackId: 'captions',
            history: [],
            redoStack: [],
            isDragging: false,
        });
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const initialRevision = useTimelineStore.getState().revision;

        useTimelineStore.getState().updateTrackName('captions', 'Renamed');
        expect(useTimelineStore.getState().revision).toBe(initialRevision + 1);
        expect(useTimelineStore.getState().history).toHaveLength(1);
        expect(useTimelineStore.getState().history[0].label).toBe('Rename subtitle track');
        expect(useTimelineStore.getState().redoStack).toEqual([]);
        expect(enqueue).toHaveBeenCalledTimes(1);

        useTimelineStore.getState().setIsDragging(true, { label: 'Move subtitles' });
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 2, endTime: 3 }, { skipHistory: true },
        );
        expect(useTimelineStore.getState().tracks[0].subtitles[0]).toMatchObject({ startTime: 2, endTime: 3 });

        await useTimelineStore.getState().undo();
        expect(useTimelineStore.getState().revision).toBe(initialRevision + 2);
        expect(useTimelineStore.getState().isDragging).toBe(false);
        expect(useTimelineStore.getState().tracks[0]).toMatchObject({
            name: 'Captions',
            subtitles: [{ startTime: 0, endTime: 1 }],
        });
        expect(useTimelineStore.getState().tracks[1].subtitles).toEqual([]);
        expect(useTimelineStore.getState().history).toEqual([]);
        expect(useTimelineStore.getState().redoStack).toHaveLength(1);
        expect(useTimelineStore.getState().redoStack[0].label).toBe('Rename subtitle track');
        expect(enqueue).toHaveBeenCalledTimes(2);
        const afterUndo = useTimelineStore.getState();

        // The overlay's window listener may still deliver one final mousemove after the history
        // command. Both horizontal timing and vertical lane updates must remain preview-only and
        // therefore reject that stale delivery without even replacing the Zustand state object.
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 8, endTime: 9 }, { skipHistory: true },
        );
        useTimelineStore.getState().moveSubtitlesToTrack(['subtitle'], 1, { skipHistory: true });
        expect(useTimelineStore.getState()).toBe(afterUndo);
        expect(enqueue).toHaveBeenCalledTimes(2);

        useTimelineStore.getState().setIsDragging(false);
        expect(useTimelineStore.getState()).toBe(afterUndo);
        expect(enqueue).toHaveBeenCalledTimes(2);

        useTimelineStore.getState().setIsDragging(true, { label: 'Move subtitles' });
        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 4, endTime: 5 }, { skipHistory: true },
        );
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState().revision).toBe(initialRevision + 3);
        expect(useTimelineStore.getState().isDragging).toBe(false);
        expect(useTimelineStore.getState().tracks[0]).toMatchObject({
            name: 'Renamed',
            subtitles: [{ startTime: 0, endTime: 1 }],
        });
        expect(useTimelineStore.getState().tracks[1].subtitles).toEqual([]);
        expect(useTimelineStore.getState().history).toHaveLength(1);
        expect(useTimelineStore.getState().history[0].label).toBe('Rename subtitle track');
        expect(useTimelineStore.getState().redoStack).toEqual([]);
        expect(enqueue).toHaveBeenCalledTimes(3);
        const afterRedo = useTimelineStore.getState();

        useTimelineStore.getState().updateSubtitleInTrack(
            'captions', 'subtitle', { startTime: 10, endTime: 11 }, { skipHistory: true },
        );
        useTimelineStore.getState().moveSubtitlesToTrack(['subtitle'], 1, { skipHistory: true });
        expect(useTimelineStore.getState()).toBe(afterRedo);
        expect(enqueue).toHaveBeenCalledTimes(3);

        useTimelineStore.getState().setIsDragging(false);
        expect(useTimelineStore.getState()).toBe(afterRedo);
        expect(enqueue).toHaveBeenCalledTimes(3);
    });

    it('restores the subtitle range anchor together with selection history', async () => {
        useTimelineStore.setState({
            tracks: [{
                ...subtitleTrack(),
                subtitles: [
                    { id: 'a', startTime: 0, endTime: 1, text: 'A' },
                    { id: 'b', startTime: 1, endTime: 2, text: 'B' },
                    { id: 'c', startTime: 2, endTime: 3, text: 'C' },
                ],
            }],
            activeTrackId: 'captions',
            selectedSubtitleIds: [],
            lastSelectedId: null,
            transientSelection: { kind: 'none' },
            history: [],
            redoStack: [],
        });

        useTimelineStore.getState().toggleSubtitleSelection('b');
        useTimelineStore.getState().updateTrackName('captions', 'Edited');
        useTimelineStore.getState().toggleSubtitleSelection('c');
        await useTimelineStore.getState().undo();

        expect(useTimelineStore.getState()).toMatchObject({
            selectedSubtitleIds: ['b'],
            lastSelectedId: 'b',
            transientSelection: { kind: 'subtitles', subtitleIds: ['b'] },
        });
        useTimelineStore.getState().toggleSubtitleSelection('a', false, true);
        expect(useTimelineStore.getState()).toMatchObject({
            selectedSubtitleIds: ['a', 'b'],
            lastSelectedId: 'a',
        });
    });

    it('restores pasted and add-on-Enter selection as part of the same command', async () => {
        useTimelineStore.setState({
            tracks: [{
                ...subtitleTrack(),
                subtitles: [{ id: 'source', startTime: 0, endTime: 1, text: 'Source' }],
            }],
            activeTrackId: 'captions',
            selectedSubtitleIds: ['source'],
            lastSelectedId: 'source',
            transientSelection: { kind: 'subtitles', trackId: 'captions', subtitleIds: ['source'] },
            history: [],
            redoStack: [],
        });
        useTimelineStore.getState().copySelection();
        useTimelineStore.getState().pasteSelection(3);
        const pastedId = useTimelineStore.getState().selectedSubtitleIds[0];
        expect(pastedId).not.toBe('source');

        await useTimelineStore.getState().undo();
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState()).toMatchObject({
            selectedSubtitleIds: [pastedId],
            lastSelectedId: pastedId,
            transientSelection: { kind: 'subtitles', subtitleIds: [pastedId] },
        });

        useTimelineStore.setState({ history: [], redoStack: [] });
        useTimelineStore.getState().requestEditSubtitleAtTime(6);
        const addedId = useTimelineStore.getState().selectedSubtitleIds[0];
        await useTimelineStore.getState().undo();
        await useTimelineStore.getState().redo();
        expect(useTimelineStore.getState()).toMatchObject({
            selectedSubtitleIds: [addedId],
            lastSelectedId: addedId,
            transientSelection: { kind: 'subtitles', subtitleIds: [addedId] },
        });
    });

    it('derives legacy transcription mirrors from the active track restored by Undo', async () => {
        useTimelineStore.setState({
            tracks: [subtitleTrack('track-a'), subtitleTrack('track-b')],
            activeTrackId: 'track-a',
        });
        useTimelineStore.getState().setTrackTranscriptionState('track-a', {
            raw: [{ id: 'word-a', startTime: 0, endTime: 1, text: 'A' }],
            groups: { 'group-a': [{ id: 'word-a', startTime: 0, endTime: 1, text: 'A' }] },
            containerIds: ['group-a'],
        });
        useTimelineStore.getState().setTrackTranscriptionState('track-b', {
            raw: [{ id: 'word-b', startTime: 0, endTime: 1, text: 'B' }],
            groups: { 'group-b': [{ id: 'word-b', startTime: 0, endTime: 1, text: 'B' }] },
            containerIds: ['group-b'],
        });
        useTimelineStore.setState({ history: [], redoStack: [], historySequence: 0, historyBytes: 0 });

        useTimelineStore.getState().updateTrackName('track-a', 'Edited');
        useTimelineStore.getState().setActiveTrackId('track-b');
        expect(useTimelineStore.getState().rawTranscription?.[0].text).toBe('B');
        await useTimelineStore.getState().undo();

        expect(useTimelineStore.getState()).toMatchObject({
            activeTrackId: 'track-a',
            rawTranscription: [{ text: 'A' }],
            transcriptionContainerIds: ['group-a'],
        });
    });

    it('jumps backward and forward across multiple retained commands atomically', async () => {
        useTimelineStore.setState({
            tracks: [subtitleTrack()],
            activeTrackId: 'captions',
            history: [],
            redoStack: [],
            historySequence: 0,
            historyBytes: 0,
        });
        const subtitleId = useTimelineStore.getState().addSubtitleToTrack('captions', {
            startTime: 0,
            endTime: 1,
            text: '',
        });
        useTimelineStore.getState().updateSubtitleInTrack('captions', subtitleId, { text: 'Restored' });
        const latestId = useTimelineStore.getState().history.at(-1)!.id;
        const beforeJumpRevision = useTimelineStore.getState().revision;

        await useTimelineStore.getState().jumpToHistoryEntry(null);
        expect(useTimelineStore.getState().tracks[0].subtitles).toEqual([]);
        expect(useTimelineStore.getState().revision).toBe(beforeJumpRevision + 1);
        expect(useTimelineStore.getState().redoStack).toHaveLength(2);

        await useTimelineStore.getState().jumpToHistoryEntry(latestId);
        expect(useTimelineStore.getState().tracks[0].subtitles).toEqual([
            expect.objectContaining({ id: subtitleId, text: 'Restored' }),
        ]);
        expect(useTimelineStore.getState().revision).toBe(beforeJumpRevision + 2);
        expect(useTimelineStore.getState().history).toHaveLength(2);
        expect(useTimelineStore.getState().redoStack).toEqual([]);
    });

    it('drops the drag history entry when the pointer produces no durable change', () => {
        useTimelineStore.setState({
            tracks: [{
                ...subtitleTrack(),
                subtitles: [{ id: 'subtitle', startTime: 0, endTime: 1, text: 'No move' }],
            }],
            activeTrackId: 'captions',
            history: [],
            redoStack: [],
        });
        const enqueue = vi.fn();
        setTimelinePersistenceBinding({ projectId: 'project', generation: 1, enqueue });
        const beforeRevision = useTimelineStore.getState().revision;

        useTimelineStore.getState().setIsDragging(true, { label: 'Move subtitles' });
        useTimelineStore.getState().setIsDragging(false);

        expect(useTimelineStore.getState().revision).toBe(beforeRevision);
        expect(useTimelineStore.getState().history).toEqual([]);
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('builds one persistence manifest for one durable snapshot payload', () => {
        const state = useTimelineStore.getState();
        const manifest = state.buildEditorManifest();
        const buildManifest = vi.fn(() => manifest);

        const payload = createTimelinePersistencePayload(state, [], buildManifest);

        expect(buildManifest).toHaveBeenCalledTimes(1);
        expect(payload.manifest).toBe(manifest);
    });

    it('leaves derived project duration for the explicit metadata synchronizer to persist', () => {
        useProjectStore.setState({
            activeProject: {
                id: 'duration_project',
                name: 'Duration project',
                duration: 1,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            },
            persistenceGeneration: 1,
        });

        appendVideo();

        expect(useProjectStore.getState().activeProject?.duration).toBe(1);
        useProjectStore.setState({ activeProject: null, persistenceGeneration: 0 });
    });

    it('keeps the default render profile unlocked until the first video import', () => {
        expect(useTimelineStore.getState().renderProfile).toEqual(createDefaultRenderProfile());
        appendVideo();
        expect(useTimelineStore.getState().renderProfile).toMatchObject({
            fps: { numerator: 30, denominator: 1 },
            width: 1920,
            height: 1080,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        });
    });
});
