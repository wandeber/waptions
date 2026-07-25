import { describe, expect, it, vi } from 'vitest';
import {
    EDITORIAL_TEST_RECORD_ID,
    createEditorialDependentLinkFixture,
    createEditorialTranscriptBodyFixture,
    createEditorManifestV4Fixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import type { ResolvedEditorialTranscriptMapV1 } from '@/types/editorial';
import type { EditorManifestV4 } from '@/types/video';
import { createDescriptorAssetHydration } from './editor-command-planner';
import {
    createEditorEngine,
    DeterministicEditorIdGenerator,
    FixedEditorClock,
    type EditorCommandBatchRequest,
    type EditorEngineSnapshot,
    type EditorEnginePorts,
    type EditorIdempotencyReceipt,
    type EditorPersistenceCommit,
    type EditorPersistencePort,
} from '.';

const NOW = {
    iso: '2026-07-25T12:00:00.000Z',
    epochMs: Date.parse('2026-07-25T12:00:00.000Z'),
};

class MemoryPersistence implements EditorPersistencePort {
    readonly commits: EditorPersistenceCommit[] = [];
    readonly lookups: Array<{ projectId: string; toolName: string; key: string }> = [];
    readonly receipts = new Map<string, EditorIdempotencyReceipt>();
    failCommit = false;
    closeCalls = 0;

    async getReceipt(
        projectId: string,
        toolName: string,
        idempotencyKey: string,
    ): Promise<EditorIdempotencyReceipt | null> {
        this.lookups.push({ projectId, toolName, key: idempotencyKey });
        return structuredClone(this.receipts.get(receiptKey(projectId, toolName, idempotencyKey)) ?? null);
    }

    async commit(input: EditorPersistenceCommit): Promise<void> {
        if (this.failCommit) throw new Error('injected persistence failure');
        this.commits.push(structuredClone(input));
        this.receipts.set(
            receiptKey(input.projectId, input.receipt.toolName, input.receipt.key),
            structuredClone(input.receipt.value),
        );
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
    }
}

function receiptKey(projectId: string, toolName: string, key: string): string {
    return `${projectId}\u0000${toolName}\u0000${key}`;
}

function createHarness(input: {
    projectId: string;
    manifest?: EditorManifestV4;
    transcriptBodies?: ResolvedEditorialTranscriptMapV1;
    initialEventSequence?: number;
    initialSessionRevision?: number;
}) {
    const persistence = new MemoryPersistence();
    const emitted: string[] = [];
    const diagnostics: string[] = [];
    const transcriptCalls: string[][] = [];
    const assetCalls: Array<{ videoSourceIds: string[]; audioSourceIds: string[] }> = [];
    const ports: EditorEnginePorts = {
        persistence,
        assets: {
            hydrate: async ({ manifest, videoSourceIds, audioSourceIds }) => {
                assetCalls.push({
                    videoSourceIds: [...videoSourceIds],
                    audioSourceIds: [...audioSourceIds],
                });
                const hydration = createDescriptorAssetHydration(manifest);
                return {
                    videoSources: hydration.videoSources.filter((source) => videoSourceIds.includes(source.id)),
                    audioSources: hydration.audioSources.filter((source) => audioSourceIds.includes(source.id)),
                };
            },
            close: vi.fn(async () => {}),
        },
        transcripts: {
            hydrate: async ({ references }) => {
                const recordIds = references.map((reference) => reference.recordId);
                transcriptCalls.push([...recordIds]);
                const bodies = input.transcriptBodies ?? {};
                return Object.fromEntries(
                    recordIds.map((recordId) => [
                        recordId,
                        bodies[recordId as keyof typeof bodies],
                    ]),
                ) as ResolvedEditorialTranscriptMapV1;
            },
            close: vi.fn(async () => {}),
        },
        clock: new FixedEditorClock(NOW),
        ids: new DeterministicEditorIdGenerator(input.projectId),
        events: {
            emit: (event) => {
                emitted.push(event.id);
            },
            close: vi.fn(async () => {}),
        },
        diagnostics: {
            record: (entry) => {
                if (entry.message) diagnostics.push(entry.message);
            },
        },
    };
    const engine = createEditorEngine({
        projectId: input.projectId,
        sessionEpoch: `epoch-${input.projectId}`,
        initialManifest: input.manifest ?? ordinaryManifest(),
        ports,
        ...(input.initialEventSequence === undefined
            ? {}
            : { initialEventSequence: input.initialEventSequence }),
        ...(input.initialSessionRevision === undefined
            ? {}
            : { initialSessionRevision: input.initialSessionRevision }),
    });
    return { engine, ports, persistence, emitted, transcriptCalls, assetCalls, diagnostics };
}

function ordinaryManifest(overrides: Partial<EditorManifestV4> = {}): EditorManifestV4 {
    return createEditorManifestV4Fixture({
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
        ...overrides,
    });
}

function hydratedBodies(): ResolvedEditorialTranscriptMapV1 {
    const body = structuredClone(createEditorialTranscriptBodyFixture());
    body.words[0].id = `sha256:${'1'.repeat(64)}`;
    body.speechRegions[0].id = `sha256:${'2'.repeat(64)}`;
    body.editBoundaries[0].id = `sha256:${'3'.repeat(64)}`;
    body.editBoundaries[0].regionId = body.speechRegions[0].id;
    body.editBoundaries[1].id = `sha256:${'4'.repeat(64)}`;
    body.editBoundaries[1].regionId = body.speechRegions[0].id;
    return {
        [EDITORIAL_TEST_RECORD_ID]: body,
    } as unknown as ResolvedEditorialTranscriptMapV1;
}

function canonicalizeNarrativeWordIds(manifest: EditorManifestV4): EditorManifestV4 {
    Object.values(manifest.narrative?.blocks ?? {}).forEach((block) => {
        if (block.kind === 'speech') {
            block.sourceWordIds = [`sha256:${'1'.repeat(64)}`];
        }
    });
    return manifest;
}

function request(
    manifest: EditorManifestV4,
    operation: NonNullable<EditorCommandBatchRequest['operations']>[number],
    overrides: Partial<EditorCommandBatchRequest> = {},
): EditorCommandBatchRequest {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_edit_apply',
        sessionEpoch: 'epoch-project-a',
        expected: {
            sessionRevision: Math.max(0, manifest.revision - 1),
            documentRevision: manifest.revision,
            audioGraphRevision: manifest.audioGraphRevision,
            ...(manifest.narrative ? { narrativeRevision: manifest.narrative.revision } : {}),
        },
        idempotencyKey: `key-${operation.operationId}`,
        operations: [operation],
        ...overrides,
    };
}

function expectedRevisions(snapshot: EditorEngineSnapshot): EditorCommandBatchRequest['expected'] {
    return {
        sessionRevision: snapshot.revisions.sessionRevision,
        documentRevision: snapshot.revisions.documentRevision,
        audioGraphRevision: snapshot.revisions.audioGraphRevision,
        ...(snapshot.revisions.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.revisions.narrativeRevision }),
    };
}

describe('EditorEngine', () => {
    it('keeps simultaneous engine state, persistence, events, and IDs isolated', async () => {
        const a = createHarness({ projectId: 'project-a' });
        const b = createHarness({ projectId: 'project-b' });
        const beforeA = a.engine.getSnapshot();
        const beforeB = b.engine.getSnapshot();

        const [resultA, resultB] = await Promise.all([
            a.engine.dispatch(request(beforeA.manifest, {
                operationId: 'rename-a',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: 'video_track_editorial',
                    name: 'Project A video',
                },
            })),
            b.engine.dispatch(request(beforeB.manifest, {
                operationId: 'rename-b',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: 'video_track_editorial',
                    name: 'Project B video',
                },
            }, {
                sessionEpoch: 'epoch-project-b',
            })),
        ]);

        expect(resultA.ok, JSON.stringify({ resultA, diagnostics: a.diagnostics })).toBe(true);
        expect(resultB.ok).toBe(true);
        expect(a.engine.getSnapshot().manifest.videoTracks[0].name).toBe('Project A video');
        expect(b.engine.getSnapshot().manifest.videoTracks[0].name).toBe('Project B video');
        expect(a.persistence.commits).toHaveLength(1);
        expect(b.persistence.commits).toHaveLength(1);
        expect(a.persistence.commits[0].commandId).toContain('project-a');
        expect(b.persistence.commits[0].commandId).toContain('project-b');
        expect(a.emitted).toHaveLength(1);
        expect(b.emitted).toHaveLength(1);

        await a.engine.close();
        expect(b.engine.getSnapshot().manifest.revision).toBe(beforeB.manifest.revision + 1);
        await b.engine.close();
    });

    it('durably receipts stable no-ops without history, hydration, revisions, or events', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const noOpRequest = request(before.manifest, {
            operationId: 'rename-noop',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: before.manifest.videoTracks[0].name,
            },
        });
        const result = await harness.engine.dispatch(noOpRequest);

        expect(result).toMatchObject({ ok: true, noOp: true, noOpReason: 'unchanged' });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(harness.persistence.commits).toHaveLength(1);
        expect(harness.persistence.commits[0]).toMatchObject({
            event: null,
            previous: before,
            next: before,
            receipt: {
                toolName: 'waptions_edit_apply',
                key: 'key-rename-noop',
            },
        });
        expect(harness.assetCalls).toHaveLength(0);
        expect(harness.transcriptCalls).toHaveLength(0);
        expect(harness.emitted).toHaveLength(0);
        expect(await harness.engine.dispatch(noOpRequest)).toMatchObject({
            ok: true,
            noOp: true,
            replayed: true,
        });
        expect(harness.persistence.commits).toHaveLength(1);
    });

    it('treats already-satisfied ordering and net-zero compound edits as semantic no-ops', async () => {
        const base = ordinaryManifest();
        const manifest = ordinaryManifest({
            videoTracks: [
                base.videoTracks[0],
                { id: 'video_track_second', name: 'Second', visible: true, locked: false },
            ],
        });
        const harness = createHarness({ projectId: 'project-a', manifest });
        const before = harness.engine.getSnapshot();
        const ordering = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'already-before',
            type: 'track.reorder',
            payload: {
                trackKind: 'video',
                trackId: before.manifest.videoTracks[0].id,
                beforeId: 'video_track_second',
            },
        }, { expected: expectedRevisions(before) }));
        expect(ordering).toMatchObject({ ok: true, noOp: true });
        expect(harness.engine.getSnapshot()).toEqual(before);

        const originalName = before.manifest.videoTracks[0].name;
        const netZero = await harness.engine.dispatch({
            ...request(before.manifest, {
                operationId: 'rename-away',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: before.manifest.videoTracks[0].id,
                    name: 'Temporary',
                },
            }, {
                expected: expectedRevisions(before),
                idempotencyKey: 'net-zero',
            }),
            operations: [{
                operationId: 'rename-away',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: before.manifest.videoTracks[0].id,
                    name: 'Temporary',
                },
            }, {
                operationId: 'rename-back',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: before.manifest.videoTracks[0].id,
                    name: originalName,
                },
            }],
        });
        expect(netZero).toMatchObject({ ok: true, noOp: true });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(harness.persistence.commits).toHaveLength(2);
        expect(harness.emitted).toHaveLength(0);
    });

    it('resolves aliases only in identity fields and preserves dollar-prefixed content', async () => {
        const subtitleTrack = createSubtitleTrackV4Fixture({
            id: 'captions',
            subtitles: [{
                id: 'subtitle_original',
                startTime: 0,
                endTime: 1,
                text: 'Original',
            }],
        });
        const harness = createHarness({
            projectId: 'project-a',
            manifest: ordinaryManifest({
                subtitleTracks: [subtitleTrack],
                activeSubtitleTrackId: subtitleTrack.id,
            }),
        });
        const before = harness.engine.getSnapshot();
        const result = await harness.engine.dispatch({
            ...request(before.manifest, {
                operationId: 'split',
                type: 'subtitle.split',
                payload: {
                    trackId: subtitleTrack.id,
                    subtitleId: 'subtitle_original',
                    atOutputSample: 24_000,
                },
            }, {
                expected: expectedRevisions(before),
                idempotencyKey: 'field-aware-aliases',
            }),
            operations: [{
                operationId: 'split',
                type: 'subtitle.split',
                payload: {
                    trackId: subtitleTrack.id,
                    subtitleId: 'subtitle_original',
                    atOutputSample: 24_000,
                },
            }, {
                operationId: 'update-right',
                type: 'subtitle.update',
                payload: {
                    trackId: subtitleTrack.id,
                    subtitleId: '$split.rightSubtitleId',
                    text: '$100',
                },
            }, {
                operationId: 'rename-track',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: 'video_track_editorial',
                    name: '$ops.main',
                },
            }],
        });

        expect(result.ok, JSON.stringify(result)).toBe(true);
        const after = harness.engine.getSnapshot();
        expect(after.manifest.subtitleTracks[0].subtitles).toHaveLength(2);
        expect(after.manifest.subtitleTracks[0].subtitles[1].text).toBe('$100');
        expect(after.manifest.videoTracks[0].name).toBe('$ops.main');
        expect(result.ok && result.aliases['$split.rightSubtitleId']).toBe(
            after.manifest.subtitleTracks[0].subtitles[1].id,
        );
    });

    it.each(['audio', 'subtitle'] as const)(
        'rejects %s track rehome into itself without publishing',
        async (trackKind) => {
            const audioTrack: EditorManifestV4['audioTracks'][number] = {
                id: 'audio_track_self',
                name: 'Self audio',
                muted: false,
                solo: false,
                locked: false,
                gainDb: 0,
                clips: [{
                    id: 'audio_clip_self',
                    source: {
                        kind: 'video-source-audio',
                        videoSourceId: 'video_source_editorial',
                    },
                    timelineStartFrame: 0,
                    sourceStart: 0,
                    sourceEnd: 1,
                    muted: false,
                    gainDb: 0,
                    fadeInFrames: 0,
                    fadeOutFrames: 0,
                }],
            };
            const subtitleTrack = createSubtitleTrackV4Fixture({
                id: 'subtitle_track_self',
                subtitles: [{
                    id: 'subtitle_self',
                    startTime: 0,
                    endTime: 1,
                    text: 'Must survive rejection',
                }],
            });
            const manifest = ordinaryManifest({
                ...(trackKind === 'audio' ? { audioTracks: [audioTrack] } : {}),
                ...(trackKind === 'subtitle'
                    ? {
                        subtitleTracks: [subtitleTrack],
                        activeSubtitleTrackId: subtitleTrack.id,
                    }
                    : {}),
            });
            const harness = createHarness({ projectId: 'project-a', manifest });
            const before = harness.engine.getSnapshot();
            const trackId = trackKind === 'audio' ? audioTrack.id : subtitleTrack.id;
            const result = await harness.engine.dispatch(request(before.manifest, {
                operationId: `self-rehome-${trackKind}`,
                type: 'track.delete',
                payload: {
                    trackKind,
                    trackId,
                    policy: 'rehome',
                    rehomeTrackId: trackId,
                },
            }, { expected: expectedRevisions(before) }));

            expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_OPERATION' } });
            expect(harness.engine.getSnapshot()).toEqual(before);
            expect(harness.persistence.commits).toHaveLength(0);
        },
    );

    it('scopes receipts by tool name and resolves them before epoch and revision guards', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const firstRequest = request(before.manifest, {
            operationId: 'rename-once',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Renamed once',
            },
        }, { idempotencyKey: 'shared-key' });
        const first = await harness.engine.dispatch(firstRequest);
        expect(first).toMatchObject({ ok: true, replayed: false });

        const replay = await harness.engine.dispatch({
            ...firstRequest,
            sessionEpoch: 'stale-epoch',
        });
        // The canonical request includes the epoch, so a changed retry is a key conflict before
        // the stale epoch is considered. An exact retry below proves guard bypass on replay.
        expect(replay).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_KEY_CONFLICT' } });
        const exactReplay = await harness.engine.dispatch(firstRequest);
        expect(exactReplay).toMatchObject({ ok: true, replayed: true });
        expect(harness.persistence.commits).toHaveLength(1);

        const current = harness.engine.getSnapshot();
        const otherTool = await harness.engine.undo({
            apiVersion: '2026-07-25',
            toolName: 'waptions_history_apply',
            sessionEpoch: 'epoch-project-a',
            expected: expectedRevisions(current),
            idempotencyKey: 'shared-key',
        });
        expect(otherTool).toMatchObject({ ok: true, replayed: false });
        expect(harness.persistence.commits).toHaveLength(2);
        expect(harness.persistence.lookups.map((lookup) => lookup.toolName)).toContain('waptions_history_apply');
    });

    it('keeps the complete batch invisible when a later operation fails', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const result = await harness.engine.dispatch({
            ...request(before.manifest, {
                operationId: 'placeholder',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: 'video_track_editorial',
                    name: 'Never visible',
                },
            }),
            operations: [{
                operationId: 'rename-first',
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: 'video_track_editorial',
                    name: 'Never visible',
                },
            }, {
                operationId: 'missing-second',
                type: 'video-clip.move',
                payload: {
                    clipId: 'missing-clip',
                    targetTrackId: 'video_track_editorial',
                    timelineStartFrame: 10,
                },
            }],
        });

        expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(harness.persistence.commits).toHaveLength(0);
        expect(harness.emitted).toHaveLength(0);
    });

    it('applies a detached plan through the same pipeline with stable aliases', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const planRequest = request(before.manifest, {
            operationId: 'add-track',
            type: 'track.add',
            payload: {
                trackKind: 'audio',
                name: 'Voiceover',
            },
        }, {
            toolName: 'waptions_edit_plan',
            idempotencyKey: 'plan-input',
        });
        const plan = harness.engine.plan(planRequest);
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;

        const applied = await harness.engine.dispatch({
            apiVersion: '2026-07-25',
            toolName: 'waptions_edit_apply',
            sessionEpoch: 'epoch-project-a',
            expected: expectedRevisions(before),
            idempotencyKey: 'apply-plan',
            planId: plan.planId,
        });
        expect(applied).toMatchObject({
            ok: true,
            aliases: plan.aliases,
        });
        expect(harness.persistence.commits).toHaveLength(1);
        expect(harness.engine.getSnapshot().manifest.audioTracks[0].id)
            .toBe(plan.aliases['$add-track.trackId']);
    });

    it('runs descriptor-only semantic validation during planning without opening sources', () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const noOpPlan = harness.engine.plan(request(before.manifest, {
            operationId: 'video-order',
            type: 'video-clip.set-order',
            payload: { clipId: 'video_clip_editorial' },
        }, { toolName: 'waptions_edit_plan' }));
        expect(noOpPlan).toMatchObject({
            ok: true,
            noOpReason: 'order-not-meaningful',
            predicted: {
                sessionRevision: before.revisions.sessionRevision,
                documentRevision: before.revisions.documentRevision,
                audioGraphRevision: before.revisions.audioGraphRevision,
            },
        });
        expect(harness.assetCalls).toHaveLength(0);

        const invalidPlan = harness.engine.plan(request(before.manifest, {
            operationId: 'missing-track',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'missing',
                name: 'Missing',
            },
        }, {
            toolName: 'waptions_edit_plan',
            idempotencyKey: 'invalid-plan',
        }));
        expect(invalidPlan).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(harness.assetCalls).toHaveLength(0);
    });

    it('rejects non-canonical planner and mutation tool scopes', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const operation = {
            operationId: 'canonical-scope',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Canonical scope',
            },
        } as const;

        expect(harness.engine.plan(request(before.manifest, operation)))
            .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        expect(await harness.engine.dispatch(request(before.manifest, operation, {
            toolName: 'waptions_edit_plan',
        }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        expect(harness.persistence.lookups).toHaveLength(0);
        expect(harness.persistence.commits).toHaveLength(0);
    });

    it('persists canonical render backgrounds with no-op and history semantics', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        expect(before.manifest.renderBackgroundColor).toBe('#000000');

        const changed = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'background-blue',
            type: 'render.set-background',
            payload: { color: '#AABBCC' },
        }));
        expect(changed.ok).toBe(true);
        const blue = harness.engine.getSnapshot();
        expect(blue.manifest.renderBackgroundColor).toBe('#aabbcc');
        expect(blue.history.past).toHaveLength(1);
        expect(blue.manifest.revision).toBe(before.manifest.revision + 1);
        expect(harness.assetCalls).toHaveLength(0);

        const noOp = await harness.engine.dispatch(request(blue.manifest, {
            operationId: 'background-same',
            type: 'render.set-background',
            payload: { color: '#AABBCC' },
        }));
        expect(noOp).toMatchObject({ ok: true, noOp: true });
        expect(harness.engine.getSnapshot().history.past).toHaveLength(1);

        const current = harness.engine.getSnapshot();
        const undone = await harness.engine.undo({
            apiVersion: '2026-07-25',
            toolName: 'waptions_history_apply',
            sessionEpoch: 'epoch-project-a',
            expected: expectedRevisions(current),
            idempotencyKey: 'undo-background',
        });
        expect(undone.ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.renderBackgroundColor).toBe('#000000');
        expect(harness.assetCalls).toHaveLength(0);
    });

    it('canonicalizes a valid recovered render background at the engine boundary', async () => {
        const harness = createHarness({
            projectId: 'project-a',
            manifest: ordinaryManifest({ renderBackgroundColor: '#AABBCC' }),
        });
        expect(harness.engine.getSnapshot().manifest.renderBackgroundColor).toBe('#aabbcc');
        await harness.engine.close();
    });

    it('publishes only after one rich atomic persistence commit succeeds', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const listener = vi.fn();
        harness.engine.subscribe(listener);
        harness.persistence.failCommit = true;
        const before = harness.engine.getSnapshot();
        const failed = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'rename-fails',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Not durable',
            },
        }));

        expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(listener).not.toHaveBeenCalled();
        expect(harness.emitted).toHaveLength(0);

        harness.persistence.failCommit = false;
        const succeeded = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'rename-succeeds',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Durable',
            },
        }));
        expect(succeeded.ok).toBe(true);
        const commit = harness.persistence.commits[0];
        expect(commit).toMatchObject({
            schemaVersion: 1,
            projectId: 'project-a',
            toolName: 'waptions_edit_apply',
            transaction: {
                operationIds: ['rename-succeeds'],
                fromDocumentRevision: before.manifest.revision,
                toDocumentRevision: before.manifest.revision + 1,
            },
            sessionState: {
                sessionEpoch: 'epoch-project-a',
                documentRevision: before.manifest.revision + 1,
            },
            receipt: {
                toolName: 'waptions_edit_apply',
            },
        });
        expect(commit.transcriptPins).toEqual({
            durableRecordIds: [],
            historyRecordIds: [],
            redoRecordIds: [],
        });
        expect(commit.event!.sequence).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('keeps post-commit notification and diagnostics failures observational', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        harness.ports.events.emit = () => {
            throw new Error('synchronous event delivery failure');
        };
        harness.ports.events.close = () => {
            throw new Error('synchronous event close failure');
        };
        harness.ports.diagnostics!.record = () => {
            throw new Error('synchronous diagnostics failure');
        };
        const before = harness.engine.getSnapshot();
        const result = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'durable-despite-notification',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Durable despite notification',
            },
        }));

        expect(result).toMatchObject({ ok: true, replayed: false });
        expect(harness.persistence.commits).toHaveLength(1);
        expect(harness.engine.getSnapshot().manifest.videoTracks[0].name)
            .toBe('Durable despite notification');
        await expect(harness.engine.close()).resolves.toBeUndefined();
    });

    it('requires relevant domain guards after durable receipt lookup', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const expected = expectedRevisions(before);
        delete expected.audioGraphRevision;
        const result = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'missing-audio-guard',
            type: 'video-clip.set-audio',
            payload: {
                clipId: 'video_clip_editorial',
                audio: before.manifest.videoClips[0].audio,
            },
        }, { expected }));

        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        expect(harness.persistence.lookups).toHaveLength(1);
        expect(harness.persistence.commits).toHaveLength(0);
        expect(harness.assetCalls).toHaveLength(0);
    });

    it('calculates audio, narrative, and link revision effects independently', async () => {
        const audioHarness = createHarness({ projectId: 'project-a' });
        const audioBefore = audioHarness.engine.getSnapshot();
        const audioResult = await audioHarness.engine.dispatch(request(audioBefore.manifest, {
            operationId: 'mute-video-audio',
            type: 'video-clip.set-audio',
            payload: {
                clipId: 'video_clip_editorial',
                audio: {
                    ...audioBefore.manifest.videoClips[0].audio!,
                    muted: true,
                },
            },
        }));
        expect(audioResult.ok).toBe(true);
        expect(audioHarness.assetCalls).toEqual([{
            videoSourceIds: ['video_source_editorial'],
            audioSourceIds: [],
        }]);
        expect(audioHarness.engine.getSnapshot().revisions).toMatchObject({
            documentRevision: audioBefore.manifest.revision + 1,
            audioGraphRevision: audioBefore.manifest.audioGraphRevision + 1,
        });

        const narrativeManifest = canonicalizeNarrativeWordIds(createEditorManifestV4Fixture());
        const narrativeHarness = createHarness({
            projectId: 'project-a',
            manifest: narrativeManifest,
            transcriptBodies: hydratedBodies(),
        });
        const narrativeBefore = narrativeHarness.engine.getSnapshot();
        const narrativeResult = await narrativeHarness.engine.dispatch(request(narrativeBefore.manifest, {
            operationId: 'show-speakers',
            type: 'narrative.set-speaker-visibility',
            payload: { showSpeakers: true },
        }));
        expect(
            narrativeResult.ok,
            JSON.stringify({ narrativeResult, diagnostics: narrativeHarness.diagnostics }),
        ).toBe(true);
        expect(narrativeHarness.engine.getSnapshot().revisions).toMatchObject({
            documentRevision: narrativeBefore.manifest.revision + 1,
            audioGraphRevision: narrativeBefore.manifest.audioGraphRevision,
            narrativeRevision: narrativeBefore.manifest.narrative!.revision + 1,
        });

        const subtitleTrack = createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Hello' }],
        });
        const linkedManifest = canonicalizeNarrativeWordIds(createEditorManifestV4Fixture({
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
            dependentLinks: [createEditorialDependentLinkFixture()],
        }));
        const linkHarness = createHarness({
            projectId: 'project-a',
            manifest: linkedManifest,
            transcriptBodies: hydratedBodies(),
        });
        const linkBefore = linkHarness.engine.getSnapshot();
        const linkResult = await linkHarness.engine.dispatch(request(linkBefore.manifest, {
            operationId: 'follow-link',
            type: 'link.set-follow-policy',
            payload: {
                target: { kind: 'subtitle', trackId: subtitleTrack.id, subtitleId: 'subtitle_1' },
                followPolicy: 'follow',
            },
        }));
        expect(linkResult.ok).toBe(true);
        expect(linkHarness.engine.getSnapshot().revisions).toMatchObject({
            documentRevision: linkBefore.manifest.revision + 1,
            audioGraphRevision: linkBefore.manifest.audioGraphRevision,
            narrativeRevision: linkBefore.manifest.narrative!.revision,
        });
    });

    it('binds transcript fragments in explicit canonical 16 kHz samples', async () => {
        const subtitleTrack = createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Hello' }],
        });
        const manifest = canonicalizeNarrativeWordIds(createEditorManifestV4Fixture({
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
            dependentLinks: [],
        }));
        const harness = createHarness({
            projectId: 'project-a',
            manifest,
            transcriptBodies: hydratedBodies(),
        });
        const before = harness.engine.getSnapshot();
        const result = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'bind-16k-fragment',
            type: 'link.bind-target',
            payload: {
                target: {
                    kind: 'subtitle',
                    trackId: subtitleTrack.id,
                    subtitleId: 'subtitle_1',
                },
                anchorBlockId: 'narrative_block_1',
                activeStartSample16k: 4_000,
                activeEndSample16k: 12_000,
            },
        }, { expected: expectedRevisions(before) }));

        expect(result.ok, JSON.stringify(result)).toBe(true);
        const binding = harness.engine.getSnapshot().manifest.dependentLinks[0].association;
        expect(binding).toMatchObject({
            kind: 'transcript-bound',
            binding: {
                activeStartSample: 4_000,
                activeEndSample: 12_000,
            },
        });
    });

    it('supports semantic undo, redo, and jump with monotonic document revisions', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        let snapshot = harness.engine.getSnapshot();
        const names = ['First', 'Second'];
        for (let index = 0; index < names.length; index += 1) {
            const name = names[index];
            const result = await harness.engine.dispatch(request(snapshot.manifest, {
                operationId: `rename-${index}`,
                type: 'track.rename',
                payload: {
                    trackKind: 'video',
                    trackId: 'video_track_editorial',
                    name,
                },
            }));
            expect(result.ok).toBe(true);
            snapshot = harness.engine.getSnapshot();
        }
        const secondHistoryId = snapshot.history.past[1].id;
        const undo = await harness.engine.undo({
            apiVersion: '2026-07-25',
            toolName: 'waptions_history_apply',
            sessionEpoch: 'epoch-project-a',
            expected: expectedRevisions(snapshot),
            idempotencyKey: 'undo-1',
        });
        expect(undo.ok).toBe(true);
        const afterUndo = harness.engine.getSnapshot();
        expect(afterUndo.manifest.videoTracks[0].name).toBe('First');
        expect(afterUndo.manifest.revision).toBe(snapshot.manifest.revision + 1);

        const redo = await harness.engine.redo({
            apiVersion: '2026-07-25',
            toolName: 'waptions_history_apply',
            sessionEpoch: 'epoch-project-a',
            expected: expectedRevisions(afterUndo),
            idempotencyKey: 'redo-1',
        });
        expect(redo.ok).toBe(true);
        const afterRedo = harness.engine.getSnapshot();
        expect(afterRedo.manifest.videoTracks[0].name).toBe('Second');

        const jump = await harness.engine.jumpToHistory({
            apiVersion: '2026-07-25',
            toolName: 'waptions_history_apply',
            sessionEpoch: 'epoch-project-a',
            expected: expectedRevisions(afterRedo),
            idempotencyKey: 'jump-1',
            entryId: secondHistoryId,
            position: 'before',
        });
        expect(jump.ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.videoTracks[0].name).toBe('First');
    });

    it('keeps transcript bodies detached and closes owned ports once', async () => {
        const harness = createHarness({
            projectId: 'project-a',
            manifest: createEditorManifestV4Fixture(),
            transcriptBodies: hydratedBodies(),
        });
        const serialized = JSON.stringify(harness.engine.getSnapshot());
        expect(serialized).not.toContain('Hello');
        expect(serialized).not.toContain('editorialTranscriptRecordBodies');

        await Promise.all([harness.engine.close(), harness.engine.close()]);
        expect(harness.persistence.closeCalls).toBe(1);
        const closed = await harness.engine.dispatch(request(createEditorManifestV4Fixture(), {
            operationId: 'after-close',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Closed',
            },
        }));
        expect(closed).toMatchObject({ ok: false, error: { code: 'COORDINATOR_UNAVAILABLE' } });
    });

    it('rejects unsafe recovered history before constructing an engine', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const changed = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'history-source',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'History source',
            },
        }));
        expect(changed.ok).toBe(true);
        const commit = harness.persistence.commits[0];
        const unsafeHistory = structuredClone(commit.history);
        unsafeHistory.past[0].patches[0].path[0] = 'transientSelection';

        expect(() => createEditorEngine({
            projectId: 'recovered',
            sessionEpoch: 'epoch-recovered',
            initialManifest: commit.next.manifest,
            initialHistory: unsafeHistory,
            ports: harness.ports,
        })).toThrow(expect.objectContaining({ code: 'INVALID_DOCUMENT' }));
    });

    it('keeps event sequences contiguous across failed commits and durable recovery', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        harness.persistence.failCommit = true;
        const firstRequest = request(before.manifest, {
            operationId: 'failed-event',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'First durable',
            },
        });
        const failed = await harness.engine.dispatch(firstRequest);
        expect(failed.ok).toBe(false);

        harness.persistence.failCommit = false;
        const committed = await harness.engine.dispatch(firstRequest);
        expect(committed.ok).toBe(true);
        expect(harness.persistence.commits[0].event!.sequence).toBe(1);

        const recovered = createHarness({
            projectId: 'project-a',
            manifest: harness.persistence.commits[0].next.manifest,
            initialEventSequence: 1,
            initialSessionRevision: 1,
        });
        const recoveredBefore = recovered.engine.getSnapshot();
        const second = await recovered.engine.dispatch(request(recoveredBefore.manifest, {
            operationId: 'second-event',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Second durable',
            },
        }));
        expect(second.ok).toBe(true);
        expect(recovered.persistence.commits[0].event!.sequence).toBe(2);
    });

    it('does not open sources for metadata edits and opens only the affected clip source', async () => {
        const harness = createHarness({ projectId: 'project-a' });
        const before = harness.engine.getSnapshot();
        const rename = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'metadata-only',
            type: 'track.rename',
            payload: {
                trackKind: 'video',
                trackId: 'video_track_editorial',
                name: 'Metadata only',
            },
        }));
        expect(rename.ok).toBe(true);
        expect(harness.assetCalls).toHaveLength(0);

        const current = harness.engine.getSnapshot();
        const clipEdit = await harness.engine.dispatch(request(current.manifest, {
            operationId: 'clip-source-only',
            type: 'video-clip.set-audio',
            payload: {
                clipId: 'video_clip_editorial',
                audio: {
                    ...current.manifest.videoClips[0].audio!,
                    muted: true,
                },
            },
        }));
        expect(clipEdit.ok).toBe(true);
        expect(harness.assetCalls).toEqual([{
            videoSourceIds: ['video_source_editorial'],
            audioSourceIds: [],
        }]);

        const changed = harness.engine.getSnapshot();
        const undo = await harness.engine.undo({
            apiVersion: '2026-07-25',
            toolName: 'waptions_history_apply',
            sessionEpoch: 'epoch-project-a',
            expected: expectedRevisions(changed),
            idempotencyKey: 'undo-clip-source-only',
        });
        expect(undo.ok).toBe(true);
        expect(harness.assetCalls).toEqual([{
            videoSourceIds: ['video_source_editorial'],
            audioSourceIds: [],
        }, {
            videoSourceIds: ['video_source_editorial'],
            audioSourceIds: [],
        }]);
    });

    it('maps all public subtitle video policies to their durable V4 values with no-op history', async () => {
        const subtitleTrack = createSubtitleTrackV4Fixture();
        const harness = createHarness({
            projectId: 'project-a',
            manifest: ordinaryManifest({
                subtitleTracks: [subtitleTrack],
                activeSubtitleTrackId: subtitleTrack.id,
            }),
        });
        const cases = [
            ['preserve-absolute', 'stay-absolute'],
            ['ripple-with-video-edit', 'follow-project-ripple'],
            ['remove-with-deleted-video-range', 'remove-with-deleted-video-range'],
        ] as const;
        for (const [policy, durable] of cases) {
            const before = harness.engine.getSnapshot();
            const result = await harness.engine.dispatch(request(before.manifest, {
                operationId: `policy-${policy}`,
                type: 'subtitle-track.set-unlinked-video-policy',
                payload: {
                    trackId: before.manifest.subtitleTracks[0].id,
                    policy,
                },
            }, {
                expected: expectedRevisions(before),
                idempotencyKey: `policy-${policy}`,
            }));
            expect(result.ok).toBe(true);
            expect(harness.engine.getSnapshot().manifest.subtitleTracks[0].unlinkedVideoEditResponse)
                .toBe(durable);
        }
        const beforeNoOp = harness.engine.getSnapshot();
        const noOp = await harness.engine.dispatch(request(beforeNoOp.manifest, {
            operationId: 'policy-no-op',
            type: 'subtitle-track.set-unlinked-video-policy',
            payload: {
                trackId: beforeNoOp.manifest.subtitleTracks[0].id,
                policy: 'remove-with-deleted-video-range',
            },
        }, {
            expected: expectedRevisions(beforeNoOp),
            idempotencyKey: 'policy-no-op',
        }));
        expect(noOp).toMatchObject({ ok: true, noOp: true });
        expect(harness.engine.getSnapshot().history.past).toHaveLength(2);
    });

    it('applies deleted-range subtitle policy in Core and rejects locked followers atomically', async () => {
        const subtitleTrack = createSubtitleTrackV4Fixture({
            unlinkedVideoEditResponse: 'remove-with-deleted-video-range',
            subtitles: [
                { id: 'overlap', startTime: 1.25, endTime: 1.75, text: 'Remove me' },
                { id: 'outside', startTime: 2.25, endTime: 2.75, text: 'Keep me' },
            ],
        });
        const manifest = ordinaryManifest({
            globalEditingMode: 'ripple',
            videoClips: [{
                ...ordinaryManifest().videoClips[0],
                timelineStartFrame: 30,
            }],
            subtitleTracks: [subtitleTrack],
            activeSubtitleTrackId: subtitleTrack.id,
        });
        const harness = createHarness({ projectId: 'project-a', manifest });
        const before = harness.engine.getSnapshot();
        const deleted = await harness.engine.dispatch(request(before.manifest, {
            operationId: 'delete-video-range',
            type: 'video-clip.delete',
            payload: { clipId: before.manifest.videoClips[0].id },
        }, { expected: expectedRevisions(before) }));

        expect(deleted.ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.subtitleTracks[0].subtitles)
            .toEqual([{ id: 'outside', startTime: 2.25, endTime: 2.75, text: 'Keep me' }]);

        const lockedTrack = { ...subtitleTrack, isLocked: true };
        const lockedHarness = createHarness({
            projectId: 'project-a',
            manifest: {
                ...manifest,
                subtitleTracks: [lockedTrack],
            },
        });
        const lockedBefore = lockedHarness.engine.getSnapshot();
        const rejected = await lockedHarness.engine.dispatch(request(lockedBefore.manifest, {
            operationId: 'delete-locked-video-range',
            type: 'video-clip.delete',
            payload: { clipId: lockedBefore.manifest.videoClips[0].id },
        }, { expected: expectedRevisions(lockedBefore) }));

        expect(rejected).toMatchObject({ ok: false, error: { code: 'LOCKED_TARGET' } });
        expect(lockedHarness.engine.getSnapshot()).toEqual(lockedBefore);
        expect(lockedHarness.persistence.commits).toHaveLength(0);
    });
});
