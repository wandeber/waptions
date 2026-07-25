import { createHmac } from 'node:crypto';
import { managedError } from '../coordinator/errors';
import type { DurableWrite, ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { canonicalJson, constantTimeStringEqual } from '../persistence/canonical-json';

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

export interface ManagedEvent {
    schemaVersion: 1;
    projectId: string;
    sessionId: string;
    sequence: number;
    kind: ManagedEventKind;
    createdAt: string;
    sessionRevision: number;
    summary: Readonly<Record<string, string | number | boolean | null>>;
}

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

export class ManagedEventLog {
    private readonly subscribers = new Map<string, Set<ManagedSubscription>>();

    constructor(
        private readonly store: ManagedFilesystemStore,
        private readonly cursorSecret: Uint8Array,
        private readonly retentionCount = DEFAULT_RETENTION_COUNT,
        private readonly retentionMilliseconds = DEFAULT_RETENTION_MILLISECONDS,
        private readonly subscriptionCapacity = 256,
    ) {}

    cursor(projectId: string, sessionId: string, sequence: number): string {
        const project = Buffer.from(projectId).toString('base64url');
        const session = Buffer.from(sessionId).toString('base64url');
        const body = `e2.${project}.${session}.${sequence}`;
        const signature = createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
        return `${body}.${signature}`;
    }

    write(event: ManagedEvent): DurableWrite {
        canonicalJson(event.summary, 16 * 1024);
        return {
            relativePath: `events/${event.sequence.toString().padStart(16, '0')}.json`,
            value: event,
        };
    }

    async retentionDeletes(projectId: string, now = Date.now()): Promise<DurableWrite[]> {
        const events = await this.store.readNamespace<ManagedEvent>(projectId, 'events');
        const minimumTime = now - this.retentionMilliseconds;
        const retained = events
            .filter((event) => Date.parse(event.createdAt) >= minimumTime)
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
        for (const subscription of Array.from(this.subscribers.get(scopeKey(event.projectId, event.sessionId)) ?? [])) {
            subscription.push(event);
        }
    }

    subscribe(projectId: string, sessionId: string, afterCursor?: string): EventSubscription {
        const sequence = afterCursor ? this.parseCursor(projectId, sessionId, afterCursor) : 0;
        const key = scopeKey(projectId, sessionId);
        const subscription = new ManagedSubscription(sequence, this.subscriptionCapacity, () => {
            const projectSubscriptions = this.subscribers.get(key);
            projectSubscriptions?.delete(subscription);
            if (projectSubscriptions?.size === 0) this.subscribers.delete(key);
        });
        const subscriptions = this.subscribers.get(key) ?? new Set<ManagedSubscription>();
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
        return new Promise<ManagedEvent>((resolve, reject) => {
            const readers = this.readers;
            function abort() {
                const index = readers.indexOf(reader);
                if (index >= 0) readers.splice(index, 1);
                reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            }
            const reader: PendingReader = {
                resolve: (next) => {
                    signal?.removeEventListener('abort', abort);
                    resolve(next);
                },
                reject,
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
