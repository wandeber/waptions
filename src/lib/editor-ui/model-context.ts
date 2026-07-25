import type { EditorUiClipKind, EditorUiModelContext, EditorUiSnapshot, EditorUiTrackKind } from './contracts';

const MAX_SELECTION_ITEMS = 32;
const MAX_ACTIVE_JOBS = 8;
const MAX_NAME_LENGTH = 120;
const MAX_ACTION_LENGTH = 160;
const MAX_OPAQUE_ID_LENGTH = 160;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9:_-]+$/;
const SAFE_SEMANTIC_ACTION = /^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)+$/;

const boundedText = (value: string, maximumLength: number): string => (
  value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`
);

const boundedOpaqueId = (value: string): string => (
  value.length > 0
  && value.length <= MAX_OPAQUE_ID_LENGTH
  && SAFE_OPAQUE_ID.test(value)
    ? value
    : 'redacted'
);

const safeProjectName = (value: string): string => {
  const looksSensitive = /(?:[/\\]|https?:|file:|api[_-]?key|token=|bearer\s)/i.test(value);
  return looksSensitive ? 'Waptions project' : boundedText(value, MAX_NAME_LENGTH);
};

/**
 * Produces the only snapshot fragment that an MCP App may publish back to model context.
 *
 * Transcript text, labels derived from transcript text, media URLs, local paths, credentials, and
 * the full timeline graph are intentionally impossible to reach from the returned type.
 */
export function buildEditorUiModelContext(snapshot: EditorUiSnapshot): EditorUiModelContext {
  const typeById = new Map<string, EditorUiClipKind | EditorUiTrackKind | 'narrative'>();
  for (const track of snapshot.project.tracks) {
    typeById.set(track.id, track.kind);
    for (const clip of track.clips) typeById.set(clip.id, clip.kind);
  }
  for (const block of snapshot.project.narrativeBlocks) typeById.set(block.id, 'narrative');

  return {
    project: {
      id: boundedOpaqueId(snapshot.project.id),
      name: safeProjectName(snapshot.project.name),
    },
    selection: snapshot.view.selectedIds.slice(0, MAX_SELECTION_ITEMS).flatMap((id) => {
      const type = typeById.get(id);
      return type ? [{ id: boundedOpaqueId(id), type }] : [];
    }),
    timecodeSeconds: Number.isFinite(snapshot.view.playheadSeconds)
      ? Math.max(0, snapshot.view.playheadSeconds)
      : 0,
    revisions: {
      session: snapshot.stateToken.sessionRevision,
      document: snapshot.stateToken.documentRevision,
      audioGraph: snapshot.stateToken.audioGraphRevision,
      ...(snapshot.stateToken.narrativeRevision === undefined
        ? {}
        : { narrative: snapshot.stateToken.narrativeRevision }),
    },
    activeJobs: snapshot.jobs
      .filter((job) => job.state === 'queued' || job.state === 'running')
      .slice(0, MAX_ACTIVE_JOBS)
      .map(({ id, kind, state, progress }) => ({
        id: boundedOpaqueId(id),
        kind,
        state,
        progress: Number.isFinite(progress) && progress !== null
          ? Math.max(0, Math.min(1, progress))
          : null,
      })),
    recentSemanticAction: snapshot.recentSemanticAction
      && snapshot.recentSemanticAction.length <= MAX_ACTION_LENGTH
      && SAFE_SEMANTIC_ACTION.test(snapshot.recentSemanticAction)
      ? snapshot.recentSemanticAction
      : null,
  };
}
