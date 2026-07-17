'use client';

import { InlineEditor } from '@/components/design-system/InlineEditor';
import { StatusBar } from '@/components/design-system/StatusBar';
import { Button } from '../design-system/Button';
import { UndoIcon } from '@/components/icons/UndoIcon';
import { RedoIcon } from '@/components/icons/RedoIcon';
import { CopyIcon } from '@/components/icons/CopyIcon';
import { PasteIcon } from '@/components/icons/PasteIcon';
import { SpinnerIcon } from '@/components/icons/SpinnerIcon';
import {
    ArrowLeft,
    HardDriveDownload,
    Save,
} from 'lucide-react';
import { ExportButton } from './ExportButton';
import { formatShortcutTitle, getShortcutAriaKeys } from '@/config/shortcuts';

interface EditorHeaderProps {
    projectName: string;
    onRename: (name: string) => void;
    onClose: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onHistoryPointerDown: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onCopy: () => void;
    onPaste: () => void;
    canCopy: boolean;
    canPaste: boolean;
    onSave: () => void;
    isDirty: boolean;
    isSaving: boolean;
    onExportBundle: () => void;
}

export function EditorHeader({
    projectName,
    onRename,
    onClose,
    onUndo,
    onRedo,
    onHistoryPointerDown,
    canUndo,
    canRedo,
    onCopy,
    onPaste,
    canCopy,
    canPaste,
    onSave,
    isDirty,
    isSaving,
    onExportBundle,
}: EditorHeaderProps) {
    return (
        <header className="flex h-12 flex-none items-center gap-3 border-b border-slate-700 bg-slate-950 px-3 text-slate-200">
            <div className="flex min-w-0 items-center gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    className="flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                    title="Back to projects"
                >
                    <ArrowLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">Projects</span>
                </button>
                <div className="h-5 w-px bg-slate-700" />
                <InlineEditor
                    initialValue={projectName}
                    onSave={onRename}
                    textClassName="max-w-64 truncate text-sm font-semibold text-slate-100"
                    inputClassName="h-8 max-w-64 text-sm font-semibold"
                />
                <StatusBar />
            </div>

            <div className="ml-auto flex min-w-0 items-center gap-1.5">
                <div className="flex items-center gap-1" role="group" aria-label="History controls">
                    <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded text-slate-300 transition-colors enabled:hover:bg-slate-800 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                        onPointerDownCapture={onHistoryPointerDown}
                        onClick={onUndo}
                        disabled={!canUndo}
                        title={formatShortcutTitle('Undo', 'UNDO')}
                        aria-label="Undo"
                        aria-keyshortcuts={getShortcutAriaKeys('UNDO')}
                    >
                        <UndoIcon width={16} height={16} />
                    </button>
                    <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded text-slate-300 transition-colors enabled:hover:bg-slate-800 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                        onPointerDownCapture={onHistoryPointerDown}
                        onClick={onRedo}
                        disabled={!canRedo}
                        title={formatShortcutTitle('Redo', 'REDO')}
                        aria-label="Redo"
                        aria-keyshortcuts={getShortcutAriaKeys('REDO')}
                    >
                        <RedoIcon width={16} height={16} />
                    </button>
                </div>

                <div className="hidden items-center gap-1 md:flex" role="group" aria-label="Clipboard controls">
                    <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded text-slate-300 transition-colors enabled:hover:bg-slate-800 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                        onClick={onCopy}
                        disabled={!canCopy}
                        title={formatShortcutTitle('Copy', 'COPY')}
                        aria-label="Copy"
                        aria-keyshortcuts={getShortcutAriaKeys('COPY')}
                    >
                        <CopyIcon width={16} height={16} />
                    </button>
                    <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded text-slate-300 transition-colors enabled:hover:bg-slate-800 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                        onClick={onPaste}
                        disabled={!canPaste}
                        title={formatShortcutTitle('Paste', 'PASTE')}
                        aria-label="Paste"
                        aria-keyshortcuts={getShortcutAriaKeys('PASTE')}
                    >
                        <PasteIcon width={16} height={16} />
                    </button>
                </div>

                <Button
                    variant="secondary"
                    size="sm"
                    className={`h-8 w-8 border p-0 ${isDirty || isSaving
                        ? 'border-sky-500/50 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30'
                        : 'border-slate-800 bg-slate-900 text-slate-500'
                        }`}
                    onClick={onSave}
                    disabled={!isDirty || isSaving}
                    title={formatShortcutTitle(isSaving ? 'Saving…' : isDirty ? 'Save changes' : 'All changes saved', 'SAVE')}
                    aria-label={isSaving ? 'Saving' : 'Save changes'}
                    aria-keyshortcuts={getShortcutAriaKeys('SAVE')}
                >
                    {isSaving ? (
                        <SpinnerIcon className="w-4 h-4" />
                    ) : (
                        <Save className="w-4 h-4" />
                    )}
                </Button>

                <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 w-8 border border-slate-800 bg-slate-900 p-0 text-slate-300 hover:bg-slate-800 hover:text-white"
                    onClick={onExportBundle}
                    title="Download project file (.waptions)"
                    aria-label="Download project file"
                >
                    <HardDriveDownload className="w-4 h-4" />
                </Button>

                <div className="mx-1 h-6 w-px bg-slate-700" />

                <ExportButton />
            </div>
        </header>
    );
}
