import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { TranscriptionPreferenceStorage } from '@/lib/ai/transcription-preferences';
import type {
    BuiltInTranscriptionRouteId,
    LocalBrowserTranscriptionSettings,
    TranscriptionSubmission,
} from '@/types/transcription';
import {
    CUSTOM_TRANSCRIPTION_PREFERENCES_KEY,
    DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS,
    LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY,
    createDefaultTranscriptionPreferences,
    loadTranscriptionPreferences,
    saveTranscriptionPreferences,
} from '@/lib/ai/transcription-preferences';

const defaultLocalSettings = {
    enabled: true,
    engine: 'whisper-webgpu' as const,
    manifestId: 'whisper-base-webgpu',
    device: 'webgpu' as const,
    language: 'auto' as const,
    allowWasmFallback: false,
};

const publicOptions = {
    visibleBuiltInRouteIds: [] as const,
    visibleLocalManifests: [
        { id: 'whisper-base-webgpu', engine: 'whisper-webgpu' as const },
    ],
    defaultLocalBrowserTranscription: defaultLocalSettings,
};

const paidOptions = {
    ...publicOptions,
    visibleBuiltInRouteIds: ['whisper-1', 'deepgram-nova-2', 'premium-whisper-gpt4o'] as const,
};

class MemoryStorage implements TranscriptionPreferenceStorage {
    readonly values = new Map<string, string>();
    readonly removed: string[] = [];

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.removed.push(key);
        this.values.delete(key);
    }
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('transcription preferences', () => {
    it('makes diarization representable only on the custom discriminated submission', () => {
        expectTypeOf<Extract<TranscriptionSubmission, { routeId: 'custom-openai-compatible' }>>()
            .toHaveProperty('diarizationEnabled');
        expectTypeOf<Extract<TranscriptionSubmission, { routeId: BuiltInTranscriptionRouteId }>>()
            .toEqualTypeOf<{ routeId: BuiltInTranscriptionRouteId }>();
        expectTypeOf<Extract<TranscriptionSubmission, { routeId: 'local-browser' }>>()
            .toEqualTypeOf<{
                routeId: 'local-browser';
                localBrowserTranscription: LocalBrowserTranscriptionSettings;
            }>();
    });

    it('returns safe browser-local defaults when both historical keys are absent', () => {
        const result = loadTranscriptionPreferences(new MemoryStorage(), publicOptions);

        expect(result).toEqual({
            storageHealthy: true,
            preferences: {
                selectedRouteId: 'local-browser',
                customOpenAITranscription: DEFAULT_CUSTOM_TRANSCRIPTION_SETTINGS,
                diarizationEnabled: false,
                localBrowserTranscription: defaultLocalSettings,
            },
        });
    });

    it('retains valid legacy fields without inferring custom selection from enabled endpoint data', () => {
        const storage = new MemoryStorage();
        storage.values.set(CUSTOM_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            enabled: true,
            requestMode: 'server',
            endpoint: 'https://legacy-transcriber.test/v1',
            apiKey: 'legacy-local-key',
            model: 'whisper-1',
        }));
        storage.values.set(LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            engine: 'untrusted-engine',
            manifestId: 'whisper-base-webgpu',
            device: 'wasm',
            language: 'es',
            allowWasmFallback: true,
        }));

        const result = loadTranscriptionPreferences(storage, publicOptions);

        expect(result.preferences.selectedRouteId).toBe('local-browser');
        expect(result.preferences.customOpenAITranscription).toEqual({
            enabled: true,
            requestMode: 'server',
            endpoint: 'https://legacy-transcriber.test/v1',
            apiKey: 'legacy-local-key',
            model: 'whisper-1',
        });
        expect(result.preferences.localBrowserTranscription).toEqual({
            enabled: true,
            engine: 'whisper-webgpu',
            manifestId: 'whisper-base-webgpu',
            device: 'wasm',
            language: 'es',
            allowWasmFallback: true,
        });
    });

    it('normalizes partial fields independently and derives a visible manifest engine', () => {
        const storage = new MemoryStorage();
        storage.values.set(CUSTOM_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            selectedRouteId: 'custom-openai-compatible',
            endpoint: 42,
            apiKey: 'preserved',
            diarizationEnabled: true,
        }));
        storage.values.set(LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            manifestId: 'hidden-experimental-manifest',
            device: 'invalid',
            language: 'fr',
        }));

        const result = loadTranscriptionPreferences(storage, publicOptions);

        expect(result.preferences).toEqual({
            selectedRouteId: 'custom-openai-compatible',
            customOpenAITranscription: {
                enabled: false,
                requestMode: 'browser',
                endpoint: '',
                apiKey: 'preserved',
                model: 'faster-whisper',
            },
            diarizationEnabled: true,
            localBrowserTranscription: defaultLocalSettings,
        });
    });

    it('keeps the custom route distinct from built-in whisper and rejects hidden paid routes', () => {
        const storage = new MemoryStorage();
        storage.values.set(CUSTOM_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            selectedRouteId: 'whisper-1',
            enabled: true,
        }));

        expect(loadTranscriptionPreferences(storage, paidOptions).preferences.selectedRouteId).toBe('whisper-1');
        expect(loadTranscriptionPreferences(storage, publicOptions).preferences.selectedRouteId).toBe('local-browser');

        storage.values.set(CUSTOM_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            selectedRouteId: 'custom-openai-compatible',
            enabled: true,
        }));
        expect(loadTranscriptionPreferences(storage, publicOptions).preferences.selectedRouteId)
            .toBe('custom-openai-compatible');
    });

    it('removes malformed records without turning successful cleanup into a storage failure', () => {
        const storage = new MemoryStorage();
        storage.values.set(CUSTOM_TRANSCRIPTION_PREFERENCES_KEY, '{contains-secret-but-is-not-json');
        storage.values.set(LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY, '[]');

        const result = loadTranscriptionPreferences(storage, publicOptions);

        expect(result.storageHealthy).toBe(true);
        expect(storage.removed).toEqual([
            CUSTOM_TRANSCRIPTION_PREFERENCES_KEY,
            LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY,
        ]);
        expect(result.preferences).toEqual(createDefaultTranscriptionPreferences(publicOptions));
    });

    it('reports getItem and cleanup failures generically while retaining usable choices from the other key', () => {
        const localRecord = JSON.stringify({
            manifestId: 'whisper-base-webgpu',
            language: 'en',
        });
        const readFailureStorage: TranscriptionPreferenceStorage = {
            getItem(key) {
                if (key === CUSTOM_TRANSCRIPTION_PREFERENCES_KEY) throw new Error('sentinel read exception');
                return localRecord;
            },
            setItem() {},
            removeItem() {},
        };
        const cleanupFailureStorage: TranscriptionPreferenceStorage = {
            getItem(key) {
                return key === CUSTOM_TRANSCRIPTION_PREFERENCES_KEY ? '{bad' : null;
            },
            setItem() {},
            removeItem() {
                throw new Error('sentinel cleanup exception');
            },
        };

        const readFailure = loadTranscriptionPreferences(readFailureStorage, publicOptions);
        expect(readFailure.storageHealthy).toBe(false);
        expect(readFailure.preferences.localBrowserTranscription.language).toBe('en');
        expect(loadTranscriptionPreferences(cleanupFailureStorage, publicOptions).storageHealthy).toBe(false);
    });

    it('round-trips every field including the exact API key without logging serialized preferences', () => {
        const storage = new MemoryStorage();
        const logSpies = [
            vi.spyOn(console, 'log').mockImplementation(() => undefined),
            vi.spyOn(console, 'warn').mockImplementation(() => undefined),
            vi.spyOn(console, 'error').mockImplementation(() => undefined),
        ];
        const preferences = {
            selectedRouteId: 'custom-openai-compatible' as const,
            customOpenAITranscription: {
                enabled: true,
                requestMode: 'server' as const,
                endpoint: 'https://configured-transcriber.test/v1',
                apiKey: '  exact sentinel key  ',
                model: 'whisper-1',
            },
            diarizationEnabled: true,
            localBrowserTranscription: {
                ...defaultLocalSettings,
                device: 'wasm' as const,
                language: 'es' as const,
                allowWasmFallback: true,
            },
        };

        expect(saveTranscriptionPreferences(storage, preferences).storageHealthy).toBe(true);
        expect(loadTranscriptionPreferences(storage, paidOptions).preferences).toEqual(preferences);
        expect(logSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);
    });

    it('attempts both records and returns a generic failure when either setItem throws', () => {
        const writtenKeys: string[] = [];
        const storage: TranscriptionPreferenceStorage = {
            getItem: () => null,
            setItem(key) {
                writtenKeys.push(key);
                if (key === CUSTOM_TRANSCRIPTION_PREFERENCES_KEY) {
                    throw new Error('sentinel key write failure');
                }
            },
            removeItem() {},
        };

        const result = saveTranscriptionPreferences(
            storage,
            createDefaultTranscriptionPreferences(publicOptions),
        );

        expect(result.storageHealthy).toBe(false);
        expect(writtenKeys).toEqual([
            CUSTOM_TRANSCRIPTION_PREFERENCES_KEY,
            LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY,
        ]);
    });
});
