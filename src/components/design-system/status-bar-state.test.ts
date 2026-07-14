import { describe, expect, it } from 'vitest';
import { getStatusBarView } from './status-bar-state';

describe('getStatusBarView', () => {
  it('keeps a persistence failure visible even after the save attempt stops', () => {
    expect(getStatusBarView({
      hasActiveProject: true,
      isProjectLoading: false,
      isSaving: false,
      persistenceStatus: 'error',
      persistenceError: new Error('quota'),
      canRetryPersistence: true,
      projectLoadErrorKind: null,
    })).toEqual({ kind: 'error', label: 'Changes not saved', canRetry: true });
  });

  it('reports active saving and confirmed saved states', () => {
    expect(getStatusBarView({
      hasActiveProject: true,
      isProjectLoading: false,
      isSaving: true,
      persistenceStatus: null,
      persistenceError: null,
      canRetryPersistence: false,
      projectLoadErrorKind: null,
    }).kind).toBe('saving');
    expect(getStatusBarView({
      hasActiveProject: true,
      isProjectLoading: false,
      isSaving: false,
      persistenceStatus: 'saved',
      persistenceError: null,
      canRetryPersistence: false,
      projectLoadErrorKind: null,
    }).kind).toBe('saved');
  });

  it('gives project loading precedence over inactive-project idle state', () => {
    expect(getStatusBarView({
      hasActiveProject: false,
      isProjectLoading: true,
      isSaving: false,
      persistenceStatus: null,
      persistenceError: null,
      canRetryPersistence: false,
      projectLoadErrorKind: null,
    }).kind).toBe('loading');
  });

  it('keeps non-recoverable errors visible without advertising a no-op retry', () => {
    expect(getStatusBarView({
      hasActiveProject: true,
      isProjectLoading: false,
      isSaving: false,
      persistenceStatus: 'error',
      persistenceError: new Error('delete failed'),
      canRetryPersistence: false,
      projectLoadErrorKind: null,
    })).toEqual({ kind: 'error', label: 'Changes not saved', canRetry: false });
  });

  it('distinguishes a missing project from an unreadable editor document', () => {
    const base = {
      hasActiveProject: false,
      isProjectLoading: false,
      isSaving: false,
      persistenceStatus: null,
      persistenceError: null,
      canRetryPersistence: false,
    } as const;

    expect(getStatusBarView({ ...base, projectLoadErrorKind: 'not-found' }))
      .toEqual({ kind: 'load-error', label: 'Project not found' });
    expect(getStatusBarView({ ...base, projectLoadErrorKind: 'unreadable' }))
      .toEqual({ kind: 'load-error', label: 'Could not load project' });
  });
});
