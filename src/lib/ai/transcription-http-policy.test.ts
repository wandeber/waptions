import { describe, expect, it, vi } from 'vitest';
import {
    boundedErrorExcerpt,
    createTotalTimeoutSignal,
    readBoundedJsonResponse,
    readBoundedErrorExcerpt,
    readBoundedMultipartFormData,
    readBoundedResponseBytes,
    TranscriptionAdmissionError,
    TranscriptionAdmissionGate,
    TranscriptionPayloadTooLargeError,
    TranscriptionTimeoutError,
} from './transcription-http-policy';

describe('transcription HTTP policy', () => {
    it('rejects declared and streamed response overflows and cancels the source', async () => {
        await expect(readBoundedResponseBytes(new Response('12345', {
            headers: { 'content-length': '5' },
        }), { maximumBytes: 4 })).rejects.toBeInstanceOf(TranscriptionPayloadTooLargeError);

        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.enqueue(new Uint8Array([4, 5, 6]));
            },
            cancel() {
                cancelled = true;
            },
        });
        await expect(readBoundedResponseBytes(new Response(body), {
            maximumBytes: 5,
        })).rejects.toBeInstanceOf(TranscriptionPayloadTooLargeError);
        expect(cancelled).toBe(true);
    });

    it('rejects false lengths, malformed JSON, and invalid UTF-8', async () => {
        await expect(readBoundedResponseBytes(new Response('x', {
            headers: { 'content-length': '-1' },
        }))).rejects.toThrow('Content-Length');
        await expect(readBoundedJsonResponse(new Response('{nope'))).rejects.toThrow('valid JSON');
        await expect(readBoundedJsonResponse(new Response(new Uint8Array([0xc3, 0x28]))))
            .rejects.toThrow('UTF-8');
    });

    it('cancels a stalled response on timeout', async () => {
        vi.useFakeTimers();
        let cancelled = false;
        const response = new Response(new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined),
            cancel: () => {
                cancelled = true;
            },
        }));
        const pending = readBoundedResponseBytes(response, {
            maximumBytes: 10,
            bodyTimeoutMs: 25,
        });
        const expectation = expect(pending).rejects.toBeInstanceOf(TranscriptionTimeoutError);
        await vi.advanceTimersByTimeAsync(25);
        await expectation;
        expect(cancelled).toBe(true);
        vi.useRealTimers();
    });

    it('bounds multipart before parsing and preserves ordinary fields', async () => {
        const form = new FormData();
        form.append('field', 'value');
        const request = new Request('https://example.test', { method: 'POST', body: form });
        await expect(readBoundedMultipartFormData(request, 4)).rejects
            .toBeInstanceOf(TranscriptionPayloadTooLargeError);

        const ordinary = new FormData();
        ordinary.append('field', 'value');
        const parsed = await readBoundedMultipartFormData(
            new Request('https://example.test', { method: 'POST', body: ordinary }),
            10_000,
        );
        expect(parsed.get('field')).toBe('value');
    });

    it('enforces rate and concurrency without queueing and releases idempotently', () => {
        let now = 0;
        const gate = new TranscriptionAdmissionGate({
            maximumConcurrent: 1,
            maximumPerWindow: 2,
            windowMs: 100,
            now: () => now,
        });
        const release = gate.acquire('client');
        expect(() => gate.acquire('other')).toThrow(TranscriptionAdmissionError);
        release();
        release();
        const releaseSecond = gate.acquire('client');
        releaseSecond();
        expect(() => gate.acquire('client')).toThrowError(expect.objectContaining({ kind: 'rate' }));
        now = 101;
        expect(() => gate.acquire('client')).not.toThrow();
    });

    it('bounds admission identities and releases expired identity state', () => {
        let now = 0;
        const gate = new TranscriptionAdmissionGate({
            maximumConcurrent: 4,
            maximumPerWindow: 4,
            maximumKeys: 2,
            windowMs: 100,
            now: () => now,
        });
        gate.acquire('one')();
        gate.acquire('two')();
        expect(() => gate.acquire('spoofed-third'))
            .toThrowError(expect.objectContaining({ kind: 'rate' }));
        now = 101;
        expect(() => gate.acquire('spoofed-third')).not.toThrow();
    });

    it('propagates caller abort and owns a disposable total timeout', async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const combined = createTotalTimeoutSignal(caller.signal, 10);
        caller.abort();
        expect(combined.signal.aborted).toBe(true);
        combined.dispose();

        const timed = createTotalTimeoutSignal(undefined, 10);
        await vi.advanceTimersByTimeAsync(10);
        expect(timed.signal.aborted).toBe(true);
        expect(timed.didTimeout()).toBe(true);
        timed.dispose();
        vi.useRealTimers();
    });

    it('retains only a bounded provider error excerpt', () => {
        const secretTail = new TextEncoder().encode(`safe${'x'.repeat(100)}SECRET`);
        expect(boundedErrorExcerpt(secretTail, 4)).toBe('safe');
    });

    it('cancels an upstream error body after the bounded diagnostic prefix', async () => {
        let cancelled = false;
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('safe-secret-tail'));
            },
            cancel() {
                cancelled = true;
            },
        }));
        await expect(readBoundedErrorExcerpt(response, { maximumBytes: 4 })).resolves.toBe('safe');
        expect(cancelled).toBe(true);
    });
});
