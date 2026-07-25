import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    EDITORIAL_TRANSCRIPTION_FAILURE_HEADER,
    EDITORIAL_TRANSCRIPTION_MAX_WAV_BYTES,
    EDITORIAL_TRANSCRIPTION_RESPONSE_MAX_BYTES,
} from '@/lib/editorial-transcription/request';
import {
    EDITORIAL_PROVIDER_BODY_TIMEOUT_MS,
    EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS,
} from '@/lib/editorial-transcription/server-provider-transport';
import { createPcm16WavBlob } from '@/lib/editorial-transcription/wav';

const undiciMock = vi.hoisted(() => ({ agentOptions: [] as unknown[] }));

vi.mock('undici', () => ({
    Agent: class TestAgent {
        constructor(options: unknown) {
            undiciMock.agentOptions.push(options);
        }
    },
}));

import { POST } from './route';

function validForm(): FormData {
    const form = new FormData();
    form.append('file', createPcm16WavBlob([Int16Array.from([0, 1, -1])], 3), 'source.wav');
    form.append('model', 'qwen-1.7b-edit-max');
    form.append('response_format', 'verbose_json');
    form.append('stream', 'false');
    form.append('endpoint', 'http://localhost:43556/v1/audio/transcriptions');
    form.append('apiKey', 'sentinel-key');
    return form;
}

describe('editorial transcription server route', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('forwards only the exact frozen provider request with SSRF and redirect protections', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
            expect(url).toBe('http://localhost:43556/v1/audio/transcriptions');
            expect(init?.redirect).toBe('error');
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sentinel-key');
            const providerForm = init?.body as FormData;
            expect(Array.from(providerForm.keys())).toEqual([
                'file',
                'model',
                'response_format',
                'stream',
            ]);
            expect(providerForm.has('timestamp_granularities')).toBe(false);
            return Response.json({ model: 'qwen3-asr-1.7b' });
        });
        vi.stubGlobal('fetch', fetchMock);

        const response = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: validForm(),
        }));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ model: 'qwen3-asr-1.7b' });
        expect(undiciMock.agentOptions).toEqual([{
            headersTimeout: EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS,
            bodyTimeout: EDITORIAL_PROVIDER_BODY_TIMEOUT_MS,
        }]);
    });

    it('rejects non-canonical WAVs, mutable fields and extra multipart options', async () => {
        const badWav = validForm();
        badWav.set('file', new File([new Uint8Array(44)], 'bad.wav', { type: 'audio/wav' }));
        expect((await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: badWav,
        }))).status).toBe(400);

        const mutable = validForm();
        mutable.set('model', 'another-model');
        mutable.append('timestamp_granularities[]', 'word');
        expect((await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: mutable,
        }))).status).toBe(400);
    });

    it('rejects an oversized multipart envelope before parsing its body', async () => {
        const request = new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: validForm(),
        });
        request.headers.set(
            'content-length',
            String(EDITORIAL_TRANSCRIPTION_MAX_WAV_BYTES + 2 * 1024 * 1024),
        );

        const response = await POST(request);
        expect(response.status).toBe(413);
    });

    it('preserves the production allowlist and never returns provider secrets or bodies', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS', 'transcriber.example.com');
        const form = validForm();
        form.set('endpoint', 'https://not-allowed.example.com/v1/audio/transcriptions');
        const blocked = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: form,
        }));
        expect(blocked.status).toBe(400);
        expect(await blocked.text()).not.toContain('not-allowed.example.com');

        form.set('endpoint', 'https://transcriber.example.com/v1/audio/transcriptions');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
            'sentinel-key transcript body',
            { status: 500 },
        )));
        const upstreamFailure = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: form,
        }));
        const retained = await upstreamFailure.text();
        expect(upstreamFailure.status).toBe(502);
        expect(upstreamFailure.headers.get(EDITORIAL_TRANSCRIPTION_FAILURE_HEADER))
            .toBe('provider-unavailable');
        expect(retained).not.toContain('sentinel-key');
        expect(retained).not.toContain('transcript body');
        expect(retained).not.toContain('transcriber.example.com');
    });

    it.each([
        [400, 'provider-rejected'],
        [401, 'provider-unauthorized'],
        [403, 'provider-forbidden'],
        [404, 'provider-not-found'],
        [405, 'provider-rejected'],
        [429, 'provider-rate-limited'],
        [503, 'provider-unavailable'],
    ] as const)('returns only the safe provider classification for upstream status %i', async (status, code) => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
            'sentinel-key endpoint filename transcript text',
            { status },
        )));

        const response = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: validForm(),
        }));

        expect(response.status).toBe(502);
        expect(response.headers.get(EDITORIAL_TRANSCRIPTION_FAILURE_HEADER)).toBe(code);
        await expect(response.json()).resolves.toEqual({
            error: 'Editorial transcription provider request failed.',
        });
    });

    it('classifies an unreachable provider without retaining exception details', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
            throw new Error('sentinel-key http://private.example/source.wav transcript text');
        }));

        const response = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: validForm(),
        }));

        expect(response.status).toBe(502);
        expect(response.headers.get(EDITORIAL_TRANSCRIPTION_FAILURE_HEADER))
            .toBe('network-unreachable');
        const retained = await response.text();
        expect(retained).not.toContain('sentinel-key');
        expect(retained).not.toContain('private.example');
        expect(retained).not.toContain('source.wav');
        expect(retained).not.toContain('transcript text');
    });

    it.each([
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
    ])('returns a safe provider timeout for trusted Undici code %s', async (code) => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
            throw new TypeError('fetch failed with sentinel-key provider detail', {
                cause: Object.assign(new Error('private endpoint detail'), { code }),
            });
        }));

        const response = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: validForm(),
        }));

        expect(response.status).toBe(504);
        expect(response.headers.get(EDITORIAL_TRANSCRIPTION_FAILURE_HEADER))
            .toBe('provider-timeout');
        await expect(response.json()).resolves.toEqual({
            error: 'Editorial transcription provider timed out.',
        });
    });

    it('preserves a safe provider status without buffering its rejected response body', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
            'sentinel-key provider body',
            {
                status: 401,
                headers: {
                    'content-length': String(EDITORIAL_TRANSCRIPTION_MAX_WAV_BYTES),
                },
            },
        )));

        const response = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: validForm(),
        }));

        expect(response.status).toBe(502);
        expect(response.headers.get(EDITORIAL_TRANSCRIPTION_FAILURE_HEADER))
            .toBe('provider-unauthorized');
        await expect(response.json()).resolves.toEqual({
            error: 'Editorial transcription provider request failed.',
        });
    });

    it('preserves the provider response-size bound under the long-running transport', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('{}', {
            status: 200,
            headers: {
                'content-length': String(EDITORIAL_TRANSCRIPTION_RESPONSE_MAX_BYTES + 1),
            },
        })));

        const response = await POST(new Request('http://localhost/api/editorial-transcription', {
            method: 'POST',
            body: validForm(),
        }));

        expect(response.status).toBe(502);
        expect(response.headers.has(EDITORIAL_TRANSCRIPTION_FAILURE_HEADER)).toBe(false);
        await expect(response.json()).resolves.toEqual({
            error: 'Editorial transcription provider response is too large.',
        });
    });
});
