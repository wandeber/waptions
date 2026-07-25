import { afterEach, describe, expect, it } from 'vitest';
import { ManagedCoordinator } from './managed-coordinator';
import { fakeEditorPortFactory, fakeSnapshot } from '../testing/fake-editor-port';
import { mutationRequest, temporaryRuntime } from '../testing/runtime-test-helpers';
import type { PersistenceFaultInjector } from '../persistence/fs-durable';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('ManagedCoordinator', () => {
    it('enforces one coordinator authority per data root', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const first = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        await expect(
            ManagedCoordinator.start(runtime.path, fakeEditorPortFactory),
        ).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });
        await first.close();
        const replacement = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(replacement.epoch).not.toBe(first.epoch);
        await replacement.close();
    });

    it('replays a lost response before stale epoch and revision guards after restart', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let fired = false;
        const injector: PersistenceFaultInjector = {
            hit: (point) => {
                if (!fired && point === 'transaction:cleaned') {
                    fired = true;
                    throw new Error('lost response');
                }
            },
        };
        const first = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory, {
            persistenceFaultInjector: injector,
        });
        const created = await first.createSession('Retry test', fakeSnapshot(), {
            projectId: 'retry-project',
            sessionId: 'retry-session',
        });
        const request = mutationRequest(created.state, 'same-key', { append: 'once' });
        const lost = await first.mutateEditor('retry-project', request);
        expect(lost.ok).toBe(false);
        await first.close();

        const recovered = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const replay = await recovered.mutateEditor('retry-project', request);
        expect(replay.ok).toBe(true);
        if (replay.ok) {
            expect(replay.data).toMatchObject({ appended: 'once', replayed: true });
            expect(replay.state.sessionEpoch).not.toBe(request.sessionEpoch);
            expect(replay.state.sessionRevision).toBe(2);
        }
        const recoveredProject = recovered.getProject('retry-project').envelope;
        expect(recoveredProject.editor.state.values).toEqual(['once']);
        expect(recoveredProject.recoveryCount).toBe(1);
        expect(recoveredProject.lastCoordinatorEpoch).toBe(recovered.epoch);
        const recoveryEvents = await recovered.events.read(
            'retry-project',
            'retry-session',
            undefined,
        );
        expect(recoveryEvents.events.at(-1)?.kind).toBe('session.recovered');
        await recovered.close();
    });

    it('serializes concurrent clients and rejects the stale second mutation', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Concurrency', fakeSnapshot(), {
            projectId: 'concurrent-project',
            sessionId: 'concurrent-session',
        });
        const [first, second] = await Promise.all([
            coordinator.mutateEditor(
                'concurrent-project',
                mutationRequest(created.state, 'client-one', { append: 'one' }),
            ),
            coordinator.mutateEditor(
                'concurrent-project',
                mutationRequest(created.state, 'client-two', { append: 'two' }),
            ),
        ]);
        expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
        const rejected = first.ok ? second : first;
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.error.code).toBe('SESSION_REVISION_CONFLICT');
        expect(coordinator.getProject('concurrent-project').envelope.editor.state.values).toHaveLength(1);
        await coordinator.close();
    });

    it('rejects reuse of an idempotency key with a different canonical request before guards', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Conflict', fakeSnapshot(), {
            projectId: 'conflict-project',
            sessionId: 'conflict-session',
        });
        const first = mutationRequest(created.state, 'duplicate', { append: 'one' });
        expect((await coordinator.mutateEditor('conflict-project', first)).ok).toBe(true);
        const conflict = await coordinator.mutateEditor('conflict-project', {
            ...first,
            sessionEpoch: 'stale-epoch',
            command: { append: 'different' },
        });
        expect(conflict.ok).toBe(false);
        if (!conflict.ok) expect(conflict.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
        await coordinator.close();
    });

    it('replays a path grant before touching a path that no longer exists', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Grant receipt', fakeSnapshot(), {
            projectId: 'grant-replay-project',
            sessionId: 'grant-replay-session',
        });
        const root = join(runtime.path, 'media');
        await mkdir(root);
        const request = mutationRequest(created.state, 'grant-replay') as never;
        const first = await coordinator.grantPath(
            'grant-replay-project',
            request,
            'read-root',
            root,
        );
        expect(first.ok).toBe(true);
        await rm(root, { recursive: true });
        const replay = await coordinator.grantPath(
            'grant-replay-project',
            request,
            'read-root',
            root,
        );
        expect(replay.ok).toBe(true);
        if (replay.ok) expect(replay.data.replayed).toBe(true);
        await coordinator.close();
    });

    it('replays an artifact receipt before consuming a replacement stream', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Artifact receipt', fakeSnapshot(), {
            projectId: 'artifact-replay-project',
            sessionId: 'artifact-replay-session',
        });
        const request = mutationRequest(created.state, 'artifact-replay') as never;
        const first = await coordinator.createArtifact('artifact-replay-project', request, {
            kind: 'contact-sheet',
            mediaType: 'image/png',
            source: Readable.from([Buffer.from('artifact')]),
        });
        expect(first.ok).toBe(true);
        let consumed = false;
        const replay = await coordinator.createArtifact('artifact-replay-project', request, {
            kind: 'contact-sheet',
            mediaType: 'image/png',
            source: (async function* replacement() {
                consumed = true;
                throw new Error('The replay consumed artifact bytes.');
            }()),
        });
        expect(replay.ok).toBe(true);
        if (replay.ok) expect(replay.data.replayed).toBe(true);
        expect(consumed).toBe(false);
        await coordinator.close();
    });
});
