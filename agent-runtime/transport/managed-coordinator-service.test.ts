import { afterEach, describe, expect, it } from 'vitest';
import { ManagedCoordinator } from '../coordinator/managed-coordinator';
import { fakeEditorPortFactory, fakeSnapshot } from '../testing/fake-editor-port';
import { mutationRequest, temporaryRuntime } from '../testing/runtime-test-helpers';
import { attachManagedCoordinator, ManagedCoordinatorService } from './managed-coordinator-service';
import {
    access,
    chmod,
    readFile,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('ManagedCoordinatorService', () => {
    it('remains authoritative after an stdio-style client disconnect and accepts a reconnect', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Detached authority', fakeSnapshot(), {
            projectId: 'service-project',
            sessionId: 'service-session',
        });
        const service = await ManagedCoordinatorService.start(
            runtime.path,
            coordinator,
            async (request) => {
                if (request.method === 'mutate') {
                    return coordinator.mutateEditor(
                        'service-project',
                        request.params as ReturnType<typeof mutationRequest>,
                    );
                }
                if (request.method === 'get') return coordinator.getProject('service-project');
                throw new Error('Unknown test method.');
            },
        );

        const firstAttachment = await attachManagedCoordinator(runtime.path);
        expect(firstAttachment.discovery.controlEndpoint.kind).toBe('unix-socket');
        expect(firstAttachment.discovery.httpBridgeEndpoint).toBeUndefined();
        const mutation = await firstAttachment.client.request(
            'mutate',
            mutationRequest(created.state, 'detached-edit', { append: 'survives' }),
        ) as { ok: boolean };
        expect(mutation.ok).toBe(true);
        firstAttachment.client.close();

        const secondAttachment = await attachManagedCoordinator(runtime.path);
        expect(secondAttachment.discovery.epoch).toBe(firstAttachment.discovery.epoch);
        const current = await secondAttachment.client.request('get') as {
            envelope: { sessionRevision: number; editor: { state: { values: string[] } } };
        };
        expect(current.envelope.sessionRevision).toBe(1);
        expect(current.envelope.editor.state.values).toEqual(['survives']);
        secondAttachment.client.close();
        await service.close();
    });

    it('shuts down idle only after a committed edit and recovers it on service restart', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Idle recovery', fakeSnapshot(), {
            projectId: 'idle-project',
            sessionId: 'idle-session',
        });
        await coordinator.mutateEditor(
            'idle-project',
            mutationRequest(created.state, 'idle-edit', { append: 'durable' }),
        );
        const service = await ManagedCoordinatorService.start(
            runtime.path,
            coordinator,
            async () => coordinator.getProject('idle-project'),
            { idleShutdownMilliseconds: 5 },
        );
        const attachment = await attachManagedCoordinator(runtime.path);
        attachment.client.close();
        await waitForMissing(join(runtime.path, 'coordinator', 'service.json'));

        const restarted = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(restarted.getProject('idle-project').envelope.editor.state.values).toEqual(['durable']);
        expect(restarted.getProject('idle-project').envelope.recoveryCount).toBe(1);
        await restarted.close();
        await service.close();
    });

    it('does not idle-shutdown while a disconnected handler is still in flight', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        let started!: () => void;
        const handlerStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        let finish!: () => void;
        const handlerFinished = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const service = await ManagedCoordinatorService.start(
            runtime.path,
            coordinator,
            async () => {
                started();
                await handlerFinished;
                return { complete: true };
            },
            { idleShutdownMilliseconds: 5 },
        );
        const attachment = await attachManagedCoordinator(runtime.path);
        const request = attachment.client.request('slow').catch(() => undefined);
        await handlerStarted;
        attachment.client.close();
        await new Promise((resolve) => setTimeout(resolve, 30));
        await expect(access(join(runtime.path, 'coordinator', 'service.json'))).resolves.toBeUndefined();

        finish();
        await request;
        await waitForMissing(join(runtime.path, 'coordinator', 'service.json'));
        await service.close();
    });

    it('rejects discovery files whose owner-only permissions were widened', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(
            runtime.path,
            fakeEditorPortFactory,
        );
        const service = await ManagedCoordinatorService.start(
            runtime.path,
            coordinator,
            async () => coordinator.getProject('missing-project'),
        );
        const path = join(runtime.path, 'coordinator', 'service.json');
        await chmod(path, 0o644);
        await expect(attachManagedCoordinator(runtime.path)).rejects.toThrow(
            'identity',
        );
        await chmod(path, 0o600);
        await service.close();
    });

    it('replaces stale discovery even when its PID has been reused', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const firstCoordinator = await ManagedCoordinator.start(
            runtime.path,
            fakeEditorPortFactory,
        );
        const firstService = await ManagedCoordinatorService.start(
            runtime.path,
            firstCoordinator,
            async () => ({ first: true }),
        );
        const path = join(runtime.path, 'coordinator', 'service.json');
        const staleDiscovery = await readFile(path);
        await firstService.close();
        await writeFile(path, staleDiscovery, { mode: 0o600 });

        const secondCoordinator = await ManagedCoordinator.start(
            runtime.path,
            fakeEditorPortFactory,
        );
        const secondService = await ManagedCoordinatorService.start(
            runtime.path,
            secondCoordinator,
            async () => ({ second: true }),
        );
        const attachment = await attachManagedCoordinator(runtime.path);
        await expect(attachment.client.request('probe')).resolves.toEqual({
            second: true,
        });
        attachment.client.close();
        await secondService.close();
    });

    it('does not classify a live service at its connection cap as stale', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(
            runtime.path,
            fakeEditorPortFactory,
        );
        const service = await ManagedCoordinatorService.start(
            runtime.path,
            coordinator,
            async () => ({ live: true }),
            { transport: { maxConnections: 1 } },
        );
        const path = join(runtime.path, 'coordinator', 'service.json');
        const first = await attachManagedCoordinator(runtime.path);
        const published = await readFile(path);

        await expect(ManagedCoordinatorService.start(
            runtime.path,
            {
                epoch: 'competing-epoch',
                canGracefullyShutdown: () => true,
                close: async () => undefined,
            },
            async () => ({ competing: true }),
        )).rejects.toThrow('connection closed');
        await expect(readFile(path)).resolves.toEqual(published);
        await expect(first.client.request('probe')).resolves.toEqual({ live: true });

        first.client.close();
        await service.close();
    });

    it('serializes concurrent service publication and preserves the winner', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const services = ['publisher-a', 'publisher-b'].map((epoch) => (
            ManagedCoordinatorService.start(
                runtime.path,
                {
                    epoch,
                    canGracefullyShutdown: () => true,
                    close: async () => undefined,
                },
                async () => ({ epoch }),
            )
        ));

        const results = await Promise.allSettled(services);
        const fulfilled = results.filter(
            (result): result is PromiseFulfilledResult<ManagedCoordinatorService> => (
                result.status === 'fulfilled'
            ),
        );
        const rejected = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({
            code: 'COORDINATOR_UNAVAILABLE',
        });

        const attachment = await attachManagedCoordinator(runtime.path);
        const reply = await attachment.client.request('probe') as { epoch: string };
        expect(reply.epoch).toBe(attachment.discovery.epoch);
        attachment.client.close();
        await fulfilled[0]!.value.close();
    });
});

async function waitForMissing(path: string, timeoutMilliseconds = 3_000): Promise<void> {
    const started = Date.now();
    while (true) {
        try {
            await access(path);
        } catch {
            return;
        }
        if (Date.now() - started > timeoutMilliseconds) {
            throw new Error('Timed out waiting for idle coordinator shutdown.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
