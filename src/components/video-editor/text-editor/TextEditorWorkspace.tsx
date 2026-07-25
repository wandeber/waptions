'use client';

import { useState } from 'react';
import type { NarrativeActivationReport } from '@/lib/narrative/commands';
import { useTimelineStore } from '@/stores/timeline-store';
import { EditorialSetupPanel } from './EditorialSetupPanel';
import { NarrativeWorkspace } from './NarrativeWorkspace';

interface TextEditorWorkspaceProps {
    active: boolean;
}

/** Keeps session-only acquisition inputs mounted while the user switches between lower panes. */
export function TextEditorWorkspace({ active }: TextEditorWorkspaceProps) {
    const narrative = useTimelineStore((state) => state.narrative);
    const [latestActivationReport, setLatestActivationReport] = useState<NarrativeActivationReport | null>(null);

    if (narrative) {
        return (
            <NarrativeWorkspace
                active={active}
                latestActivationReport={latestActivationReport}
                onActivationReport={setLatestActivationReport}
            />
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-slate-950">
            {/*
              Setup has no edit actions yet, but it still owns a toolbar surface for the persistent
              pane selector rendered by EditorWorkspace. Matching the removed row's 32px height
              keeps setup content space unchanged while avoiding a second selector instance.
            */}
            <div
                data-testid="text-setup-toolbar"
                className="flex h-8 flex-none items-center border-b border-slate-800 bg-slate-900/95 px-2"
            >
                <div className="w-40 flex-none" aria-hidden="true" />
            </div>
            <div className="min-h-0 flex-1">
                <EditorialSetupPanel onActivated={setLatestActivationReport} />
            </div>
        </div>
    );
}
