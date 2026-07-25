import { afterEach, describe, expect, it } from 'vitest';
import { ManagedCoordinator } from '../coordinator/managed-coordinator';
import { fakeEditorPortFactory, fakeSnapshot } from '../testing/fake-editor-port';
import { mutationRequest, temporaryRuntime } from '../testing/runtime-test-helpers';
import { attachManagedCoordinator, ManagedCoordinatorService } from './managed-coordinator-service';
import { access } from 'node:fs/promises';
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
        expect(firstAttachment.discovery.controlEndpoint.kind).toBe('socket');
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
