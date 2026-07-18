import { describe, expect, it, vi } from 'vitest';
import {
    parseOpenAICompatibleTranscriptionSettings,
    resolveOpenAICompatibleTranscriptionUrl,
    transcribeWithOpenAICompatibleEndpoint,
} from './openai-compatible-transcription';

describe('resolveOpenAICompatibleTranscriptionUrl', () => {
    it('accepts a bare local domain and appends the OpenAI transcription route', () => {
        expect(resolveOpenAICompatibleTranscriptionUrl('localhost:8000')).toBe('http://localhost:8000/v1/audio/transcriptions');
    });

    it('accepts an OpenAI-style base path', () => {
        expect(resolveOpenAICompatibleTranscriptionUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1/audio/transcriptions');
    });

    it('keeps a full transcription route unchanged', () => {
        expect(resolveOpenAICompatibleTranscriptionUrl('http://localhost:8000/custom/v1/audio/transcriptions')).toBe(
            'http://localhost:8000/custom/v1/audio/transcriptions'
        );
    });

    it('rejects unsupported protocols and credentials in the URL', () => {
        expect(() => resolveOpenAICompatibleTranscriptionUrl('ftp://localhost:8000/v1')).toThrow('http or https');
        expect(() => resolveOpenAICompatibleTranscriptionUrl('http://user:pass@localhost:8000/v1')).toThrow('API key field');
    });
});

describe('parseOpenAICompatibleTranscriptionSettings', () => {
    it('returns null when custom transcription is missing or disabled', () => {
        expect(parseOpenAICompatibleTranscriptionSettings(null)).toBeNull();
        expect(parseOpenAICompatibleTranscriptionSettings(JSON.stringify({ enabled: false }))).toBeNull();
    });

    it('trims enabled custom settings', () => {
        expect(parseOpenAICompatibleTranscriptionSettings(JSON.stringify({
            enabled: true,
            requestMode: 'browser',
            endpoint: ' http://localhost:9000/v1 ',
            apiKey: ' local-key ',
            model: ' faster-whisper ',
        }))).toEqual({
            enabled: true,
            requestMode: 'browser',
            endpoint: 'http://localhost:9000/v1',
            apiKey: 'local-key',
            model: 'faster-whisper',
        });
    });

    it('defaults backend-provided custom settings to server mode', () => {
        expect(parseOpenAICompatibleTranscriptionSettings(JSON.stringify({
            enabled: true,
            endpoint: 'http://localhost:9000/v1',
        }))).toEqual({
            enabled: true,
            requestMode: 'server',
            endpoint: 'http://localhost:9000/v1',
            apiKey: undefined,
            model: undefined,
        });
    });

    it('rejects malformed settings', () => {
        expect(() => parseOpenAICompatibleTranscriptionSettings('not-json')).toThrow('valid JSON');
        expect(() => parseOpenAICompatibleTranscriptionSettings(JSON.stringify({ enabled: true }))).toThrow('endpoint is required');
    });
});

describe('transcribeWithOpenAICompatibleEndpoint', () => {
    it('posts an OpenAI-compatible multipart transcription request', async () => {
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const formData = init?.body as FormData;
            const multipartEntries = Array.from(formData.entries()).map(([key, value]) => [
                key,
                typeof value === 'string' ? value : `file:${value.name}`,
            ]);

            expect(_input.toString()).toBe('http://localhost:8000/v1/audio/transcriptions');
            expect((init?.headers as Headers).get('Authorization')).toBe('Bearer local-key');
            expect(init?.redirect).toBe('error');
            expect(multipartEntries).toEqual([
                ['file', 'file:clip.mp3'],
                ['model', 'faster-whisper'],
                ['response_format', 'verbose_json'],
                ['timestamp_granularities[]', 'word'],
                ['prompt', 'Use correct punctuation.'],
                ['temperature', '0'],
            ]);
            expect(formData.has('diarize')).toBe(false);
            expect(formData.has('stream')).toBe(false);

            return new Response(JSON.stringify({ words: [{ word: 'hola', start: 0, end: 1 }] }), { status: 200 });
        }) as unknown as typeof fetch;

        const result = await transcribeWithOpenAICompatibleEndpoint({
            settings: {
                enabled: true,
                endpoint: 'localhost:8000/v1',
                apiKey: 'local-key',
                model: 'faster-whisper',
            },
            audioFile: new File(['audio'], 'clip.mp3', { type: 'audio/mpeg' }),
            fallbackModel: 'whisper-1',
            options: {
                response_format: 'verbose_json',
                timestamp_granularities: ['word'],
                prompt: 'Use correct punctuation.',
                temperature: 0,
            },
            fetchImpl,
        });

        expect(result).toEqual({ words: [{ word: 'hola', start: 0, end: 1 }] });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('surfaces endpoint error messages without logging secrets', async () => {
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify({ error: { message: 'model not found' } }),
            { status: 404 }
        )) as unknown as typeof fetch;

        await expect(transcribeWithOpenAICompatibleEndpoint({
            settings: {
                enabled: true,
                endpoint: 'http://localhost:8000/v1',
                apiKey: 'secret-key',
                model: 'missing-model',
            },
            audioFile: new Blob(['audio'], { type: 'audio/mpeg' }),
            fallbackModel: 'whisper-1',
            fetchImpl,
        })).rejects.toThrow('model not found');
    });

    it('redacts an API key echoed by the endpoint error', async () => {
        const sentinelKey = 'sentinel-local-api-key';
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify({ error: { message: `Authentication failed for ${sentinelKey}; retry with ${sentinelKey}.` } }),
            { status: 401 }
        )) as unknown as typeof fetch;

        let thrown: unknown;
        try {
            await transcribeWithOpenAICompatibleEndpoint({
                settings: {
                    enabled: true,
                    endpoint: 'http://localhost:8000/v1',
                    apiKey: sentinelKey,
                },
                audioFile: new Blob(['audio'], { type: 'audio/mpeg' }),
                fallbackModel: 'whisper-1',
                fetchImpl,
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('[REDACTED]');
        expect((thrown as Error).message).not.toContain(sentinelKey);
    });
});
