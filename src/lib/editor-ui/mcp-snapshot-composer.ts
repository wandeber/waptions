import {
  DEFAULT_EDITOR_UI_SUBTITLE_STYLE,
  DEFAULT_EDITOR_UI_VIEW_STATE,
  createEmptyEditorUiSnapshot,
  type EditorUiArtifact,
  type EditorUiClip,
  type EditorUiJob,
  type EditorUiMediaSource,
  type EditorUiSnapshot,
  type EditorUiStateToken,
  type EditorUiTrack,
  type EditorUiTrackKind,
} from './contracts';
import { normalizeMcpJobState } from './mcp-envelope';
import type {
  McpArtifactListData,
  McpGraphReference,
  McpHistoryGetData,
  McpJobListData,
  McpProjectSummaryData,
  McpTimelineQueryData,
  McpViewData,
} from './mcp-projection-contract';

export interface McpSnapshotParts {
  state: EditorUiStateToken;
  project: McpProjectSummaryData;
  sourceReferences: McpGraphReference[];
  tracks: McpTimelineQueryData;
  clips: McpTimelineQueryData;
  subtitles: McpTimelineQueryData;
  narrativeBlocks: McpTimelineQueryData;
  history: McpHistoryGetData;
  view: McpViewData;
  jobs: McpJobListData;
  artifacts: McpArtifactListData;
}

const frameRate = (project: McpProjectSummaryData): number => (
  project.renderProfile.fps.numerator / project.renderProfile.fps.denominator
);

const inferTrackKind = (value: string): EditorUiTrackKind => {
  const kind = value.toLowerCase();
  if (kind.includes('subtitle') || kind.includes('caption')) return 'subtitle';
  if (kind.includes('audio')) return 'audio';
  return 'video';
};

const inferClipKind = (
  reference: McpGraphReference,
  trackKind: EditorUiTrackKind,
): EditorUiClip['kind'] => {
  const kind = reference.kind.toLowerCase();
  if (kind.includes('subtitle') || kind.includes('caption')) return 'subtitle';
  if (kind.includes('silence')) return 'silence';
  if (kind.includes('text')) return 'text';
  if (kind.includes('audio')) return 'audio';
  if (kind.includes('video')) return 'video';
  return trackKind;
};

const clipFromReference = (
  reference: McpGraphReference,
  track: EditorUiTrack,
  fps: number,
): EditorUiClip => {
  const startFrame = reference.startFrame ?? 0;
  const endFrame = Math.max(startFrame, reference.endFrame ?? startFrame);
  const sourceOffsetSeconds = reference.sourceStartSeconds
    ?? (reference.sourceStartSample !== undefined
      ? reference.sourceStartSample / 48_000
      : (reference.sourceStartFrame ?? 0) / fps);
  const sourceEndSeconds = reference.sourceEndSeconds
    ?? (reference.sourceEndSample !== undefined
      ? reference.sourceEndSample / 48_000
      : reference.sourceEndFrame !== undefined
        ? reference.sourceEndFrame / fps
        : undefined);
  return {
    id: reference.id,
    trackId: track.id,
    ...(reference.sourceId ? { sourceId: reference.sourceId } : {}),
    kind: inferClipKind(reference, track.kind),
    label: reference.label ?? reference.id,
    startSeconds: startFrame / fps,
    durationSeconds: (endFrame - startFrame) / fps,
    sourceOffsetSeconds,
    ...(sourceEndSeconds !== undefined
      ? { sourceDurationSeconds: Math.max(0, sourceEndSeconds) }
      : {}),
    ...(reference.audioLinkState
      ? { hasLinkedAudio: reference.audioLinkState === 'linked' }
      : {}),
    linkedTargetIds: [],
    ...(reference.muted !== undefined ? { muted: reference.muted } : {}),
    ...(reference.gainDb !== undefined ? { gainDb: reference.gainDb } : {}),
    ...(reference.text !== undefined ? { text: reference.text } : {}),
  };
};

const mapJobKind = (kind: string): EditorUiJob['kind'] => {
  if (kind.includes('transcription')) return 'transcription';
  if (kind.includes('export')) return 'export';
  if (kind.includes('import')) return 'import';
  return 'analysis';
};

const mapArtifactKind = (kind: string): EditorUiArtifact['kind'] => {
  if (kind === 'transcript') return 'transcript';
  if (kind.includes('proof')) return 'proof';
  if (kind.includes('bundle') || kind.includes('snapshot')) return 'bundle';
  return 'export';
};

const mapMediaSource = (reference: McpGraphReference, fps: number): EditorUiMediaSource => ({
  id: reference.id,
  kind: reference.kind.toLowerCase().includes('audio') ? 'audio' : 'video',
  label: reference.label ?? reference.id,
  durationSeconds: Math.max(
    0,
    ((reference.endFrame ?? 0) - (reference.startFrame ?? 0)) / fps,
  ),
});

const allHistoryEntries = (history: McpHistoryGetData) => [
  ...history.past.map((entry, index) => ({
    id: entry.entryId,
    label: entry.label,
    timestamp: Date.parse(entry.occurredAt),
    isCurrent: index === history.past.length - 1,
    isRedo: false,
  })),
  ...history.future.map((entry) => ({
    id: entry.entryId,
    label: entry.label,
    timestamp: Date.parse(entry.occurredAt),
    isCurrent: false,
    isRedo: true,
  })),
];

/**
 * Build the UI's bounded view model only from fields present in closed Core tool outputs.
 * Graph references intentionally become lightweight rows; richer media details remain behind
 * capability-bound artifact and source resolvers.
 */
export function composeMcpEditorUiSnapshot(
  parts: McpSnapshotParts,
  previous?: EditorUiSnapshot,
): EditorUiSnapshot {
  const empty = createEmptyEditorUiSnapshot({
    sessionId: parts.state.sessionId,
    projectId: parts.project.projectId,
    sessionEpoch: parts.state.sessionEpoch,
    eventCursor: parts.state.eventCursor,
    presentation: parts.view.view.presentation,
  });
  const fps = frameRate(parts.project);
  const tracks = parts.tracks.items.map<EditorUiTrack>((reference) => {
    const kind = inferTrackKind(reference.kind);
    return {
      id: reference.id,
      kind,
      name: reference.label ?? reference.id,
      clips: [],
      locked: reference.locked ?? false,
      ...(reference.visible !== undefined ? { visible: reference.visible } : {}),
      ...(reference.muted !== undefined ? { muted: reference.muted } : {}),
      ...(reference.solo !== undefined ? { solo: reference.solo } : {}),
      ...(reference.gainDb !== undefined ? { gainDb: reference.gainDb } : {}),
      height: previous?.view.trackHeights[reference.id]
        ?? (kind === 'video' ? 96 : 72),
      ...(kind === 'subtitle' ? { subtitleStyle: DEFAULT_EDITOR_UI_SUBTITLE_STYLE } : {}),
    };
  });
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const clipReferences = [...parts.clips.items, ...parts.subtitles.items];
  for (const reference of clipReferences) {
    if (!reference.trackId) continue;
    let track = tracksById.get(reference.trackId);
    if (!track) {
      const kind = inferTrackKind(reference.kind);
      track = {
        id: reference.trackId,
        kind,
        name: reference.trackId,
        clips: [],
        locked: false,
        height: kind === 'video' ? 96 : 72,
        ...(kind === 'subtitle' ? { subtitleStyle: DEFAULT_EDITOR_UI_SUBTITLE_STYLE } : {}),
      };
      tracks.push(track);
      tracksById.set(track.id, track);
    }
    track.clips.push(clipFromReference(reference, track, fps));
  }
  const maxEndFrame = clipReferences.reduce(
    (maximum, reference) => Math.max(maximum, reference.endFrame ?? 0),
    0,
  );
  const view = parts.view.view;
  const selectedIds = view.selection.kind === 'none' ? [] : view.selection.ids;
  const history = allHistoryEntries(parts.history);
  return {
    ...empty,
    stateToken: parts.state,
    connection: 'connected',
    capabilities: {
      canEdit: true,
      // MCP Apps cannot acquire verified media or export destination capabilities yet.
      canImportMedia: false,
      canTranscribe: true,
      canExport: false,
      canPresentFullscreen: false,
      canPresentPictureInPicture: false,
      canSubscribeToEvents: true,
    },
    project: {
      id: parts.project.projectId,
      name: parts.project.name,
      durationSeconds: maxEndFrame / fps,
      fps,
      renderProfile: parts.project.renderProfile,
      backgroundColor: parts.project.renderBackgroundColor,
      mediaSources: parts.sourceReferences.map((source) => mapMediaSource(source, fps)),
      artifacts: parts.artifacts.items.map((artifact) => ({
        id: artifact.artifactId,
        kind: mapArtifactKind(artifact.kind),
        label: artifact.kind,
      })),
      tracks,
      narrativeBlocks: parts.narrativeBlocks.items.map((reference) => {
        const startFrame = reference.startFrame ?? 0;
        const endFrame = Math.max(startFrame, reference.endFrame ?? startFrame);
        return {
          id: reference.id,
          clipId: reference.clipId ?? null,
          kind: reference.kind.toLowerCase().includes('silence') ? 'silence' : 'speech',
          text: reference.text ?? reference.label ?? '',
          sourceStartSample16k: reference.coreStartSample
            ?? Math.round((startFrame / fps) * 16_000),
          sourceEndSample16k: reference.coreEndSample
            ?? Math.round((endFrame / fps) * 16_000),
          startSeconds: startFrame / fps,
          durationSeconds: (endFrame - startFrame) / fps,
          linkedTargetIds: reference.targetId ? [reference.targetId] : [],
        };
      }),
      history,
      canUndo: parts.history.past.length > 0,
      canRedo: parts.history.future.length > 0,
      editingMode: previous?.project.editingMode ?? 'ripple',
      narrativeSettings: previous?.project.narrativeSettings
        ?? empty.project.narrativeSettings,
    },
    view: {
      ...DEFAULT_EDITOR_UI_VIEW_STATE,
      ...previous?.view,
      revision: view.viewRevision,
      presentation: view.presentation,
      zoom: view.zoom,
      scrollLeft: view.scrollLeft,
      playheadSeconds: view.playheadFrame / fps,
      selectedIds,
      focusedTrackId: view.focusedPanel ?? null,
    },
    playback: previous?.playback ?? empty.playback,
    jobs: parts.jobs.items.map((job) => ({
      id: job.jobId,
      kind: mapJobKind(job.kind),
      label: job.kind,
      state: normalizeMcpJobState(job.state),
      progress: job.fraction ?? null,
      ...(job.message ? { message: job.message } : {}),
      ...(job.resultArtifactIds[0] ? { artifactId: job.resultArtifactIds[0] } : {}),
    })),
    presence: view.participantIds.map((participantId) => ({
      viewId: participantId,
      label: participantId,
      color: '#64748b',
      selectedIds: [],
      isPresenter: previous?.playback.presenterViewId === participantId,
      isFollowing: false,
    })),
    pendingCommandIds: previous?.pendingCommandIds ?? [],
    conflict: previous?.conflict ?? null,
    recentSemanticAction: previous?.recentSemanticAction ?? null,
    errorMessage: null,
  };
}
