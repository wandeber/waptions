'use client';

import { useState } from 'react';
import { Check, Layers, ChevronDown, Grid3X3, Info } from 'lucide-react';
import { DevinIcon } from '../icons/DevinIcon';
import { Button } from '../design-system/Button';
import { Popover } from '../design-system/Popover';

interface OverlayMenuProps {
    showThirdsGuide: boolean;
    onThirdsGuideToggle: () => void;
    showDevinGuide: boolean;
    onDevinGuideToggle: () => void;
    showMetaInfo: boolean;
    onMetaInfoToggle: () => void;
}

export function OverlayMenu({
    showThirdsGuide,
    onThirdsGuideToggle,
    showDevinGuide,
    onDevinGuideToggle,
    showMetaInfo,
    onMetaInfoToggle
}: OverlayMenuProps) {
    const [isOpen, setIsOpen] = useState(false);

    const options = [
        {
            id: 'thirds',
            label: 'Rule of thirds',
            icon: <Grid3X3 className="w-4 h-4" />,
            active: showThirdsGuide,
            onToggle: onThirdsGuideToggle
        },
        {
            id: 'devin',
            label: 'Subtitle safe area',
            icon: <DevinIcon className="w-4 h-4" />,
            active: showDevinGuide,
            onToggle: onDevinGuideToggle
        },
        {
            id: 'info',
            label: 'Media diagnostics',
            icon: <Info className="w-4 h-4" />,
            active: showMetaInfo,
            onToggle: onMetaInfoToggle
        }
    ];
    const hasActiveOverlay = options.some((option) => option.active);

    return (
        <Popover
            isOpen={isOpen}
            onOpenChange={setIsOpen}
            width={224} // w-56 = 224px
            trigger={
                <Button
                    variant="ghost"
                    title="Viewer overlays"
                    aria-label="Viewer overlays"
                    aria-expanded={isOpen}
                    className={`h-7 px-2 ${isOpen || hasActiveOverlay
                        ? 'bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 hover:text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'}`}
                >
                    <Layers className="w-[18px] h-[18px]" />
                    <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                </Button>
            }
        >
            <div className="mb-1 border-b border-slate-700/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Viewer overlays
            </div>
            {options.map((option) => (
                <button
                    type="button"
                    key={option.id}
                    aria-pressed={option.active}
                    onClick={(e) => {
                        e.stopPropagation();
                        option.onToggle();
                    }}
                    className="group flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-white/5"
                >
                    <div className="flex items-center gap-3">
                        <div className={`rounded p-1.5 ${option.active ? 'bg-sky-500/20 text-sky-300' : 'bg-slate-800 text-slate-400 group-hover:text-slate-200'}`}>
                            {option.icon}
                        </div>
                        <span className={`text-sm ${option.active ? 'font-medium text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>
                            {option.label}
                        </span>
                    </div>
                    {option.active && <Check className="h-4 w-4 text-sky-300" />}
                </button>
            ))}
            <div className="mt-1 border-t border-slate-700/70 px-3 py-2">
                <p className="text-[11px] text-slate-500">
                    Overlays affect preview only and are never exported.
                </p>
            </div>
        </Popover>
    );
}
