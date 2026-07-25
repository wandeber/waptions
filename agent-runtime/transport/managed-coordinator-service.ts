import { chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { managedError } from '../coordinator/errors';
import { atomicWriteJson, readJsonFile } from '../persistence/fs-durable';
import {
    LocalJsonTransportClient,
    LocalJsonTransportServer,
    type LocalTransportRequest,
    type LocalTransportEndpoint,
} from './local-json-transport';

export interface ManagedCoordinatorServiceAuthority {
    readonly epoch: string;
    canGracefullyShutdown(): boolean;
    close(): Promise<void>;
}

export interface CoordinatorServiceDiscovery {
    schemaVersion: 1;
    pid: number;
    epoch: string;
    controlEndpoint: LocalTransportEndpoint;
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
}

/**
 * Process-independent service host. The MCP stdio package supplies only the request dispatcher
 * and process launcher; this host owns discovery, authenticated IPC, reconnect, and lifecycle.
 */
export class ManagedCoordinatorService {
    private readonly transport: LocalJsonTransportServer;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private connectionCount = 0;
    private closed = false;

    private constructor(
        private readonly dataRoot: string,
        private readonly authority: ManagedCoordinatorServiceAuthority,
        secret: string,
        handler: (request: LocalTransportRequest) => Promise<unknown>,
        private readonly options: ManagedCoordinatorServiceOptions,
    ) {
        this.transport = new LocalJsonTransportServer(dataRoot, secret, handler, {
            onConnectionCountChanged: (count) => this.onConnectionCountChanged(count),
        });
    }

    static async start(
        dataRoot: string,
        authority: ManagedCoordinatorServiceAuthority,
        handler: (request: LocalTransportRequest) => Promise<unknown>,
        options: ManagedCoordinatorServiceOptions = {},
    ): Promise<ManagedCoordinatorService> {
        await assertNoLiveService(dataRoot);
        const secret = await readServiceSecret(dataRoot);
        const service = new ManagedCoordinatorService(dataRoot, authority, secret, handler, options);
        await service.transport.start();
        const discovery: CoordinatorServiceDiscovery = {
            schemaVersion: 1,
            pid: process.pid,
            epoch: authority.epoch,
            controlEndpoint: service.transport.endpoint,
            startedAt: new Date().toISOString(),
        };
        const path = discoveryPath(dataRoot);
        await atomicWriteJson(path, discovery, { mode: 0o600, faultPrefix: 'service-discovery' });
        await chmod(path, 0o600);
        return service;
    }

    async requestShutdownWhenIdle(): Promise<boolean> {
        if (this.closed || this.connectionCount > 0 || !this.authority.canGracefullyShutdown()) {
            return false;
        }
        await this.close();
        return true;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        await this.transport.close();
        await this.authority.close();
        await rm(discoveryPath(this.dataRoot), { force: true });
    }

    private onConnectionCountChanged(count: number): void {
        this.connectionCount = count;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        const timeout = this.options.idleShutdownMilliseconds;
        if (count !== 0 || timeout === undefined || this.closed) return;
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
        handler: (request: LocalTransportRequest) => Promise<unknown>;
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

export async function attachManagedCoordinator(dataRoot: string): Promise<{
    discovery: CoordinatorServiceDiscovery;
    client: LocalJsonTransportClient;
}> {
    const discovery = await readJsonFile<CoordinatorServiceDiscovery>(discoveryPath(dataRoot), 64 * 1024);
    if (!discovery || discovery.schemaVersion !== 1 || !Number.isSafeInteger(discovery.pid)) {
        throw managedError('COORDINATOR_UNAVAILABLE', 'No managed coordinator service is discoverable.', true);
    }
    if (
        !discovery.controlEndpoint
        || (
            discovery.controlEndpoint.kind === 'tcp'
            && (
                discovery.controlEndpoint.host !== 'localhost'
                || !Number.isSafeInteger(discovery.controlEndpoint.port)
                || discovery.controlEndpoint.port <= 0
                || discovery.controlEndpoint.port > 65_535
                || discovery.controlEndpoint.port === 59_941
            )
        )
        || (
            discovery.controlEndpoint.kind !== 'tcp'
            && discovery.controlEndpoint.kind !== 'socket'
        )
    ) {
        throw managedError('COORDINATOR_UNAVAILABLE', 'The coordinator discovery endpoint is invalid.');
    }
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
        await readServiceSecret(dataRoot),
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

async function readServiceSecret(dataRoot: string): Promise<string> {
    const bytes = await readFile(join(dataRoot, 'coordinator', 'secret'));
    if (bytes.byteLength !== 32) throw new Error('Coordinator secret has an invalid length.');
    return bytes.toString('base64url');
}

async function assertNoLiveService(dataRoot: string): Promise<void> {
    const discovery = await readJsonFile<CoordinatorServiceDiscovery>(discoveryPath(dataRoot), 64 * 1024);
    if (!discovery) return;
    try {
        process.kill(discovery.pid, 0);
        throw managedError(
            'COORDINATOR_UNAVAILABLE',
            'A managed coordinator service is already published for this data root.',
            true,
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        await rm(discoveryPath(dataRoot), { force: true });
    }
}
