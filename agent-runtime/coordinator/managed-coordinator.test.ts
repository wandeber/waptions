import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedCoordinator } from './managed-coordinator';
import {
    fakeEditorCommit,
    fakeEditorPortFactory,
    fakeEditorResultFromCommit,
    fakeSnapshot,
    fakeSnapshotFromCommit,
    type FakeEditorCommand,
    type FakeEditorResult,
    type FakeEditorState,
} from '../testing/fake-editor-port';
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
import type {
    ManagedMutationEnvelope,
    StateToken,
} from './types';
import type { EditorCommandFailure } from '../../src/lib/editor-engine';
import { DurableJobScheduler } from '../jobs/durable-job-scheduler';
import {
    CoreEditorPortFactory,
    createEmptyManagedCoreSnapshot,
    createImportedManagedCoreSnapshot,
    type ManagedCoreCommand,
    type ManagedCoreEditorState,
    type ManagedCoreResult,
} from '../integration/core-editor-port';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

type FakeCoreFailure = EditorCommandFailure & Record<string, unknown>;

describe('ManagedCoordinator', () => {
    it('creates and replays session_open from the durable receipt before project guards', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const first = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const input = {
            apiVersion: '2026-07-25' as const,
            action: 'create' as const,
            projectId: 'bootstrap-project',
            idempotencyKey: 'bootstrap-request',
            canonicalRequestHash: `sha256:${'b'.repeat(64)}`,
            name: 'Bootstrap project',
            initialSnapshot: fakeProjectSnapshot('bootstrap-project'),
        };

        const created = await first.openSessionReceiptFirst(input);
        expect(created).toMatchObject({
            ok: true,
            replayed: false,
            data: { action: 'create', created: true, recovered: false },
        });
        if (!created.ok) throw new Error('Session creation failed.');
        await first.close();

        const restarted = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const replay = await restarted.openSessionReceiptFirst(input);
        expect(replay).toMatchObject({
            ok: true,
            replayed: true,
            data: {
                participantId: created.data.participantId,
                project: { projectId: 'bootstrap-project' },
            },
        });
        const conflict = await restarted.openSessionReceiptFirst({
            ...input,
            canonicalRequestHash: `sha256:${'c'.repeat(64)}`,
        });
        expect(conflict).toMatchObject({
            ok: false,
            error: { code: 'IDEMPOTENCY_KEY_CONFLICT' },
        });
        await restarted.close();
    });

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

    it('configures coordinator-owned runtime services before handler registration and recovery', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const order: string[] = [];
        const recover = vi.spyOn(DurableJobScheduler.prototype, 'recover')
            .mockImplementation(async () => {
                order.push('recover');
            });
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory, {
            configureRuntime: async (configured) => {
                expect(configured.pathGrants).toBeDefined();
                expect(configured.artifacts).toBeDefined();
                expect(configured.store).toBeDefined();
                order.push('configure');
            },
            registerJobHandlers: (scheduler) => {
                expect(scheduler).toBeDefined();
                order.push('register');
            },
        });

        expect(order).toEqual(['configure', 'register', 'recover']);
        recover.mockRestore();
        await coordinator.close();
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
        const created = await first.createSession(
            'Retry test',
            fakeProjectSnapshot('retry-project'),
            {
                projectId: 'retry-project',
                sessionId: 'retry-session',
            },
        );
        const request = editorMutationRequest(created.state, 'same-key', { append: 'once' });
        const lost = await first.mutateEditor('retry-project', request);
        expect(lost.ok).toBe(false);
        const immediateReplay = await first.mutateEditor('retry-project', request);
        expect(immediateReplay.ok).toBe(true);
        if (immediateReplay.ok) {
            expect(immediateReplay.replayed).toBe(true);
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
            type: 'project.mutated',
            state: immediateReplay.ok ? immediateReplay.state : undefined,
            data: {
                commandId: `command-${request.idempotencyKey}`,
                operationIds: ['fake-operation'],
                historyEntryId: `history-${request.idempotencyKey}`,
            },
        });
        await first.close();

        const recovered = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const replay = await recovered.mutateEditor('retry-project', request);
        expect(replay.ok).toBe(true);
        if (replay.ok) {
            expect(replay.data).toMatchObject({ appended: 'once' });
            expect(replay.replayed).toBe(true);
            expect(replay.state.sessionEpoch).not.toBe(request.sessionEpoch);
            expect(replay.state.sessionRevision).toBe(1);
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

    it('replays an atomically committed project import when recovery and post-commit adoption fail', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let fired = false;
        const coordinator = await ManagedCoordinator.start<
            ManagedCoreEditorState,
            ManagedCoreCommand,
            ManagedCoreResult
        >(runtime.path, new CoreEditorPortFactory(), {
            persistenceFaultInjector: {
                hit: (point) => {
                    if (!fired && point === 'transaction:cleaned') {
                        fired = true;
                        throw new Error('lost project import response');
                    }
                },
            },
        });
        const initial = createEmptyManagedCoreSnapshot(
            'import-replay-project',
            coordinator.epoch,
            'Before import',
        );
        const created = await coordinator.createSession(
            'Before import',
            initial,
            {
                projectId: 'import-replay-project',
                sessionId: 'import-replay-session',
            },
        );
        const requestBody = {
            apiVersion: '2026-07-25' as const,
            sessionId: created.state.sessionId,
            sessionEpoch: created.state.sessionEpoch,
            expected: {
                sessionRevision: created.state.sessionRevision,
                documentRevision: created.state.documentRevision,
                audioGraphRevision: created.state.audioGraphRevision,
            },
            idempotencyKey: 'import-replay-key',
            toolName: 'waptions_project_import',
        };
        const request: ManagedMutationEnvelope = {
            ...requestBody,
            command: {},
            canonicalRequestHash: canonicalDigest(requestBody),
        };
        const next = createImportedManagedCoreSnapshot({
            current: initial,
            manifest: initial.state.snapshot.manifest,
            projectName: 'Imported project',
        });
        const accept = vi.fn(async () => {
            throw new Error('process-local adoption failed');
        });
        const reject = vi.fn(async () => undefined);
        const publication = {
            nextEditor: next,
            nextName: 'Imported project',
            sourceRegistryAdditions: [],
            writes: [{
                relativePath: 'import-evidence/staged-source.json',
                value: { retained: true },
            }],
            jobId: 'bundle-import:replay-test',
            formatVersion: 4,
            verify: vi.fn(async () => undefined),
            accept,
            reject,
        };

        const recovered =
            await coordinator.publishProjectImportReceiptFirst(
                'import-replay-project',
                request,
                publication,
            );
        expect(recovered).toMatchObject({
            ok: true,
            replayed: true,
            warnings: expect.arrayContaining([
                expect.stringMatching(/media authority needs recovery/u),
            ]),
        });
        const replay = await coordinator.publishProjectImportReceiptFirst(
            'import-replay-project',
            request,
            publication,
        );
        expect(replay).toMatchObject({
            ok: true,
            replayed: true,
            data: recovered.ok ? recovered.data : undefined,
        });
        expect(accept).toHaveBeenCalledOnce();
        expect(reject).not.toHaveBeenCalled();
        expect(coordinator.jobs.get('bundle-import:replay-test')).toMatchObject({
            state: 'succeeded',
        });
        expect(await coordinator.store.readNamespace(
            'import-replay-project',
            'import-evidence',
        )).toEqual([{ retained: true }]);
        await coordinator.close();
    });

    it('publishes a post-marker recovered event before any later event to active long-polls', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let fired = false;
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory, {
            persistenceFaultInjector: {
                hit: (point) => {
                    if (!fired && point === 'transaction:committed') {
                        fired = true;
                        throw new Error('lost response after marker');
                    }
                },
            },
        });
        const created = await coordinator.createSession(
            'Ordered recovery',
            fakeProjectSnapshot('ordered-recovery-project'),
            {
            projectId: 'ordered-recovery-project',
            sessionId: 'ordered-recovery-session',
            },
        );
        const subscription = coordinator.events.subscribe(
            'ordered-recovery-project',
            'ordered-recovery-session',
            created.state.eventCursor,
        );
        const firstRead = subscription.next();
        const firstRequest = editorMutationRequest(created.state, 'ordered-recovery-one', {
            append: 'one',
        });
        expect((await coordinator.mutateEditor(
            'ordered-recovery-project',
            firstRequest,
        )).ok).toBe(false);
        const replay = await coordinator.mutateEditor(
            'ordered-recovery-project',
            firstRequest,
        );
        expect(replay.ok).toBe(true);
        if (!replay.ok) throw new Error('The recovered mutation receipt was not replayed.');
        const recoveredEvent = await firstRead;
        expect(recoveredEvent.sequence).toBe(1);

        const second = await coordinator.mutateEditor(
            'ordered-recovery-project',
            editorMutationRequest(replay.state, 'ordered-recovery-two', { append: 'two' }),
        );
        expect(second.ok).toBe(true);
        const laterEvent = await subscription.next();
        expect(laterEvent.sequence).toBe(2);
        subscription.close();
        await coordinator.close();
    });

    it('serializes concurrent clients and rejects the stale second mutation', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession(
            'Concurrency',
            fakeProjectSnapshot('concurrent-project'),
            {
                projectId: 'concurrent-project',
                sessionId: 'concurrent-session',
            },
        );
        const [first, second] = await Promise.all([
            coordinator.mutateEditor(
                'concurrent-project',
                editorMutationRequest(created.state, 'client-one', { append: 'one' }),
            ),
            coordinator.mutateEditor(
                'concurrent-project',
                editorMutationRequest(created.state, 'client-two', { append: 'two' }),
            ),
        ]);
        expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
        const rejected = first.ok ? second : first;
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.error.code).toBe('SESSION_REVISION_CONFLICT');
        expect(coordinator.getProject('concurrent-project').envelope.editor.state.values).toHaveLength(1);
        await coordinator.close();
    });

    it('revalidates media authority before Core and commits it only after the WAL', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession(
            'Core media boundary',
            fakeProjectSnapshot('core-media-boundary-project'),
            {
                projectId: 'core-media-boundary-project',
                sessionId: 'core-media-boundary-session',
            },
        );
        const request = editorMutationRequest(
            created.state,
            'core-media-boundary',
            { append: 'imported' },
        );
        const order: string[] = [];
        const result = await coordinator.importMediaThroughCore(
            'core-media-boundary-project',
            request,
            { append: 'imported' },
            {
                revalidate: () => {
                    expect(
                        coordinator.getProject('core-media-boundary-project').state.sessionRevision,
                    ).toBe(0);
                    order.push('revalidate');
                },
                commitAuthority: () => {
                    expect(
                        coordinator.getProject('core-media-boundary-project')
                            .envelope.editor.state.values,
                    ).toEqual(['imported']);
                    order.push('commit-authority');
                },
            },
        );
        expect(result.ok).toBe(true);
        expect(order).toEqual(['revalidate', 'commit-authority']);

        const replayRevalidate = vi.fn();
        const replayCommit = vi.fn();
        const replay = await coordinator.importMediaThroughCore(
            'core-media-boundary-project',
            request,
            { append: 'ignored-on-replay' },
            {
                revalidate: replayRevalidate,
                commitAuthority: replayCommit,
            },
        );
        expect(replay).toMatchObject({ ok: true, replayed: true });
        expect(replayRevalidate).not.toHaveBeenCalled();
        expect(replayCommit).not.toHaveBeenCalled();
        await coordinator.close();
    });

    it('rejects reuse of an idempotency key with a different canonical request before guards', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession(
            'Conflict',
            fakeProjectSnapshot('conflict-project'),
            {
                projectId: 'conflict-project',
                sessionId: 'conflict-session',
            },
        );
        const first = editorMutationRequest(created.state, 'duplicate', { append: 'one' });
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
        if (replay.ok) expect(replay.replayed).toBe(true);
        await coordinator.close();
    });

    it('reconciles prepared grant creation and revocation after post-marker recovery', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        let armed = false;
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory, {
            persistenceFaultInjector: {
                hit: (point) => {
                    if (armed && point === 'transaction:committed') {
                        armed = false;
                        throw new Error('lost grant response after marker');
                    }
                },
            },
        });
        const created = await coordinator.createSession('Grant recovery', fakeSnapshot(), {
            projectId: 'grant-recovery-project',
            sessionId: 'grant-recovery-session',
        });
        const root = join(runtime.path, 'grant-recovery-root');
        const source = join(root, 'source.txt');
        await mkdir(root);
        await writeFile(source, 'durable source');
        const grantRequest = mutationRequest(created.state, 'grant-recovery') as never;
        armed = true;
        expect((await coordinator.grantPath(
            'grant-recovery-project',
            grantRequest,
            'read-root',
            root,
        )).ok).toBe(false);
        const grantReplay = await coordinator.grantPath(
            'grant-recovery-project',
            grantRequest,
            'read-root',
            root,
        );
        expect(grantReplay.ok).toBe(true);
        if (!grantReplay.ok) throw new Error('The durable grant was not replayed.');
        const scope = {
            sessionId: 'grant-recovery-session',
            sessionEpoch: coordinator.epoch,
        };
        const handle = await coordinator.pathGrants.openRead(
            grantReplay.data.grant.grantId,
            scope,
            source,
        );
        await handle.close();

        const revokeRequest = mutationRequest(grantReplay.state, 'grant-revoke') as never;
        armed = true;
        expect((await coordinator.revokePathGrant(
            'grant-recovery-project',
            revokeRequest,
            grantReplay.data.grant.grantId,
        )).ok).toBe(false);
        const revokeReplay = await coordinator.revokePathGrant(
            'grant-recovery-project',
            revokeRequest,
            grantReplay.data.grant.grantId,
        );
        expect(revokeReplay.ok).toBe(true);
        await expect(coordinator.pathGrants.openRead(
            grantReplay.data.grant.grantId,
            scope,
            source,
        )).rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
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
        if (replay.ok) expect(replay.replayed).toBe(true);
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
            FakeEditorState,
            { append: string },
            { claimed: boolean }
        > = {
            create: async (initial) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async () => {
                        dispatches += 1;
                        return { claimed: true };
                    },
                    snapshotFromCommit: () => {
                        throw new Error('The no-commit adapter cannot project a commit.');
                    },
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession(
            'No commit',
            fakeProjectSnapshot('no-commit-project'),
            {
                projectId: 'no-commit-project',
                sessionId: 'no-commit-session',
            },
        );
        const request = editorMutationRequest(created.state, 'no-commit');
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

    it('returns a Core failure without requiring a persistence commit', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const factory: ManagedEditorPortFactory<
            FakeEditorState,
            FakeEditorCommand,
            FakeCoreFailure
        > = {
            create: async (initial) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async () => ({
                        ok: false,
                        error: {
                            code: 'INVALID_OPERATION',
                            message: 'The fake operation is invalid.',
                            retryable: false,
                        },
                    } as FakeCoreFailure),
                    snapshotFromCommit: () => {
                        throw new Error('A failed Core operation cannot have a commit.');
                    },
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession(
            'Core failure',
            fakeProjectSnapshot('core-failure-project'),
            {
                projectId: 'core-failure-project',
                sessionId: 'core-failure-session',
            },
        );
        const request = editorMutationRequest(created.state, 'core-failure');
        const transact = vi.spyOn(coordinator.store, 'transact');
        const result = await coordinator.mutateEditor('core-failure-project', request);
        expect(result).toMatchObject({
            ok: false,
            error: {
                code: 'INVALID_OPERATION',
                message: 'The fake operation is invalid.',
                retryable: false,
            },
            state: created.state,
        });
        expect(transact).not.toHaveBeenCalled();
        expect(await coordinator.store.readReceipt(
            'core-failure-project',
            request.toolName,
            request.idempotencyKey,
        )).toBeNull();
        await coordinator.close();
    });

    it('uses one persistence transaction for a valid editor mutation', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession(
            'Single commit',
            fakeProjectSnapshot('single-commit-project'),
            {
                projectId: 'single-commit-project',
                sessionId: 'single-commit-session',
            },
        );
        const transact = vi.spyOn(coordinator.store, 'transact');
        const result = await coordinator.mutateEditor(
            'single-commit-project',
            editorMutationRequest(created.state, 'single-commit', { append: 'once' }),
        );
        expect(result.ok).toBe(true);
        expect(transact).toHaveBeenCalledTimes(1);
        await coordinator.close();
    });

    it.each([
        ['previous manifest', (commit: ReturnType<typeof fakeEditorCommit>) => {
            commit.previous.manifest.renderBackgroundColor = '#ffffff';
        }],
        ['transaction revision', (commit: ReturnType<typeof fakeEditorCommit>) => {
            commit.transaction.toDocumentRevision += 1;
        }],
        ['session revision projection', (commit: ReturnType<typeof fakeEditorCommit>) => {
            commit.sessionState.audioGraphRevision += 1;
        }],
        ['receipt command identity', (commit: ReturnType<typeof fakeEditorCommit>) => {
            commit.receipt.value.result.commandId = 'wrong-command';
        }],
        ['event revisions', (commit: ReturnType<typeof fakeEditorCommit>) => {
            if (commit.event) commit.event.revisions.sessionRevision += 1;
        }],
        ['history projection', (commit: ReturnType<typeof fakeEditorCommit>) => {
            commit.next.history.currentIndex += 1;
        }],
    ])('rejects an invalid Core %s before creating a WAL transaction', async (_, corrupt) => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const factory: ManagedEditorPortFactory<
            FakeEditorState,
            FakeEditorCommand,
            FakeEditorResult
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ command, request }) => {
                        const next = fakeSnapshot(
                            [...current.state.values, command.append],
                            current.state.projectId,
                            current.state.eventSequence + 1,
                        );
                        const commit = fakeEditorCommit(
                            current.state.projectId,
                            request,
                            current,
                            next,
                        );
                        corrupt(commit);
                        await persistence.commit(commit);
                        current = fakeSnapshotFromCommit(commit);
                        return fakeEditorResultFromCommit(commit, command.append);
                    },
                    snapshotFromCommit: fakeSnapshotFromCommit,
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession('Invalid Core commit', fakeSnapshot(), {
            projectId: 'invalid-core-commit-project',
            sessionId: 'invalid-core-commit-session',
        });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const result = await coordinator.mutateEditor(
            'invalid-core-commit-project',
            editorMutationRequest(created.state, 'invalid-core-commit'),
        );
        expect(result.ok).toBe(false);
        expect(transact).not.toHaveBeenCalled();
        await coordinator.close();
    });

    it('mutates a near-limit editor head without duplicating the full Core commit in the WAL', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const largeValue = 'x'.repeat(28 * 1024 * 1024);
        const initial = fakeSnapshot([largeValue], 'near-limit-project');
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory);
        const created = await coordinator.createSession('Near limit', initial, {
            projectId: 'near-limit-project',
            sessionId: 'near-limit-session',
        });
        const result = await coordinator.mutateEditor(
            'near-limit-project',
            editorMutationRequest(created.state, 'near-limit', { append: 'small' }),
        );
        expect(result.ok).toBe(true);
        expect(await coordinator.store.readNamespace(
            'near-limit-project',
            'core/commits',
        )).toEqual([]);
        const evidence = await coordinator.store.readNamespace<Record<string, unknown>>(
            'near-limit-project',
            'core/commit-evidence',
        );
        expect(evidence).toHaveLength(1);
        expect(evidence[0]).toMatchObject({
            schemaVersion: 1,
            projectId: 'near-limit-project',
            operationCount: 1,
        });
        expect(evidence[0]).not.toHaveProperty('previous');
        expect(evidence[0]).not.toHaveProperty('next');
        await coordinator.close();
    }, 60_000);

    it('persists a Core no-op receipt without advancing state or emitting an event', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const factory: ManagedEditorPortFactory<
            FakeEditorState,
            FakeEditorCommand,
            FakeEditorResult
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ command, request }) => {
                        const commit = fakeEditorCommit(
                            current.state.projectId,
                            request,
                            current,
                            current,
                            { noOp: true },
                        );
                        await persistence.commit(commit);
                        current = fakeSnapshotFromCommit(commit);
                        return fakeEditorResultFromCommit(commit, command.append);
                    },
                    snapshotFromCommit: fakeSnapshotFromCommit,
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession(
            'Core no-op',
            fakeProjectSnapshot('no-op-project'),
            {
                projectId: 'no-op-project',
                sessionId: 'no-op-session',
            },
        );
        const request = editorMutationRequest(created.state, 'no-op', { append: 'ignored' });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const result = await coordinator.mutateEditor('no-op-project', request);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('The Core no-op did not commit its receipt.');
        expect(result.replayed).toBe(false);
        expect(result.data).toMatchObject({ noOp: true, eventId: null });
        expect(result.state).toEqual(created.state);
        expect(transact).toHaveBeenCalledTimes(1);
        expect((await coordinator.events.read(
            'no-op-project',
            'no-op-session',
            undefined,
        )).events).toEqual([]);

        const receipt = await coordinator.store.readReceipt(
            'no-op-project',
            request.toolName,
            request.idempotencyKey,
        );
        expect(receipt?.coreReceipt?.result).toMatchObject({ noOp: true, eventId: null });
        expect(receipt?.coreReceipt?.result).not.toHaveProperty('snapshot');
        expect(receipt?.coreReceipt?.result).not.toHaveProperty('replayed');

        const replay = await coordinator.mutateEditor('no-op-project', request);
        expect(replay.ok).toBe(true);
        if (replay.ok) {
            expect(replay.replayed).toBe(true);
            expect(replay.state).toEqual(created.state);
        }
        expect(transact).toHaveBeenCalledTimes(1);
        await coordinator.close();
    });

    it('rejects an invalid adapter transition before any durable mutation', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const factory: ManagedEditorPortFactory<
            FakeEditorState,
            FakeEditorCommand,
            FakeEditorResult
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ command, request }) => {
                        const next = fakeSnapshot(
                            [...current.state.values, command.append],
                            current.state.projectId,
                            current.state.eventSequence + 1,
                        );
                        const commit = fakeEditorCommit(
                            current.state.projectId,
                            request,
                            current,
                            next,
                        );
                        await persistence.commit(commit);
                        current = fakeSnapshotFromCommit(commit);
                        return fakeEditorResultFromCommit(commit, command.append);
                    },
                    snapshotFromCommit: (commit) => ({
                        ...fakeSnapshotFromCommit(commit),
                        documentRevision: Number.NaN,
                    }),
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession(
            'Invalid adapter',
            fakeProjectSnapshot('invalid-adapter-project'),
            {
                projectId: 'invalid-adapter-project',
                sessionId: 'invalid-adapter-session',
            },
        );
        const result = await coordinator.mutateEditor(
            'invalid-adapter-project',
            editorMutationRequest(created.state, 'invalid-adapter'),
        );
        expect(result.ok).toBe(false);
        expect((await coordinator.store.readProject('invalid-adapter-project'))?.sessionRevision).toBe(0);
        await coordinator.close();

        const restarted = await ManagedCoordinator.start(runtime.path, factory);
        expect(restarted.getProject('invalid-adapter-project').envelope.sessionRevision).toBe(0);
        await restarted.close();
    });

    it('returns the authoritative durable result when Core misbehaves after committing', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const factory: ManagedEditorPortFactory<
            FakeEditorState,
            FakeEditorCommand,
            FakeEditorResult
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ command, request }) => {
                        const next = fakeSnapshot(
                            [...current.state.values, command.append],
                            current.state.projectId,
                            current.state.eventSequence + 1,
                        );
                        const commit = fakeEditorCommit(
                            current.state.projectId,
                            request,
                            current,
                            next,
                        );
                        await persistence.commit(commit);
                        current = fakeSnapshotFromCommit(commit);
                        throw new Error('Core failed after commit.');
                    },
                    snapshotFromCommit: fakeSnapshotFromCommit,
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession(
            'Post-commit authority',
            fakeProjectSnapshot('post-commit-project'),
            {
                projectId: 'post-commit-project',
                sessionId: 'post-commit-session',
            },
        );
        const request = editorMutationRequest(created.state, 'post-commit', { append: 'once' });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const result = await coordinator.mutateEditor('post-commit-project', request);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data).toMatchObject({ appended: 'once', noOp: false });
            expect(result.replayed).toBe(false);
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
            FakeEditorState,
            FakeEditorCommand,
            FakeEditorResult
        > = {
            create: async (initial, persistence) => {
                let current = structuredClone(initial);
                return {
                    snapshot: () => structuredClone(current),
                    dispatch: async ({ command, request }) => {
                        const next = fakeSnapshot(
                            [...current.state.values, command.append],
                            current.state.projectId,
                            current.state.eventSequence + 1,
                        );
                        const commit = fakeEditorCommit(
                            current.state.projectId,
                            request,
                            current,
                            next,
                        );
                        await persistence.commit(commit);
                        if (throwAfterCommit) {
                            throwAfterCommit = false;
                            throw new Error('Core failed before publishing its in-memory head.');
                        }
                        current = fakeSnapshotFromCommit(commit);
                        return fakeEditorResultFromCommit(commit, command.append);
                    },
                    snapshotFromCommit: fakeSnapshotFromCommit,
                    hydrate: async (snapshot) => {
                        current = structuredClone(snapshot);
                    },
                    close: async () => undefined,
                };
            },
        };
        const coordinator = await ManagedCoordinator.start(runtime.path, factory);
        const created = await coordinator.createSession(
            'Post-commit hydration',
            fakeProjectSnapshot('post-commit-hydration-project'),
            {
                projectId: 'post-commit-hydration-project',
                sessionId: 'post-commit-hydration-session',
            },
        );
        const first = await coordinator.mutateEditor(
            'post-commit-hydration-project',
            editorMutationRequest(
                created.state,
                'post-commit-hydration-one',
                { append: 'one' },
            ),
        );
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error('The first mutation did not commit.');
        const second = await coordinator.mutateEditor(
            'post-commit-hydration-project',
            editorMutationRequest(
                first.state,
                'post-commit-hydration-two',
                { append: 'two' },
            ),
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

    it('publishes terminal Core and coverage transcription writes with the succeeded job', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const accepted = vi.fn();
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory, {
            transcriptionPublicationAuthority: {
                prepare: async () => ({
                    writes: [{
                        relativePath: 'transcription/descriptors/editorial.json',
                        value: { schemaVersion: 1, transcriptRecordId: `sha256:${'5'.repeat(64)}` },
                    }],
                    verify: () => true,
                    accept: accepted,
                    reject: vi.fn(),
                }),
            },
        });
        const created = await coordinator.createSession(
            'Atomic transcription',
            fakeProjectSnapshot('atomic-transcription-project'),
            {
            projectId: 'atomic-transcription-project',
            sessionId: 'atomic-transcription-session',
            },
        );
        const inputDigest = `sha256:${'1'.repeat(64)}`;
        const sourceFingerprint = `sha256:${'2'.repeat(64)}`;
        const profileDigest = `sha256:${'3'.repeat(64)}`;
        const coverageRecordId = `sha256:${'4'.repeat(64)}`;
        const transcriptRecordId = `sha256:${'5'.repeat(64)}`;
        const coverageAccepted = vi.fn();
        const coreCapability = await coordinator.prepareEditorialTranscriptionPublication(
            'atomic-transcription-project',
            {
                sessionEpoch: coordinator.epoch,
                expected: {
                    sessionRevision: created.state.sessionRevision,
                    documentRevision: created.state.documentRevision,
                    audioGraphRevision: created.state.audioGraphRevision,
                },
                idempotencyKey: 'atomic-core-transcription',
            } as never,
        );
        coordinator.jobs.register('editorial-transcription', {
            run: async () => ({
                result: { publicationId: 'core-publication' },
                artifactIds: [],
                terminalPublication: {
                    artifacts: [],
                    transcription: {
                        schemaVersion: 1 as const,
                        proposalId: 'transcription-proposal:atomic',
                        projectId: 'atomic-transcription-project',
                        kind: 'editorial-transcription',
                        inputDigest,
                        preparedCorePublication: coreCapability,
                        preparedCoverageUpdates: [{
                            capabilityId: 'coverage-publication',
                            projectId: 'atomic-transcription-project',
                            kind: 'coverage' as const,
                            sourceFingerprint,
                            acquisitionProfileDigest: profileDigest,
                            expectedCoverageRecordIds: [],
                            coverageRecordId,
                            pinRecordIds: [transcriptRecordId],
                            durableWrites: () => [
                                {
                                    relativePath: `transcription/coverage/${
                                        coverageRecordId.slice(7)
                                    }.json`,
                                    value: { schemaVersion: 1, recordId: coverageRecordId },
                                },
                                {
                                    relativePath: 'transcription/coverage-heads/family.json',
                                    value: {
                                        schemaVersion: 1,
                                        sourceFingerprint,
                                        acquisitionProfileDigest: profileDigest,
                                        expectedCoverageRecordIds: [],
                                        coverageRecordIds: [coverageRecordId],
                                    },
                                },
                            ],
                            accept: coverageAccepted,
                            reject: vi.fn(),
                        }],
                        stagedArtifacts: [],
                        transcriptRecordIds: [transcriptRecordId],
                        coverageRecordIds: [coverageRecordId],
                        chunkRecordIds: [],
                        sourceIds: ['source-1'],
                    },
                },
            }),
        });
        const transact = vi.spyOn(coordinator.store, 'transact');
        const enqueued = await coordinator.enqueueJob(
            'atomic-transcription-project',
            mutationRequest(created.state, 'atomic-transcription-job'),
            {
                kind: 'editorial-transcription',
                input: {},
                inputDigest,
                cancellable: true,
                resumable: true,
            },
        );
        expect(enqueued.ok).toBe(true);
        if (!enqueued.ok) throw new Error('The transcription job was not enqueued.');
        await waitFor(() => coordinator.jobs.get(enqueued.data.job.jobId)?.state === 'succeeded');

        const transaction = transact.mock.calls.map(([input]) => input).find((input) => (
            input.writes?.some((write) => (
                write.relativePath === 'transcription/descriptors/editorial.json'
            ))
        ));
        expect(transaction?.writes?.map((write) => write.relativePath)).toEqual(
            expect.arrayContaining([
                'transcription/descriptors/editorial.json',
                'transcription/coverage-heads/family.json',
                `jobs/${enqueued.data.job.jobId}.json`,
                expect.stringMatching(/^events\/.+\.json$/),
            ]),
        );
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(coverageAccepted).toHaveBeenCalledTimes(1);
        expect(
            coordinator.getProject('atomic-transcription-project').envelope.editor.state.values,
        ).toEqual(['editorial-transcription']);
        await coordinator.close();
    });

    it('rejects a losing terminal transcription CAS as a retryable revision conflict', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const coordinator = await ManagedCoordinator.start(runtime.path, fakeEditorPortFactory, {
            transcriptionPublicationAuthority: {
                prepare: async () => ({
                    writes: [],
                    verify: () => true,
                }),
            },
        });
        const created = await coordinator.createSession(
            'Stale transcription',
            fakeProjectSnapshot('stale-transcription-project'),
            {
            projectId: 'stale-transcription-project',
            sessionId: 'stale-transcription-session',
            },
        );
        const inputDigest = `sha256:${'6'.repeat(64)}`;
        const expectedCoverageRecordId = `sha256:${'7'.repeat(64)}`;
        const nextCoverageRecordId = `sha256:${'8'.repeat(64)}`;
        const transcriptRecordId = `sha256:${'9'.repeat(64)}`;
        const coverageRejected = vi.fn();
        const coreCapability = await coordinator.prepareSubtitleTranscriptionPublication(
            'stale-transcription-project',
            {
                sessionEpoch: coordinator.epoch,
                expected: {
                    sessionRevision: created.state.sessionRevision,
                    documentRevision: created.state.documentRevision,
                    audioGraphRevision: created.state.audioGraphRevision,
                },
                idempotencyKey: 'stale-core-transcription',
            } as never,
        );
        const rejected = vi.fn(coreCapability.reject);
        const observedCoreCapability = {
            ...coreCapability,
            reject: rejected,
        };
        coordinator.jobs.register('subtitle-transcription', {
            run: async () => ({
                result: { publicationId: 'stale-core-publication' },
                artifactIds: [],
                terminalPublication: {
                    artifacts: [],
                    transcription: {
                        schemaVersion: 1 as const,
                        proposalId: 'transcription-proposal:stale',
                        projectId: 'stale-transcription-project',
                        kind: 'subtitle-transcription',
                        inputDigest,
                        preparedCorePublication: observedCoreCapability,
                        preparedCoverageUpdates: [{
                            capabilityId: 'stale-coverage-publication',
                            projectId: 'stale-transcription-project',
                            kind: 'coverage' as const,
                            sourceFingerprint: `sha256:${'a'.repeat(64)}`,
                            acquisitionProfileDigest: `sha256:${'b'.repeat(64)}`,
                            expectedCoverageRecordIds: [expectedCoverageRecordId],
                            coverageRecordId: nextCoverageRecordId,
                            pinRecordIds: [transcriptRecordId],
                            durableWrites: () => [{
                                relativePath: 'transcription/coverage-heads/stale-family.json',
                                value: {
                                    schemaVersion: 1,
                                    sourceFingerprint: `sha256:${'a'.repeat(64)}`,
                                    acquisitionProfileDigest: `sha256:${'b'.repeat(64)}`,
                                    expectedCoverageRecordIds: [expectedCoverageRecordId],
                                    coverageRecordIds: [nextCoverageRecordId],
                                },
                            }],
                            accept: vi.fn(),
                            reject: coverageRejected,
                        }],
                        stagedArtifacts: [],
                        transcriptRecordIds: [transcriptRecordId],
                        coverageRecordIds: [nextCoverageRecordId],
                        chunkRecordIds: [],
                        sourceIds: ['source-1'],
                    },
                },
            }),
        });
        const enqueued = await coordinator.enqueueJob(
            'stale-transcription-project',
            mutationRequest(created.state, 'stale-transcription-job'),
            {
                kind: 'subtitle-transcription',
                input: {},
                inputDigest,
                cancellable: true,
                resumable: true,
            },
        );
        expect(enqueued.ok).toBe(true);
        if (!enqueued.ok) throw new Error('The transcription job was not enqueued.');
        await waitFor(() => coordinator.jobs.get(enqueued.data.job.jobId)?.state === 'stale');

        expect(coordinator.jobs.get(enqueued.data.job.jobId)?.error).toMatchObject({
            code: 'REVISION_CONFLICT',
            retryable: true,
        });
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(coverageRejected).toHaveBeenCalledTimes(1);
        await expect(readFile(join(
            runtime.path,
            'projects',
            'stale-transcription-project',
            'transcription',
            'descriptors',
            'subtitle.json',
        ))).rejects.toMatchObject({ code: 'ENOENT' });
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

function fakeProjectSnapshot(
    projectId: string,
    values: readonly string[] = [],
): ManagedEditorSnapshot<FakeEditorState> {
    return fakeSnapshot(values, projectId);
}

function editorMutationRequest(
    token: StateToken,
    key: string,
    command: FakeEditorCommand = { append: key },
): ManagedMutationEnvelope<FakeEditorCommand> {
    const base = mutationRequest(token, key, command);
    const request = {
        ...base,
        toolName: 'waptions_edit_apply',
    };
    return {
        ...request,
        canonicalRequestHash: canonicalDigest({
            apiVersion: request.apiVersion,
            sessionId: request.sessionId,
            sessionEpoch: request.sessionEpoch,
            expected: request.expected,
            idempotencyKey: request.idempotencyKey,
            toolName: request.toolName,
            command: request.command,
        }),
    };
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
