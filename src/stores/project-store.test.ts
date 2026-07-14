import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TProject } from '@/types/project';
import { editorPersistenceRegistry } from '@/lib/storage/editor-persistence';
import { storageService } from '@/lib/storage/storage-service';
import * as mediaUtils from '@/lib/mediabunny-utils';
import { useProjectStore } from './project-store';
import { useTimelineStore } from './timeline-store';
import type { SubtitleTrack } from '@/types/timeline';
import type { AudioSourceAsset, EditorDocumentV3 } from '@/types/video';
import { createDefaultRenderProfile } from '@/lib/render-profile';

const project = (id: string): TProject => ({
    id,
    name: id,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

const emptyLegacyPayload = {
    tracks: null,
    rawTranscription: null,
    transcriptionGroups: null,
    transcriptionContainerIds: null,
    videoFile: null,
};

describe('project persistence lifecycle integration', () => {
    beforeEach(() => {
        useProjectStore.setState({
            activeProject: null,
            persistenceGeneration: 0,
            persistenceStatus: null,
            persistenceError: null,
            isProjectLoading: false,
        });
        vi.spyOn(storageService, 'saveEditorDocument').mockResolvedValue();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        const state = useProjectStore.getState();
        if (state.activeProject) state.closeProject();
        vi.restoreAllMocks();
    });

    it('settles before reading and keeps a recovered save failure visible after attach', async () => {
        const id = 'project_reopen_success';
        const recoveredFailure = new Error('previous save failed');
        const settle = vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(recoveredFailure);
        const loadProject = vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadLegacyProjectPayload').mockResolvedValue(emptyLegacyPayload);

        await useProjectStore.getState().loadProject(id);

        expect(settle).toHaveBeenCalledWith(id);
        expect(settle.mock.invocationCallOrder[0]).toBeLessThan(loadProject.mock.invocationCallOrder[0]);
        expect(useProjectStore.getState().persistenceError).toBe(recoveredFailure);
        expect(useProjectStore.getState().activeProject?.id).toBe(id);
    });

    it('does not clear a recovered failure when durable document loading also fails', async () => {
        const id = 'project_reopen_read_error';
        const recoveredFailure = new Error('previous save failed');
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(recoveredFailure);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        vi.spyOn(storageService, 'loadEditorDocument').mockRejectedValue(new Error('read failed'));

        await expect(useProjectStore.getState().loadProject(id)).rejects.toThrow('read failed');
        expect(useProjectStore.getState().persistenceError).toBe(recoveredFailure);
    });

    it('leaves the project index untouched when database deletion fails', async () => {
        vi.spyOn(editorPersistenceRegistry, 'deleteProject').mockRejectedValue(new Error('delete failed'));
        const deleteIndex = vi.spyOn(storageService, 'deleteProjectIndex').mockResolvedValue();

        await expect(useProjectStore.getState().deleteProject('project_a')).rejects.toThrow('delete failed');
        expect(deleteIndex).not.toHaveBeenCalled();
    });

    it('migrates a legacy scalar video and transcription into one durable V3 document', async () => {
        const id = 'legacy_project';
        const file = {
            name: 'legacy.mp4',
            type: 'video/mp4',
            size: 1_024,
            lastModified: 12,
        } as File;
        const legacyTrack = {
            id: 'track-1',
            name: 'Captions',
            style: {} as SubtitleTrack['style'],
            subtitles: [],
            isVisible: true,
            isLocked: false,
        } satisfies SubtitleTrack;
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue({
            ...project(id),
            thumbnail: 'data:image/jpeg;base64,thumbnail',
            duration: 2,
        });
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadLegacyProjectPayload').mockResolvedValue({
            tracks: [legacyTrack],
            rawTranscription: [],
            transcriptionGroups: { group: [] },
            transcriptionContainerIds: ['group'],
            videoFile: file,
        });
        vi.spyOn(mediaUtils, 'getVideoInfo').mockResolvedValue({
            duration: 2,
            width: 1920,
            height: 1080,
            fps: 24,
            bitrate: 1_000_000,
            hasAudio: true,
        });

        await useProjectStore.getState().loadProject(id);

        expect(useTimelineStore.getState()).toMatchObject({
            projectFps: 24,
            videoSources: [{ originalName: 'legacy.mp4', hasAudio: true }],
            videoClips: [{
                sourceStart: 0,
                sourceEnd: 2,
                audio: { linkState: 'linked' },
            }],
            transcriptionByTrackId: {
                'track-1': { groups: { group: [] }, containerIds: ['group'] },
            },
        });
        expect(storageService.saveEditorDocument).toHaveBeenCalled();
    });

    it('hydrates a typed V3 audio graph and derives project duration from its audio tail', async () => {
        const id = 'project_v3_audio_tail';
        const audioSource: AudioSourceAsset = {
            id: 'shared_id',
            originalName: 'music.wav',
            mimeType: 'audio/wav',
            size: 100,
            lastModified: 10,
            fingerprint: 'audio_fingerprint',
            duration: 2,
            nativeSampleRate: 48_000,
            nativeSampleCount: 96_000,
            nativeChannelCount: 2,
            bitrate: null,
            codec: 'pcm_s16le',
            file: { name: 'music.wav', type: 'audio/wav', size: 100, lastModified: 10 } as File,
        };
        const document: EditorDocumentV3 = {
            version: 3,
            revision: 4,
            audioGraphRevision: 2,
            renderProfile: createDefaultRenderProfile({
                isFrameRateLocked: true,
                isCanvasSizeLocked: true,
            }),
            subtitleTracks: [],
            videoSources: [],
            videoClips: [],
            audioSources: [audioSource],
            audioTracks: [{
                id: 'audio_track',
                name: 'Music',
                muted: false,
                solo: false,
                locked: false,
                gainDb: 0,
                clips: [{
                    id: 'audio_clip',
                    source: { kind: 'audio-source', audioSourceId: audioSource.id },
                    timelineStartFrame: 30,
                    sourceStartSample: 0,
                    sourceEndSample: audioSource.nativeSampleCount,
                    muted: false,
                    gainDb: 0,
                    fadeInSamples: 0,
                    fadeOutSamples: 0,
                }],
            }],
            activeSubtitleTrackId: null,
            transientSelection: { kind: 'none' },
            transcriptionByTrackId: {},
        };
        vi.spyOn(editorPersistenceRegistry, 'settleBeforeOpen').mockResolvedValue(null);
        vi.spyOn(storageService, 'loadProject').mockResolvedValue(project(id));
        vi.spyOn(storageService, 'loadEditorDocument').mockResolvedValue(document);
        vi.spyOn(storageService, 'saveProject').mockResolvedValue();
        vi.spyOn(storageService, 'loadAllProjects').mockResolvedValue([]);

        await useProjectStore.getState().loadProject(id);

        expect(useTimelineStore.getState()).toMatchObject({
            revision: 4,
            audioGraphRevision: 2,
            audioSources: [{ id: 'shared_id' }],
            audioTracks: [{ clips: [{ id: 'audio_clip' }] }],
        });
        expect(useProjectStore.getState().activeProject?.duration).toBe(3);
        expect(useTimelineStore.getState().buildEditorManifest()).toMatchObject({
            version: 3,
            audioSourceDescriptors: [{ id: 'shared_id' }],
        });
    });
});
