import { constants } from 'node:fs';
import { chmod, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { managedError } from '../coordinator/errors';
import { SingleInstanceLock } from '../coordinator/single-instance-lock';
import { atomicWriteJson } from '../persistence/fs-durable';
import {
    LocalJsonTransportClient,
    LocalJsonTransportServer,
    type LocalTransportRequest,
    type LocalTransportOptions,
    type LocalTransportRequestContext,
} from './local-json-transport';
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import {
    assertPrivateControlEndpoint,
    type CoordinatorControlEndpoint,
    type WindowsNamedPipeSecurityPort,
} from '../server/control-endpoint';

export interface ManagedCoordinatorServiceAuthority {
    readonly epoch: string;
    readonly diagnostics?: RuntimeDiagnostics;
    readonly httpBridgeEndpoint?: { host: 'localhost'; port: 59941 };
    canGracefullyShutdown(): boolean;
    close(): Promise<void>;
}

export interface CoordinatorServiceDiscovery {
    schemaVersion: 1;
    pid: number;
    epoch: string;
    controlEndpoint: CoordinatorControlEndpoint;
    httpBridgeEndpoint?: { host: 'localhost'; port: 59941 };
    startedAt: string;
}

export interface ManagedCoordinatorServiceOptions {
    /**
     * Undefined keeps the headless authority alive indefinitely. A finite value permits idle
     * shutdown, but only after every client detached and the coordinator confirms no queued,
     * running, or unflushed work remains.
     */
    idleShutdownMilliseconds?: number;
    transport?: Omit<
        LocalTransportOptions,
        'onConnectionCountChanged' | 'onResourceStateChanged' | 'onDiagnostic'
    >;
}

/**
 * Process-independent service host. The MCP stdio package supplies only the request dispatcher
 * and process launcher; this host owns discovery, authenticated IPC, reconnect, and lifecycle.
 */
export class ManagedCoordinatorService {
    private readonly transport: LocalJsonTransportServer;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private connectionCount = 0;
    private inFlightCount = 0;
    private queuedBytes = 0;
    private closed = false;
    private closePromise: Promise<void> | null = null;

    private constructor(
        private readonly dataRoot: string,
        private readonly authority: ManagedCoordinatorServiceAuthority,
        handler: (
            request: LocalTransportRequest,
            context: LocalTransportRequestContext,
        ) => Promise<unknown>,
        private readonly options: ManagedCoordinatorServiceOptions,
    ) {
        this.transport = new LocalJsonTransportServer(dataRoot, handler, {
            ...options.transport,
            onConnectionCountChanged: (count) => this.onConnectionCountChanged(count),
            onResourceStateChanged: (state) => {
                this.inFlightCount = state.inFlight;
                this.queuedBytes = state.queuedBytes;
                authority.diagnostics?.set('ipcConnections', state.connections);
                authority.diagnostics?.set('ipcInFlight', state.inFlight);
                authority.diagnostics?.set('ipcQueuedBytes', state.queuedBytes);
                this.scheduleIdleShutdown();
            },
            onDiagnostic: (kind) => {
                authority.diagnostics?.record(
                    kind === 'aborted'
                        ? 'abortedOperations'
                        : kind === 'deadline'
                            ? 'deadlineExceeded'
                            : 'limitRejections',
                );
            },
        });
    }

    static async start(
        dataRoot: string,
        authority: ManagedCoordinatorServiceAuthority,
        handler: (
            request: LocalTransportRequest,
            context: LocalTransportRequestContext,
        ) => Promise<unknown>,
        options: ManagedCoordinatorServiceOptions = {},
    ): Promise<ManagedCoordinatorService> {
        const service = new ManagedCoordinatorService(dataRoot, authority, handler, options);
        try {
            await withControlEndpointTransition(dataRoot, async () => {
                await assertNoLiveService(
                    dataRoot,
                    options.transport?.windowsNamedPipeSecurity,
                );
                await service.transport.start();
                const discovery: CoordinatorServiceDiscovery = {
                    schemaVersion: 1,
                    pid: process.pid,
                    epoch: authority.epoch,
                    controlEndpoint: service.transport.endpoint,
                    ...(authority.httpBridgeEndpoint
                        ? { httpBridgeEndpoint: authority.httpBridgeEndpoint }
                        : {}),
                    startedAt: new Date().toISOString(),
                };
                const path = discoveryPath(dataRoot);
                await atomicWriteJson(path, discovery, {
                    mode: 0o600,
                    faultPrefix: 'service-discovery',
                });
                await chmod(path, 0o600);
            });
            return service;
        } catch (error) {
            await service.close().catch(() => undefined);
            throw error;
        }
    }

    async requestShutdownWhenIdle(): Promise<boolean> {
        if (
            this.closed
            || this.connectionCount > 0
            || this.inFlightCount > 0
            || this.queuedBytes > 0
            || !this.authority.canGracefullyShutdown()
        ) {
            return false;
        }
        await this.close();
        return true;
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.closePromise = this.closeResources();
        return this.closePromise;
    }

    private async closeResources(): Promise<void> {
        let authorityCloseAttempted = false;
        try {
            await withControlEndpointTransition(this.dataRoot, async () => {
                await this.transport.close();
                let authorityCloseError: unknown;
                try {
                    authorityCloseAttempted = true;
                    await this.authority.close();
                } catch (error) {
                    authorityCloseError = error;
                }
                await removeOwnedDiscovery(this.dataRoot, this.authority.epoch);
                if (authorityCloseError) throw authorityCloseError;
            });
        } finally {
            if (!authorityCloseAttempted) await this.authority.close();
        }
    }

    private onConnectionCountChanged(count: number): void {
        this.connectionCount = count;
        this.scheduleIdleShutdown();
    }

    private scheduleIdleShutdown(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        const timeout = this.options.idleShutdownMilliseconds;
        if (
            this.connectionCount !== 0
            || this.inFlightCount !== 0
            || this.queuedBytes !== 0
            || timeout === undefined
            || this.closed
        ) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            void this.requestShutdownWhenIdle();
        }, timeout);
        this.idleTimer.unref?.();
    }
}

export async function runManagedCoordinatorService(
    bootstrap: () => Promise<{
        authority: ManagedCoordinatorServiceAuthority;
        handler: (
            request: LocalTransportRequest,
            context: LocalTransportRequestContext,
        ) => Promise<unknown>;
        dataRoot: string;
        options?: ManagedCoordinatorServiceOptions;
    }>,
): Promise<void> {
    const started = await bootstrap();
    const service = await ManagedCoordinatorService.start(
        started.dataRoot,
        started.authority,
        started.handler,
        started.options,
    );
    await new Promise<void>((resolve, reject) => {
        let stopping = false;
        const stop = () => {
            if (stopping) return;
            stopping = true;
            service.close().then(resolve, reject);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

export async function attachManagedCoordinator(
    dataRoot: string,
    options: {
        windowsNamedPipeSecurity?: WindowsNamedPipeSecurityPort;
    } = {},
): Promise<{
    discovery: CoordinatorServiceDiscovery;
    client: LocalJsonTransportClient;
}> {
    const record = await readPrivateDiscovery(discoveryPath(dataRoot));
    if (!record) {
        throw managedError('COORDINATOR_UNAVAILABLE', 'No managed coordinator service is discoverable.', true);
    }
    const discovery = record.discovery;
    try {
        process.kill(discovery.pid, 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            throw managedError('COORDINATOR_UNAVAILABLE', 'The discovered coordinator is no longer running.', true);
        }
        throw error;
    }
    const client = new LocalJsonTransportClient(
        discovery.controlEndpoint,
        {
            windowsNamedPipeSecurity: options.windowsNamedPipeSecurity,
        },
    );
    try {
        await client.connect();
        return { discovery, client };
    } catch {
        client.close();
        throw managedError('COORDINATOR_UNAVAILABLE', 'Could not attach to the managed coordinator.', true);
    }
}

function discoveryPath(dataRoot: string): string {
    return join(dataRoot, 'coordinator', 'service.json');
}

async function removeOwnedDiscovery(dataRoot: string, epoch: string): Promise<void> {
    const path = discoveryPath(dataRoot);
    const record = await readPrivateDiscovery(path);
    const discovery = record?.discovery;
    if (
        discovery
        && discovery.schemaVersion === 1
        && discovery.pid === process.pid
        && discovery.epoch === epoch
    ) {
        await removeDiscoveryRecord(path, record);
    }
}

async function assertNoLiveService(
    dataRoot: string,
    windowsNamedPipeSecurity?: WindowsNamedPipeSecurityPort,
): Promise<void> {
    const path = discoveryPath(dataRoot);
    const record = await readPrivateDiscovery(path);
    if (!record) return;
    const client = new LocalJsonTransportClient(
        record.discovery.controlEndpoint,
        { windowsNamedPipeSecurity },
    );
    let connected = false;
    try {
        await client.connect();
        connected = true;
    } catch (error) {
        if (!isStaleEndpointFailure(error)) throw error;
    } finally {
        client.close();
    }
    if (connected) {
        throw managedError(
            'COORDINATOR_UNAVAILABLE',
            'A managed coordinator service is already published for this data root.',
            true,
        );
    }
    await removeDiscoveryRecord(path, record);
}

interface PrivateDiscoveryRecord {
    discovery: CoordinatorServiceDiscovery;
    identity: { dev: number; ino: number };
}

async function readPrivateDiscovery(
    path: string,
): Promise<PrivateDiscoveryRecord | null> {
    let handle;
    try {
        handle = await open(
            path,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw managedError(
            'COORDINATOR_UNAVAILABLE',
            'The coordinator discovery file could not be opened safely.',
        );
    }
    try {
        const before = await handle.stat();
        const uid = process.getuid?.();
        if (
            !before.isFile()
            || before.size < 2
            || before.size > 64 * 1024
            || (
                process.platform !== 'win32'
                && (
                    (uid !== undefined && before.uid !== uid)
                    || (before.mode & 0o777) !== 0o600
                )
            )
        ) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The coordinator discovery file identity is invalid.',
            );
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (
            before.dev !== after.dev
            || before.ino !== after.ino
            || before.size !== after.size
            || bytes.byteLength !== before.size
        ) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The coordinator discovery file changed while it was read.',
                true,
            );
        }
        let value: unknown;
        try {
            value = JSON.parse(bytes.toString('utf8'));
        } catch {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The coordinator discovery file is malformed.',
            );
        }
        return {
            discovery: validateDiscovery(value),
            identity: { dev: before.dev, ino: before.ino },
        };
    } finally {
        await handle.close();
    }
}

async function removeDiscoveryRecord(
    path: string,
    record: PrivateDiscoveryRecord,
): Promise<void> {
    const current = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
        const metadata = await current.stat();
        if (
            !metadata.isFile()
            || metadata.dev !== record.identity.dev
            || metadata.ino !== record.identity.ino
        ) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The coordinator discovery identity changed before cleanup.',
                true,
            );
        }
        await rm(path);
    } finally {
        await current.close();
    }
}

function isStaleEndpointFailure(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ECONNREFUSED' || code === 'ENOENT';
}

async function withControlEndpointTransition<T>(
    dataRoot: string,
    operation: () => Promise<T>,
): Promise<T> {
    // The authority lock is held for the coordinator lifetime. This second,
    // short-lived lock serializes discovery and socket path transitions so a
    // retiring service cannot unlink the successor it just observed.
    const lock = await SingleInstanceLock.acquire(
        join(dataRoot, 'coordinator', 'control-transition'),
    );
    try {
        return await operation();
    } finally {
        await lock.release();
    }
}

function validateDiscovery(value: unknown): CoordinatorServiceDiscovery {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw managedError(
            'COORDINATOR_UNAVAILABLE',
            'The coordinator discovery record is invalid.',
        );
    }
    const discovery = value as Partial<CoordinatorServiceDiscovery>;
    const keys = Object.keys(discovery).sort();
    const expected = [
        'controlEndpoint',
        'epoch',
        ...(discovery.httpBridgeEndpoint === undefined
            ? []
            : ['httpBridgeEndpoint']),
        'pid',
        'schemaVersion',
        'startedAt',
    ].sort();
    if (
        keys.length !== expected.length
        || keys.some((key, index) => key !== expected[index])
        || discovery.schemaVersion !== 1
        || !Number.isSafeInteger(discovery.pid)
        || Number(discovery.pid) <= 0
        || typeof discovery.epoch !== 'string'
        || discovery.epoch.length === 0
        || discovery.epoch.length > 128
        || typeof discovery.startedAt !== 'string'
        || !isCanonicalIsoTimestamp(discovery.startedAt)
        || !discovery.controlEndpoint
    ) {
        throw managedError(
            'COORDINATOR_UNAVAILABLE',
            'The coordinator discovery record is invalid.',
        );
    }
    try {
        assertPrivateControlEndpoint(discovery.controlEndpoint);
    } catch {
        throw managedError(
            'COORDINATOR_UNAVAILABLE',
            'The coordinator discovery endpoint is invalid.',
        );
    }
    if (
        discovery.httpBridgeEndpoint !== undefined
        && (
            discovery.httpBridgeEndpoint.host !== 'localhost'
            || discovery.httpBridgeEndpoint.port !== 59941
            || Object.keys(discovery.httpBridgeEndpoint).sort().join(',')
                !== 'host,port'
        )
    ) {
        throw managedError(
            'COORDINATOR_UNAVAILABLE',
            'The coordinator HTTP bridge discovery is invalid.',
        );
    }
    return discovery as CoordinatorServiceDiscovery;
}

function isCanonicalIsoTimestamp(value: string): boolean {
    try {
        return new Date(value).toISOString() === value;
    } catch {
        return false;
    }
}
