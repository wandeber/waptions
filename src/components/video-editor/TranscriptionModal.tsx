'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/design-system/Button';
import { getVisibleTranscriptionModels, OpenAICompatibleTranscriptionSettings, TranscriptionModel, TranscriptionModelId } from '@/types/transcription';
import { Sparkles, Bot, Check, Server, KeyRound, Monitor } from 'lucide-react';
import { shouldShowPaidTranscriptionModels } from '@/lib/config/feature-flags';

const CUSTOM_TRANSCRIPTION_SETTINGS_KEY = 'waptions-custom-openai-compatible-transcription';

const DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS: OpenAICompatibleTranscriptionSettings = {
    enabled: !shouldShowPaidTranscriptionModels(),
    requestMode: 'browser',
    endpoint: 'http://localhost:8000/v1',
    apiKey: '',
    model: 'whisper-1',
};

interface TranscriptionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (modelId: TranscriptionModelId, customOpenAITranscription?: OpenAICompatibleTranscriptionSettings | null) => void;
    isProcessing?: boolean;
}

export function TranscriptionModal({
    isOpen,
    onClose,
    onConfirm,
    isProcessing = false
}: TranscriptionModalProps) {
    const paidModelsVisible = shouldShowPaidTranscriptionModels();
    const visibleModels = getVisibleTranscriptionModels();
    const customTranscriberOnly = visibleModels.length === 0;
    const [selectedId, setSelectedId] = useState<TranscriptionModelId>('whisper-1');
    const [customSettings, setCustomSettings] = useState<OpenAICompatibleTranscriptionSettings>(DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS);
    const [hasLoadedCustomSettings, setHasLoadedCustomSettings] = useState(false);
    const [endpointError, setEndpointError] = useState<string | null>(null);

    const canUseCustomEndpoint = selectedId === 'whisper-1';

    useEffect(() => {
        const storedSettings = window.localStorage.getItem(CUSTOM_TRANSCRIPTION_SETTINGS_KEY);

        if (storedSettings) {
            try {
                const parsed = JSON.parse(storedSettings) as Partial<OpenAICompatibleTranscriptionSettings>;
                setCustomSettings({
                    ...DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS,
                    ...parsed,
                    enabled: customTranscriberOnly || parsed.enabled === true,
                    requestMode: parsed.requestMode === 'server' ? 'server' : 'browser',
                    endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS.endpoint,
                    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
                    model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS.model,
                });
            } catch {
                window.localStorage.removeItem(CUSTOM_TRANSCRIPTION_SETTINGS_KEY);
            }
        }

        setHasLoadedCustomSettings(true);
    }, [customTranscriberOnly]);

    useEffect(() => {
        if (!hasLoadedCustomSettings) {
            return;
        }

        window.localStorage.setItem(CUSTOM_TRANSCRIPTION_SETTINGS_KEY, JSON.stringify(customSettings));
    }, [customSettings, hasLoadedCustomSettings]);

    if (!isOpen) return null;

    const getIcon = (provider: TranscriptionModel['provider']) => {
        switch (provider) {
            case 'OpenAI': return <Bot className="w-5 h-5" />;
            case 'Deepgram': return <Sparkles className="w-5 h-5" />;
            default: return <Bot className="w-5 h-5" />;
        }
    };

    const updateCustomSettings = (updates: Partial<OpenAICompatibleTranscriptionSettings>) => {
        setCustomSettings(current => ({ ...current, ...updates }));

        if (updates.endpoint !== undefined) {
            setEndpointError(null);
        }
    };

    const getCustomSettingsForSubmit = (): OpenAICompatibleTranscriptionSettings | null | undefined => {
        if (!canUseCustomEndpoint || (!customTranscriberOnly && !customSettings.enabled)) {
            return null;
        }

        const endpoint = customSettings.endpoint.trim();
        if (!endpoint) {
            setEndpointError('El endpoint es obligatorio.');
            return undefined;
        }

        return {
            enabled: true,
            requestMode: customSettings.requestMode || 'browser',
            endpoint,
            apiKey: customSettings.apiKey?.trim() || undefined,
            model: customSettings.model?.trim() || 'whisper-1',
        };
    };

    const handleConfirm = () => {
        const customOpenAITranscription = getCustomSettingsForSubmit();

        if (customOpenAITranscription === undefined) {
            return;
        }

        onConfirm(selectedId, customOpenAITranscription);
    };

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-[100] transition-opacity duration-300">
            <div className="bg-gray-900 border border-gray-700/50 rounded-xl p-0 max-w-3xl w-full mx-4 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 ring-1 ring-white/10 max-h-[90vh] flex flex-col">

                {/* Header */}
                <div className="p-6 pb-2 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-4 opacity-10">
                        <Sparkles className="w-32 h-32 text-purple-500 transform rotate-12" />
                    </div>

                    <h2 className="text-2xl font-bold text-white mb-2 flex items-center gap-2 relative z-10">
                        <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
                            {paidModelsVisible ? 'Potencia tu contenido' : 'Configura tu transcriptor'}
                        </span>
                        <Sparkles className="w-5 h-5 text-purple-400" />
                    </h2>
                    <p className="text-gray-400 text-sm relative z-10">
                        {paidModelsVisible
                            ? 'Elige el motor de IA que mejor se adapte a tus necesidades de velocidad y precisión.'
                            : 'Waptions usará únicamente el endpoint OpenAI-compatible que configures en este navegador.'}
                    </p>
                </div>

                {/* Body */}
                <div className="p-6 space-y-3 overflow-y-auto">
                    {visibleModels.map((model) => {
                        const isSelected = selectedId === model.id;

                        return (
                            <div
                                key={model.id}
                                onClick={() => setSelectedId(model.id)}
                                className={`
                                    relative flex items-center gap-4 p-4 rounded-lg cursor-pointer transition-all duration-200 border
                                    ${isSelected
                                        ? model.id === 'premium-whisper-gpt4o'
                                            ? 'bg-purple-500/10 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.15)]'
                                            : 'bg-blue-500/10 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                                        : 'bg-gray-800/50 border-gray-700 hover:bg-gray-800 hover:border-gray-600'
                                    }
                                `}
                            >
                                <div className={`
                                    flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center
                                    ${isSelected
                                        ? model.id === 'premium-whisper-gpt4o' ? 'bg-purple-600 text-white' : 'bg-blue-500 text-white'
                                        : 'bg-gray-700 text-gray-400'}
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
                                                ${model.badgeColor === 'purple' ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' : ''}
                                                ${model.badgeColor === 'blue' ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : ''}
                                                ${model.badgeColor === 'green' ? 'bg-green-500/20 text-green-400 border-green-500/30' : ''}
                                            `}>
                                                {model.badge}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-400/80">
                                        {model.description}
                                    </p>
                                </div>

                                <div className={`
                                    w-5 h-5 rounded-full border flex items-center justify-center transition-all
                                    ${isSelected
                                        ? model.id === 'premium-whisper-gpt4o' ? 'border-purple-500 bg-purple-500 text-white scale-100' : 'border-blue-500 bg-blue-500 text-white scale-100'
                                        : 'border-gray-600 bg-transparent text-transparent scale-90 opacity-50'
                                    }
                                `}>
                                    <Check className="w-3 h-3 stroke-[3]" />
                                </div>
                            </div>
                        );
                    })}

                    <div className={`rounded-lg border p-4 transition-colors ${canUseCustomEndpoint ? 'border-gray-700 bg-gray-800/40' : 'border-gray-800 bg-gray-900/40 opacity-70'}`}>
                        <div className="flex items-center gap-3 text-sm text-gray-200">
                            {customTranscriberOnly ? (
                                <Check className="h-4 w-4 text-blue-400" />
                            ) : (
                                <input
                                    type="checkbox"
                                    checked={customSettings.enabled}
                                    onChange={(event) => updateCustomSettings({ enabled: event.target.checked })}
                                    disabled={!canUseCustomEndpoint || isProcessing}
                                    className="h-4 w-4 accent-blue-500"
                                />
                            )}
                            <span className="flex items-center gap-2 font-medium">
                                <Server className="h-4 w-4 text-blue-400" />
                                Transcriptor OpenAI-compatible
                            </span>
                        </div>

                        {!canUseCustomEndpoint && customSettings.enabled && (
                            <p className="mt-2 text-xs text-amber-300">
                                Disponible sólo con Whisper estándar.
                            </p>
                        )}

                        {canUseCustomEndpoint && (customTranscriberOnly || customSettings.enabled) && (
                            <div className="mt-4 grid gap-3">
                                <div className="grid gap-2 text-xs text-gray-400">
                                    <span>Modo de llamada</span>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <button
                                            type="button"
                                            onClick={() => updateCustomSettings({ requestMode: 'browser' })}
                                            disabled={isProcessing}
                                            className={`rounded border p-3 text-left transition-colors ${customSettings.requestMode !== 'server'
                                                ? 'border-blue-500 bg-blue-500/10 text-white'
                                                : 'border-gray-700 bg-gray-950 text-gray-300 hover:border-gray-600'
                                                }`}
                                        >
                                            <span className="flex items-center gap-2 text-sm font-medium">
                                                <Monitor className="h-4 w-4" />
                                                Navegador
                                            </span>
                                            <span className="mt-1 block text-xs text-gray-400">
                                                Usa el localhost del usuario.
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            onClick={() => updateCustomSettings({ requestMode: 'server' })}
                                            disabled={isProcessing}
                                            className={`rounded border p-3 text-left transition-colors ${customSettings.requestMode === 'server'
                                                ? 'border-blue-500 bg-blue-500/10 text-white'
                                                : 'border-gray-700 bg-gray-950 text-gray-300 hover:border-gray-600'
                                                }`}
                                        >
                                            <span className="flex items-center gap-2 text-sm font-medium">
                                                <Server className="h-4 w-4" />
                                                Servidor
                                            </span>
                                            <span className="mt-1 block text-xs text-gray-400">
                                                Evita CORS; localhost es el servidor de Waptions.
                                            </span>
                                        </button>
                                    </div>
                                </div>

                                <label className="grid gap-1 text-xs text-gray-400">
                                    <span>Endpoint</span>
                                    <input
                                        type="text"
                                        value={customSettings.endpoint}
                                        onChange={(event) => updateCustomSettings({ endpoint: event.target.value })}
                                        placeholder="http://localhost:8000/v1"
                                        disabled={isProcessing}
                                        className={`w-full rounded border bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${endpointError ? 'border-red-500' : 'border-gray-700'}`}
                                    />
                                    {endpointError && (
                                        <span className="text-red-400">{endpointError}</span>
                                    )}
                                </label>

                                <div className="rounded border border-gray-700 bg-gray-950/70 p-3 text-xs leading-relaxed text-gray-400">
                                    {customSettings.requestMode === 'server' ? (
                                        <span>
                                            La llamada saldrá del servidor de Waptions, no del navegador. No requiere CORS y la API key no se expone al cliente, pero localhost apunta al servidor donde corre Waptions. En producción, el host debe estar permitido por el servidor.
                                        </span>
                                    ) : (
                                        <span>
                                            La llamada saldrá directamente desde este navegador. localhost apunta a este equipo, pero el transcriptor debe permitir CORS desde {typeof window !== 'undefined' ? window.location.origin : 'Waptions'}; si usas API key, también debe permitir Authorization en CORS.
                                        </span>
                                    )}
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="grid gap-1 text-xs text-gray-400">
                                        <span>Modelo</span>
                                        <input
                                            type="text"
                                            value={customSettings.model || ''}
                                            onChange={(event) => updateCustomSettings({ model: event.target.value })}
                                            placeholder="whisper-1"
                                            disabled={isProcessing}
                                            className="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                        />
                                    </label>

                                    <label className="grid gap-1 text-xs text-gray-400">
                                        <span className="flex items-center gap-1">
                                            <KeyRound className="h-3.5 w-3.5" />
                                            API key opcional
                                        </span>
                                        <input
                                            type="password"
                                            value={customSettings.apiKey || ''}
                                            onChange={(event) => updateCustomSettings({ apiKey: event.target.value })}
                                            placeholder="sk-local..."
                                            disabled={isProcessing}
                                            className="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                        />
                                    </label>
                                </div>

                                <p className="text-xs text-gray-500">
                                    Guardado sólo en este navegador.
                                </p>
                            </div>
                        )}
                    </div>
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
                        onClick={handleConfirm}
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
