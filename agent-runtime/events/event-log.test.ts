import { afterEach, describe, expect, it } from 'vitest';
import { ManagedEventLog, type ManagedEvent } from './event-log';
import { ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { temporaryRuntime, testEnvelope } from '../testing/runtime-test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('ManagedEventLog', () => {
    it('reports retained-history gaps and subscriber backpressure', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        let envelope = testEnvelope('events-project');
        await store.createProject(envelope);
        const log = new ManagedEventLog(store, Buffer.alloc(32, 4), 2, Number.MAX_SAFE_INTEGER, 1);
        const events: ManagedEvent[] = [];
        for (let sequence = 1; sequence <= 4; sequence += 1) {
            const event: ManagedEvent = {
                schemaVersion: 1,
                cursor: log.cursor(envelope.projectId, envelope.sessionId, sequence),
                type: 'project.changed',
                occurredAt: new Date().toISOString(),
                sequence,
                state: {
                    sessionId: envelope.sessionId,
                    projectId: envelope.projectId,
                    sessionEpoch: 'event-test-epoch',
                    sessionRevision: sequence,
                    documentRevision: envelope.editor.documentRevision,
                    audioGraphRevision: envelope.editor.audioGraphRevision,
                    eventCursor: log.cursor(envelope.projectId, envelope.sessionId, sequence),
                },
                data: { sequence },
            };
            events.push(event);
            const next = {
                ...envelope,
                eventSequence: sequence,
                sessionRevision: sequence,
            };
            await store.transact({
                baseSessionRevision: envelope.sessionRevision,
                envelope: next,
                writes: [log.write(event)],
            });
            envelope = next;
        }
        await store.transact({
            baseSessionRevision: envelope.sessionRevision,
            envelope: { ...envelope, sessionRevision: envelope.sessionRevision + 1 },
            writes: await log.retentionDeletes(envelope.projectId),
        });
        await expect(log.read(
            envelope.projectId,
            envelope.sessionId,
            log.cursor(envelope.projectId, envelope.sessionId, 0),
        )).rejects.toMatchObject({
            code: 'EVENT_CURSOR_EXPIRED',
        });
        const page = await log.read(
            envelope.projectId,
            envelope.sessionId,
            log.cursor(envelope.projectId, envelope.sessionId, 2),
        );
        expect(page.events.map((event) => event.sequence)).toEqual([3, 4]);

        const subscription = log.subscribe(envelope.projectId, envelope.sessionId);
        log.publish(events[0]);
        log.publish(events[1]);
        await expect(subscription.next()).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
        subscription.close();

        const scopedCursor = log.cursor(envelope.projectId, envelope.sessionId, 4);
        await expect(log.read('other-project', 'other-session', scopedCursor)).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });

        const abortable = log.subscribe(envelope.projectId, envelope.sessionId);
        const controller = new AbortController();
        const aborted = abortable.next(controller.signal);
        controller.abort();
        await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
        log.publish(events[0]);
        await expect(abortable.next()).resolves.toMatchObject({ sequence: 1 });
        abortable.close();
    });

    it('bounds subscriptions, pending reads, and long-poll lifetime', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const log = new ManagedEventLog(
            store,
            Buffer.alloc(32, 5),
            undefined,
            undefined,
            undefined,
            {
                maximumSubscriptionsPerScope: 2,
                maximumSubscriptionsGlobal: 2,
                maximumPendingReadersGlobal: 1,
                longPollMilliseconds: 20,
            },
        );
        const first = log.subscribe('project', 'session');
        const second = log.subscribe('project', 'session');
        expect(() => log.subscribe('project', 'session')).toThrowError(expect.objectContaining({
            code: 'COORDINATOR_UNAVAILABLE',
        }));

        const pending = first.next();
        await expect(first.next()).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });
        await expect(second.next()).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });
        await expect(pending).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });

        first.close();
        const replacement = log.subscribe('project', 'session');
        replacement.close();
        second.close();
    });
});
