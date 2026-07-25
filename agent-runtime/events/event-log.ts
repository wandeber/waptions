import { createHmac } from 'node:crypto';
import { managedError } from '../coordinator/errors';
import type { DurableWrite, ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { canonicalJson, constantTimeStringEqual } from '../persistence/canonical-json';
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import type { StateToken } from '../coordinator/types';

export type ManagedEventKind =
    | 'project.changed'
    | 'session.recovered'
    | 'history.changed'
    | 'playback.changed'
    | 'presenter.changed'
    | 'grant.changed'
    | 'source.changed'
    | 'job.changed'
    | 'artifact.created'
    | 'diagnostics.changed';

export type ManagedEventData = Readonly<Record<string, unknown>>;

/**
 * Durable, lossless event contract consumed by MCP polling/subscriptions and every editor host.
 * `state` is the complete canonical token after the event's transaction; `data` remains typed at
 * call sites instead of being flattened into a lossy string/number summary.
 */
export interface EventRecordV1<
    Kind extends ManagedEventKind = ManagedEventKind,
    Data extends ManagedEventData = ManagedEventData,
> {
    schemaVersion: 1;
    cursor: string;
    type: Kind;
    occurredAt: string;
    state: StateToken;
    sequence: number;
    data: Data;
}

export type ManagedEvent = EventRecordV1;

export interface EventPage {
    events: readonly ManagedEvent[];
    nextCursor: string;
}

export interface EventSubscription {
    next(signal?: AbortSignal): Promise<ManagedEvent>;
    close(): void;
}

interface PendingReader {
    resolve(event: ManagedEvent): void;
    reject(error: unknown): void;
}

const MAX_PAGE = 500;
const DEFAULT_RETENTION_COUNT = 10_000;
const DEFAULT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export interface EventLogLimits {
    maximumSubscriptionsPerScope?: number;
    maximumSubscriptionsGlobal?: number;
    maximumPendingReadersGlobal?: number;
    longPollMilliseconds?: number;
    diagnostics?: RuntimeDiagnostics;
}

export class ManagedEventLog {
    private readonly subscribers = new Map<string, Set<ManagedSubscription>>();
    private subscriptionCount = 0;
    private pendingReaderCount = 0;

    constructor(
        private readonly store: ManagedFilesystemStore,
        private readonly cursorSecret: Uint8Array,
        private readonly retentionCount = DEFAULT_RETENTION_COUNT,
        private readonly retentionMilliseconds = DEFAULT_RETENTION_MILLISECONDS,
        private readonly subscriptionCapacity = 256,
        private readonly limits: EventLogLimits = {},
    ) {}

    cursor(projectId: string, sessionId: string, sequence: number): string {
        const project = Buffer.from(projectId).toString('base64url');
        const session = Buffer.from(sessionId).toString('base64url');
        const body = `e2.${project}.${session}.${sequence}`;
        const signature = createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
        return `${body}.${signature}`;
    }

    write(event: ManagedEvent): DurableWrite {
        if (
            event.cursor !== this.cursor(event.state.projectId, event.state.sessionId, event.sequence)
            || event.state.eventCursor !== event.cursor
        ) {
            throw managedError('INVALID_REQUEST', 'The event cursor does not match its state token.');
        }
        canonicalJson(event.state, 16 * 1024);
        canonicalJson(event.data, 48 * 1024);
        return {
            relativePath: `events/${event.sequence.toString().padStart(16, '0')}.json`,
            value: event,
        };
    }

    async retentionDeletes(projectId: string, now = Date.now()): Promise<DurableWrite[]> {
        const events = await this.store.readNamespace<ManagedEvent>(projectId, 'events');
        const minimumTime = now - this.retentionMilliseconds;
        const retained = events
            .filter((event) => Date.parse(event.occurredAt) >= minimumTime)
            .slice(-this.retentionCount);
        const retainedSequences = new Set(retained.map((event) => event.sequence));
        return events
            .filter((event) => !retainedSequences.has(event.sequence))
            .map((event) => ({
                relativePath: `events/${event.sequence.toString().padStart(16, '0')}.json`,
                delete: true as const,
            }));
    }

    async read(
        projectId: string,
        sessionId: string,
        cursor: string | undefined,
        limit = 100,
    ): Promise<EventPage> {
        const requestedSequence = cursor ? this.parseCursor(projectId, sessionId, cursor) : 0;
        const safeLimit = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE));
        const events = await this.store.readNamespace<ManagedEvent>(projectId, 'events');
        const earliest = events.at(0)?.sequence;
        if (earliest !== undefined && requestedSequence < earliest - 1) {
            throw managedError(
                'EVENT_CURSOR_EXPIRED',
                'The event cursor predates retained session events.',
                false,
                { earliestSequence: earliest },
            );
        }
        const page = events.filter((event) => event.sequence > requestedSequence).slice(0, safeLimit);
        const nextSequence = page.at(-1)?.sequence ?? requestedSequence;
        return { events: page, nextCursor: this.cursor(projectId, sessionId, nextSequence) };
    }

    publish(event: ManagedEvent): void {
        for (const subscription of Array.from(this.subscribers.get(scopeKey(
            event.state.projectId,
            event.state.sessionId,
        )) ?? [])) {
            subscription.push(event);
        }
    }

    subscribe(projectId: string, sessionId: string, afterCursor?: string): EventSubscription {
        const sequence = afterCursor ? this.parseCursor(projectId, sessionId, afterCursor) : 0;
        const key = scopeKey(projectId, sessionId);
        const subscriptions = this.subscribers.get(key) ?? new Set<ManagedSubscription>();
        if (
            subscriptions.size >= (this.limits.maximumSubscriptionsPerScope ?? 16)
            || this.subscriptionCount >= (this.limits.maximumSubscriptionsGlobal ?? 64)
        ) {
            this.limits.diagnostics?.record('limitRejections');
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The managed event subscription limit was reached.',
                true,
            );
        }
        this.subscriptionCount += 1;
        const releaseDiagnostic = this.limits.diagnostics?.increment('subscriptions');
        const subscription = new ManagedSubscription(sequence, this.subscriptionCapacity, () => {
            const projectSubscriptions = this.subscribers.get(key);
            projectSubscriptions?.delete(subscription);
            if (projectSubscriptions?.size === 0) this.subscribers.delete(key);
            this.subscriptionCount = Math.max(0, this.subscriptionCount - 1);
            releaseDiagnostic?.();
        }, () => {
            if (
                this.pendingReaderCount
                >= (this.limits.maximumPendingReadersGlobal ?? 64)
            ) {
                this.limits.diagnostics?.record('limitRejections');
                throw managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'The managed event pending-read limit was reached.',
                    true,
                );
            }
            this.pendingReaderCount += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                this.pendingReaderCount = Math.max(0, this.pendingReaderCount - 1);
            };
        }, this.limits.longPollMilliseconds ?? 30_000, {
            aborted: () => this.limits.diagnostics?.record('abortedOperations'),
            deadline: () => this.limits.diagnostics?.record('deadlineExceeded'),
            rejected: () => this.limits.diagnostics?.record('limitRejections'),
        });
        subscriptions.add(subscription);
        this.subscribers.set(key, subscriptions);
        return subscription;
    }

    private parseCursor(projectId: string, sessionId: string, cursor: string): number {
        const match = /^e2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
        if (!match) throw managedError('INVALID_REQUEST', 'The event cursor is invalid.');
        const body = `e2.${match[1]}.${match[2]}.${match[3]}`;
        const expected = createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
        if (
            !constantTimeStringEqual(expected, match[4])
            || Buffer.from(match[1], 'base64url').toString() !== projectId
            || Buffer.from(match[2], 'base64url').toString() !== sessionId
        ) {
            throw managedError('INVALID_REQUEST', 'The event cursor is invalid.');
        }
        const sequence = Number(match[3]);
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
            throw managedError('INVALID_REQUEST', 'The event cursor is invalid.');
        }
        return sequence;
    }
}

class ManagedSubscription implements EventSubscription {
    private readonly queue: ManagedEvent[] = [];
    private readonly readers: PendingReader[] = [];
    private closed = false;
    private overflowed = false;

    constructor(
        private sequence: number,
        private readonly capacity: number,
        private readonly onClose: () => void,
        private readonly reservePendingReader: () => () => void,
        private readonly longPollMilliseconds: number,
        private readonly diagnostics: {
            aborted(): void;
            deadline(): void;
            rejected(): void;
        },
    ) {}

    push(event: ManagedEvent): void {
        if (this.closed || event.sequence <= this.sequence) return;
        const reader = this.readers.shift();
        if (reader) {
            this.sequence = event.sequence;
            reader.resolve(event);
            return;
        }
        if (this.queue.length >= this.capacity) {
            this.queue.length = 0;
            this.overflowed = true;
            return;
        }
        this.queue.push(event);
    }

    async next(signal?: AbortSignal): Promise<ManagedEvent> {
        if (this.closed) throw managedError('EVENT_CURSOR_EXPIRED', 'The event subscription is closed.');
        if (this.overflowed) {
            throw managedError(
                'EVENT_CURSOR_EXPIRED',
                'The event subscriber exceeded its backpressure capacity.',
            );
        }
        const event = this.queue.shift();
        if (event) {
            this.sequence = event.sequence;
            return event;
        }
        if (this.readers.length > 0) {
            this.diagnostics.rejected();
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'Only one pending event read is allowed per subscription.',
                true,
            );
        }
        if (
            !Number.isSafeInteger(this.longPollMilliseconds)
            || this.longPollMilliseconds <= 0
            || this.longPollMilliseconds > 5 * 60 * 1000
        ) {
            throw managedError('INVALID_REQUEST', 'The event long-poll duration is invalid.');
        }
        const releasePending = this.reservePendingReader();
        return new Promise<ManagedEvent>((resolve, reject) => {
            const readers = this.readers;
            const timer = setTimeout(() => {
                const index = readers.indexOf(reader);
                if (index >= 0) readers.splice(index, 1);
                signal?.removeEventListener('abort', abort);
                releasePending();
                this.diagnostics.deadline();
                reject(managedError(
                    'COORDINATOR_UNAVAILABLE',
                    'The managed event long poll timed out.',
                    true,
                ));
            }, this.longPollMilliseconds);
            timer.unref?.();
            const abort = () => {
                const index = readers.indexOf(reader);
                if (index >= 0) readers.splice(index, 1);
                clearTimeout(timer);
                releasePending();
                this.diagnostics.aborted();
                reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            const reader: PendingReader = {
                resolve: (next) => {
                    signal?.removeEventListener('abort', abort);
                    clearTimeout(timer);
                    releasePending();
                    resolve(next);
                },
                reject: (error) => {
                    signal?.removeEventListener('abort', abort);
                    clearTimeout(timer);
                    releasePending();
                    reject(error);
                },
            };
            if (signal?.aborted) return abort();
            signal?.addEventListener('abort', abort, { once: true });
            this.readers.push(reader);
        });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const reader of this.readers.splice(0)) {
            reader.reject(managedError('EVENT_CURSOR_EXPIRED', 'The event subscription is closed.'));
        }
        this.onClose();
    }
}

function scopeKey(projectId: string, sessionId: string): string {
    return `${projectId}\0${sessionId}`;
}
