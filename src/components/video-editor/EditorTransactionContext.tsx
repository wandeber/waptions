'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  createEditorTransactionCoordinator,
  type EditorTransactionCoordinator,
} from '@/lib/editor-transaction-coordinator';

const EditorTransactionContext = createContext<EditorTransactionCoordinator | null>(null);

/**
 * Owns every continuous edit session for one mounted editor.
 *
 * Keeping the registry inside the editor tree prevents a second editor, Storybook surface, or
 * stale route from cancelling another instance's inputs. Cancellation iterates over a snapshot
 * because a terminal callback may synchronously unmount or unregister its control.
 */
export function EditorTransactionProvider({ children }: { children: React.ReactNode }) {
  const coordinatorRef = useRef<EditorTransactionCoordinator | null>(null);
  coordinatorRef.current ??= createEditorTransactionCoordinator();
  const value = useMemo(() => coordinatorRef.current!, []);
  useEffect(() => () => value.dispose(), [value]);
  return (
    <EditorTransactionContext.Provider value={value}>
      {children}
    </EditorTransactionContext.Provider>
  );
}

export function useEditorTransactionCoordinator(): EditorTransactionCoordinator {
  const coordinator = useContext(EditorTransactionContext);
  if (!coordinator) {
    throw new Error('Editor transaction controls must be mounted inside EditorTransactionProvider.');
  }
  return coordinator;
}

/** Subscribes only to the aggregate draft bit, without coupling the header to editor internals. */
export function useHasPendingUndoableDraft(): boolean {
  const coordinator = useEditorTransactionCoordinator();
  return useSyncExternalStore(
    coordinator.subscribePendingUndoableDraft,
    coordinator.hasPendingUndoableDraft,
    () => false,
  );
}
