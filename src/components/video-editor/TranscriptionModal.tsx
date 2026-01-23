'use client';

import { useState } from 'react';
import { Button } from '@/components/design-system/Button';
import { SUPPORTED_MODELS, TranscriptionModel, TranscriptionModelId } from '@/types/transcription';
import { Sparkles, Bot, Check } from 'lucide-react';

interface TranscriptionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (modelId: TranscriptionModelId) => void;
    isProcessing?: boolean;
}

export function TranscriptionModal({
    isOpen,
    onClose,
    onConfirm,
    isProcessing = false
}: TranscriptionModalProps) {
    const [selectedId, setSelectedId] = useState<TranscriptionModelId>('whisper-1');

    if (!isOpen) return null;

    const getIcon = (provider: TranscriptionModel['provider']) => {
        switch (provider) {
            case 'OpenAI': return <Bot className="w-5 h-5" />;
            case 'Deepgram': return <Sparkles className="w-5 h-5" />;
            default: return <Bot className="w-5 h-5" />;
        }
    };

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-[100] transition-opacity duration-300">
            <div className="bg-gray-900 border border-gray-700/50 rounded-xl p-0 max-w-2xl w-full mx-4 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 ring-1 ring-white/10">

                {/* Header */}
                <div className="p-6 pb-2 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-4 opacity-10">
                        <Sparkles className="w-32 h-32 text-purple-500 transform rotate-12" />
                    </div>

                    <h2 className="text-2xl font-bold text-white mb-2 flex items-center gap-2 relative z-10">
                        <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
                            Potencia tu contenido
                        </span>
                        <Sparkles className="w-5 h-5 text-purple-400" />
                    </h2>
                    <p className="text-gray-400 text-sm relative z-10">
                        Elige el motor de IA que mejor se adapte a tus necesidades de velocidad y precisión.
                    </p>
                </div>

                {/* Body */}
                <div className="p-6 space-y-3">
                    {SUPPORTED_MODELS.map((model) => {
                        const isSelected = selectedId === model.id;

                        return (
                            <div
                                key={model.id}
                                onClick={() => setSelectedId(model.id)}
                                className={`
                                    relative flex items-center gap-4 p-4 rounded-lg cursor-pointer transition-all duration-200 border
                                    ${isSelected
                                        ? 'bg-blue-500/10 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                                        : 'bg-gray-800/50 border-gray-700 hover:bg-gray-800 hover:border-gray-600'
                                    }
                                `}
                            >
                                <div className={`
                                    flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center
                                    ${isSelected ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-400'}
                                    transition-colors
                                `}>
                                    {getIcon(model.provider)}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <h3 className={`font-semibold text-sm ${isSelected ? 'text-white' : 'text-gray-200'}`}>
                                            {model.name}
                                        </h3>
                                        {model.badge && (
                                            <span className={`
                                                text-[10px] px-1.5 py-0.5 rounded-full font-medium tracking-wide border
                                                ${model.badgeColor === 'purple' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : ''}
                                                ${model.badgeColor === 'blue' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : ''}
                                                ${model.badgeColor === 'green' ? 'bg-green-500/10 text-green-400 border-green-500/20' : ''}
                                            `}>
                                                {model.badge}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-400/80 truncate">
                                        {model.description}
                                    </p>
                                </div>

                                <div className={`
                                    w-5 h-5 rounded-full border flex items-center justify-center transition-all
                                    ${isSelected
                                        ? 'border-blue-500 bg-blue-500 text-white scale-100 opacity-100'
                                        : 'border-gray-600 bg-transparent text-transparent scale-90 opacity-50'
                                    }
                                `}>
                                    <Check className="w-3 h-3 stroke-[3]" />
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Footer */}
                <div className="p-6 pt-2 flex justify-end gap-3 border-t border-gray-800 bg-gray-900/50">
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        disabled={isProcessing}
                        className="text-gray-400 hover:text-white"
                    >
                        Cancelar
                    </Button>
                    <Button
                        variant="primary"
                        onClick={() => onConfirm(selectedId)}
                        disabled={isProcessing}
                        className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 border-none shadow-lg shadow-blue-900/20 min-w-[140px]"
                    >
                        {isProcessing ? (
                            <span className="flex items-center gap-2">
                                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                Procesando...
                            </span>
                        ) : (
                            <span className="flex items-center gap-2">
                                <Sparkles className="w-4 h-4" />
                                Generar Subtítulos
                            </span>
                        )}
                    </Button>
                </div>
            </div>
        </div>
    );
}
