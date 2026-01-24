'use client';

import { InlineEditor } from '@/components/design-system/InlineEditor';
import { StatusBar } from '@/components/design-system/StatusBar';
import { UndoIcon } from '@/components/icons/UndoIcon';
import { RedoIcon } from '@/components/icons/RedoIcon';
import { CopyIcon } from '@/components/icons/CopyIcon';
import { PasteIcon } from '@/components/icons/PasteIcon';
import { SpinnerIcon } from '@/components/icons/SpinnerIcon';
import { ExportButton } from './ExportButton';
import { Subtitle } from '@/types/timeline';
import { SubtitleAnimationStyle } from './subtitle-editor/types';

interface EditorHeaderProps {
    projectName: string;
    onRename: (name: string) => void;
    onClose: () => void;
    onUndo: () => void;
    onRedo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onCopy: () => void;
    onPaste: () => void;
    canCopy: boolean;
    canPaste: boolean;
    onSave: () => void;
    isDirty: boolean;
    isSaving: boolean;
    videoFile: File | null;
    subtitles: Subtitle[];
    fps: number;
    animationStyle?: SubtitleAnimationStyle;
}

export function EditorHeader({
    projectName,
    onRename,
    onClose,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    onCopy,
    onPaste,
    canCopy,
    canPaste,
    onSave,
    isDirty,
    isSaving,
    videoFile,
    subtitles,
    fps,
    animationStyle
}: EditorHeaderProps) {
    return (
        <header className="flex-none p-4 bg-gray-800 flex justify-between items-center border-b border-gray-700">
            <div className="flex items-center gap-4">
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-white transition-colors"
                >
                    ← Volver
                </button>
                <InlineEditor
                    initialValue={projectName}
                    onSave={onRename}
                    textClassName="text-xl font-bold"
                    inputClassName="text-xl font-bold h-8"
                />
            </div>

            <div className="flex items-center gap-4">
                <StatusBar />

                <div className="flex items-center gap-2">
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${!canUndo ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={onUndo}
                        disabled={!canUndo}
                        title="Deshacer (Ctrl+Z)"
                    >
                        <UndoIcon width={16} height={16} />
                    </button>
                    <button
                        className={`h-8 px-3 bg-gray-700 enabled:hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors flex items-center justify-center ${!canRedo ? 'opacity-50 cursor-not-allowed' : ''}`}
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

                <button
                    className={`h-8 px-3 rounded text-sm font-medium transition-colors flex items-center gap-2 ${isDirty || isSaving
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-gray-700 text-gray-400 cursor-default'
                        }`}
                    onClick={onSave}
                    disabled={!isDirty || isSaving}
                >
                    {isSaving ? (
                        <>
                            <SpinnerIcon className="w-3 h-3" />
                            <span>Guardando...</span>
                        </>
                    ) : isDirty ? (
                        'Guardar'
                    ) : (
                        'Guardado'
                    )}
                </button>

                <div className="w-px h-6 bg-gray-700 mx-2" />

                <ExportButton
                    videoFile={videoFile}
                    subtitles={subtitles}
                    fps={fps}
                    animationStyle={animationStyle}
                />
            </div>
        </header>
    );
}
