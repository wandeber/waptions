'use client';

import { useState } from 'react';
import { NarrativeInspector } from './NarrativeInspector';
import { SourceRangeDialog } from './SourceRangeDialog';
import { useTextEditorCommands } from './useTextEditorCommands';

/** Inspector host keeps recovery dialogs and command feedback scoped to narrative selection. */
export function NarrativePropertiesPanel() {
    const commands = useTextEditorCommands();
    const [sourceAction, setSourceAction] = useState<'insert' | 'recover' | null>(null);

    return (
        <>
            <NarrativeInspector
                pending={commands.pending}
                runNarrative={commands.runNarrative}
                onOpenSourceRange={setSourceAction}
            />
            {sourceAction && (
                <SourceRangeDialog
                    action={sourceAction}
                    pending={commands.pending}
                    runNarrative={commands.runNarrative}
                    onClose={() => setSourceAction(null)}
                />
            )}
            {commands.feedback.message && (
                <p
                    role={commands.feedback.tone === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                    className={`border-t px-3 py-2 text-[10px] ${commands.feedback.tone === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-200'
                        : commands.feedback.tone === 'success'
                            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200'
                            : 'border-slate-800 text-slate-400'}`}
                >
                    {commands.feedback.message}
                </p>
            )}
        </>
    );
}
