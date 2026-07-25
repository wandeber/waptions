'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/design-system/Button';
import { Select } from '@/components/design-system/Select';
import {
    BuiltInTranscriptionRouteId,
    getVisibleTranscriptionModels,
    LocalBrowserTranscriptionDevice,
    LocalBrowserTranscriptionLanguage,
    LocalBrowserTranscriptionSettings,
    OpenAICompatibleTranscriptionSettings,
    TranscriptionModel,
    TranscriptionRouteId,
    TranscriptionSubmission,
} from '@/types/transcription';
import { Sparkles, Bot, Check, Server, KeyRound, Monitor, Cpu, AlertTriangle } from 'lucide-react';
import { shouldShowPaidTranscriptionModels } from '@/lib/config/feature-flags';
import {
    DEFAULT_LOCAL_BROWSER_TRANSCRIPTION_SETTINGS,
    getLocalBrowserTranscriptionCapabilities,
    getVisibleLocalBrowserModelManifests,
    isLocalBrowserWebGpuReady,
    LocalBrowserModelManifest,
} from '@/lib/ai/local-browser-transcription';
import {
    createDefaultTranscriptionPreferences,
    DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS,
    loadTranscriptionPreferences,
    saveTranscriptionPreferences,
    TranscriptionPreferenceCodecOptions,
} from '@/lib/ai/transcription-preferences';

interface TranscriptionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (submission: TranscriptionSubmission) => void;
    isProcessing?: boolean;
    status?: string | null;
    onCancelProcessing?: () => void;
}

interface LocalBrowserCapabilities {
    browserSupported: boolean;
    webgpuAvailable: boolean;
    crossOriginIsolated: boolean;
    recommendedDevice: LocalBrowserTranscriptionDevice;
}

const DEFAULT_LOCAL_BROWSER_CAPABILITIES: LocalBrowserCapabilities = {
    browserSupported: false,
    webgpuAvailable: false,
    crossOriginIsolated: false,
    recommendedDevice: 'webgpu',
};

export function TranscriptionModal({
    isOpen,
    onClose,
    onConfirm,
    isProcessing = false,
    status = null,
    onCancelProcessing
}: TranscriptionModalProps) {
    const paidModelsVisible = shouldShowPaidTranscriptionModels();
    const visibleModels = useMemo(() => getVisibleTranscriptionModels(), []);
    const localManifests = useMemo(() => getVisibleLocalBrowserModelManifests(), []);
    const preferenceCodecOptions = useMemo<TranscriptionPreferenceCodecOptions>(() => ({
        visibleBuiltInRouteIds: visibleModels.map(model => model.id as BuiltInTranscriptionRouteId),
        visibleLocalManifests: localManifests,
        defaultLocalBrowserTranscription: DEFAULT_LOCAL_BROWSER_TRANSCRIPTION_SETTINGS,
    }), [localManifests, visibleModels]);
    const initialPreferences = useMemo(
        () => createDefaultTranscriptionPreferences(preferenceCodecOptions),
        [preferenceCodecOptions],
    );
    const [selectedRouteId, setSelectedRouteId] = useState<TranscriptionRouteId>(initialPreferences.selectedRouteId);
    const [customSettings, setCustomSettings] = useState<OpenAICompatibleTranscriptionSettings>(initialPreferences.customOpenAITranscription);
    const [diarizationEnabled, setDiarizationEnabled] = useState(initialPreferences.diarizationEnabled);
    const [localSettings, setLocalSettings] = useState<LocalBrowserTranscriptionSettings>(initialPreferences.localBrowserTranscription);
    const [capabilities, setCapabilities] = useState<LocalBrowserCapabilities>(DEFAULT_LOCAL_BROWSER_CAPABILITIES);
    const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);
    const [storageLoadFailed, setStorageLoadFailed] = useState(false);
    const [storageWriteFailed, setStorageWriteFailed] = useState(false);
    const [endpointError, setEndpointError] = useState<string | null>(null);
    const [localBrowserError, setLocalBrowserError] = useState<string | null>(null);

    const selectedLocalManifest = getVisibleLocalManifest(localManifests, localSettings.manifestId);
    const requestedLocalDevice = localSettings.device || capabilities.recommendedDevice;
    const localNeedsWasmFallback = !capabilities.webgpuAvailable
        && (requestedLocalDevice === 'webgpu' || selectedLocalManifest.requiresWebGpu);
    const localSelectionBlocked = selectedRouteId === 'local-browser'
        && (!capabilities.browserSupported || (localNeedsWasmFallback && !localSettings.allowWasmFallback));
    const customEndpointSelected = selectedRouteId === 'custom-openai-compatible';
    const canUseCustomEndpoint = customEndpointSelected;

    useEffect(() => {
        let isMounted = true;
        const initialCapabilities = getLocalBrowserTranscriptionCapabilities();
        setCapabilities(initialCapabilities);

        isLocalBrowserWebGpuReady().then((webgpuReady) => {
            if (!isMounted) {
                return;
            }

            setCapabilities(current => ({
                ...current,
                webgpuAvailable: webgpuReady,
                recommendedDevice: webgpuReady ? 'webgpu' : 'wasm',
            }));
        });

        return () => {
            isMounted = false;
        };
    }, []);

    useEffect(() => {
        try {
            const loaded = loadTranscriptionPreferences(window.localStorage, preferenceCodecOptions);
            setSelectedRouteId(loaded.preferences.selectedRouteId);
            setCustomSettings(loaded.preferences.customOpenAITranscription);
            setDiarizationEnabled(loaded.preferences.diarizationEnabled);
            setLocalSettings(loaded.preferences.localBrowserTranscription);
            setStorageLoadFailed(!loaded.storageHealthy);
        } catch {
            // Some browser policies can reject access to the localStorage object itself before the
            // adapter can guard its methods. Session defaults remain usable in that environment.
            setStorageLoadFailed(true);
        } finally {
            setHasLoadedPreferences(true);
        }
    }, [preferenceCodecOptions]);

    useEffect(() => {
        if (!hasLoadedPreferences) {
            return;
        }

        try {
            const saved = saveTranscriptionPreferences(window.localStorage, {
                selectedRouteId,
                customOpenAITranscription: customSettings,
                diarizationEnabled,
                localBrowserTranscription: localSettings,
            });
            // A later successful write can recover a write-only failure. A failed initial read is
            // kept separately because that mounted session never had trustworthy persisted state.
            setStorageWriteFailed(!saved.storageHealthy);
        } catch {
            setStorageWriteFailed(true);
        }
    }, [
        customSettings,
        diarizationEnabled,
        hasLoadedPreferences,
        localSettings,
        selectedRouteId,
    ]);

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

    const updateLocalSettings = (updates: Partial<LocalBrowserTranscriptionSettings>) => {
        setLocalBrowserError(null);
        setLocalSettings(current => {
            const manifest = updates.manifestId
                ? getVisibleLocalManifest(localManifests, updates.manifestId)
                : getVisibleLocalManifest(localManifests, current.manifestId);

            return {
                ...current,
                ...updates,
                enabled: true,
                manifestId: manifest.id,
                engine: manifest.engine,
            };
        });
    };

    const selectCustomEndpoint = () => {
        setSelectedRouteId('custom-openai-compatible');
        updateCustomSettings({ enabled: true });
    };

    const getCustomSettingsForSubmit = (): OpenAICompatibleTranscriptionSettings | undefined => {
        const endpoint = customSettings.endpoint.trim();
        if (!endpoint) {
            setEndpointError('The endpoint is required.');
            return undefined;
        }

        return {
            enabled: true,
            requestMode: customSettings.requestMode || 'browser',
            endpoint,
            apiKey: customSettings.apiKey?.trim() || undefined,
            model: customSettings.model?.trim() || DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS.model,
        };
    };

    const getLocalBrowserSettingsForSubmit = (): LocalBrowserTranscriptionSettings | undefined => {
        if (!capabilities.browserSupported) {
            setLocalBrowserError('This browser cannot run local transcription workers.');
            return undefined;
        }

        if (localNeedsWasmFallback && !localSettings.allowWasmFallback) {
            setLocalBrowserError('WebGPU is not available. Enable the WASM fallback or use a Chromium browser with WebGPU.');
            return undefined;
        }

        return {
            ...localSettings,
            enabled: true,
            engine: selectedLocalManifest.engine,
            manifestId: selectedLocalManifest.id,
            device: localNeedsWasmFallback ? 'wasm' : requestedLocalDevice,
            language: localSettings.language || 'auto',
        };
    };

    const handleConfirm = () => {
        if (selectedRouteId === 'local-browser') {
            const localBrowserTranscription = getLocalBrowserSettingsForSubmit();
            if (!localBrowserTranscription) {
                return;
            }
            onConfirm({ routeId: 'local-browser', localBrowserTranscription });
            return;
        }

        if (selectedRouteId === 'custom-openai-compatible') {
            const customOpenAITranscription = getCustomSettingsForSubmit();
            if (!customOpenAITranscription) {
                return;
            }
            onConfirm({
                routeId: 'custom-openai-compatible',
                customOpenAITranscription,
                diarizationEnabled,
            });
            return;
        }

        onConfirm({ routeId: selectedRouteId });
    };

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-[100] transition-opacity duration-300">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="transcription-modal-title"
                className="bg-gray-900 border border-gray-700/50 rounded-xl p-0 max-w-4xl w-full mx-4 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 ring-1 ring-white/10 max-h-[90vh] flex flex-col"
            >

                {/* Header */}
                <div className="p-6 pb-2 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-4 opacity-10">
                        <Sparkles className="w-32 h-32 text-purple-500 transform rotate-12" />
                    </div>

                    <h2
                        id="transcription-modal-title"
                        className="text-2xl font-bold text-white mb-2 flex items-center gap-2 relative z-10"
                    >
                        <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
                            {paidModelsVisible ? 'Potencia tu contenido' : 'Configura tu transcriptor'}
                        </span>
                        <Sparkles className="w-5 h-5 text-purple-400" />
                    </h2>
                    <p className="text-gray-400 text-sm relative z-10">
                        {paidModelsVisible
                            ? 'Elige el motor de IA que mejor se adapte a tus necesidades de velocidad y precisión.'
                            : 'Waptions can run transcription in the browser or use the OpenAI-compatible endpoint configured on this device.'}
                    </p>
                </div>

                {/* Body */}
                <div className="p-6 space-y-3 overflow-y-auto">
                    {(storageLoadFailed || storageWriteFailed) && (
                        <div
                            role="alert"
                            aria-live="polite"
                            data-testid="transcription-preferences-storage-warning"
                            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200"
                        >
                            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                            <span>
                                Transcription preferences could not be read or saved in this browser. Your current choices will work for this session only.
                            </span>
                        </div>
                    )}
                    <div
                        onClick={() => setSelectedRouteId('local-browser')}
                        data-testid="transcription-route-local-browser"
                        data-selected={selectedRouteId === 'local-browser'}
                        className={`
                            relative rounded-lg border p-4 cursor-pointer transition-all duration-200
                            ${selectedRouteId === 'local-browser'
                                ? 'bg-emerald-500/10 border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.14)]'
                                : 'bg-gray-800/50 border-gray-700 hover:bg-gray-800 hover:border-gray-600'
                            }
                        `}
                    >
                        <div className="flex items-center gap-4">
                            <div className={`
                                flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors
                                ${selectedRouteId === 'local-browser' ? 'bg-emerald-500 text-white' : 'bg-gray-700 text-gray-400'}
                            `}>
                                <Cpu className="w-5 h-5" />
                            </div>

                            <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2 mb-0.5">
                                    <h3 className={`font-semibold text-sm ${selectedRouteId === 'local-browser' ? 'text-white' : 'text-gray-200'}`}>
                                        Local browser transcription
                                    </h3>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium tracking-wide border bg-emerald-500/20 text-emerald-300 border-emerald-500/30">
                                        Free
                                    </span>
                                </div>
                                <p className="text-xs text-gray-400/80">
                                    Runs on the user&apos;s device. The first run downloads the model into the browser cache and keeps audio off Waptions servers.
                                </p>
                            </div>

                            <div className={`
                                w-5 h-5 rounded-full border flex items-center justify-center transition-all
                                ${selectedRouteId === 'local-browser'
                                    ? 'border-emerald-500 bg-emerald-500 text-white scale-100'
                                    : 'border-gray-600 bg-transparent text-transparent scale-90 opacity-50'
                                }
                            `}>
                                <Check className="w-3 h-3 stroke-[3]" />
                            </div>
                        </div>

                        {selectedRouteId === 'local-browser' && (
                            <div className="mt-4 grid gap-3" onClick={(event) => event.stopPropagation()}>
                                <div className="grid gap-3 sm:grid-cols-[1.3fr_1fr_0.8fr]">
                                    <label className="grid gap-1 text-xs text-gray-400">
                                        <span>Model</span>
                                        <Select
                                            value={selectedLocalManifest.id}
                                            onChange={(event) => updateLocalSettings({ manifestId: event.target.value })}
                                            disabled={isProcessing}
                                            tone="modalSuccess"
                                            controlSize="md"
                                        >
                                            {localManifests.map(manifest => (
                                                <option key={manifest.id} value={manifest.id}>
                                                    {manifest.label} ({manifest.estimatedDownloadMb} MB)
                                                </option>
                                            ))}
                                        </Select>
                                    </label>

                                    <label className="grid gap-1 text-xs text-gray-400">
                                        <span>Runtime</span>
                                        <Select
                                            value={requestedLocalDevice}
                                            onChange={(event) => updateLocalSettings({ device: event.target.value as LocalBrowserTranscriptionDevice })}
                                            disabled={isProcessing}
                                            tone="modalSuccess"
                                            controlSize="md"
                                        >
                                            <option value="webgpu">WebGPU</option>
                                            <option value="wasm">WASM</option>
                                        </Select>
                                    </label>

                                    <label className="grid gap-1 text-xs text-gray-400">
                                        <span>Language</span>
                                        <Select
                                            value={localSettings.language || 'auto'}
                                            onChange={(event) => updateLocalSettings({ language: event.target.value as LocalBrowserTranscriptionLanguage })}
                                            disabled={isProcessing}
                                            tone="modalSuccess"
                                            controlSize="md"
                                        >
                                            <option value="auto">Auto</option>
                                            <option value="es">Spanish</option>
                                            <option value="en">English</option>
                                        </Select>
                                    </label>
                                </div>

                                <label className="flex items-start gap-2 text-xs text-gray-400">
                                    <input
                                        type="checkbox"
                                        checked={localSettings.allowWasmFallback === true}
                                        onChange={(event) => updateLocalSettings({ allowWasmFallback: event.target.checked })}
                                        disabled={isProcessing}
                                        className="mt-0.5 h-4 w-4 accent-emerald-500"
                                    />
                                    <span>
                                        Allow slow WASM fallback when WebGPU is unavailable. This helps compatibility, but long videos can be much slower.
                                    </span>
                                </label>

                                <div className="grid gap-2 text-xs text-gray-400">
                                    <p>
                                        {selectedLocalManifest.description}
                                    </p>
                                    {!capabilities.webgpuAvailable && (
                                        <p className="flex items-start gap-2 text-amber-300">
                                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                                            <span>WebGPU was not detected in this browser. Use WASM fallback or try Chromium/Edge for better performance.</span>
                                        </p>
                                    )}
                                    {selectedLocalManifest.experimental && (
                                        <p className="flex items-start gap-2 text-amber-300">
                                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                                            <span>This Qwen/Mega-ASR path is experimental and intended for validation before making it public by default.</span>
                                        </p>
                                    )}
                                    {localBrowserError && (
                                        <p className="text-red-400">{localBrowserError}</p>
                                    )}
                                    {isProcessing && status && (
                                        <p className="text-emerald-200">{status}</p>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {visibleModels.map((model) => {
                        const isSelected = selectedRouteId === model.id;

                        return (
                            <div
                                key={model.id}
                                onClick={() => {
                                    setSelectedRouteId(model.id);
                                }}
                                data-testid={`transcription-route-${model.id}`}
                                data-selected={isSelected}
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

                    <div
                        onClick={selectCustomEndpoint}
                        data-testid="transcription-route-custom-openai-compatible"
                        data-selected={customEndpointSelected}
                        className={`rounded-lg border p-4 cursor-pointer transition-colors ${customEndpointSelected ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 bg-gray-800/40 hover:border-gray-600'}`}
                    >
                        <div className="flex items-center gap-3 text-sm text-gray-200">
                            <input
                                type="checkbox"
                                checked={customEndpointSelected}
                                onChange={(event) => {
                                    event.stopPropagation();
                                    const enabled = event.target.checked;
                                    updateCustomSettings({ enabled });
                                    setSelectedRouteId(enabled ? 'custom-openai-compatible' : 'local-browser');
                                }}
                                disabled={isProcessing}
                                className="h-4 w-4 accent-blue-500"
                            />
                            <span className="flex items-center gap-2 font-medium">
                                <Server className="h-4 w-4 text-blue-400" />
                                OpenAI-compatible transcriber
                            </span>
                            {customEndpointSelected && (
                                <Check className="ml-auto h-4 w-4 text-blue-400" />
                            )}
                        </div>

                        {canUseCustomEndpoint && (
                            <div className="mt-4 grid gap-3" onClick={(event) => event.stopPropagation()}>
                                <div className="grid gap-2 text-xs text-gray-400">
                                    <span>Request mode</span>
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
                                                Browser
                                            </span>
                                            <span className="mt-1 block text-xs text-gray-400">
                                                Uses localhost on this device.
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
                                                Server
                                            </span>
                                            <span className="mt-1 block text-xs text-gray-400">
                                                Avoids browser CORS; localhost is the Waptions server.
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
                                            Waptions sends the request from its server, so browser CORS does not apply. localhost resolves on the Waptions server, and production hosts must be explicitly allowed there.
                                        </span>
                                    ) : (
                                        <span>
                                            This browser sends the request directly. localhost resolves on this device, and the transcriber must allow CORS from {typeof window !== 'undefined' ? window.location.origin : 'Waptions'}, including Authorization when an API key is used.
                                        </span>
                                    )}
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="grid gap-1 text-xs text-gray-400">
                                        <span>Model</span>
                                        <input
                                            type="text"
                                            value={customSettings.model || ''}
                                            onChange={(event) => updateCustomSettings({ model: event.target.value })}
                                            placeholder="faster-whisper"
                                            disabled={isProcessing}
                                            className="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                        />
                                    </label>

                                    <label className="grid gap-1 text-xs text-gray-400">
                                        <span className="flex items-center gap-1">
                                            <KeyRound className="h-3.5 w-3.5" />
                                            Optional API key
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

                                <label className="flex items-start gap-2 rounded border border-gray-700 bg-gray-950/70 p-3 text-xs text-gray-300">
                                    <input
                                        type="checkbox"
                                        checked={diarizationEnabled}
                                        onChange={(event) => setDiarizationEnabled(event.target.checked)}
                                        disabled={isProcessing}
                                        className="mt-0.5 h-4 w-4 accent-blue-500"
                                    />
                                    <span>
                                        <span className="block font-medium text-gray-100">Speaker diarization</span>
                                        <span className="mt-1 block text-gray-400">
                                            Render the audible project mix and create one subtitle track per detected speaker.
                                        </span>
                                    </span>
                                </label>

                                <p className="text-xs leading-relaxed text-gray-500">
                                    These settings, including the API key, are stored in this browser&apos;s localStorage. They can be read by scripts running on this Waptions origin and by browser extensions, and are never added to the project.
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="p-6 pt-2 flex justify-end gap-3 border-t border-gray-800 bg-gray-900/50">
                    <Button
                        variant="ghost"
                        onClick={isProcessing ? onCancelProcessing : onClose}
                        disabled={isProcessing && !onCancelProcessing}
                        className="text-gray-400 hover:text-white"
                    >
                        {isProcessing ? 'Cancelar tarea' : 'Cancelar'}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleConfirm}
                        disabled={isProcessing || localSelectionBlocked}
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

function getVisibleLocalManifest(manifests: LocalBrowserModelManifest[], manifestId: string | undefined): LocalBrowserModelManifest {
    return manifests.find(manifest => manifest.id === manifestId) ?? manifests[0];
}
