import { afterEach, describe, expect, it } from 'vitest';
import { ManagedCoordinator } from './managed-coordinator';
import { evaluateSourceRelease } from './source-reachability';
import { fakeEditorPortFactory, fakeSnapshot } from '../testing/fake-editor-port';
import { mutationRequest, temporaryRuntime, testEnvelope } from '../testing/runtime-test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('managed session state', () => {
    it('keeps follow presence ephemeral while presenter authority is durable', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Presenter', fakeSnapshot(), {
            projectId: 'presenter-project',
            sessionId: 'presenter-session',
        });
        coordinator.presence.attach('presenter-project', 'view-a');
        coordinator.presence.update('view-a', { followPresenter: true });
        const result = await coordinator.updatePlayback(
            'presenter-project',
            mutationRequest(created.state, 'presenter') as never,
            0,
            { presenterViewId: 'view-a', playing: true, outputSample: 480 },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('The playback mutation failed.');
        const noOp = await coordinator.updatePlayback(
            'presenter-project',
            mutationRequest(result.state, 'presenter-no-op') as never,
            1,
            { presenterViewId: 'view-a', playing: true, outputSample: 480 },
        );
        expect(noOp.ok).toBe(true);
        if (!noOp.ok) throw new Error('The playback no-op failed.');
        expect(noOp.data.playback.revision).toBe(1);
        expect((await coordinator.events.read(
            'presenter-project',
            'presenter-session',
            undefined,
        )).events).toHaveLength(1);
        const stale = await coordinator.updatePlayback(
            'presenter-project',
            mutationRequest(noOp.state, 'presenter-stale') as never,
            0,
            { playing: false },
        );
        expect(stale).toMatchObject({
            ok: false,
            error: { code: 'REVISION_CONFLICT', retryable: true },
        });
        expect(coordinator.presence.list('presenter-project')[0].followPresenter).toBe(true);
        coordinator.presence.detach('view-a');
        expect(coordinator.getProject('presenter-project').envelope.playback.presenterViewId).toBe('view-a');
        await coordinator.close();

        const recovered = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(recovered.presence.list('presenter-project')).toEqual([]);
        expect(recovered.getProject('presenter-project').envelope.playback).toMatchObject({
            presenterViewId: 'view-a',
            playing: true,
            outputSample: 480,
        });
        await recovered.close();
    });

    it('detaches only views owned by the last connection for one participant', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        coordinator.bindParticipant('connection-a', 'participant-a');
        coordinator.bindParticipant('connection-b', 'participant-a');
        coordinator.bindParticipant('connection-c', 'participant-b');
        coordinator.presence.attach('project-a', 'view-a', 'participant-a');
        coordinator.presence.attach('project-a', 'view-b', 'participant-b');

        expect(coordinator.detachConnection('connection-a')).toEqual([]);
        expect(coordinator.presence.list('project-a').map((view) => view.viewId))
            .toEqual(['view-a', 'view-b']);
        expect(coordinator.detachConnection('connection-b')).toEqual(['view-a']);
        expect(coordinator.presence.list('project-a').map((view) => view.viewId))
            .toEqual(['view-b']);
        expect(coordinator.participantForConnection('connection-c')).toBe('participant-b');
        await coordinator.close();
    });

    it('retains sources rooted by editor history, jobs, and receipts during GC planning', () => {
        const envelope = {
            ...testEnvelope('gc-project'),
            editor: {
                ...fakeSnapshot(),
                reachableSourceIds: ['document-source'],
            },
            sourceRegistry: [
                'artifact-source',
                'document-source',
                'job-source',
                'receipt-source',
                'unused-source',
            ].map(
                (sourceId) => ({
                    sourceId,
                    immutableVersion: 'v1',
                    byteLength: 1,
                    digest: `sha256:${sourceId}`,
                    streamSignature: `stream:${sourceId}`,
                    registeredAt: new Date().toISOString(),
                }),
            ),
        };
        const plan = evaluateSourceRelease(
            envelope,
            [{ state: 'running', input: { sourceId: 'job-source' } }],
            [{
                schemaVersion: 2,
                projectId: envelope.projectId,
                toolName: 'test',
                idempotencyKey: 'key',
                canonicalRequestHash: `sha256:${'2'.repeat(64)}`,
                result: {},
                committedSessionRevision: 1,
                createdAt: new Date().toISOString(),
                retainedSourceIds: ['receipt-source'],
            }],
            [{ sourceIds: ['artifact-source'] }],
        );
        expect(plan.releasableSourceIds).toEqual(['unused-source']);
        expect(plan.retained.map((source) => source.sourceId)).toEqual([
            'artifact-source',
            'document-source',
            'job-source',
            'receipt-source',
        ]);
    });
});
