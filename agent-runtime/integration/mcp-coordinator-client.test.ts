import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { managedError } from '../coordinator/errors';
import {
    canonicalRequestHash,
    canonicalizeJson,
} from '../mcp/canonical-json';
import type {
    CoordinatorResult,
    MutationToolCall,
    ReadToolCall,
} from '../mcp/contracts';
import type {
    CoordinatorEventSubscription,
    ManagedCoordinatorAdapter,
} from '../server/coordinator-adapter';
import { temporaryRuntime } from '../testing/runtime-test-helpers';
import {
    ManagedCoordinatorService,
} from '../transport/managed-coordinator-service';
import {
    attachOrStartMcpCoordinator,
    McpCoordinatorClient,
    resolveWaptionsAgentDataRoot,
    type LocalControlTransportClient,
    type PersistentRuntimeProcessPort,
} from './mcp-coordinator-client';
import {
    createCoordinatorControlHandler,
} from './control-protocol';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('coordinator control protocol', () => {
    it('forwards exact canonical calls and rejects a changed request hash', async () => {
        const adapter = new RecordingCoordinator();
        const handler = createCoordinatorControlHandler(adapter);
        const call = readCall();

        await expect(handler(
            {
                id: 'read-1',
                method: 'coordinator.execute-read',
                params: { call },
            },
            {
                signal: new AbortController().signal,
                deadlineAt: Date.now() + 1_000,
            },
        )).resolves.toMatchObject({ ok: true });
        expect(adapter.readCalls).toEqual([call]);

        await expect(handler(
            {
                id: 'read-2',
                method: 'coordinator.execute-read',
                params: {
                    call: {
                        ...call,
                        requestHash: `sha256:${'0'.repeat(64)}`,
                    },
                },
            },
            {
                signal: new AbortController().signal,
                deadlineAt: Date.now() + 1_000,
            },
        )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('turns a bounded subscription into one event-availability wait', async () => {
        const adapter = new RecordingCoordinator();
        const handler = createCoordinatorControlHandler(adapter);
        const pending = handler(
            {
                id: 'events-1',
                method: 'coordinator.wait-for-events',
                params: {
                    sessionId: 'session-1',
                    waitMilliseconds: 1_000,
                },
            },
            {
                signal: new AbortController().signal,
                deadlineAt: Date.now() + 2_000,
            },
        );
        adapter.eventCallback?.();
        await expect(pending).resolves.toEqual({ available: true });
        expect(adapter.subscriptionClose).toHaveBeenCalledOnce();
    });

    it('rejects a mutation identity that differs from its canonical request', async () => {
        const handler = createCoordinatorControlHandler(
            new RecordingCoordinator(),
        );
        const call = mutationCall();
        await expect(handler(
            {
                id: 'mutation-identity',
                method: 'coordinator.execute-session-open',
                params: {
                    call: {
                        ...call,
                        identity: {
                            ...call.identity,
                            idempotencyKey: 'changed-after-hash',
                        },
                    },
                },
            },
            {
                signal: new AbortController().signal,
                deadlineAt: Date.now() + 1_000,
            },
        )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
});

describe('McpCoordinatorClient', () => {
    it('reconnects once after a lost response and preserves the exact request frame identity', async () => {
        const observed: Array<{
            method: string;
            params: unknown;
            requestId: string | undefined;
            exactRequestJson: string | undefined;
        }> = [];
        const first = fakeTransport(async (method, params, options) => {
            observed.push({
                method,
                params,
                requestId: options?.requestId,
                exactRequestJson: options?.exactRequestJson,
            });
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'Lost response.',
                true,
            );
        });
        const second = fakeTransport(async (method, params, options) => {
            observed.push({
                method,
                params,
                requestId: options?.requestId,
                exactRequestJson: options?.exactRequestJson,
            });
            return success();
        });
        const connect = vi.fn(async () => second);
        const client = new McpCoordinatorClient(first, connect);
        const call = mutationCall();

        await expect(client.executeSessionOpen(
            call,
            { signal: new AbortController().signal },
        )).resolves.toMatchObject({ ok: true });
        expect(connect).toHaveBeenCalledOnce();
        expect(first.close).toHaveBeenCalledOnce();
        expect(observed).toHaveLength(2);
        expect(observed[1]).toEqual(observed[0]);
        expect(observed[0].exactRequestJson).toBe(
            observed[1].exactRequestJson,
        );
        expect(JSON.parse(observed[0].exactRequestJson!)).toEqual({
            id: observed[0].requestId,
            method: observed[0].method,
            params: observed[0].params,
        });
        expect(
            (observed[0].params as { call: MutationToolCall }).call
                .canonicalRequest,
        ).toBe(call.canonicalRequest);
        await client.close();
    });

    it('bounds subscriptions and stops the long poll when the subscription closes', async () => {
        let waitCalls = 0;
        const transport = fakeTransport(async (method, _params, options) => {
            if (method !== 'coordinator.wait-for-events') return success();
            waitCalls += 1;
            if (waitCalls === 1) return { available: true };
            return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener(
                    'abort',
                    () => reject(options.signal?.reason),
                    { once: true },
                );
            });
        });
        const callback = vi.fn();
        const client = new McpCoordinatorClient(
            transport,
            async () => transport,
            1,
        );
        const subscription = await client.subscribeToEvents(
            'session-1',
            callback,
            { signal: new AbortController().signal },
        );
        await waitUntil(() => callback.mock.calls.length === 1);
        await expect(client.subscribeToEvents(
            'session-2',
            vi.fn(),
            { signal: new AbortController().signal },
        )).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });
        await subscription.close();
        expect(waitCalls).toBe(2);
        await client.close();
    });
});

describe('attachOrStartMcpCoordinator', () => {
    it('starts one persistent service through the narrow process port and attaches as a thin client', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinatorRoot = join(runtime.path, 'coordinator');
        await mkdir(coordinatorRoot, { recursive: true, mode: 0o700 });
        await chmod(runtime.path, 0o700);
        const adapter = new RecordingCoordinator();
        let service: ManagedCoordinatorService | undefined;
        const processPort: PersistentRuntimeProcessPort = {
            ensureRunning: vi.fn(async ({ dataRoot }) => {
                if (service) return;
                service = await ManagedCoordinatorService.start(
                    dataRoot,
                    {
                        epoch: 'epoch-1',
                        canGracefullyShutdown: () => false,
                        close: async () => undefined,
                    },
                    createCoordinatorControlHandler(adapter),
                );
            }),
        };

        const client = await attachOrStartMcpCoordinator({
            dataRoot: runtime.path,
            runtimeProcess: processPort,
        });
        await expect(client.executeRead(
            readCall(),
            { signal: new AbortController().signal },
        )).resolves.toMatchObject({ ok: true });
        expect(processPort.ensureRunning).toHaveBeenCalledOnce();
        await client.close();
        await service?.close();
    });

    it('coalesces concurrent attach attempts through the idempotent process port', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinatorRoot = join(runtime.path, 'coordinator');
        await mkdir(coordinatorRoot, { recursive: true, mode: 0o700 });
        await chmod(runtime.path, 0o700);
        const adapter = new RecordingCoordinator();
        let service: ManagedCoordinatorService | undefined;
        let starting: Promise<void> | undefined;
        const processPort: PersistentRuntimeProcessPort = {
            ensureRunning: vi.fn(({ dataRoot }) => {
                starting ??= (async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    service = await ManagedCoordinatorService.start(
                        dataRoot,
                        {
                            epoch: 'epoch-concurrent',
                            canGracefullyShutdown: () => false,
                            close: async () => undefined,
                        },
                        createCoordinatorControlHandler(adapter),
                    );
                })();
                return starting;
            }),
        };

        const [first, second] = await Promise.all([
            attachOrStartMcpCoordinator({
                dataRoot: runtime.path,
                runtimeProcess: processPort,
            }),
            attachOrStartMcpCoordinator({
                dataRoot: runtime.path,
                runtimeProcess: processPort,
            }),
        ]);
        expect(processPort.ensureRunning).toHaveBeenCalledTimes(2);
        await expect(Promise.all([
            first.executeRead(
                readCall(),
                { signal: new AbortController().signal },
            ),
            second.executeRead(
                readCall(),
                { signal: new AbortController().signal },
            ),
        ])).resolves.toEqual([
            expect.objectContaining({ ok: true }),
            expect.objectContaining({ ok: true }),
        ]);
        await first.close();
        await second.close();
        await service?.close();
    });

    it('restarts the persistent service on reconnect and retries the exact call', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        await mkdir(join(runtime.path, 'coordinator'), {
            recursive: true,
            mode: 0o700,
        });
        await chmod(runtime.path, 0o700);
        const adapter = new RecordingCoordinator();
        let service: ManagedCoordinatorService | undefined;
        let epoch = 0;
        const processPort: PersistentRuntimeProcessPort = {
            ensureRunning: vi.fn(async ({ dataRoot }) => {
                if (service) return;
                epoch += 1;
                service = await ManagedCoordinatorService.start(
                    dataRoot,
                    {
                        epoch: `epoch-restart-${epoch}`,
                        canGracefullyShutdown: () => false,
                        close: async () => undefined,
                    },
                    createCoordinatorControlHandler(adapter),
                );
            }),
        };
        const client = await attachOrStartMcpCoordinator({
            dataRoot: runtime.path,
            runtimeProcess: processPort,
        });
        await service?.close();
        service = undefined;
        await new Promise((resolve) => setTimeout(resolve, 5));

        await expect(client.executeRead(
            readCall(),
            { signal: new AbortController().signal },
        )).resolves.toMatchObject({ ok: true });
        expect(processPort.ensureRunning).toHaveBeenCalledTimes(2);
        expect(adapter.readCalls).toHaveLength(1);
        await client.close();
        await (service as ManagedCoordinatorService | undefined)?.close();
    });

    it('rejects a relative data root before attempting process startup', async () => {
        expect(() => resolveWaptionsAgentDataRoot('relative/runtime')).toThrow(
            'absolute path',
        );
    });
});

class RecordingCoordinator implements ManagedCoordinatorAdapter {
    readonly readCalls: ReadToolCall[] = [];
    eventCallback: (() => void) | undefined;
    readonly subscriptionClose = vi.fn(async () => undefined);

    async executeRead(call: ReadToolCall): Promise<CoordinatorResult> {
        this.readCalls.push(call);
        return success();
    }

    async resolveReceiptScope() {
        return {
            ok: true as const,
            scope: {
                projectId: 'project-1',
                toolName: 'waptions_session_open' as const,
                idempotencyKey: 'open-1',
            },
        };
    }

    async executeMutation(): Promise<CoordinatorResult> {
        return success();
    }

    async executeSessionOpen(): Promise<CoordinatorResult> {
        return success();
    }

    async subscribeToEvents(
        _sessionId: string,
        onEventAvailable: () => void,
    ): Promise<CoordinatorEventSubscription> {
        this.eventCallback = onEventAvailable;
        return {
            close: async () => {
                this.eventCallback = undefined;
                await this.subscriptionClose();
            },
        };
    }
}

function readCall(): ReadToolCall {
    const request = {
        apiVersion: '2026-07-25',
        sessionId: 'session-1',
    };
    return {
        mutation: false,
        toolName: 'waptions_project_get',
        request,
        canonicalRequest: canonicalizeJson(request),
        requestHash: canonicalRequestHash(request),
    };
}

function mutationCall(): MutationToolCall {
    const request = {
        apiVersion: '2026-07-25',
        idempotencyKey: 'open-1',
        mode: 'create',
    };
    return {
        mutation: true,
        toolName: 'waptions_session_open',
        request,
        canonicalRequest: canonicalizeJson(request),
        requestHash: canonicalRequestHash(request),
        identity: {
            idempotencyKey: 'open-1',
        },
    };
}

function success(): CoordinatorResult {
    return {
        ok: true,
        data: { accepted: true },
        warnings: [],
    };
}

function fakeTransport(
    request: LocalControlTransportClient['request'],
) {
    const close = vi.fn<() => void>();
    return {
        request,
        close,
    };
}

async function waitUntil(
    predicate: () => boolean,
    timeoutMilliseconds = 1_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for coordinator client state.');
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}
