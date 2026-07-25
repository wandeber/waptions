import { describe, expect, it, vi } from 'vitest';
import {
    buildEditorialTranscriptionProviderMultipart,
    EDITORIAL_TRANSCRIPTION_FAILURE_HEADER,
    EditorialTranscriptionRequestError,
    readEditorialTranscriptionResponseBytes,
    requestEditMaxEditorialTranscript,
} from './request';

const wav = new Blob([new Uint8Array(44)], { type: 'audio/wav' });

describe('frozen editorial edit-max request', () => {
    it('emits exactly the required fields and omits timestamp granularities', () => {
        const form = buildEditorialTranscriptionProviderMultipart({
            wav,
            language: 'ES',
            speakerMode: 'diarized',
        });
        expect(Array.from(form.keys())).toEqual([
            'file',
            'model',
            'response_format',
            'stream',
            'diarize',
            'language',
        ]);
        expect(form.get('model')).toBe('qwen-1.7b-edit-max');
        expect(form.get('response_format')).toBe('verbose_json');
        expect(form.get('stream')).toBe('false');
        expect(form.get('diarize')).toBe('true');
        expect(form.get('language')).toBe('es');
        expect(form.has('timestamp_granularities')).toBe(false);
        expect(form.has('timestamp_granularities[]')).toBe(false);
    });

    it('sends browser credentials only as Authorization and rejects redirects', async () => {
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            expect(_url).toBe('http://localhost:43556/v1/audio/transcriptions');
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-key');
            expect(init?.redirect).toBe('error');
            const form = init?.body as FormData;
            expect(form.has('endpoint')).toBe(false);
            expect(form.has('apiKey')).toBe(false);
            return new Response('{"model":"ok"}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        await expect(requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'browser',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl,
        })).resolves.toEqual({ model: 'ok' });
    });

    it('carries endpoint and key transiently inside only the server request body', async () => {
        const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
            expect(url).toBe('/api/editorial-transcription');
            expect(new Headers(init?.headers).has('Authorization')).toBe(false);
            const form = init?.body as FormData;
            expect(form.get('endpoint')).toBe('http://localhost:43556/v1/audio/transcriptions');
            expect(form.get('apiKey')).toBe('session-key');
            return new Response('{}', { status: 200 });
        });

        await requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'server',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl,
        });
    });

    it('never includes an echoed credential or provider body in retained errors', async () => {
        const networkFailure = vi.fn<typeof fetch>(async () => {
            throw new Error('failed with session-key');
        });
        const networkRequest = requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'browser',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl: networkFailure,
        });
        await expect(networkRequest).rejects.toMatchObject({
            name: 'EditorialTranscriptionRequestError',
            code: 'network-unreachable',
        });
        await expect(networkRequest).rejects.not.toThrow('session-key');

        const providerFailure = vi.fn<typeof fetch>(async () => new Response(
            'session-key transcript body',
            { status: 500 },
        ));
        const providerRequest = requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'browser',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl: providerFailure,
        });
        await expect(providerRequest).rejects.toMatchObject({
            name: 'EditorialTranscriptionRequestError',
            code: 'provider-unavailable',
        });
        await expect(providerRequest).rejects.not.toThrow('session-key');
        await expect(providerRequest).rejects.not.toThrow('transcript body');
    });

    it.each([
        [400, 'provider-rejected'],
        [401, 'provider-unauthorized'],
        [403, 'provider-forbidden'],
        [404, 'provider-not-found'],
        [405, 'provider-rejected'],
        [429, 'provider-rate-limited'],
        [503, 'provider-unavailable'],
    ] as const)('classifies browser provider status %i as %s', async (status, code) => {
        await expect(requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'browser',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl: vi.fn<typeof fetch>(async () => new Response('provider-controlled', { status })),
        })).rejects.toMatchObject({
            name: 'EditorialTranscriptionRequestError',
            code,
        });
    });

    it('accepts only an allowlisted same-origin proxy failure classification', async () => {
        const classified = requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'server',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl: vi.fn<typeof fetch>(async () => new Response('sentinel-key provider body', {
                status: 502,
                headers: { [EDITORIAL_TRANSCRIPTION_FAILURE_HEADER]: 'provider-unauthorized' },
            })),
        });
        await expect(classified).rejects.toMatchObject({
            name: 'EditorialTranscriptionRequestError',
            code: 'provider-unauthorized',
        });

        const untrusted = requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'server',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl: vi.fn<typeof fetch>(async () => new Response('sentinel-key provider body', {
                status: 502,
                headers: { [EDITORIAL_TRANSCRIPTION_FAILURE_HEADER]: 'provider-secret-detail' },
            })),
        });
        await expect(untrusted).rejects.not.toBeInstanceOf(EditorialTranscriptionRequestError);
        await expect(untrusted).rejects.not.toThrow('sentinel-key');
        await expect(untrusted).rejects.not.toThrow('provider body');
    });

    it('preserves the closed provider-timeout proxy classification', async () => {
        await expect(requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'server',
            wav,
            apiKey: 'session-key',
            language: null,
            speakerMode: 'none',
            fetchImpl: vi.fn<typeof fetch>(async () => new Response('provider-controlled', {
                status: 504,
                headers: { [EDITORIAL_TRANSCRIPTION_FAILURE_HEADER]: 'provider-timeout' },
            })),
        })).rejects.toMatchObject({
            name: 'EditorialTranscriptionRequestError',
            code: 'provider-timeout',
        });
    });

    it('classifies a rejected provider before consuming its untrusted error stream', async () => {
        const hostileBody = new ReadableStream<Uint8Array>({
            pull() {
                throw new Error('sentinel-key provider stream detail');
            },
        });

        await expect(requestEditMaxEditorialTranscript({
            endpoint: 'localhost:43556',
            requestMode: 'browser',
            wav,
            apiKey: 'sentinel-key',
            language: null,
            speakerMode: 'none',
            fetchImpl: vi.fn<typeof fetch>(async () => new Response(hostileBody, { status: 401 })),
        })).rejects.toMatchObject({
            name: 'EditorialTranscriptionRequestError',
            code: 'provider-unauthorized',
        });
    });

    it('enforces the response limit while streaming without Content-Length', async () => {
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(Uint8Array.from([1, 2]));
                controller.enqueue(Uint8Array.from([3, 4]));
                controller.close();
            },
        }));

        await expect(readEditorialTranscriptionResponseBytes(response, 3))
            .rejects.toThrow('exceeded the safe size limit');
    });
});
