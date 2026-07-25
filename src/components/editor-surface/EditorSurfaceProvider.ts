'use client';

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type {
  EditorUiController,
  EditorUiMediaResolver,
  EditorUiServices,
  EditorUiSnapshot,
} from '@/lib/editor-ui/contracts';

interface EditorSurfaceContextValue {
  controller: EditorUiController;
  mediaResolver?: EditorUiMediaResolver;
  services: EditorUiServices;
}

const defaultServices: EditorUiServices = {
  notify(message, tone = 'neutral') {
    if (tone === 'error') console.error(message);
    else console.info(message);
  },
  async confirm(options) {
    return typeof window === 'undefined' ? false : window.confirm(options.message);
  },
  async requestText(options) {
    return typeof window === 'undefined'
      ? null
      : window.prompt(options.label, options.initialValue ?? '');
  },
};

const EditorSurfaceContext = createContext<EditorSurfaceContextValue | null>(null);

export interface EditorSurfaceProviderProps {
  controller: EditorUiController;
  mediaResolver?: EditorUiMediaResolver;
  services?: Partial<EditorUiServices>;
  children?: ReactNode;
}

/**
 * Stable per-editor provider. Controller identity, not project revision or presentation mode,
 * defines the lifetime of decoder-owning children and transaction coordinators.
 */
export function EditorSurfaceProvider({
  controller,
  mediaResolver,
  services,
  children,
}: EditorSurfaceProviderProps) {
  const lifecycleGenerations = useRef(new WeakMap<EditorUiController, number>());
  const resolvedServices = useMemo<EditorUiServices>(() => ({
    ...defaultServices,
    ...services,
  }), [services]);
  const value = useMemo<EditorSurfaceContextValue>(() => ({
    controller,
    mediaResolver,
    services: resolvedServices,
  }), [controller, mediaResolver, resolvedServices]);

  useEffect(() => {
    const generations = lifecycleGenerations.current;
    const generation = (generations.get(controller) ?? 0) + 1;
    generations.set(controller, generation);
    void controller.connect();
    return () => {
      // React Strict Mode immediately replays effects in development. Defer terminal disposal so
      // the replay can reclaim the same controller, while a real unmount or controller swap still
      // closes its transport and subscriptions.
      queueMicrotask(() => {
        if (generations.get(controller) !== generation) return;
        generations.delete(controller);
        controller.close();
      });
    };
  }, [controller]);

  return createElement(EditorSurfaceContext.Provider, { value }, children);
}

export function useEditorSurfaceHost(): EditorSurfaceContextValue {
  const context = useContext(EditorSurfaceContext);
  if (!context) throw new Error('Editor surface components require EditorSurfaceProvider.');
  return context;
}

export function useEditorUiSnapshot(): EditorUiSnapshot {
  const { controller } = useEditorSurfaceHost();
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
}

export function EditorSurfaceBoundary({ children }: { children: ReactNode }) {
  const snapshot = useEditorUiSnapshot();
  return createElement('div', {
    className: 'contents',
    'data-editor-surface': '',
    'data-editor-connection': snapshot.connection,
    'data-editor-presentation': snapshot.view.presentation,
    'data-editor-revision': snapshot.stateToken.documentRevision,
  }, children);
}
