'use client';

import { useState, useRef, useEffect } from 'react';

interface InlineEditorProps {
    initialValue: string;
    onSave: (value: string) => void;
    onCancel?: () => void;
    className?: string;
    textClassName?: string;
    inputClassName?: string;
    autoFocus?: boolean;
}

export function InlineEditor({
    initialValue,
    onSave,
    onCancel,
    className = '',
    textClassName = '',
    inputClassName = '',
    autoFocus = false
}: InlineEditorProps) {
    const [isEditing, setIsEditing] = useState(autoFocus);
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setValue(initialValue);
    }, [initialValue]);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    const handleSave = () => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== initialValue) {
            onSave(trimmed);
        } else {
            setValue(initialValue);
        }
        setIsEditing(false);
    };

    const handleCancel = () => {
        setValue(initialValue);
        setIsEditing(false);
        onCancel?.();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSave();
        } else if (e.key === 'Escape') {
            handleCancel();
        }
    };

    if (isEditing) {
        return (
            <div className={`inline-block ${className}`}>
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onBlur={handleSave}
                    onKeyDown={handleKeyDown}
                    className={`bg-gray-700 text-white px-1 rounded border border-blue-500 outline-none w-full ${inputClassName}`}
                />
            </div>
        );
    }

    return (
        <div
            className={`cursor-pointer hover:bg-white/5 px-1 rounded group relative flex items-center ${className}`}
            onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
            }}
        >
            <span className={`truncate block ${textClassName}`}>
                {initialValue || "Sin Título"}
            </span>
            <div className="absolute right-1 opacity-0 group-hover:opacity-50 transition-opacity pointer-events-none">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
            </div>
        </div>
    );
}
