'use client';

import { AlertTriangle, History } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useTimelineStore } from '@/stores/timeline-store';
import { useEditorTransactionCoordinator } from './EditorTransactionContext';
import { buildNewestFirstHistoryDisplay } from '@/lib/history-display';

/** Inspector history browser with one-click atomic navigation to any retained command. */
export function HistoryPanel() {
  const transactionCoordinator = useEditorTransactionCoordinator();
  const { history, redoStack, jumpToHistoryEntry } = useTimelineStore(useShallow((state) => ({
    history: state.history,
    redoStack: state.redoStack,
    jumpToHistoryEntry: state.jumpToHistoryEntry,
  })));
  const commands = buildNewestFirstHistoryDisplay(history, redoStack);
  const cursor = history.length;
  const jump = (entryId: string | null) => {
    transactionCoordinator.prepareHistoryNavigation();
    void jumpToHistoryEntry(entryId);
  };

  return (
    <section data-testid="history-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2 text-xs text-slate-400">
        <span>Edit history</span>
        <span>{commands.length} {commands.length === 1 ? 'change' : 'changes'}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {commands.map(({ entry, chronologicalIndex, applied, current }) => {
          return (
            <button
              key={entry.id}
              type="button"
              data-history-entry-id={entry.id}
              data-history-index={chronologicalIndex}
              onClick={() => jump(entry.id)}
              className={`mb-1 grid w-full grid-cols-[12px_1fr_auto] items-center gap-2 rounded px-2 py-2 text-left text-xs transition-colors ${current
                ? 'bg-sky-500/15 text-sky-100'
                : applied
                  ? 'text-slate-200 hover:bg-slate-800'
                  : 'text-slate-500 hover:bg-slate-800/70'}`}
            >
              <span className={`h-2 w-2 rounded-full ${applied ? 'bg-sky-400' : 'border border-slate-600'}`} />
              <span className="min-w-0">
                <span className="block truncate">{entry.label}</span>
                <span className="block text-[10px] text-slate-500">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </span>
              <span className="flex items-center gap-1 text-[10px] text-slate-500">
                {entry.oversized && <AlertTriangle className="h-3 w-3 text-amber-400" aria-label="Large history entry" />}
                {current ? <span className="font-medium text-sky-300">Current</span> : null}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => jump(null)}
          className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs transition-colors ${cursor === 0
            ? 'bg-sky-500/15 text-sky-100'
            : 'text-slate-400 hover:bg-slate-800'}`}
        >
          <History className="h-3.5 w-3.5 flex-none" />
          <span>Earliest retained state</span>
          {cursor === 0 && <span className="ml-auto text-[10px] font-medium text-sky-300">Current</span>}
        </button>
      </div>
    </section>
  );
}
