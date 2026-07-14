import type { EditorPersistenceStatus } from '@/lib/storage/editor-persistence';
import type { ProjectLoadErrorKind } from '@/stores/project-store';

export type StatusBarView =
  | { kind: 'idle'; label: '' }
  | { kind: 'loading'; label: 'Loading project…' }
  | { kind: 'saving'; label: 'Saving…' }
  | { kind: 'saved'; label: 'Saved' }
  | { kind: 'load-error'; label: 'Project not found' | 'Could not load project' }
  | { kind: 'error'; label: 'Changes not saved'; canRetry: boolean };

interface StatusBarState {
  hasActiveProject: boolean;
  isProjectLoading: boolean;
  isSaving: boolean;
  persistenceStatus: EditorPersistenceStatus | null;
  persistenceError: unknown | null;
  canRetryPersistence: boolean;
  projectLoadErrorKind: ProjectLoadErrorKind | null;
}

/** Persistence errors win until the store receives a confirmed saved event. */
export function getStatusBarView(state: StatusBarState): StatusBarView {
  if (state.isProjectLoading) return { kind: 'loading', label: 'Loading project…' };
  if (state.projectLoadErrorKind) {
    return {
      kind: 'load-error',
      label: state.projectLoadErrorKind === 'not-found'
        ? 'Project not found'
        : 'Could not load project',
    };
  }
  if (!state.hasActiveProject) return { kind: 'idle', label: '' };
  if (state.persistenceError) {
    return {
      kind: 'error',
      label: 'Changes not saved',
      canRetry: state.canRetryPersistence,
    };
  }
  if (state.isSaving || state.persistenceStatus === 'saving') {
    return { kind: 'saving', label: 'Saving…' };
  }
  if (state.persistenceStatus === 'saved') return { kind: 'saved', label: 'Saved' };
  return { kind: 'idle', label: '' };
}
