import { useLayoutEffect } from 'react';
import { useProjectStore } from '@/stores/project-store';

/**
 * Reconciles one editor route with the project store.
 *
 * The route intent is published before deciding whether a load is needed. This matters when the
 * browser returns from a slow B navigation to an already-active A: A stays mounted, while B loses
 * its request token and can no longer publish either a document or an error into A.
 */
export interface EditorProjectRouteSession {
    projectId: string;
    token: number;
    settled: Promise<void>;
    release: () => void;
}

const loadEditorProjectRoute = async (projectId: string, token: number): Promise<void> => {
    const current = useProjectStore.getState();
    if (
        current.projectRouteIntentId !== projectId
        || current.projectRouteIntentToken !== token
        || current.activeProject?.id === projectId
        || current.loadingProjectId === projectId
        || current.projectLoadError?.projectId === projectId
    ) return;

    await current.loadProject(projectId);
};

export const beginEditorProjectRoute = (projectId: string): EditorProjectRouteSession => {
    const initial = useProjectStore.getState();
    const token = initial.beginProjectRouteIntent(projectId);

    return {
        projectId,
        token,
        settled: loadEditorProjectRoute(projectId, token),
        release: () => useProjectStore.getState().clearProjectRouteIntent(projectId, token),
    };
};

export const useEditorProjectRoute = (projectId: string): void => {
    useLayoutEffect(() => {
        // Layout timing invalidates a superseded load in the same commit as the route change,
        // before the already-active editor is painted for the new route intent.
        const session = beginEditorProjectRoute(projectId);
        void session.settled.catch(() => undefined);
        return session.release;
    }, [projectId]);
};
