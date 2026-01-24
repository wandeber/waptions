'use client';

import { useProjectStore } from '@/stores/project-store';
import { SpinnerIcon } from '../icons/SpinnerIcon';
import { useState, useEffect } from 'react';

export function StatusBar() {
    const { isProjectLoading, activeProject } = useProjectStore();
    const [minTimeElapsed, setMinTimeElapsed] = useState(true);

    useEffect(() => {
        if (isProjectLoading) {
            setMinTimeElapsed(false);
        }
    }, [isProjectLoading]);

    useEffect(() => {
        if (!minTimeElapsed) {
            const timer = setTimeout(() => {
                setMinTimeElapsed(true);
            }, 1000);
            return () => clearTimeout(timer);
        }
    }, [minTimeElapsed]);

    if (!isProjectLoading && minTimeElapsed) return null;
    if (!activeProject && !isProjectLoading) return null;

    return (
        <div className="flex items-center gap-2 text-xs text-blue-400 animate-fade-in">
            <SpinnerIcon className="w-3 h-3 animate-spin" />
            <span>Cargando proyecto...</span>
        </div>
    );
}
