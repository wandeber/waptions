'use client';

import { ReactNode } from 'react';
import { Button } from './Button';

interface ConfirmDialogProps {
    title: string;
    message: string | ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    confirmVariant?: 'primary' | 'danger' | 'success';
    onConfirm: () => void;
    onCancel: () => void;
    isOpen: boolean;
}

export function ConfirmDialog({
    title,
    message,
    confirmLabel = 'Confirmar',
    cancelLabel = 'Cancelar',
    confirmVariant = 'primary',
    onConfirm,
    onCancel,
    isOpen
}: ConfirmDialogProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] transition-opacity">
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 shadow-2xl animate-in zoom-in-95 duration-200">
                <h3 className="text-xl font-bold text-white mb-2">
                    {title}
                </h3>

                <div className="text-gray-300 mb-6 text-sm leading-relaxed">
                    {message}
                </div>

                <div className="flex gap-3 justify-end">
                    <Button
                        variant="ghost"
                        onClick={onCancel}
                        className="px-4 py-2"
                    >
                        {cancelLabel}
                    </Button>

                    <Button
                        variant={confirmVariant}
                        onClick={onConfirm}
                        className="px-4 py-2"
                    >
                        {confirmLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
}
