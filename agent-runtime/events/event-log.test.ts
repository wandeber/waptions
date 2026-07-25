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
                projectId: envelope.projectId,
                sessionId: envelope.sessionId,
                sequence,
                kind: 'project.changed',
                createdAt: new Date().toISOString(),
                sessionRevision: sequence,
                summary: { sequence },
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
});
