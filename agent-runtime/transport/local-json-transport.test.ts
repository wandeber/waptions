import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { once } from 'node:events';
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
        const server = new LocalJsonTransportServer(runtime.path, async (request) => {
            const delay = request.method === 'slow' ? 30 : 1;
            await new Promise((resolve) => setTimeout(resolve, delay));
            completionOrder.push(request.method);
            return { method: request.method };
        });
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint);
        await client.connect();
        const [slow, fast] = await Promise.all([
            client.request('slow'),
            client.request('fast'),
        ]);
        expect(completionOrder).toEqual(['fast', 'slow']);
        expect(slow).toEqual({ method: 'slow' });
        expect(fast).toEqual({ method: 'fast' });
        client.close();

        const reconnected = new LocalJsonTransportClient(server.endpoint);
        await reconnected.connect();
        await expect(reconnected.request('fast')).resolves.toEqual({ method: 'fast' });
        reconnected.close();
        await server.close();
    });

    it('propagates aborts without leaving a pending request', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(runtime.path, async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {};
        });
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint);
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
            async () => {
                await barrier;
                return { completed: true };
            },
            { maxInFlightPerConnection: 2, maxGlobalInFlight: 2 },
        );
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint);
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
        const client = new LocalJsonTransportClient(server.endpoint);
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
            async () => new Promise(() => undefined),
            { requestDeadlineMilliseconds: 20 },
        );
        await server.start();
        const client = new LocalJsonTransportClient(server.endpoint);
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
        const client = new LocalJsonTransportClient(server.endpoint);
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
        const client = new LocalJsonTransportClient(server.endpoint, {
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
            async () => ({}),
            { maxConnections: 1 },
        );
        await server.start();
        const first = new LocalJsonTransportClient(server.endpoint);
        await first.connect();
        const second = new LocalJsonTransportClient(server.endpoint);
        await expect(second.connect()).rejects.toThrow();
        second.close();
        first.close();
        await server.close();
    });

    it('rejects a client that does not prove the ownership-bound challenge', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(
            runtime.path,
            async () => ({}),
        );
        await server.start();
        const raw = createConnection(server.endpoint.path);
        await waitForConnect(raw);
        const challenge = await readFrame(raw) as {
            protocol: string;
            nonce: string;
        };
        const closed = waitForClose(raw);
        await writeRawFrame(raw, JSON.stringify({
            type: 'hello',
            protocol: challenge.protocol,
            proof: 'invalid-proof',
        }));
        await expect(closed).resolves.toBeUndefined();
        await server.close();
    });

    it('rejects oversized request frames before they reach the handler', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const handler = vi.fn(async () => ({}));
        const server = new LocalJsonTransportServer(
            runtime.path,
            handler,
            { inputLimitBytes: 256 },
        );
        await server.start();
        const client = new LocalJsonTransportClient(
            server.endpoint,
            { inputLimitBytes: 256 },
        );
        await client.connect();
        await expect(client.request('oversized', {
            value: 'x'.repeat(1_024),
        })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
        expect(handler).not.toHaveBeenCalled();
        client.close();
        await server.close();
    });

    it.skipIf(process.platform === 'win32')(
        'rejects a socket whose owner-only permissions were widened',
        async () => {
            const runtime = await temporaryRuntime();
            cleanups.push(runtime.cleanup);
            const server = new LocalJsonTransportServer(
                runtime.path,
                async () => ({}),
            );
            await server.start();
            await chmod(server.endpoint.path, 0o666);
            const client = new LocalJsonTransportClient(
                server.endpoint,
            );
            await expect(client.connect()).rejects.toThrow('permissions');
            client.close();
            await chmod(server.endpoint.path, 0o600);
            await server.close();
        },
    );

    it.skipIf(process.platform === 'win32')(
        'does not remove a live socket when a second service races startup',
        async () => {
            const runtime = await temporaryRuntime();
            cleanups.push(runtime.cleanup);
            const first = new LocalJsonTransportServer(
                runtime.path,
                async () => ({ owner: 'first' }),
            );
            await first.start();
            const second = new LocalJsonTransportServer(
                runtime.path,
                async () => ({ owner: 'second' }),
            );
            await expect(second.start()).rejects.toThrow('already owns');
            await second.close();

            const client = new LocalJsonTransportClient(first.endpoint);
            await client.connect();
            await expect(client.request('owner')).resolves.toEqual({
                owner: 'first',
            });
            client.close();
            await first.close();
        },
    );

    it.skipIf(process.platform === 'win32')(
        'removes an owned private stale socket before binding',
        async () => {
            const runtime = await temporaryRuntime();
            cleanups.push(runtime.cleanup);
            const socketPath = `${runtime.path}/coordinator.sock`;
            const child = spawn(
                process.execPath,
                [
                    '-e',
                    [
                        "const { chmodSync } = require('node:fs');",
                        "const { createServer } = require('node:net');",
                        'const server = createServer();',
                        'server.listen(process.argv[1], () => {',
                        '  chmodSync(process.argv[1], 0o600);',
                        "  process.stdout.write('ready\\n');",
                        '});',
                        'setInterval(() => undefined, 1_000);',
                    ].join('\n'),
                    socketPath,
                ],
                { stdio: ['ignore', 'pipe', 'pipe'] },
            );
            cleanups.push(async () => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                    await once(child, 'exit');
                }
            });
            await waitForChildOutput(child, 'ready\n');
            child.kill('SIGKILL');
            await once(child, 'exit');

            const server = new LocalJsonTransportServer(
                runtime.path,
                async () => ({ rebound: true }),
            );
            await server.start();
            const client = new LocalJsonTransportClient(server.endpoint);
            await client.connect();
            await expect(client.request('after-stale')).resolves.toEqual({
                rebound: true,
            });
            client.close();
            await server.close();
        },
    );

    it('closes authenticated connections that send malformed JSON', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(
            runtime.path,
            async () => ({}),
        );
        await server.start();
        const raw = createConnection(server.endpoint.path);
        await waitForConnect(raw);
        const challenge = await readFrame(raw) as {
            protocol: string;
            nonce: string;
        };
        await writeRawFrame(raw, JSON.stringify({
            type: 'hello',
            protocol: challenge.protocol,
            proof: createHash('sha256')
                .update(
                    `${challenge.protocol}\0${server.endpoint.kind}`
                    + `\0${server.endpoint.path}\0${challenge.nonce}`,
                )
                .digest('base64url'),
        }));
        await readFrame(raw);
        const closed = waitForClose(raw);
        await writeRawFrame(raw, '{');
        await expect(closed).resolves.toBeUndefined();
        await server.close();
    });

    it('expires unauthenticated connections and releases their connection capacity', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const server = new LocalJsonTransportServer(
            runtime.path,
            async () => ({}),
            {
                maxConnections: 1,
                authenticationDeadlineMilliseconds: 20,
            },
        );
        await server.start();
        const raw = createConnection(server.endpoint.path);
        await new Promise<void>((resolve, reject) => {
            raw.once('connect', resolve);
            raw.once('error', reject);
        });
        raw.resume();
        await new Promise<void>((resolve) => raw.once('close', () => resolve()));

        const client = new LocalJsonTransportClient(server.endpoint, {
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

async function waitForConnect(socket: ReturnType<typeof createConnection>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
}

async function waitForClose(socket: ReturnType<typeof createConnection>): Promise<void> {
    socket.resume();
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
}

async function readFrame(
    socket: ReturnType<typeof createConnection>,
): Promise<unknown> {
    let buffered = Buffer.alloc(0);
    return new Promise((resolve, reject) => {
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.byteLength < 4) return;
            const length = buffered.readUInt32BE(0);
            if (buffered.byteLength < length + 4) return;
            cleanup();
            resolve(JSON.parse(buffered.subarray(4, length + 4).toString('utf8')));
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            socket.off('data', onData);
            socket.off('error', onError);
        };
        socket.on('data', onData);
        socket.once('error', onError);
    });
}

async function writeRawFrame(
    socket: ReturnType<typeof createConnection>,
    body: string,
): Promise<void> {
    const bytes = Buffer.from(body);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.byteLength);
    await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.concat([header, bytes]), (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function waitForChildOutput(
    child: ReturnType<typeof spawn>,
    expected: string,
): Promise<void> {
    let output = '';
    await new Promise<void>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
            output += chunk.toString('utf8');
            if (!output.includes(expected)) return;
            cleanup();
            resolve();
        };
        const onExit = () => {
            cleanup();
            reject(new Error(`Socket fixture exited before readiness: ${output}`));
        };
        const cleanup = () => {
            child.stdout?.off('data', onData);
            child.off('exit', onExit);
        };
        child.stdout?.on('data', onData);
        child.once('exit', onExit);
    });
}
