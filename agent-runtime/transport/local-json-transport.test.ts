import { afterEach, describe, expect, it } from 'vitest';
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
});
