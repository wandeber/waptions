import { createHash } from 'node:crypto';
import { lstat, chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { asManagedRuntimeError, managedError } from '../coordinator/errors';
import { constantTimeStringEqual } from '../persistence/canonical-json';

export interface LocalTransportRequest {
    id: string;
    method: string;
    params?: unknown;
}

export interface LocalTransportResponse {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: ReturnType<ReturnType<typeof asManagedRuntimeError>['toJSON']>;
}

export interface LocalTransportOptions {
    inputLimitBytes?: number;
    outputLimitBytes?: number;
    maxConnections?: number;
    maxInFlightPerConnection?: number;
    maxGlobalInFlight?: number;
    maxQueuedBytesPerConnection?: number;
    maxGlobalQueuedBytes?: number;
    authenticationDeadlineMilliseconds?: number;
    requestDeadlineMilliseconds?: number;
    onConnectionCountChanged?(count: number): void;
    onResourceStateChanged?(state: {
        connections: number;
        inFlight: number;
        queuedBytes: number;
    }): void;
    onDiagnostic?(kind: 'aborted' | 'deadline' | 'limit'): void;
    localhostPort?: number;
}

export interface LocalTransportRequestContext {
    signal: AbortSignal;
    deadlineAt: number;
}

export type LocalTransportEndpoint =
    | { kind: 'socket'; path: string }
    | { kind: 'tcp'; host: 'localhost'; port: number };

const DEFAULT_INPUT_LIMIT = 512 * 1024;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_IN_FLIGHT_PER_CONNECTION = 32;
const DEFAULT_MAX_GLOBAL_IN_FLIGHT = 128;
const DEFAULT_MAX_QUEUED_BYTES_PER_CONNECTION = 2 * 1024 * 1024;
const DEFAULT_MAX_GLOBAL_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_AUTHENTICATION_DEADLINE_MILLISECONDS = 5_000;
const DEFAULT_REQUEST_DEADLINE_MILLISECONDS = 30_000;

export class LocalJsonTransportServer {
    private endpointValue: LocalTransportEndpoint;
    private server: Server | null = null;
    private readonly sockets = new Set<Socket>();
    private readonly inputLimit: number;
    private readonly outputLimit: number;
    private globalInFlight = 0;
    private globalQueuedBytes = 0;

    constructor(
        dataRoot: string,
        private readonly secret: string,
        private readonly handler: (
            request: LocalTransportRequest,
            context: LocalTransportRequestContext,
        ) => Promise<unknown>,
        private readonly options: LocalTransportOptions = {},
    ) {
        this.endpointValue = options.localhostPort === undefined
            ? localEndpoint(dataRoot)
            : { kind: 'tcp', host: 'localhost', port: options.localhostPort };
        this.inputLimit = options.inputLimitBytes ?? DEFAULT_INPUT_LIMIT;
        this.outputLimit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
        for (const [name, value] of Object.entries({
            inputLimitBytes: this.inputLimit,
            outputLimitBytes: this.outputLimit,
            maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
            maxInFlightPerConnection:
                options.maxInFlightPerConnection ?? DEFAULT_MAX_IN_FLIGHT_PER_CONNECTION,
            maxGlobalInFlight: options.maxGlobalInFlight ?? DEFAULT_MAX_GLOBAL_IN_FLIGHT,
            maxQueuedBytesPerConnection:
                options.maxQueuedBytesPerConnection ?? DEFAULT_MAX_QUEUED_BYTES_PER_CONNECTION,
            maxGlobalQueuedBytes:
                options.maxGlobalQueuedBytes ?? DEFAULT_MAX_GLOBAL_QUEUED_BYTES,
            authenticationDeadlineMilliseconds:
                options.authenticationDeadlineMilliseconds
                    ?? DEFAULT_AUTHENTICATION_DEADLINE_MILLISECONDS,
            requestDeadlineMilliseconds:
                options.requestDeadlineMilliseconds ?? DEFAULT_REQUEST_DEADLINE_MILLISECONDS,
        })) {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw managedError('INVALID_REQUEST', `The local transport ${name} limit is invalid.`);
            }
        }
    }

    get endpoint(): LocalTransportEndpoint {
        return this.endpointValue;
    }

    async start(): Promise<void> {
        if (this.server) return;
        if (this.endpointValue.kind === 'socket' && process.platform !== 'win32') {
            await removeStaleSocket(this.endpointValue.path);
        }
        const server = createServer((socket) => this.accept(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            if (this.endpointValue.kind === 'tcp') {
                server.listen(this.endpointValue.port, this.endpointValue.host);
            } else {
                server.listen(this.endpointValue.path);
            }
        });
        if (this.endpointValue.kind === 'tcp' && this.endpointValue.port === 0) {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Could not resolve local TCP port.');
            this.endpointValue = { ...this.endpointValue, port: address.port };
        }
        if (this.endpointValue.kind === 'socket' && process.platform !== 'win32') {
            await chmod(this.endpointValue.path, 0o600);
        }
    }

    async close(): Promise<void> {
        const server = this.server;
        this.server = null;
        for (const socket of Array.from(this.sockets)) socket.destroy();
        this.sockets.clear();
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        if (this.endpointValue.kind === 'socket' && process.platform !== 'win32') {
            await rm(this.endpointValue.path, { force: true });
        }
    }

    private accept(socket: Socket): void {
        if (this.sockets.size >= (this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) {
            this.options.onDiagnostic?.('limit');
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        this.notifyResources();
        socket.setNoDelay(true);
        let authenticated = false;
        const seenRequestIds = new Set<string>();
        const inFlight = new Map<string, AbortController>();
        let queuedBytes = 0;
        let closed = false;
        const authenticationTimer = setTimeout(() => {
            if (authenticated || closed) return;
            this.options.onDiagnostic?.('deadline');
            socket.destroy(managedError(
                'COORDINATOR_UNAVAILABLE',
                'The local coordinator authentication timed out.',
                true,
            ));
        }, this.options.authenticationDeadlineMilliseconds
            ?? DEFAULT_AUTHENTICATION_DEADLINE_MILLISECONDS);
        authenticationTimer.unref?.();
        const write = async (value: unknown) => {
            const frame = encodeFrame(value, this.outputLimit);
            const perConnectionLimit = this.options.maxQueuedBytesPerConnection
                ?? DEFAULT_MAX_QUEUED_BYTES_PER_CONNECTION;
            const globalLimit = this.options.maxGlobalQueuedBytes
                ?? DEFAULT_MAX_GLOBAL_QUEUED_BYTES;
            if (
                closed
                || socket.destroyed
                || socket.writableLength + queuedBytes + frame.byteLength > perConnectionLimit
                || this.globalQueuedBytes + frame.byteLength > globalLimit
            ) {
                this.options.onDiagnostic?.('limit');
                throw managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'The local transport response backpressure limit was reached.',
                    true,
                );
            }
            queuedBytes += frame.byteLength;
            this.globalQueuedBytes += frame.byteLength;
            this.notifyResources();
            try {
                await writeEncodedFrame(socket, frame);
            } finally {
                queuedBytes = Math.max(0, queuedBytes - frame.byteLength);
                this.globalQueuedBytes = Math.max(0, this.globalQueuedBytes - frame.byteLength);
                this.notifyResources();
            }
        };
        const reader = new FrameReader(this.inputLimit, async (payload) => {
            if (!authenticated) {
                const hello = parseRecord(payload);
                if (
                    hello.type !== 'hello'
                    || typeof hello.secret !== 'string'
                    || !constantTimeStringEqual(hello.secret, this.secret)
                ) {
                    socket.destroy();
                    return;
                }
                authenticated = true;
                clearTimeout(authenticationTimer);
                await write({ type: 'ready' });
                return;
            }
            const parsed = parseRecord(payload);
            const request = validateRequest(parsed);
            if (seenRequestIds.has(request.id) || seenRequestIds.size >= 10_000) {
                socket.destroy();
                return;
            }
            seenRequestIds.add(request.id);
            if (
                inFlight.size >= (
                    this.options.maxInFlightPerConnection
                    ?? DEFAULT_MAX_IN_FLIGHT_PER_CONNECTION
                )
                || this.globalInFlight >= (
                    this.options.maxGlobalInFlight
                    ?? DEFAULT_MAX_GLOBAL_IN_FLIGHT
                )
            ) {
                this.options.onDiagnostic?.('limit');
                await write({
                    id: request.id,
                    ok: false,
                    error: managedError(
                        'COORDINATOR_UNAVAILABLE',
                        'The local coordinator request limit was reached.',
                        true,
                    ).toJSON(),
                });
                return;
            }
            const controller = new AbortController();
            const deadlineMilliseconds = this.options.requestDeadlineMilliseconds
                ?? DEFAULT_REQUEST_DEADLINE_MILLISECONDS;
            const deadlineAt = Date.now() + deadlineMilliseconds;
            const timer = setTimeout(() => {
                this.options.onDiagnostic?.('deadline');
                controller.abort(managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'The local coordinator request timed out.',
                    true,
                ));
            }, deadlineMilliseconds);
            timer.unref?.();
            inFlight.set(request.id, controller);
            this.globalInFlight += 1;
            this.notifyResources();
            // Requests intentionally execute concurrently. The coordinator itself serializes
            // project mutations, while independent reads may complete out of order.
            const handlerExecution = Promise.resolve().then(() => (
                this.handler(request, { signal: controller.signal, deadlineAt })
            ));
            void raceWithAbort(
                handlerExecution,
                controller.signal,
            ).then(
                (result) => write({ id: request.id, ok: true, result }),
                (error) => write({
                    id: request.id,
                    ok: false,
                    error: asManagedRuntimeError(error).toJSON(),
                }),
            ).catch(() => socket.destroy());
            // A response deadline cancels the caller-facing wait, but authority capacity remains
            // leased until the handler actually settles. This keeps ignoring AbortSignal from
            // turning timeouts or disconnects into unbounded hidden concurrency.
            void handlerExecution.then(() => {
                clearTimeout(timer);
                inFlight.delete(request.id);
                this.globalInFlight = Math.max(0, this.globalInFlight - 1);
                this.notifyResources();
            }, () => {
                clearTimeout(timer);
                inFlight.delete(request.id);
                this.globalInFlight = Math.max(0, this.globalInFlight - 1);
                this.notifyResources();
            });
        });
        socket.on('data', (chunk) => {
            reader.push(chunk).catch(() => socket.destroy());
        });
        socket.once('close', () => {
            closed = true;
            clearTimeout(authenticationTimer);
            for (const controller of Array.from(inFlight.values())) {
                this.options.onDiagnostic?.('aborted');
                controller.abort(managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'The local coordinator client disconnected.',
                    true,
                ));
            }
            this.sockets.delete(socket);
            this.notifyResources();
        });
        socket.once('error', () => socket.destroy());
    }

    private notifyResources(): void {
        this.options.onConnectionCountChanged?.(this.sockets.size);
        this.options.onResourceStateChanged?.({
            connections: this.sockets.size,
            inFlight: this.globalInFlight,
            queuedBytes: this.globalQueuedBytes,
        });
    }
}

export class LocalJsonTransportClient {
    private socket: Socket | null = null;
    private readonly pending = new Map<string, {
        resolve(value: unknown): void;
        reject(error: unknown): void;
        timer: ReturnType<typeof setTimeout>;
        signal?: AbortSignal;
        abort?: () => void;
    }>();
    private requestSequence = 0;
    private ready = false;
    private readyPromise: Promise<void> | null = null;
    private readyResolve: (() => void) | null = null;
    private readyReject: ((error: unknown) => void) | null = null;

    constructor(
        readonly endpoint: LocalTransportEndpoint,
        private readonly secret: string,
        private readonly limits: LocalTransportOptions = {},
    ) {}

    async connect(): Promise<void> {
        if (this.socket) return;
        const socket = this.endpoint.kind === 'tcp'
            ? createConnection({ host: this.endpoint.host, port: this.endpoint.port })
            : createConnection(this.endpoint.path);
        this.socket = socket;
        this.ready = false;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        // A socket may fail while the hello frame itself is still being written. Attach a handler
        // immediately so the concurrently rejected readiness promise never becomes unhandled.
        void this.readyPromise.catch(() => undefined);
        const reader = new FrameReader(
            this.limits.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT,
            async (payload) => this.deliver(JSON.parse(payload.toString('utf8'))),
        );
        socket.on('data', (chunk) => {
            reader.push(chunk).catch((error) => this.fail(error));
        });
        socket.once('close', () => this.fail(new Error('The local coordinator connection closed.')));
        socket.once('error', (error) => this.fail(error));
        const timeout = this.limits.authenticationDeadlineMilliseconds
            ?? DEFAULT_AUTHENTICATION_DEADLINE_MILLISECONDS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(managedError(
                'COORDINATOR_UNAVAILABLE',
                'The local coordinator authentication timed out.',
                true,
            )), timeout);
            timer.unref?.();
        });
        try {
            await Promise.race([
                new Promise<void>((resolve, reject) => {
                    socket.once('connect', resolve);
                    socket.once('error', reject);
                }),
                deadline,
            ]);
            await writeFrame(
                socket,
                { type: 'hello', secret: this.secret },
                this.limits.inputLimitBytes ?? DEFAULT_INPUT_LIMIT,
            );
            await Promise.race([this.readyPromise, deadline]);
        } catch (error) {
            this.fail(error);
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async request(
        method: string,
        params?: unknown,
        options: { signal?: AbortSignal; timeoutMilliseconds?: number } = {},
    ): Promise<unknown> {
        if (!this.socket || !this.ready) throw new Error('Local transport client is not connected.');
        if (
            this.pending.size
            >= (this.limits.maxInFlightPerConnection ?? DEFAULT_MAX_IN_FLIGHT_PER_CONNECTION)
        ) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The local transport client request limit was reached.',
                true,
            );
        }
        const id = `${process.pid}-${++this.requestSequence}`;
        if (this.pending.has(id)) throw new Error('Duplicate local transport request identifier.');
        if (options.signal?.aborted) {
            throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        const timeout = options.timeoutMilliseconds ?? 30_000;
        if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 300_000) {
            throw managedError('INVALID_REQUEST', 'The local transport timeout is invalid.');
        }
        const response = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(managedError('COORDINATOR_UNAVAILABLE', 'The local coordinator request timed out.', true));
            }, timeout);
            timer.unref?.();
            const abort = () => {
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            this.pending.set(id, {
                resolve,
                reject,
                timer,
                signal: options.signal,
                abort,
            });
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener('abort', abort, { once: true });
        });
        try {
            await writeFrame(
                this.socket,
                { id, method, ...(params === undefined ? {} : { params }) },
                this.limits.inputLimitBytes ?? DEFAULT_INPUT_LIMIT,
            );
        } catch (error) {
            this.rejectPending(id, error);
        }
        return response;
    }

    close(): void {
        this.fail(new Error('The local coordinator client closed.'));
    }

    private deliver(value: unknown): void {
        if (!this.ready) {
            if (
                !value
                || typeof value !== 'object'
                || (value as { type?: unknown }).type !== 'ready'
            ) {
                this.fail(new Error('Local coordinator authentication failed.'));
                return;
            }
            this.ready = true;
            this.readyResolve?.();
            this.readyResolve = null;
            this.readyReject = null;
            return;
        }
        if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
            this.fail(new Error('The local coordinator returned an invalid response.'));
            return;
        }
        const response = value as LocalTransportResponse;
        const pending = this.pending.get(response.id);
        if (!pending) {
            this.fail(new Error('The local coordinator returned an unknown response identifier.'));
            return;
        }
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.abort!);
        if (response.ok) {
            pending.resolve(response.result);
        } else {
            pending.reject(managedError(
                response.error?.code ?? 'INTERNAL_ERROR',
                response.error?.message ?? 'The local coordinator request failed.',
                response.error?.retryable,
                response.error?.details,
            ));
        }
    }

    private rejectPending(id: string, error: unknown): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.abort!);
        pending.reject(error);
    }

    private fail(error: unknown): void {
        const socket = this.socket;
        this.socket = null;
        this.ready = false;
        socket?.destroy();
        this.readyReject?.(error);
        this.readyResolve = null;
        this.readyReject = null;
        for (const id of Array.from(this.pending.keys())) this.rejectPending(id, error);
    }
}

class FrameReader {
    private buffer = Buffer.alloc(0);
    private processing = Promise.resolve();

    constructor(
        private readonly maximumBytes: number,
        private readonly onFrame: (frame: Buffer) => Promise<void>,
    ) {}

    async push(chunk: Buffer): Promise<void> {
        if (this.buffer.byteLength + chunk.byteLength > this.maximumBytes + 4) {
            throw managedError('PAYLOAD_TOO_LARGE', 'The local transport frame is oversized.');
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processing = this.processing.then(async () => {
            while (this.buffer.byteLength >= 4) {
                const length = this.buffer.readUInt32BE(0);
                if (length > this.maximumBytes) {
                    throw managedError('PAYLOAD_TOO_LARGE', 'The local transport frame is oversized.');
                }
                if (this.buffer.byteLength < length + 4) return;
                const frame = this.buffer.subarray(4, length + 4);
                this.buffer = this.buffer.subarray(length + 4);
                await this.onFrame(frame);
            }
        });
        await this.processing;
    }
}

async function writeFrame(socket: Socket, value: unknown, maximumBytes: number): Promise<void> {
    await writeEncodedFrame(socket, encodeFrame(value, maximumBytes));
}

function encodeFrame(value: unknown, maximumBytes: number): Buffer {
    const body = Buffer.from(JSON.stringify(value));
    if (body.byteLength > maximumBytes) {
        throw managedError('PAYLOAD_TOO_LARGE', 'The local transport response is oversized.');
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.byteLength);
    return Buffer.concat([header, body]);
}

async function writeEncodedFrame(socket: Socket, frame: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.write(frame, (error) => error ? reject(error) : resolve());
    });
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([operation, cancellation]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}

function parseRecord(payload: Buffer): Record<string, unknown> {
    const value = JSON.parse(payload.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw managedError('INVALID_REQUEST', 'The local transport request must be an object.');
    }
    return value as Record<string, unknown>;
}

function validateRequest(value: Record<string, unknown>): LocalTransportRequest {
    if (
        typeof value.id !== 'string'
        || value.id.length === 0
        || value.id.length > 128
        || typeof value.method !== 'string'
        || value.method.length === 0
        || value.method.length > 128
    ) {
        throw managedError('INVALID_REQUEST', 'The local transport request is invalid.');
    }
    return {
        id: value.id,
        method: value.method,
        ...(value.params === undefined ? {} : { params: value.params }),
    };
}

function localEndpoint(dataRoot: string): LocalTransportEndpoint {
    if (process.platform === 'win32') {
        const digest = createHash('sha256').update(dataRoot).digest('hex').slice(0, 24);
        return { kind: 'socket', path: `\\\\.\\pipe\\waptions-${digest}` };
    }
    return { kind: 'socket', path: join(dataRoot, 'coordinator.sock') };
}

async function removeStaleSocket(path: string): Promise<void> {
    try {
        const metadata = await lstat(path);
        if (!metadata.isSocket() || metadata.isSymbolicLink()) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The local transport path is occupied by a non-socket object.',
            );
        }
        await rm(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}
