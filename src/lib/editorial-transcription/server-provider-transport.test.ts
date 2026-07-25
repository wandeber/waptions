import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    EDITORIAL_PROVIDER_BODY_TIMEOUT_MS,
    EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS,
    EDITORIAL_PROVIDER_TOTAL_TIMEOUT_MS,
    EditorialProviderTimeoutError,
    requestEditorialTranscriptionProvider,
} from './server-provider-transport';

const endpoint = 'http://localhost:43556/v1/audio/transcriptions';

function requestInput(fetchImpl: typeof fetch, signal = new AbortController().signal) {
    return {
        endpoint,
        body: new FormData(),
        headers: new Headers(),
        signal,
        fetchImpl,
    };
}

describe('editorial provider server transport', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the explicit production timeout policy bounded', () => {
        expect(EDITORIAL_PROVIDER_TOTAL_TIMEOUT_MS).toBe(30 * 60 * 1_000);
        expect(EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS).toBe(30 * 60 * 1_000);
        expect(EDITORIAL_PROVIDER_BODY_TIMEOUT_MS).toBe(5 * 60 * 1_000);
    });

    it('keeps a legitimate header wait alive beyond five minutes and then enforces the deadline', async () => {
        vi.useFakeTimers();
        const transport = { signal: null as AbortSignal | null };
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>(
            (_resolve, reject) => {
                transport.signal = init?.signal ?? null;
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                    once: true,
                });
            },
        ));
        const request = requestEditorialTranscriptionProvider(requestInput(fetchImpl));
        const assertion = expect(request).rejects.toBeInstanceOf(EditorialProviderTimeoutError);

        const beyondUndiciDefaultMs = 5 * 60 * 1_000 + 10_000;
        await vi.advanceTimersByTimeAsync(beyondUndiciDefaultMs);
        expect(transport.signal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(
            EDITORIAL_PROVIDER_TOTAL_TIMEOUT_MS - beyondUndiciDefaultMs,
        );

        await assertion;
    });

    it('bounds successful response-body completion independently of response size', async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    init?.signal?.addEventListener('abort', () => {
                        controller.error(init.signal?.reason);
                    }, { once: true });
                },
            }),
            { status: 200 },
        ));
        const request = requestEditorialTranscriptionProvider(requestInput(fetchImpl));
        const assertion = expect(request).rejects.toBeInstanceOf(EditorialProviderTimeoutError);

        await vi.advanceTimersByTimeAsync(EDITORIAL_PROVIDER_BODY_TIMEOUT_MS);

        await assertion;
    });

    it.each([
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
    ])('classifies only trusted Undici timeout code %s', async (code) => {
        const providerDetail = Object.assign(new Error('sentinel-key provider detail'), { code });
        const fetchFailure = new TypeError('fetch failed', { cause: providerDetail });

        await expect(requestEditorialTranscriptionProvider(requestInput(
            vi.fn<typeof fetch>(async () => { throw fetchFailure; }),
        ))).rejects.toMatchObject({
            name: 'EditorialProviderTimeoutError',
            message: 'Editorial transcription provider timed out.',
        });
    });

    it('gives caller cancellation precedence over a simultaneous provider timeout', async () => {
        const caller = new AbortController();
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            caller.abort();
            throw Object.assign(new Error('sentinel-key provider detail'), {
                code: 'UND_ERR_HEADERS_TIMEOUT',
            });
        });

        await expect(requestEditorialTranscriptionProvider(requestInput(
            fetchImpl,
            caller.signal,
        ))).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('leaves unknown transport failures unclassified for the proxy to redact', async () => {
        const unknown = Object.assign(new Error('sentinel-key provider detail'), {
            code: 'UND_ERR_SOCKET',
        });

        await expect(requestEditorialTranscriptionProvider(requestInput(
            vi.fn<typeof fetch>(async () => { throw unknown; }),
        ))).rejects.toBe(unknown);
    });

    it('preserves the bounded response reader under the long-running transport', async () => {
        await expect(requestEditorialTranscriptionProvider({
            ...requestInput(vi.fn<typeof fetch>(async () => new Response(
                Uint8Array.from([1, 2, 3, 4]),
                { status: 200 },
            ))),
            responseMaxBytes: 3,
        })).rejects.toMatchObject({
            name: 'EditorialTranscriptionResponseTooLargeError',
        });
    });
});
