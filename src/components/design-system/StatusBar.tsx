'use client';

import { AlertTriangle, Check } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useProjectStore } from '@/stores/project-store';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { getStatusBarView } from './status-bar-state';
import { useRouter } from 'next/navigation';

export function StatusBar() {
    const router = useRouter();
    const {
        activeProject,
        isProjectLoading,
        isSaving,
        persistenceStatus,
        persistenceError,
        persistenceRetryKind,
        projectLoadError,
        retryProjectLoad,
        retryPersistence,
    } = useProjectStore(useShallow((state) => ({
        activeProject: state.activeProject,
        isProjectLoading: state.isProjectLoading,
        isSaving: state.isSaving,
        persistenceStatus: state.persistenceStatus,
        persistenceError: state.persistenceError,
        persistenceRetryKind: state.persistenceRetryKind,
        projectLoadError: state.projectLoadError,
        retryProjectLoad: state.retryProjectLoad,
        retryPersistence: state.retryPersistence,
    })));
    const view = getStatusBarView({
        hasActiveProject: Boolean(activeProject),
        isProjectLoading,
        isSaving,
        persistenceStatus,
        persistenceError,
        canRetryPersistence: persistenceRetryKind !== null,
        projectLoadErrorKind: projectLoadError?.kind ?? null,
    });

    if (view.kind === 'idle') return null;
    if (view.kind === 'error' || view.kind === 'load-error') {
        return (
            <div
                role="alert"
                className="flex items-center gap-2 text-xs text-amber-300"
                data-testid="persistence-status-error"
            >
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{view.label}</span>
                {view.kind === 'load-error' || view.canRetry ? (
                    <button
                        type="button"
                        className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
                        onClick={() => void (view.kind === 'load-error'
                            ? retryProjectLoad().catch(() => undefined)
                            : retryPersistence())}
                        disabled={isSaving || isProjectLoading}
                    >
                        Retry
                    </button>
                ) : null}
                {view.kind === 'load-error' ? (
                    <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-gray-300 underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
                        onClick={() => router.push('/')}
                    >
                        Projects
                    </button>
                ) : null}
            </div>
        );
    }

    return (
        <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-xs text-blue-300"
            data-testid={`persistence-status-${view.kind}`}
        >
            {view.kind === 'saved'
                ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                : <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
            <span>{view.label}</span>
        </div>
    );
}
