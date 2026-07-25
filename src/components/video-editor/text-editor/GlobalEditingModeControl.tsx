'use client';

import { AlignHorizontalJustifyCenter, MoveHorizontal } from 'lucide-react';
import type { GlobalEditingMode } from '@/types/editorial';

interface GlobalEditingModeControlProps {
    mode: GlobalEditingMode;
    onChange: (mode: GlobalEditingMode) => void;
    disabled?: boolean;
    compact?: boolean;
}

/** One visible project-wide structural mode shared by Text and Timeline. */
export function GlobalEditingModeControl({
    mode,
    onChange,
    disabled = false,
    compact = false,
}: GlobalEditingModeControlProps) {
    return (
        <div
            role="group"
            aria-label="Structural editing mode"
            className="flex h-7 items-center rounded border border-slate-700 bg-slate-950/70"
        >
            <button
                type="button"
                disabled={disabled}
                aria-pressed={mode === 'ripple'}
                onClick={() => onChange('ripple')}
                title="Ripple editing: structural edits close or open time in their command scope"
                className={`flex h-6 items-center justify-center gap-1 rounded px-2 text-[11px] font-medium transition-colors motion-reduce:transition-none disabled:opacity-40 ${mode === 'ripple'
                    ? 'bg-sky-500/20 text-sky-100'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
            >
                <MoveHorizontal className="h-3.5 w-3.5" />
                {!compact && 'Ripple'}
            </button>
            <button
                type="button"
                disabled={disabled}
                aria-pressed={mode === 'absolute'}
                onClick={() => onChange('absolute')}
                title="Absolute editing: structural edits preserve unrelated project starts"
                className={`flex h-6 items-center justify-center gap-1 rounded px-2 text-[11px] font-medium transition-colors motion-reduce:transition-none disabled:opacity-40 ${mode === 'absolute'
                    ? 'bg-amber-500/20 text-amber-100'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
            >
                <AlignHorizontalJustifyCenter className="h-3.5 w-3.5" />
                {!compact && 'Absolute'}
            </button>
        </div>
    );
}
