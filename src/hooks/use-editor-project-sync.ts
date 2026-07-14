import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getTimelineDurations } from '@/lib/video-timeline';
import { usePlaybackStore } from '@/stores/playback-store';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';

/**
 * Publishes document-derived duration and frame-rate metadata without subscribing the editor shell.
 * Mount this hook in a leaf runtime component: timeline edits then update only this coordinator,
 * rather than rebuilding the header and workspace just to synchronize store metadata.
 */
export function useEditorProjectSync(): void {
  const {
    tracks,
    projectFps,
    renderProfile,
    videoSources,
    videoClips,
    audioSources,
    audioTracks,
    addTrack,
  } = useTimelineStore(useShallow((state) => ({
    tracks: state.tracks,
    projectFps: state.projectFps,
    renderProfile: state.renderProfile,
    videoSources: state.videoSources,
    videoClips: state.videoClips,
    audioSources: state.audioSources,
    audioTracks: state.audioTracks,
    addTrack: state.addTrack,
  })));
  const { setFps, setDuration, setContentDuration } = usePlaybackStore(useShallow((state) => ({
    setFps: state.setFps,
    setDuration: state.setDuration,
    setContentDuration: state.setContentDuration,
  })));
  const { activeProject, persistenceGeneration, updateProjectDuration } = useProjectStore(useShallow((state) => ({
    activeProject: state.activeProject,
    persistenceGeneration: state.persistenceGeneration,
    updateProjectDuration: state.updateProjectDuration,
  })));

  useEffect(() => {
    if (tracks.length === 0) addTrack('Subtitles 1', undefined, { skipHistory: true });
  }, [addTrack, tracks.length]);

  const durations = useMemo(() => getTimelineDurations(videoClips, tracks, {
    audioTracks,
    videoSources,
    audioSources,
    renderProfile,
  }), [audioSources, audioTracks, renderProfile, tracks, videoClips, videoSources]);

  useEffect(() => {
    // Duration setters quantize on the store's current FPS, so publish the canonical rate first.
    setFps(projectFps);
    setContentDuration(durations.contentDuration);
    setDuration(durations.viewDuration);
  }, [durations, projectFps, setContentDuration, setDuration, setFps]);

  useEffect(() => {
    if (!activeProject) return;
    if (Math.abs((activeProject.duration ?? 0) - durations.contentDuration) > 0.0005) {
      void updateProjectDuration({
        projectId: activeProject.id,
        generation: persistenceGeneration,
      }, durations.contentDuration);
    }
  }, [activeProject, durations.contentDuration, persistenceGeneration, updateProjectDuration]);
}
