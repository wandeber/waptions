import { afterEach, describe, expect, it } from 'vitest';
import { createConnection } from 'node:net';
import { LocalJsonTransportClient, LocalJsonTransportServer } from './local-json-transport';
import { temporaryRuntime } from '../testing/runtime-test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('LocalJsonTransport', () => {
    it('correlates concurrent responses by id when reads complete out of order', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const completionOrder: string[] = [];
        const server = new LocalJsonTransportServer(runtime.path, 'secret', async (request) => {
            const delay = request.method === 'slow' ? 30 : 1;
            await new Promise((resolve) => setTimeout(resolve, delay));
            completionOrder.push(request.method);
            return { method: request.method };
        });
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint, 'secret');
        await client.connect();
        const [slow, fast] = await Promise.all([
            client.request('slow'),
            client.request('fast'),
        ]);
        expect(completionOrder).toEqual(['fast', 'slow']);
        expect(slow).toEqual({ method: 'slow' });
        expect(fast).toEqual({ method: 'fast' });
        client.close();

        const reconnected = new LocalJsonTransportClient(server.endpoint, 'secret');
        await reconnected.connect();
        await expect(reconnected.request('fast')).resolves.toEqual({ method: 'fast' });
        reconnected.close();
        await server.close();
    });

    it('propagates aborts without leaving a pending request', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(runtime.path, 'secret', async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {};
        });
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint, 'secret');
        await client.connect();
        const controller = new AbortController();
        const request = client.request('wait', undefined, { signal: controller.signal });
        controller.abort();
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        client.close();
        await server.close();
    });

    it('enforces per-connection admission while allowing accepted work to finish', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        const server = new LocalJsonTransportServer(
            runtime.path,
            'secret',
            async () => {
                await barrier;
                return { completed: true };
            },
            { maxInFlightPerConnection: 2, maxGlobalInFlight: 2 },
        );
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint, 'secret');
        await client.connect();
        const first = client.request('first');
        const second = client.request('second');
        await expect(client.request('rejected')).rejects.toMatchObject({
            code: 'COORDINATOR_UNAVAILABLE',
        });
        release();
        await expect(Promise.all([first, second])).resolves.toEqual([
            { completed: true },
            { completed: true },
        ]);
        client.close();
        await server.close();
    });

    it('aborts server work on disconnect and releases global capacity', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let observedAbort!: () => void;
        const aborted = new Promise<void>((resolve) => {
            observedAbort = resolve;
        });
        let finalState = { connections: 0, inFlight: 0, queuedBytes: 0 };
        const server = new LocalJsonTransportServer(
            runtime.path,
            'secret',
            async (_request, context) => new Promise((_resolve, reject) => {
                context.signal.addEventListener('abort', () => {
                    observedAbort();
                    reject(context.signal.reason);
                }, { once: true });
            }),
            {
                onResourceStateChanged: (state) => {
                    finalState = state;
                },
            },
        );
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint, 'secret');
        await client.connect();
        void client.request('blocked').catch(() => undefined);
        client.close();
        await aborted;
        await waitUntil(() => finalState.connections === 0 && finalState.inFlight === 0);
        expect(finalState).toEqual({ connections: 0, inFlight: 0, queuedBytes: 0 });
        await server.close();
    });

    it('applies a server deadline even when a handler never settles', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(
            runtime.path,
            'secret',
            async () => new Promise(() => undefined),
            { requestDeadlineMilliseconds: 20 },
        );
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint, 'secret');
        await client.connect();
        await expect(client.request('never')).rejects.toMatchObject({
            code: 'COORDINATOR_UNAVAILABLE',
        });
        client.close();
        await server.close();
    });

    it('retains global capacity until an abort-ignoring handler actually settles', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let releaseHandler!: () => void;
        const barrier = new Promise<void>((resolve) => {
            releaseHandler = resolve;
        });
        let resourceState = { connections: 0, inFlight: 0, queuedBytes: 0 };
        const server = new LocalJsonTransportServer(
            runtime.path,
            'secret',
            async () => {
                await barrier;
                return { settled: true };
            },
            {
                maxInFlightPerConnection: 1,
                maxGlobalInFlight: 1,
                requestDeadlineMilliseconds: 20,
                onResourceStateChanged: (state) => {
                    resourceState = state;
                },
            },
        );
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint, 'secret');
        await client.connect();
        await expect(client.request('ignores-abort')).rejects.toMatchObject({
            code: 'COORDINATOR_UNAVAILABLE',
        });
        expect(resourceState.inFlight).toBe(1);
        await expect(client.request('still-at-capacity')).rejects.toMatchObject({
            code: 'COORDINATOR_UNAVAILABLE',
        });
        releaseHandler();
        await waitUntil(() => resourceState.inFlight === 0);
        await expect(client.request('after-settlement')).resolves.toEqual({ settled: true });
        client.close();
        await server.close();
    });

    it('closes a non-reading response path before its queued-byte budget can grow', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let limitRejections = 0;
        const server = new LocalJsonTransportServer(
            runtime.path,
            'secret',
            async () => ({ payload: 'x'.repeat(2_048) }),
            {
                outputLimitBytes: 4_096,
                maxQueuedBytesPerConnection: 1_024,
                maxGlobalQueuedBytes: 1_024,
                onDiagnostic: (kind) => {
                    if (kind === 'limit') limitRejections += 1;
                },
            },
        );
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint, 'secret', {
            outputLimitBytes: 4_096,
        });
        await client.connect();
        await expect(client.request('large-response')).rejects.toThrow();
        expect(limitRejections).toBeGreaterThan(0);
        client.close();
        await server.close();
    });

    it('enforces a global connection cap before authentication work is retained', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(
            runtime.path,
            'secret',
            async () => ({}),
            { maxConnections: 1 },
        );
        await server.start();
        const first = new LocalJsonTransportClient(server.endpoint, 'secret');
        await first.connect();
        const second = new LocalJsonTransportClient(server.endpoint, 'secret');
        await expect(second.connect()).rejects.toThrow();
        second.close();
        first.close();
        await server.close();
    });

    it('expires unauthenticated connections and releases their connection capacity', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(
            runtime.path,
            'secret',
            async () => ({}),
            {
                maxConnections: 1,
                authenticationDeadlineMilliseconds: 20,
            },
        );
        await server.start();
        const raw = server.endpoint.kind === 'tcp'
            ? createConnection({ host: server.endpoint.host, port: server.endpoint.port })
            : createConnection(server.endpoint.path);
        await new Promise<void>((resolve, reject) => {
            raw.once('connect', resolve);
            raw.once('error', reject);
        });
        await new Promise<void>((resolve) => raw.once('close', () => resolve()));

        const client = new LocalJsonTransportClient(server.endpoint, 'secret', {
            authenticationDeadlineMilliseconds: 100,
        });
        await expect(client.connect()).resolves.toBeUndefined();
        client.close();
        await server.close();
    });
});

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for transport cleanup.');
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}
