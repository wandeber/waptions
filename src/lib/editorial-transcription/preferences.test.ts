import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
    EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
    EditorialSessionApiKey,
    LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
    loadEditorialTranscriptionPreferences,
    saveEditorialTranscriptionPreferences,
} from './preferences';

class MemoryStorage {
    readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

describe('editorial transcription preference codec', () => {
    it('migrates the legacy exact default Browser combination once and preserves other settings', () => {
        const storage = new MemoryStorage();
        storage.setItem(LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            requestMode: 'browser',
            language: 'pt-BR',
            detectSpeakers: true,
        }));

        const migrated = loadEditorialTranscriptionPreferences(storage);
        expect(migrated).toEqual({
            preferences: {
                ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
                requestMode: 'server',
                language: 'pt-br',
                detectSpeakers: true,
            },
            storageHealthy: true,
        });
        expect(storage.values.has(LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY)).toBe(false);
        expect(JSON.parse(storage.values.get(EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY) ?? '{}'))
            .toEqual({
                version: 2,
                endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES.endpoint,
                requestMode: 'server',
                language: 'pt-br',
                detectSpeakers: true,
            });
        expect(loadEditorialTranscriptionPreferences(storage)).toEqual(migrated);
    });

    it('keeps a custom legacy Browser endpoint in Browser mode', () => {
        const storage = new MemoryStorage();
        const customEndpoint = 'https://saved-transcriber.example/v1/audio/transcriptions';
        storage.setItem(LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            endpoint: customEndpoint,
            requestMode: 'browser',
        }));

        expect(loadEditorialTranscriptionPreferences(storage).preferences).toEqual({
            ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            endpoint: customEndpoint,
            requestMode: 'browser',
        });
    });

    it('keeps an explicit current Browser choice after the legacy migration has run', () => {
        const storage = new MemoryStorage();
        storage.setItem(LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
            ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            requestMode: 'browser',
        }));
        const migrated = loadEditorialTranscriptionPreferences(storage);
        expect(migrated.preferences.requestMode).toBe('server');

        const explicitBrowser = { ...migrated.preferences, requestMode: 'browser' as const };
        expect(saveEditorialTranscriptionPreferences(storage, explicitBrowser))
            .toEqual({ storageHealthy: true });
        expect(loadEditorialTranscriptionPreferences(storage).preferences).toEqual(explicitBrowser);
    });

    it('defaults first use to Server without overriding current saved preferences', () => {
        const storage = new MemoryStorage();

        expect(loadEditorialTranscriptionPreferences(storage).preferences.requestMode).toBe('server');

        const savedPreferences = {
            ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            endpoint: 'https://saved-transcriber.example/v1/audio/transcriptions',
            requestMode: 'browser' as const,
            language: 'fr',
            detectSpeakers: true,
        };
        saveEditorialTranscriptionPreferences(storage, savedPreferences);
        expect(loadEditorialTranscriptionPreferences(storage).preferences).toEqual(savedPreferences);
    });

    it('defaults the first-use endpoint without overriding a saved endpoint', () => {
        const storage = new MemoryStorage();

        expect(loadEditorialTranscriptionPreferences(storage).preferences.endpoint).toBe(
            'http://localhost:43556/v1/audio/transcriptions',
        );

        const savedEndpoint = 'https://saved-transcriber.example/v1/audio/transcriptions';
        saveEditorialTranscriptionPreferences(storage, {
            ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            endpoint: savedEndpoint,
        });
        expect(loadEditorialTranscriptionPreferences(storage).preferences.endpoint).toBe(savedEndpoint);
    });

    it('defaults first-use language to Spanish without overriding a saved preference', () => {
        const storage = new MemoryStorage();

        expect(loadEditorialTranscriptionPreferences(storage)).toEqual({
            preferences: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
            storageHealthy: true,
        });

        for (const language of ['en', null]) {
            saveEditorialTranscriptionPreferences(storage, {
                ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
                language,
            });
            expect(loadEditorialTranscriptionPreferences(storage).preferences.language).toBe(language);
        }
    });

    it('persists only normalized non-secret editorial settings', () => {
        const storage = new MemoryStorage();
        const input = {
            version: 1 as const,
            endpoint: 'localhost:43556',
            requestMode: 'server' as const,
            language: ' ES-es ',
            detectSpeakers: true,
            apiKey: 'must-not-persist',
        };

        expect(() => saveEditorialTranscriptionPreferences(storage, input)).toThrow(
            'unsupported fields',
        );
        expect(storage.values.size).toBe(0);

        const safe = { ...input } as Record<string, unknown>;
        delete safe.apiKey;
        expect(saveEditorialTranscriptionPreferences(
            storage,
            safe as unknown as typeof DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
        )).toEqual({ storageHealthy: true });
        const serialized = storage.values.get(EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY) ?? '';
        expect(serialized).toBe(
            '{"version":2,"endpoint":"http://localhost:43556/v1/audio/transcriptions","requestMode":"server","language":"es-es","detectSpeakers":true}',
        );
        expect(serialized).not.toContain('must-not-persist');
    });

    it('removes malformed or secret-bearing current and legacy records without exposing values', () => {
        for (const [key, serialized] of [
            [EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, '{malformed-current'],
            [LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, '{malformed-legacy'],
            [EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
                version: 2,
                endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES.endpoint,
                requestMode: 'unexpected-direct-mode',
                language: 'es',
                detectSpeakers: false,
            })],
            [EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
                version: 2,
                endpoint: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES.endpoint,
                requestMode: 'server',
                language: 'es',
                detectSpeakers: false,
                apiKey: 'sentinel-current-secret',
            })],
            [LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, JSON.stringify({
                ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
                apiKey: 'sentinel-legacy-secret',
            })],
        ] as const) {
            const storage = new MemoryStorage();
            storage.values.set(key, serialized);

            expect(loadEditorialTranscriptionPreferences(storage)).toEqual({
                preferences: DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
                storageHealthy: true,
            });
            expect(storage.values.size).toBe(0);
        }
    });

    it('rejects fragments, URL credentials and query parameters', () => {
        const storage = new MemoryStorage();
        for (const endpoint of [
            'https://example.com/v1#fragment',
            'https://user:pass@example.com/v1',
            'https://example.com/v1?api_key=secret',
        ]) {
            expect(() => saveEditorialTranscriptionPreferences(storage, {
                ...DEFAULT_EDITORIAL_TRANSCRIPTION_PREFERENCES,
                endpoint,
            })).toThrow();
        }
    });

    it('keeps the API key only in an explicit disposable session holder', () => {
        const credential = new EditorialSessionApiKey();
        credential.set(' session-secret ');
        expect(credential.get()).toBe('session-secret');
        expect(credential.hasValue()).toBe(true);
        expect(JSON.stringify(credential)).not.toContain('session-secret');
        credential.dispose();
        expect(credential.get()).toBeUndefined();
    });
});
