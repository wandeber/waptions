import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimationStyle, SubtitleTrack } from '@/types/timeline';
import type {
    AudioClip,
    AudioSourceAsset,
    AudioTrack,
    EditorManifestV3,
    VideoSourceAsset,
} from '@/types/video';
import type { EditorPersistentAsset } from '@/lib/storage/storage-service';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { createVideoSourceFingerprint } from '@/lib/video-timeline';
import { validateEditorManifestV3 } from '@/lib/editor-document-v3';
import { setTimelinePersistenceBinding, useTimelineStore } from './timeline-store';
import { useVideoStore } from './video-store';

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

describe('canonical V3 timeline state', () => {
    beforeEach(resetStores);

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

    it('builds and enqueues a typed V3 manifest with both source kinds', () => {
        const calls: Array<{ manifest: EditorManifestV3; assets: readonly EditorPersistentAsset[] }> = [];
        setTimelinePersistenceBinding({
            projectId: 'project',
            generation: 1,
            enqueue: (manifest, assets) => calls.push({ manifest, assets }),
        });
        const video = videoSource();
        const audio = audioSource();

        useTimelineStore.getState().appendMixedMediaCandidate({
            videoSources: [video],
            videoClips: [{ id: 'video_clip', sourceId: video.id, sourceStart: 0, sourceEnd: 4 }],
            audioSources: [audio],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].manifest).toMatchObject({ version: 3, revision: useTimelineStore.getState().revision });
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

        expect(useTimelineStore.getState().revision).toBe(before.revision);
        expect(useTimelineStore.getState().history).toHaveLength(before.history.length);
        expect(enqueue).not.toHaveBeenCalled();
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
