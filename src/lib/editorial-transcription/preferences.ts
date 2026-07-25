import { normalizeEditorialTranscriptionEndpoint } from './endpoint';

export const LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY = 'waptions-editorial-transcription-v1';
export const EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY = 'waptions-editorial-transcription-v2';
export const DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT =
    'http://localhost:43556/v1/audio/transcriptions';

export type EditorialTranscriptionRequestMode = 'browser' | 'server';

/**
 * The only editorial transcription values allowed in localStorage.
 *
 * The fixed model/profile are deliberately absent, and there is no credential field. Runtime
 * writers below serialize a property whitelist, so an accidentally widened caller object cannot
 * persist an API key, Authorization value or future secret-bearing extension.
 */
export interface EditorialTranscriptionPreferencesV1 {
    version: 1;
    endpoint: string;
    requestMode: EditorialTranscriptionRequestMode;
    language: string | null;
    detectSpeakers: boolean;
}

/**
 * V2 is deliberately a storage-only schema. The runtime contract remains V1 so migrating a
 * browser preference cannot alter request identities, orchestration inputs or project records.
 * A new key/schema is necessary to distinguish a migrated legacy Browser default from a Browser
 * mode the user explicitly selected later; repeatedly rewriting V1 would make that choice stick
 * to Server forever.
 */
interface PersistedEditorialTranscriptionPreferencesV2 {
    version: 2;
    endpoint: string;
    requestMode: EditorialTranscriptionRequestMode;
    language: string | null;
    detectSpeakers: boolean;
}

export const DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES: EditorialTranscriptionPreferencesV1 = {
    version: 1,
    endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_ENDPOINT,
    requestMode: 'server',
    language: 'es',
    detectSpeakers: false,
};

export interface EditorialPreferenceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface EditorialPreferenceCodecResult {
    preferences: EditorialTranscriptionPreferencesV1;
    storageHealthy: boolean;
}

const PERSISTED_KEYS = new Set([
    'version',
    'endpoint',
    'requestMode',
    'language',
    'detectSpeakers',
]);

export function normalizeEditorialLanguage(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'auto') return null;
    if (normalized.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized)) {
        throw new Error('Editorial transcription language must be a valid BCP 47-style tag.');
    }
    return normalized;
}

export function normalizeEditorialTranscriptionPreferences(
    value: unknown,
): EditorialTranscriptionPreferencesV1 {
    if (!isRecord(value) || value.version !== 1) {
        throw new Error('Editorial transcription preferences must use version 1.');
    }
    if (Object.keys(value).some(key => !PERSISTED_KEYS.has(key))) {
        // Unknown fields fail closed. This is important for legacy or injected records containing
        // `apiKey`, `Authorization`, or a similarly named secret that a permissive codec might
        // otherwise preserve during a later write.
        throw new Error('Editorial transcription preferences contain unsupported fields.');
    }

    if (
        typeof value.endpoint !== 'string'
        || (value.requestMode !== 'browser' && value.requestMode !== 'server')
        || (value.language !== null && typeof value.language !== 'string')
        || typeof value.detectSpeakers !== 'boolean'
    ) {
        // Do not coerce a damaged or hand-edited record into Browser mode. The Browser path sends
        // requests from the user's origin, so invalid persisted state must be removed and replaced
        // by the safe Server-first defaults in the loader instead.
        throw new Error('Editorial transcription preferences contain invalid field values.');
    }

    const endpoint = value.endpoint.trim();
    return {
        version: 1,
        endpoint: endpoint ? normalizeEditorialTranscriptionEndpoint(endpoint) : '',
        requestMode: value.requestMode,
        language: normalizeEditorialLanguage(value.language),
        detectSpeakers: value.detectSpeakers === true,
    };
}

function normalizePersistedEditorialTranscriptionPreferencesV2(
    value: unknown,
): EditorialTranscriptionPreferencesV1 {
    if (!isRecord(value) || value.version !== 2) {
        throw new Error('Persisted editorial transcription preferences must use version 2.');
    }
    if (Object.keys(value).some(key => !PERSISTED_KEYS.has(key))) {
        throw new Error('Persisted editorial transcription preferences contain unsupported fields.');
    }
    return normalizeEditorialTranscriptionPreferences({
        version: 1,
        endpoint: value.endpoint,
        requestMode: value.requestMode,
        language: value.language,
        detectSpeakers: value.detectSpeakers,
    });
}

function createPersistedEditorialTranscriptionPreferencesV2(
    preferences: EditorialTranscriptionPreferencesV1,
): PersistedEditorialTranscriptionPreferencesV2 {
    return {
        version: 2,
        endpoint: preferences.endpoint,
        requestMode: preferences.requestMode,
        language: preferences.language,
        detectSpeakers: preferences.detectSpeakers,
    };
}

function migrateLegacyEditorialTranscriptionPreferences(
    preferences: EditorialTranscriptionPreferencesV1,
): EditorialTranscriptionPreferencesV1 {
    if (
        preferences.endpoint === DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES.endpoint
        && preferences.requestMode === 'browser'
    ) {
        return { ...preferences, requestMode: 'server' };
    }
    return preferences;
}

export function loadEditorialTranscriptionPreferences(
    storage: EditorialPreferenceStorage,
): EditorialPreferenceCodecResult {
    let currentSerialized: string | null;
    try {
        currentSerialized = storage.getItem(EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY);
    } catch {
        return defaultEditorialPreferenceResult(false);
    }
    if (currentSerialized !== null) {
        try {
            return {
                preferences: normalizePersistedEditorialTranscriptionPreferencesV2(
                    JSON.parse(currentSerialized),
                ),
                storageHealthy: removeEditorialPreferenceKeys(
                    storage,
                    [LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY],
                ),
            };
        } catch {
            // Either key may contain a secret-bearing injected record. Remove both without
            // logging or copying either serialized value into diagnostics.
            return defaultEditorialPreferenceResult(removeEditorialPreferenceKeys(storage, [
                EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
                LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
            ]));
        }
    }

    let legacySerialized: string | null;
    try {
        legacySerialized = storage.getItem(LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY);
    } catch {
        return defaultEditorialPreferenceResult(false);
    }
    if (legacySerialized === null) return defaultEditorialPreferenceResult(true);

    try {
        const preferences = migrateLegacyEditorialTranscriptionPreferences(
            normalizeEditorialTranscriptionPreferences(JSON.parse(legacySerialized)),
        );
        const saved = saveEditorialTranscriptionPreferences(storage, preferences);
        return {
            preferences,
            storageHealthy: saved.storageHealthy,
        };
    } catch {
        return defaultEditorialPreferenceResult(removeEditorialPreferenceKeys(
            storage,
            [LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY],
        ));
    }
}

export function saveEditorialTranscriptionPreferences(
    storage: EditorialPreferenceStorage,
    value: EditorialTranscriptionPreferencesV1,
): { storageHealthy: boolean } {
    const normalized = normalizeEditorialTranscriptionPreferences(value);
    const record = createPersistedEditorialTranscriptionPreferencesV2(normalized);
    try {
        storage.setItem(EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify(record));
    } catch {
        return { storageHealthy: false };
    }
    return {
        storageHealthy: removeEditorialPreferenceKeys(
            storage,
            [LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY],
        ),
    };
}

function defaultEditorialPreferenceResult(storageHealthy: boolean): EditorialPreferenceCodecResult {
    return {
        preferences: { ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES },
        storageHealthy,
    };
}

function removeEditorialPreferenceKeys(
    storage: EditorialPreferenceStorage,
    keys: readonly string[],
): boolean {
    let storageHealthy = true;
    for (const key of keys) {
        try {
            storage.removeItem(key);
        } catch {
            storageHealthy = false;
        }
    }
    return storageHealthy;
}

/**
 * Mounted-session credential holder used by the hook. It deliberately has no serialization API,
 * public field or storage dependency. Calling dispose on editor teardown overwrites the retained
 * reference before releasing it, which prevents a later project session from reusing the key.
 */
const sessionApiKeyValues = new WeakMap<EditorialSessionApiKey, string>();

export class EditorialSessionApiKey {
    constructor() {
        sessionApiKeyValues.set(this, '');
    }

    set(value: string): void {
        sessionApiKeyValues.set(this, value.trim());
    }

    get(): string | undefined {
        return sessionApiKeyValues.get(this) || undefined;
    }

    hasValue(): boolean {
        return (sessionApiKeyValues.get(this)?.length ?? 0) > 0;
    }

    clear(): void {
        sessionApiKeyValues.set(this, '');
    }

    dispose(): void {
        this.clear();
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
