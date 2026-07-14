'use client';

import { InlineEditor } from '@/components/design-system/InlineEditor';
import { StatusBar } from '@/components/design-system/StatusBar';
import { Button } from '../design-system/Button';
import { UndoIcon } from '@/components/icons/UndoIcon';
import { RedoIcon } from '@/components/icons/RedoIcon';
import { CopyIcon } from '@/components/icons/CopyIcon';
import { PasteIcon } from '@/components/icons/PasteIcon';
import { SpinnerIcon } from '@/components/icons/SpinnerIcon';
import { HardDriveDownload, Save } from 'lucide-react';
import { ExportButton } from './ExportButton';

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
    onExportBundle
}: EditorHeaderProps) {
    return (
        <header className="flex-none h-12 px-3 bg-gray-800 flex justify-between items-center border-b border-gray-700 gap-3">
            {/* ... */}
            <div className="flex items-center gap-3 min-w-0">
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-white transition-colors"
                >
                    ← Volver
                </button>
                <InlineEditor
                    initialValue={projectName}
                    onSave={onRename}
                    textClassName="text-base font-semibold truncate"
                    inputClassName="text-base font-semibold h-8"
                />
            </div>

            <div className="flex items-center gap-2 min-w-0">
                <StatusBar />

                <div className="flex items-center gap-2">
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${!canUndo ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onPointerDownCapture={onHistoryPointerDown}
                        onClick={onUndo}
                        disabled={!canUndo}
                        title="Deshacer (Ctrl+Z)"
                    >
                        <UndoIcon width={16} height={16} />
                    </button>
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${!canRedo ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onPointerDownCapture={onHistoryPointerDown}
                        onClick={onRedo}
                        disabled={!canRedo}
                        title="Rehacer (Ctrl+Shift+Z)"
                    >
                        <RedoIcon width={16} height={16} />
                    </button>
                </div>

                <div className="w-[1px] h-6 bg-gray-700 mx-1" />

                <div className="flex items-center gap-2">
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${!canCopy ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={onCopy}
                        disabled={!canCopy}
                        title="Copiar (Cmd+C)"
                    >
                        <CopyIcon width={16} height={16} />
                    </button>
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${!canPaste ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={onPaste}
                        disabled={!canPaste}
                        title="Pegar (Cmd+V)"
                    >
                        <PasteIcon width={16} height={16} />
                    </button>
                </div>

                <Button
                    className={`h-8 px-3 rounded text-sm font-medium transition-colors flex items-center justify-center ${isDirty || isSaving
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-gray-700 text-gray-400 cursor-default'
                        }`}
                    onClick={onSave}
                    disabled={!isDirty || isSaving}
                    title={isSaving ? 'Guardando...' : isDirty ? 'Guardar cambios' : 'Todo guardado'}
                >
                    {isSaving ? (
                        <SpinnerIcon className="w-4 h-4" />
                    ) : (
                        <Save className="w-4 h-4" />
                    )}
                </Button>

                <Button
                    variant="secondary"
                    size="md"
                    className="h-8 px-3 flex items-center justify-center"
                    onClick={onExportBundle}
                    title="Exportar archivo de proyecto (.waptions)"
                >
                    <HardDriveDownload className="w-4 h-4" />
                </Button>

                <div className="w-px h-6 bg-gray-700 mx-1" />

                <ExportButton />
            </div>
        </header>
    );
}
