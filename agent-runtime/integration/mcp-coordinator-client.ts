import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
    ManagedRuntimeError,
    managedError,
} from '../coordinator/errors';
import type {
    CoordinatorResult,
    DurableReceiptScopeResolution,
    MutationToolCall,
    ReadToolCall,
    ScopedMutationToolCall,
} from '../mcp/contracts';
import type {
    CoordinatorCallContext,
    CoordinatorEventSubscription,
    ManagedCoordinatorAdapter,
} from '../server/coordinator-adapter';
import type {
    WindowsNamedPipeSecurityPort,
} from '../server/control-endpoint';
import {
    attachManagedCoordinator,
} from '../transport/managed-coordinator-service';
import {
    COORDINATOR_CONTROL_PROTOCOL_VERSION,
    type CoordinatorControlHealth,
    type CoordinatorEventWaitResult,
} from './control-protocol';

export interface PersistentRuntimeProcessPort {
    readonly windowsNamedPipeSecurity?: WindowsNamedPipeSecurityPort;
    /**
     * Ensure one persistent authority process exists for this data root.
     *
     * The runtime-host owner must implement this as a cross-process,
     * single-flight launch/attach operation. It must start the statically
     * packaged authority with `createCoordinatorControlHandler(realAdapter)`,
     * keep it alive independently of this MCP process, and return only after
     * its private discovery file and owner-only IPC endpoint are published.
     * It must not return, persist, log, or pass an IPC bearer credential; the
     * transport authenticates the local account through endpoint ownership.
     */
    ensureRunning(input: {
        dataRoot: string;
        protocolVersion: typeof COORDINATOR_CONTROL_PROTOCOL_VERSION;
    }): Promise<void>;
}

export interface AttachMcpCoordinatorOptions {
    dataRoot?: string;
    runtimeProcess: PersistentRuntimeProcessPort;
    startupTimeoutMilliseconds?: number;
    maxSubscriptions?: number;
}

export interface LocalControlTransportClient {
    request(
        method: string,
        params?: unknown,
        options?: {
            signal?: AbortSignal;
            timeoutMilliseconds?: number;
            requestId?: string;
            exactRequestJson?: string;
        },
    ): Promise<unknown>;
    close(): void;
}

type ConnectTransport = () => Promise<LocalControlTransportClient>;

const DEFAULT_STARTUP_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_MAX_SUBSCRIPTIONS = 16;
const EVENT_WAIT_MILLISECONDS = 25_000;
const EVENT_WAIT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

/**
 * Thin MCP-process adapter. It owns no project state, receipt store, job, path
 * capability, or media authority; every call crosses the private control IPC.
 */
export class McpCoordinatorClient implements ManagedCoordinatorAdapter {
    private client: LocalControlTransportClient | null;
    private connecting: Promise<LocalControlTransportClient> | null = null;
    private readonly subscriptionControllers = new Set<AbortController>();
    private closed = false;

    constructor(
        initialClient: LocalControlTransportClient,
        private readonly connectTransport: ConnectTransport,
        private readonly maxSubscriptions = DEFAULT_MAX_SUBSCRIPTIONS,
    ) {
        if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions <= 0) {
            throw managedError(
                'INVALID_REQUEST',
                'The MCP coordinator subscription limit is invalid.',
            );
        }
        this.client = initialClient;
    }

    executeRead(
        call: ReadToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        return this.call(
            'coordinator.execute-read',
            { call },
            context.signal,
        ) as Promise<CoordinatorResult>;
    }

    resolveReceiptScope(
        call: MutationToolCall,
        context: CoordinatorCallContext,
    ): Promise<DurableReceiptScopeResolution> {
        return this.call(
            'coordinator.resolve-receipt-scope',
            { call },
            context.signal,
        ) as Promise<DurableReceiptScopeResolution>;
    }

    executeMutation(
        call: ScopedMutationToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        return this.call(
            'coordinator.execute-mutation',
            { call },
            context.signal,
        ) as Promise<CoordinatorResult>;
    }

    executeSessionOpen(
        call: MutationToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        return this.call(
            'coordinator.execute-session-open',
            { call },
            context.signal,
        ) as Promise<CoordinatorResult>;
    }

    async subscribeToEvents(
        sessionId: string,
        onEventAvailable: () => void,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorEventSubscription> {
        if (
            this.closed
            || this.subscriptionControllers.size >= this.maxSubscriptions
        ) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The MCP coordinator subscription limit was reached.',
                true,
            );
        }
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(context.signal.reason);
        if (context.signal.aborted) {
            controller.abort(context.signal.reason);
        } else {
            context.signal.addEventListener('abort', abortFromCaller, {
                once: true,
            });
        }
        this.subscriptionControllers.add(controller);
        let subscriptionClosed = false;
        const loop = this.runEventWaitLoop(
            sessionId,
            onEventAvailable,
            controller.signal,
        ).finally(() => {
            this.subscriptionControllers.delete(controller);
            context.signal.removeEventListener('abort', abortFromCaller);
        });
        void loop.catch(() => undefined);

        return {
            close: async () => {
                if (subscriptionClosed) return;
                subscriptionClosed = true;
                controller.abort(new DOMException('Subscription closed.', 'AbortError'));
                await loop.catch(() => undefined);
            },
        };
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const controller of this.subscriptionControllers) {
            controller.abort(new DOMException('MCP coordinator client closed.', 'AbortError'));
        }
        this.subscriptionControllers.clear();
        const client = this.client;
        this.client = null;
        client?.close();
        const connecting = this.connecting;
        this.connecting = null;
        if (connecting) {
            const connected = await connecting.catch(() => null);
            connected?.close();
        }
    }

    private async call(
        method: string,
        params: unknown,
        signal: AbortSignal,
        timeoutMilliseconds = 30_000,
    ): Promise<unknown> {
        if (this.closed) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The MCP coordinator client is closed.',
                true,
            );
        }
        const requestId = `mcp-${randomUUID()}`;
        const exactRequestJson = JSON.stringify({
            id: requestId,
            method,
            ...(params === undefined ? {} : { params }),
        });
        const client = await this.ensureClient();
        try {
            return await client.request(method, params, {
                requestId,
                exactRequestJson,
                signal,
                timeoutMilliseconds,
            });
        } catch (error) {
            if (!isRetryableTransportFailure(error) || signal.aborted) {
                throw error;
            }
            this.invalidate(client);
            const reconnected = await this.ensureClient();
            // The method, params object, canonical request string/hash,
            // idempotency key, and transport request id are deliberately
            // reused byte-for-byte after an ambiguous lost response.
            return reconnected.request(method, params, {
                requestId,
                exactRequestJson,
                signal,
                timeoutMilliseconds,
            });
        }
    }

    private async runEventWaitLoop(
        sessionId: string,
        onEventAvailable: () => void,
        signal: AbortSignal,
    ): Promise<void> {
        while (!signal.aborted && !this.closed) {
            const result = await this.call(
                'coordinator.wait-for-events',
                {
                    sessionId,
                    waitMilliseconds: EVENT_WAIT_MILLISECONDS,
                },
                signal,
                EVENT_WAIT_REQUEST_TIMEOUT_MILLISECONDS,
            ) as CoordinatorEventWaitResult;
            if (result.available) {
                onEventAvailable();
            } else {
                await abortableDelay(100, signal);
            }
        }
    }

    private async ensureClient(): Promise<LocalControlTransportClient> {
        if (this.client) return this.client;
        if (!this.connecting) {
            this.connecting = this.connectTransport().then((client) => {
                if (this.closed) {
                    client.close();
                    throw managedError(
                        'COORDINATOR_UNAVAILABLE',
                        'The MCP coordinator client closed during reconnect.',
                        true,
                    );
                }
                this.client = client;
                return client;
            }).finally(() => {
                this.connecting = null;
            });
        }
        return this.connecting;
    }

    private invalidate(client: LocalControlTransportClient): void {
        if (this.client !== client) return;
        this.client = null;
        client.close();
    }
}

async function abortableDelay(
    milliseconds: number,
    signal: AbortSignal,
): Promise<void> {
    if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolveDelay, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolveDelay();
        }, milliseconds);
        timer.unref?.();
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export async function attachOrStartMcpCoordinator(
    options: AttachMcpCoordinatorOptions,
): Promise<McpCoordinatorClient> {
    const dataRoot = resolveWaptionsAgentDataRoot(options.dataRoot);
    const startupTimeout = options.startupTimeoutMilliseconds
        ?? DEFAULT_STARTUP_TIMEOUT_MILLISECONDS;
    if (
        !Number.isSafeInteger(startupTimeout)
        || startupTimeout <= 0
        || startupTimeout > 60_000
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'The managed runtime startup timeout is invalid.',
        );
    }

    const attach = async () => (
        await attachManagedCoordinator(dataRoot, {
            windowsNamedPipeSecurity:
                options.runtimeProcess.windowsNamedPipeSecurity,
        })
    ).client;
    const connect = async () => {
        let client: LocalControlTransportClient;
        try {
            client = await attach();
        } catch (error) {
            if (!isRetryableTransportFailure(error)) throw error;
            await options.runtimeProcess.ensureRunning({
                dataRoot,
                protocolVersion: COORDINATOR_CONTROL_PROTOCOL_VERSION,
            });
            client = await waitForAttachment(attach, startupTimeout);
        }
        return validateControlHealth(client);
    };
    const initial = await connect();
    return new McpCoordinatorClient(
        initial,
        connect,
        options.maxSubscriptions,
    );
}

async function validateControlHealth(
    client: LocalControlTransportClient,
): Promise<LocalControlTransportClient> {
    try {
        const health = await client.request(
            'coordinator.health',
            undefined,
            { requestId: `health-${randomUUID()}` },
        ) as CoordinatorControlHealth;
        if (
            health.ready !== true
            || health.protocolVersion !== COORDINATOR_CONTROL_PROTOCOL_VERSION
        ) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The managed runtime control protocol is incompatible.',
            );
        }
        return client;
    } catch (error) {
        client.close();
        throw error;
    }
}

export function resolveWaptionsAgentDataRoot(value?: string): string {
    const configured = value ?? process.env.WAPTIONS_AGENT_DATA_DIR;
    const candidate = configured ?? defaultDataRoot();
    if (
        !isAbsolute(candidate)
        || candidate.includes('\0')
        || candidate.length > 2_048
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'WAPTIONS_AGENT_DATA_DIR must be a valid absolute path.',
        );
    }
    return resolve(candidate);
}

async function waitForAttachment(
    connect: ConnectTransport,
    timeoutMilliseconds: number,
): Promise<LocalControlTransportClient> {
    const deadline = Date.now() + timeoutMilliseconds;
    let delay = 20;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            return await connect();
        } catch (error) {
            lastError = error;
            if (!isRetryableTransportFailure(error)) throw error;
        }
        await new Promise((resolveDelay) => {
            const timer = setTimeout(resolveDelay, delay);
            timer.unref?.();
        });
        delay = Math.min(250, delay * 2);
    }
    throw managedError(
        'COORDINATOR_UNAVAILABLE',
        'The persistent managed runtime did not become ready in time.',
        true,
        lastError instanceof ManagedRuntimeError
            ? { lastCode: lastError.code }
            : undefined,
    );
}

function isRetryableTransportFailure(error: unknown): boolean {
    if (error instanceof ManagedRuntimeError) {
        return error.code === 'COORDINATOR_UNAVAILABLE' && error.retryable;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return (
        code === 'ECONNREFUSED'
        || code === 'ECONNRESET'
        || code === 'ENOENT'
        || code === 'EPIPE'
    );
}

function defaultDataRoot(): string {
    if (process.platform === 'win32') {
        return join(
            process.env.LOCALAPPDATA ?? homedir(),
            'Waptions',
            'Agent',
        );
    }
    if (process.platform === 'darwin') {
        return join(
            homedir(),
            'Library',
            'Application Support',
            'Waptions',
            'Agent',
        );
    }
    return join(
        process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
        'waptions-agent',
    );
}
