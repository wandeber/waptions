import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedCoordinator } from './managed-coordinator';
import { fakeEditorPortFactory, fakeSnapshot } from '../testing/fake-editor-port';
import { mutationRequest, temporaryRuntime } from '../testing/runtime-test-helpers';
import type { PersistenceFaultInjector } from '../persistence/fs-durable';
import { canonicalDigest } from '../persistence/canonical-json';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type {
    ManagedEditorPortFactory,
    ManagedEditorSnapshot,
} from './managed-editor-port';

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
        const immediateReplay = await first.mutateEditor('retry-project', request);
        expect(immediateReplay.ok).toBe(true);
        if (immediateReplay.ok) {
            expect(immediateReplay.data.replayed).toBe(true);
            expect(immediateReplay.state.sessionRevision).toBe(1);
        }
        const receipt = await first.store.readReceipt(
            'retry-project',
            request.toolName,
            request.idempotencyKey,
        );
        expect(receipt?.canonicalRequestHash).toBe(request.canonicalRequestHash);
        const mutationEvents = await first.events.read(
            'retry-project',
            'retry-session',
            undefined,
        );
        expect(mutationEvents.events[0]).toMatchObject({
            cursor: immediateReplay.ok ? immediateReplay.state.eventCursor : undefined,
            type: 'project.changed',
            state: immediateReplay.ok ? immediateReplay.state : undefined,
            data: {
                action: 'append test value',
                toolName: request.toolName,
            },
        });
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
        expect(recoveryEvents.events.at(-1)).toMatchObject({
            type: 'session.recovered',
            state: replay.ok ? replay.state : undefined,
            data: {
                previousEpoch: first.epoch,
                newEpoch: recovered.epoch,
                outcome: 'clean',
                interruptedJobIds: [],
            },
        });
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
            canonicalRequestHash: canonicalDigest({
                method: 'waptions_test_append',
                command: { append: 'different' },
            }),
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
            sourceIdentity: 'sha256:test-artifact',
        });
        expect(first.ok).toBe(true);
        let consumed = false;
        const replay = await coordinator.createArtifact('artifact-replay-project', request, {
            kind: 'contact-sheet',
            mediaType: 'image/png',
            sourceIdentity: 'sha256:test-artifact',
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

    it('binds registry receipts to effective path arguments before path access', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Receipt binding', fakeSnapshot(), {
            projectId: 'effective-receipt-project',
            sessionId: 'effective-receipt-session',
        });
        const firstPath = join(runtime.path, 'first-path');
        const absentPath = join(runtime.path, 'absent-path');
        await mkdir(firstPath);
        const baseRequest = mutationRequest(created.state, 'effective-receipt');
        const request = {
            ...baseRequest,
            canonicalRequestHash: canonicalDigest({
                method: 'waptions_path_grant',
                kind: 'read-root',
                path: firstPath,
            }),
        };
        expect((await coordinator.grantPath(
            'effective-receipt-project',
            request,
            'read-root',
            firstPath,
        )).ok).toBe(true);
        const conflict = await coordinator.grantPath(
            'effective-receipt-project',
            {
                ...request,
                canonicalRequestHash: canonicalDigest({
                    method: 'waptions_path_grant',
                    kind: 'read-root',
                    path: absentPath,
                }),
            },
            'read-root',
            absentPath,
        );
        expect(conflict.ok).toBe(false);
        if (!conflict.ok) expect(conflict.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
        await coordinator.close();
    });

    it('validates adapter acceptance before creating durable session state', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const rejectingFactory = {
            create: async (...args: Parameters<typeof fakeEditorPortFactory.create>) => {
                if (args[0].manifestDigest === 'rejected') {
                    throw new Error('Adapter rejected snapshot.');
                }
                return fakeEditorPortFactory.create(...args);
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, rejectingFactory);
        await expect(coordinator.createSession(
            'Rejected',
            { ...fakeSnapshot(), manifestDigest: 'rejected' },
            { projectId: 'rejected-project', sessionId: 'rejected-session' },
        )).rejects.toThrow('Adapter rejected snapshot.');
        expect(await coordinator.store.readProject('rejected-project')).toBeNull();
        await coordinator.close();

        const restarted = await ManagedCoordinator.start(runtime.path, rejectingFactory);
        expect(restarted.listSessions()).toEqual([]);
        await restarted.close();
    });

    it('does not publish a recovery revision before a durable snapshot passes adapter hydration', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const first = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        await first.createSession('Recovery validation', fakeSnapshot(), {
            projectId: 'recovery-validation-project',
            sessionId: 'recovery-validation-session',
        });
        await first.close();

        const rejectingFactory: ManagedEditorPortFactory<
            unknown,
            unknown,
            Record<string, unknown>
        > = {
            create: async () => {
                throw new Error('Recovered snapshot rejected.');
            },
        };
        await expect(
            ManagedCoordinator.start(runtime.path, rejectingFactory),
        ).rejects.toThrow('Recovered snapshot rejected.');
        expect(
            (await first.store.readProject('recovery-validation-project'))?.sessionRevision,
        ).toBe(0);

        const recovered = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(recovered.getProject('recovery-validation-project').envelope.recoveryCount).toBe(1);
        await recovered.close();
    });

    it('quarantines unauthenticated legacy grants in the recovery transaction', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const first = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        await first.createSession('Legacy grant recovery', fakeSnapshot(), {
            projectId: 'legacy-grant-project',
            sessionId: 'legacy-grant-session',
        });
        const legacyGrant = {
            schemaVersion: 1,
            grantId: 'legacy-grant',
            sessionId: 'legacy-grant-session',
            kind: 'read-root',
            canonicalPath: runtime.path,
            createdAt: new Date().toISOString(),
        };
        await writeFile(
            first.store.projectPath(
                'legacy-grant-project',
                'grants',
                `${legacyGrant.grantId}.json`,
            ),
            `${JSON.stringify(legacyGrant)}\n`,
        );
        await first.close();

        const recovered = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(
            await recovered.store.readNamespace('legacy-grant-project', 'grants'),
        ).toEqual([]);
        expect(recovered.getProject('legacy-grant-project').envelope.grantRevision).toBe(1);
        await recovered.close();

        const restarted = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(restarted.getProject('legacy-grant-project').envelope.grantRevision).toBe(1);
        await restarted.close();
    });

    it('fails closed when an editor adapter returns without exactly one commit', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let dispatches = 0;
        const factory: ManagedEditorPortFactory<
            { values: readonly string[] },
            { append: string },
            { claimed: boolean }
        > = {
            create: async (initial) => {
                let current: ManagedEditorSnapshot<{ values: readonly string[] }> = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async () => {
                        dispatches += 1;
                        return { claimed: true };
                    },
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession('No commit', fakeSnapshot(), {
            projectId: 'no-commit-project',
            sessionId: 'no-commit-session',
        });
        const request = mutationRequest(created.state, 'no-commit');
        const result = await coordinator.mutateEditor('no-commit-project', request);
        expect(result.ok).toBe(false);
        expect(dispatches).toBe(1);
        expect((await coordinator.store.readProject('no-commit-project'))?.sessionRevision).toBe(0);
        expect(await coordinator.store.readReceipt(
            'no-commit-project',
            request.toolName,
            request.idempotencyKey,
        )).toBeNull();
        await coordinator.close();
    });

    it('uses one persistence transaction for a valid editor mutation', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Single commit', fakeSnapshot(), {
            projectId: 'single-commit-project',
            sessionId: 'single-commit-session',
        });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const result = await coordinator.mutateEditor(
            'single-commit-project',
            mutationRequest(created.state, 'single-commit', { append: 'once' }),
        );
        expect(result.ok).toBe(true);
        expect(transact).toHaveBeenCalledTimes(1);
        await coordinator.close();
    });

    it('rejects an invalid adapter transition before any durable mutation', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const factory: ManagedEditorPortFactory<
            { values: readonly string[] },
            { append: string },
            { fraction: number }
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ request }) => {
                        const next = {
                            ...current,
                            documentRevision: current.documentRevision + 1,
                            historyRevision: current.historyRevision + 1,
                        };
                        const result = { fraction: Number.NaN };
                        await persistence.commit({
                            request,
                            baseDocumentRevision: current.documentRevision,
                            next,
                            result,
                            semanticLabel: 'invalid-result',
                        });
                        current = next;
                        return result;
                    },
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession('Invalid adapter', fakeSnapshot(), {
            projectId: 'invalid-adapter-project',
            sessionId: 'invalid-adapter-session',
        });
        const result = await coordinator.mutateEditor(
            'invalid-adapter-project',
            mutationRequest(created.state, 'invalid-adapter') as never,
        );
        expect(result.ok).toBe(false);
        expect((await coordinator.store.readProject('invalid-adapter-project'))?.sessionRevision).toBe(0);
        await coordinator.close();

        const restarted = await ManagedCoordinator.start(runtime.path, factory);
        expect(restarted.getProject('invalid-adapter-project').envelope.sessionRevision).toBe(1);
        await restarted.close();
    });

    it('returns the authoritative durable result when Core misbehaves after committing', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const factory: ManagedEditorPortFactory<
            { values: readonly string[] },
            { append: string },
            { claimed: boolean }
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ request }) => {
                        const next = {
                            ...current,
                            documentRevision: current.documentRevision + 1,
                            historyRevision: current.historyRevision + 1,
                            state: { values: [...current.state.values, request.command.append] },
                        };
                        await persistence.commit({
                            request,
                            baseDocumentRevision: current.documentRevision,
                            next,
                            result: { claimed: true },
                            semanticLabel: 'committed-before-adapter-failure',
                        });
                        current = next;
                        throw new Error('Core failed after commit.');
                    },
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession('Post-commit authority', fakeSnapshot(), {
            projectId: 'post-commit-project',
            sessionId: 'post-commit-session',
        });
        const request = mutationRequest(created.state, 'post-commit', { append: 'once' });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const result = await coordinator.mutateEditor('post-commit-project', request);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data).toMatchObject({ claimed: true, replayed: false });
            expect(result.warnings).toHaveLength(1);
        }
        expect(transact).toHaveBeenCalledTimes(1);
        expect((await coordinator.store.readProject('post-commit-project'))?.sessionRevision).toBe(1);
        expect(await coordinator.store.readReceipt(
            'post-commit-project',
            request.toolName,
            request.idempotencyKey,
        )).not.toBeNull();
        await coordinator.close();
    });

    it('rehydrates the committed head when Core throws before publishing it in memory', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let throwAfterCommit = true;
        const factory: ManagedEditorPortFactory<
            { values: readonly string[] },
            { append: string },
            { appended: string }
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ command, request }) => {
                        const next = {
                            ...current,
                            state: { values: [...current.state.values, command.append] },
                            documentRevision: current.documentRevision + 1,
                            historyRevision: current.historyRevision + 1,
                            manifestDigest: `fake:${[...current.state.values, command.append].join(',')}`,
                        };
                        const result = { appended: command.append };
                        await persistence.commit({
                            request,
                            baseDocumentRevision: current.documentRevision,
                            next,
                            result,
                            semanticLabel: 'append before publication',
                        });
                        if (throwAfterCommit) {
                            throwAfterCommit = false;
                            throw new Error('Core failed before publishing its in-memory head.');
                        }
                        current = structuredClone(next);
                        return result;
                    },
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession('Post-commit hydration', fakeSnapshot(), {
            projectId: 'post-commit-hydration-project',
            sessionId: 'post-commit-hydration-session',
        });
        const first = await coordinator.mutateEditor(
            'post-commit-hydration-project',
            mutationRequest(created.state, 'post-commit-hydration-one', { append: 'one' }),
        );
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error('The first mutation did not commit.');
        const second = await coordinator.mutateEditor(
            'post-commit-hydration-project',
            mutationRequest(first.state, 'post-commit-hydration-two', { append: 'two' }),
        );
        expect(second.ok).toBe(true);
        expect(
            coordinator.getProject('post-commit-hydration-project').envelope.editor.state.values,
        ).toEqual(['one', 'two']);
        await coordinator.close();
    });

    it('atomically enqueues a job with its receipt, state, and typed event', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Atomic enqueue', fakeSnapshot(), {
            projectId: 'atomic-enqueue-project',
            sessionId: 'atomic-enqueue-session',
        });
        coordinator.jobs.register('review', {
            run: async () => ({ result: { reviewed: true } }),
        });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const request = mutationRequest(created.state, 'atomic-enqueue');
        const result = await coordinator.enqueueJob(
            'atomic-enqueue-project',
            request,
            {
                kind: 'review',
                input: { range: 'first-five' },
                inputDigest: `sha256:${'a'.repeat(64)}`,
                cancellable: true,
                resumable: true,
            },
        );
        expect(result.ok).toBe(true);
        const enqueueTransactions = transact.mock.calls
            .map(([input]) => input)
            .filter((input) => input.writes?.some((write) => write.relativePath.startsWith('receipts/')));
        expect(enqueueTransactions).toHaveLength(1);
        expect(enqueueTransactions[0]?.writes?.map((write) => write.relativePath)).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^jobs\/.+\.json$/),
                expect.stringMatching(/^receipts\/.+\.json$/),
                expect.stringMatching(/^events\/.+\.json$/),
            ]),
        );
        const receipt = await coordinator.store.readReceipt(
            'atomic-enqueue-project',
            request.toolName,
            request.idempotencyKey,
        );
        expect(receipt?.canonicalRequestHash).toBe(request.canonicalRequestHash);
        const queuedEvent = (await coordinator.events.read(
            'atomic-enqueue-project',
            'atomic-enqueue-session',
            undefined,
            20,
        )).events.find((event) => event.type === 'job.changed' && event.data.state === 'queued');
        expect(queuedEvent).toMatchObject({
            state: result.ok ? result.state : undefined,
            data: {
                kind: 'review',
                state: 'queued',
                jobSequence: 1,
                stage: 'queued',
            },
        });
        expect(queuedEvent?.cursor).toBe(queuedEvent?.state.eventCursor);
        if (result.ok) {
            await waitFor(() => coordinator.jobs.get(result.data.job.jobId)?.state === 'succeeded');
        }
        await coordinator.close();
    });

    it('atomically publishes terminal artifacts with the succeeded job and event', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Atomic terminal artifact', fakeSnapshot(), {
            projectId: 'atomic-terminal-project',
            sessionId: 'atomic-terminal-session',
        });
        coordinator.jobs.register('contact-sheet', {
            run: async () => {
                const staged = await coordinator.artifacts.stage(
                    'atomic-terminal-project',
                    'contact-sheet',
                    'image/png',
                    Readable.from([Buffer.from('bounded-contact-sheet')]),
                );
                return {
                    result: { generated: true },
                    artifactIds: [staged.record.artifactId],
                    terminalPublication: { artifacts: [staged] },
                };
            },
        });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const request = mutationRequest(created.state, 'atomic-terminal');
        const enqueued = await coordinator.enqueueJob(
            'atomic-terminal-project',
            request,
            {
                kind: 'contact-sheet',
                input: { samples: 5 },
                inputDigest: `sha256:${'b'.repeat(64)}`,
                cancellable: true,
                resumable: true,
            },
        );
        expect(enqueued.ok).toBe(true);
        if (!enqueued.ok) throw new Error('The job was not enqueued.');
        await waitFor(() => coordinator.jobs.get(enqueued.data.job.jobId)?.state === 'succeeded');

        const terminalTransactions = transact.mock.calls
            .map(([input]) => input)
            .filter((input) => (
                input.writes?.some((write) => write.relativePath.startsWith('artifacts/'))
                && input.writes.some((write) => (
                    write.relativePath === `jobs/${enqueued.data.job.jobId}.json`
                    && (write.value as { state?: string }).state === 'succeeded'
                ))
            ));
        expect(terminalTransactions).toHaveLength(1);
        expect(terminalTransactions[0]?.writes?.map((write) => write.relativePath)).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^artifacts\/.+\.json$/),
                `jobs/${enqueued.data.job.jobId}.json`,
                expect.stringMatching(/^events\/.+\.json$/),
            ]),
        );
        const terminal = coordinator.jobs.get(enqueued.data.job.jobId);
        expect(terminal?.resultArtifactIds).toHaveLength(1);
        expect(await coordinator.artifacts.list('atomic-terminal-project')).toHaveLength(1);
        const terminalEvent = (await coordinator.events.read(
            'atomic-terminal-project',
            'atomic-terminal-session',
            undefined,
            20,
        )).events.find((event) => event.data.state === 'succeeded');
        expect(terminalEvent).toMatchObject({
            type: 'job.changed',
            data: {
                jobId: enqueued.data.job.jobId,
                kind: 'contact-sheet',
                state: 'succeeded',
                stage: 'complete',
            },
        });
        expect(terminalEvent?.cursor).toBe(terminalEvent?.state.eventCursor);
        await coordinator.close();
    });

    it('atomically claims a recoverable output publication with the terminal job', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const target = join(runtime.path, 'atomic-output.mp4');
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Atomic terminal output', fakeSnapshot(), {
            projectId: 'atomic-output-project',
            sessionId: 'atomic-output-session',
        });
        const granted = await coordinator.grantPath(
            'atomic-output-project',
            mutationRequest(created.state, 'atomic-output-grant'),
            'create-only-destination',
            target,
        );
        expect(granted.ok).toBe(true);
        if (!granted.ok) throw new Error('The output destination was not granted.');
        coordinator.jobs.register('export', {
            run: async () => {
                const staged = await coordinator.pathGrants.stageCreate(
                    granted.data.grant.grantId,
                    {
                        sessionId: 'atomic-output-session',
                        sessionEpoch: coordinator.epoch,
                    },
                );
                await staged.handle.writeFile('complete-export');
                const output = await staged.commit();
                return {
                    result: { publicationId: output.record.publicationId },
                    terminalPublication: { artifacts: [], outputs: [output] },
                };
            },
        });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const enqueued = await coordinator.enqueueJob(
            'atomic-output-project',
            mutationRequest(granted.state, 'atomic-output-job'),
            {
                kind: 'export',
                input: {},
                inputDigest: `sha256:${'f'.repeat(64)}`,
                cancellable: true,
                resumable: true,
            },
        );
        expect(enqueued.ok).toBe(true);
        if (!enqueued.ok) throw new Error('The output job was not enqueued.');
        await waitFor(() => coordinator.jobs.get(enqueued.data.job.jobId)?.state === 'succeeded');

        const transaction = transact.mock.calls
            .map(([input]) => input)
            .find((input) => (
                input.writes?.some((write) => write.relativePath.startsWith('outputs/'))
                && input.writes.some((write) => (
                    write.relativePath === `jobs/${enqueued.data.job.jobId}.json`
                    && (write.value as { state?: string }).state === 'succeeded'
                ))
            ));
        expect(transaction?.writes?.map((write) => write.relativePath)).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^outputs\/.+\.json$/),
                `jobs/${enqueued.data.job.jobId}.json`,
                expect.stringMatching(/^events\/.+\.json$/),
            ]),
        );
        expect(await readFile(target, 'utf8')).toBe('complete-export');
        expect(await coordinator.pathGrants.recoverOutputPublication(
            granted.data.grant.grantId,
            'atomic-output-session',
        )).toBeNull();
        await coordinator.close();
    });

    it('removes rejected artifact publications immediately and across restart', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Artifact rejection', fakeSnapshot(), {
            projectId: 'artifact-rejection-project',
            sessionId: 'artifact-rejection-session',
        });
        const result = await coordinator.createArtifact(
            'artifact-rejection-project',
            mutationRequest(created.state, 'artifact-rejected') as never,
            {
                kind: '',
                mediaType: 'application/octet-stream',
                sourceIdentity: 'sha256:rejected',
                source: Readable.from([Buffer.from('must-not-publish')]),
            },
        );
        expect(result.ok).toBe(false);
        expect(await directoryEntries(join(
            runtime.path,
            'projects',
            'artifact-rejection-project',
            'artifacts',
            'blobs',
        ))).toEqual([]);
        await coordinator.close();
        const restarted = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(await directoryEntries(join(
            runtime.path,
            'projects',
            'artifact-rejection-project',
            'artifacts',
            'blobs',
        ))).toEqual([]);
        await restarted.close();
    });

    it('keeps a committed artifact through lost-response recovery without an orphan', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let fired = false;
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory, {
            persistenceFaultInjector: {
                hit: (point) => {
                    if (!fired && point === 'transaction:committed') {
                        fired = true;
                        throw new Error('lost artifact response');
                    }
                },
            },
        });
        const created = await coordinator.createSession('Artifact recovery', fakeSnapshot(), {
            projectId: 'artifact-recovery-project',
            sessionId: 'artifact-recovery-session',
        });
        const result = await coordinator.createArtifact(
            'artifact-recovery-project',
            mutationRequest(created.state, 'artifact-recovery') as never,
            {
                kind: 'contact-sheet',
                mediaType: 'image/png',
                sourceIdentity: 'sha256:durable-artifact',
                source: Readable.from([Buffer.from('durable-artifact')]),
            },
        );
        expect(result.ok).toBe(false);
        await coordinator.close();

        const restarted = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        expect(await restarted.artifacts.list('artifact-recovery-project')).toHaveLength(1);
        expect(await directoryEntries(join(
            runtime.path,
            'projects',
            'artifact-recovery-project',
            'artifacts',
            'blobs',
        ))).toHaveLength(1);
        await restarted.close();
    });

    it('recomputes source release from authoritative state inside the serialized commit', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession(
            'Source authority',
            { ...fakeSnapshot(), reachableSourceIds: ['live-source'] },
            { projectId: 'source-authority-project', sessionId: 'source-authority-session' },
        );
        const registered = await coordinator.mutateRegistry(
            'source-authority-project',
            mutationRequest(created.state, 'register-source') as never,
            () => ({
                update: (envelope) => ({
                    ...envelope,
                    sourceRegistryRevision: envelope.sourceRegistryRevision + 1,
                    sourceRegistry: [{
                        sourceId: 'live-source',
                        immutableVersion: 'sha256:version',
                        readGrantId: 'opaque-grant',
                        byteLength: 1,
                        digest: 'sha256:source',
                        streamSignature: 'stream:source',
                        registeredAt: new Date().toISOString(),
                    }],
                }),
                result: { registered: true },
                eventKind: 'source.changed',
                eventData: { action: 'registered' },
            }),
        );
        expect(registered.ok).toBe(true);
        if (!registered.ok) throw new Error('Source registration failed.');
        const plan = await coordinator.planSourceRelease('source-authority-project');
        const applied = await coordinator.applySourceRelease(
            'source-authority-project',
            mutationRequest(registered.state, 'release-source') as never,
            { ...plan, releasableSourceIds: ['live-source'], retained: [] },
        );
        expect(applied.ok).toBe(true);
        if (applied.ok) expect(applied.data.releasedSourceIds).toEqual([]);
        expect(
            coordinator.getProject('source-authority-project').envelope.sourceRegistry[0].releasedAt,
        ).toBeUndefined();
        await coordinator.close();
    });

    it('reaps immutable source copies after an authoritative source release', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const source = join(runtime.path, 'releasable-source.mp4');
        await writeFile(source, 'source-bytes');
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Source copy release', fakeSnapshot(), {
            projectId: 'source-copy-release-project',
            sessionId: 'source-copy-release-session',
        });
        const granted = await coordinator.grantPath(
            'source-copy-release-project',
            mutationRequest(created.state, 'source-copy-grant'),
            'read-root',
            source,
        );
        expect(granted.ok).toBe(true);
        if (!granted.ok) throw new Error('The source grant failed.');
        const verified = await coordinator.pathGrants.openRead(
            granted.data.grant.grantId,
            {
                sessionId: 'source-copy-release-session',
                sessionEpoch: coordinator.epoch,
            },
            source,
        );
        const digest = verified.digest;
        await verified.close();
        const registered = await coordinator.mutateRegistry(
            'source-copy-release-project',
            mutationRequest(granted.state, 'source-copy-register'),
            () => ({
                update: (envelope) => ({
                    ...envelope,
                    sourceRegistryRevision: envelope.sourceRegistryRevision + 1,
                    sourceRegistry: [{
                        sourceId: 'releasable-source',
                        immutableVersion: digest,
                        readGrantId: granted.data.grant.grantId,
                        byteLength: 'source-bytes'.length,
                        digest,
                        streamSignature: 'stream:releasable',
                        registeredAt: new Date().toISOString(),
                    }],
                }),
                result: { registered: true },
                eventKind: 'source.changed',
                eventData: { action: 'registered' },
            }),
        );
        expect(registered.ok).toBe(true);
        if (!registered.ok) throw new Error('The source registration failed.');
        const releaseCopies = vi.spyOn(coordinator.pathGrants, 'releaseSourceCopies');
        const plan = await coordinator.planSourceRelease('source-copy-release-project');
        const released = await coordinator.applySourceRelease(
            'source-copy-release-project',
            mutationRequest(registered.state, 'source-copy-release'),
            plan,
        );
        expect(released.ok).toBe(true);
        expect(releaseCopies).toHaveBeenCalledWith('source-copy-release-session', [digest]);
        await coordinator.close();
    });
});

async function directoryEntries(path: string): Promise<string[]> {
    try {
        return await readdir(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMilliseconds) {
            throw new Error('Timed out waiting for the managed runtime condition.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
