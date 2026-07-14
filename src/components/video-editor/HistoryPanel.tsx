'use client';

import { AlertTriangle, History } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useTimelineStore } from '@/stores/timeline-store';
import { useEditorTransactionCoordinator } from './EditorTransactionContext';

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

/** Inspector history browser with one-click atomic navigation to any retained command. */
export function HistoryPanel() {
  const transactionCoordinator = useEditorTransactionCoordinator();
  const { history, redoStack, historyBytes, jumpToHistoryEntry } = useTimelineStore(useShallow((state) => ({
    history: state.history,
    redoStack: state.redoStack,
    historyBytes: state.historyBytes,
    jumpToHistoryEntry: state.jumpToHistoryEntry,
  })));
  const future = [...redoStack].reverse();
  const commands = [...history, ...future];
  const cursor = history.length;
  const jump = (entryId: string | null) => {
    transactionCoordinator.prepareHistoryNavigation();
    void jumpToHistoryEntry(entryId);
  };

  return (
    <section data-testid="history-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2 text-[11px] text-gray-400">
        <span>{commands.length} retained commands</span>
        <span className="font-mono">{formatBytes(historyBytes)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <button
          type="button"
          onClick={() => jump(null)}
          className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs ${cursor === 0
            ? 'bg-blue-500/20 text-blue-100'
            : 'text-gray-400 hover:bg-gray-700/60'}`}
        >
          <History className="h-3.5 w-3.5 flex-none" />
          <span>Oldest retained state</span>
        </button>
        {commands.map((entry, index) => {
          const applied = index < cursor;
          const current = index + 1 === cursor;
          return (
            <button
              key={entry.id}
              type="button"
              data-history-entry-id={entry.id}
              onClick={() => jump(entry.id)}
              className={`mb-1 grid w-full grid-cols-[12px_1fr_auto] items-center gap-2 rounded px-2 py-2 text-left text-xs ${current
                ? 'bg-blue-500/20 text-blue-100'
                : applied
                  ? 'text-gray-200 hover:bg-gray-700/60'
                  : 'text-gray-500 hover:bg-gray-700/40'}`}
            >
              <span className={`h-2 w-2 rounded-full ${applied ? 'bg-blue-400' : 'border border-gray-600'}`} />
              <span className="min-w-0">
                <span className="block truncate">{entry.label}</span>
                <span className="block text-[10px] text-gray-500">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </span>
              <span className="flex items-center gap-1 font-mono text-[10px] text-gray-500">
                {entry.oversized && <AlertTriangle className="h-3 w-3 text-amber-400" aria-label="Oversized command" />}
                {formatBytes(entry.byteSize)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
