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
            label: 'Guía de tercios',
            icon: <Grid3X3 className="w-4 h-4" />,
            active: showThirdsGuide,
            onToggle: onThirdsGuideToggle
        },
        {
            id: 'devin',
            label: 'Guía Devin',
            icon: <DevinIcon className="w-4 h-4" />,
            active: showDevinGuide,
            onToggle: onDevinGuideToggle
        },
        {
            id: 'info',
            label: 'Info de recursos',
            icon: <Info className="w-4 h-4" />,
            active: showMetaInfo,
            onToggle: onMetaInfoToggle
        }
    ];

    return (
        <Popover
            isOpen={isOpen}
            onOpenChange={setIsOpen}
            width={224} // w-56 = 224px
            trigger={
                <Button
                    variant={isOpen || options.some(o => o.active) ? 'primary' : 'secondary'}
                    title="Capas y Guías"
                    className="flex items-center gap-1"
                >
                    <Layers className="w-[18px] h-[18px]" />
                    <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                </Button>
            }
        >
            <div className="px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-700/50 mb-1">
                Visualización
            </div>
            {options.map((option) => (
                <button
                    key={option.id}
                    onClick={(e) => {
                        e.stopPropagation();
                        option.onToggle();
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 transition-colors group text-left"
                >
                    <div className="flex items-center gap-3">
                        <div className={`p-1.5 rounded ${option.active ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-700 text-gray-400 group-hover:text-gray-200'}`}>
                            {option.icon}
                        </div>
                        <span className={`text-sm ${option.active ? 'text-white font-medium' : 'text-gray-400 group-hover:text-gray-200'}`}>
                            {option.label}
                        </span>
                    </div>
                    {option.active && <Check className="w-4 h-4 text-blue-400" />}
                </button>
            ))}
            <div className="px-3 py-2 mt-1 border-t border-gray-700/50">
                <p className="text-[10px] text-gray-500 italic">
                    Las guías te ayudan a encuadrar mejor tus subtítulos.
                </p>
            </div>
        </Popover>
    );
}
