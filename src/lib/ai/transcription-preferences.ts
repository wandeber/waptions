import type {
    BuiltInTranscriptionRouteId,
    LocalBrowserTranscriptionEngine,
    LocalBrowserTranscriptionSettings,
    OpenAICompatibleTranscriptionSettings,
    TranscriptionRouteId,
} from '@/types/transcription';

export const CUSTOM_TRANSCRIPTION_PREFERENCES_KEY = 'waptions-custom-openai-compatible-transcription';
export const LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY = 'waptions-local-browser-transcription';

export const DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS: OpenAICompatibleTranscriptionSettings = {
    enabled: false,
    requestMode: 'browser',
    endpoint: '',
    apiKey: '',
    model: 'faster-whisper',
};

export interface VisibleLocalTranscriptionManifest {
    id: string;
    engine: LocalBrowserTranscriptionEngine;
}

export interface TranscriptionPreferenceCodecOptions {
    visibleBuiltInRouteIds: readonly BuiltInTranscriptionRouteId[];
    visibleLocalManifests: readonly VisibleLocalTranscriptionManifest[];
    defaultLocalBrowserTranscription: LocalBrowserTranscriptionSettings;
}

export interface TranscriptionPreferences {
    selectedRouteId: TranscriptionRouteId;
    customOpenAITranscription: OpenAICompatibleTranscriptionSettings;
    diarizationEnabled: boolean;
    localBrowserTranscription: LocalBrowserTranscriptionSettings;
}

/** A minimal adapter keeps the preference codec usable in unit tests without a DOM. */
export interface TranscriptionPreferenceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface LoadedTranscriptionPreferences {
    preferences: TranscriptionPreferences;
    storageHealthy: boolean;
}

export interface SavedTranscriptionPreferences {
    storageHealthy: boolean;
}

interface ReadStoredRecordResult {
    record: Record<string, unknown> | null;
    storageHealthy: boolean;
}

export function createDefaultTranscriptionPreferences(
    options: TranscriptionPreferenceCodecOptions,
): TranscriptionPreferences {
    return {
        selectedRouteId: 'local-browser',
        customOpenAITranscription: { ...DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS },
        diarizationEnabled: false,
        localBrowserTranscription: normalizeLocalBrowserSettings(null, options),
    };
}

/**
 * Reads both historical storage keys independently. A failure in one record must not discard a
 * valid record in the other, and storage exceptions are deliberately returned as generic health
 * state instead of being logged where credentials or serialized values could leak.
 */
export function loadTranscriptionPreferences(
    storage: TranscriptionPreferenceStorage,
    options: TranscriptionPreferenceCodecOptions,
): LoadedTranscriptionPreferences {
    const customResult = readStoredRecord(storage, CUSTOM_TRANSCRIPTION_PREFERENCES_KEY);
    const localResult = readStoredRecord(storage, LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY);
    const customRecord = customResult.record;

    return {
        preferences: {
            selectedRouteId: normalizeSelectedRoute(customRecord?.selectedRouteId, options.visibleBuiltInRouteIds),
            customOpenAITranscription: normalizeCustomSettings(customRecord),
            diarizationEnabled: customRecord?.diarizationEnabled === true,
            localBrowserTranscription: normalizeLocalBrowserSettings(localResult.record, options),
        },
        storageHealthy: customResult.storageHealthy && localResult.storageHealthy,
    };
}

/**
 * Writes the two established records additively. The API key is intentionally preserved exactly:
 * trimming or otherwise rewriting it during persistence can silently invalidate a local service
 * credential. Callers may still normalize the value they submit over the network.
 */
export function saveTranscriptionPreferences(
    storage: TranscriptionPreferenceStorage,
    preferences: TranscriptionPreferences,
): SavedTranscriptionPreferences {
    const customRecord = {
        version: 1,
        selectedRouteId: preferences.selectedRouteId,
        enabled: preferences.customOpenAITranscription.enabled,
        requestMode: preferences.customOpenAITranscription.requestMode === 'server' ? 'server' : 'browser',
        endpoint: preferences.customOpenAITranscription.endpoint,
        apiKey: preferences.customOpenAITranscription.apiKey ?? '',
        model: preferences.customOpenAITranscription.model ?? '',
        diarizationEnabled: preferences.diarizationEnabled,
    };
    const localRecord = {
        version: 1,
        enabled: true,
        engine: preferences.localBrowserTranscription.engine,
        manifestId: preferences.localBrowserTranscription.manifestId,
        device: preferences.localBrowserTranscription.device === 'wasm' ? 'wasm' : 'webgpu',
        language: normalizeLocalLanguage(preferences.localBrowserTranscription.language),
        allowWasmFallback: preferences.localBrowserTranscription.allowWasmFallback === true,
    };

    let storageHealthy = true;
    try {
        storage.setItem(CUSTOM_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify(customRecord));
    } catch {
        storageHealthy = false;
    }
    try {
        storage.setItem(LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify(localRecord));
    } catch {
        storageHealthy = false;
    }

    return { storageHealthy };
}

function readStoredRecord(
    storage: TranscriptionPreferenceStorage,
    key: string,
): ReadStoredRecordResult {
    let serialized: string | null;
    try {
        serialized = storage.getItem(key);
    } catch {
        return { record: null, storageHealthy: false };
    }

    if (serialized === null) {
        return { record: null, storageHealthy: true };
    }

    try {
        const parsed: unknown = JSON.parse(serialized);
        if (isRecord(parsed)) {
            return { record: parsed, storageHealthy: true };
        }
    } catch {
        // A malformed record is removed below without exposing its potentially secret contents.
    }

    try {
        storage.removeItem(key);
        return { record: null, storageHealthy: true };
    } catch {
        return { record: null, storageHealthy: false };
    }
}

function normalizeSelectedRoute(
    value: unknown,
    visibleBuiltInRouteIds: readonly BuiltInTranscriptionRouteId[],
): TranscriptionRouteId {
    if (value === 'local-browser' || value === 'custom-openai-compatible') {
        return value;
    }
    if (typeof value === 'string' && visibleBuiltInRouteIds.includes(value as BuiltInTranscriptionRouteId)) {
        return value as BuiltInTranscriptionRouteId;
    }
    return 'local-browser';
}

function normalizeCustomSettings(record: Record<string, unknown> | null): OpenAICompatibleTranscriptionSettings {
    return {
        enabled: record?.enabled === true,
        requestMode: record?.requestMode === 'server' ? 'server' : 'browser',
        endpoint: typeof record?.endpoint === 'string' ? record.endpoint : DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS.endpoint,
        apiKey: typeof record?.apiKey === 'string' ? record.apiKey : DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS.apiKey,
        model: typeof record?.model === 'string' ? record.model : DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS.model,
    };
}

function normalizeLocalBrowserSettings(
    record: Record<string, unknown> | null,
    options: TranscriptionPreferenceCodecOptions,
): LocalBrowserTranscriptionSettings {
    const fallbackManifest = options.visibleLocalManifests.find(
        manifest => manifest.id === options.defaultLocalBrowserTranscription.manifestId,
    ) ?? options.visibleLocalManifests[0];
    const storedManifest = typeof record?.manifestId === 'string'
        ? options.visibleLocalManifests.find(manifest => manifest.id === record.manifestId)
        : undefined;
    const manifest = storedManifest ?? fallbackManifest;

    // The application always exposes at least one local manifest. Retaining the configured default
    // here makes this pure codec safe in isolated tests or future feature-flag mistakes as well.
    const manifestId = manifest?.id ?? options.defaultLocalBrowserTranscription.manifestId;
    const engine = manifest?.engine ?? options.defaultLocalBrowserTranscription.engine;

    return {
        enabled: true,
        engine,
        manifestId,
        device: record?.device === 'wasm' ? 'wasm' : 'webgpu',
        language: normalizeLocalLanguage(record?.language),
        allowWasmFallback: record?.allowWasmFallback === true,
    };
}

function normalizeLocalLanguage(value: unknown): 'auto' | 'en' | 'es' {
    return value === 'en' || value === 'es' ? value : 'auto';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
