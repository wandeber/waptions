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
            { presenterViewId: 'view-a', playing: true, outputSample: 480 },
        );
        expect(result.ok).toBe(true);
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
                    readGrantId: `grant-${sourceId}`,
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
