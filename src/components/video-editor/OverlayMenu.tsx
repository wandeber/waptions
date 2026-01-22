'use client';

import { useState, useRef, useEffect } from 'react';
import { Check, Layers, ChevronDown, Grid3X3, Info } from 'lucide-react';
import { DevinIcon } from '../icons/DevinIcon';

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
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const toggleMenu = () => setIsOpen(!isOpen);

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
        <div className="relative" ref={menuRef}>
            <button
                onClick={toggleMenu}
                className={`flex items-center gap-1 h-8 px-2 rounded text-sm font-medium transition-all ${isOpen || options.some(o => o.active)
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
                    }`}
                title="Capas y Guías"
            >
                <Layers className="w-4 h-4" />
                <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-2xl z-50 py-1 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-700/50 mb-1">
                        Visualización
                    </div>
                    {options.map((option) => (
                        <button
                            key={option.id}
                            onClick={() => {
                                option.onToggle();
                                // We don't close the menu so user can toggle multiple
                            }}
                            className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 transition-colors group"
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
                </div>
            )}
        </div>
    );
}
