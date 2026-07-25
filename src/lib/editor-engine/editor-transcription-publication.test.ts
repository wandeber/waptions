import { describe, expect, it, vi } from 'vitest';
import {
    getCanonicalEditorAudioGraphSignature,
    getStableValueSignature,
} from '@/lib/audio-graph-signature';
import {
    createAcquisitionProfileDigest,
    createTranscriptionCoverageRecordV2,
    verifyTranscriptionCoverageRecordV2,
} from '@/lib/editorial-transcription/range-coverage';
import {
    createCanonicalEditorialTranscriptRecord,
} from '@/lib/editorial-transcription/transcript-body';
import {
    createEditorialTranscriptDescriptorV2,
} from '@/lib/editorial-transcription/identity';
import {
    createEditorManifestV4Fixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import type {
    EditorialTranscriptDescriptorV2,
    EditorialTranscriptRecordBodyV1,
    Sha256Digest,
    TranscriptionCoverageRecordV2,
} from '@/types/editorial';
import type { SubtitleTrackV4 } from '@/types/timeline';
import type { EditorManifestV4 } from '@/types/video';
import {
    createDescriptorAssetHydration,
    manifestToPlanningDocument,
} from './editor-command-planner';
import {
    createEditorEngine,
    DeterministicEditorIdGenerator,
    FixedEditorClock,
    type EditorialTranscriptionPublicationHydration,
    type EditorialTranscriptionPublicationRequest,
    type EditorEngineEvent,
    type EditorEnginePorts,
    type EditorEngineSnapshot,
    type EditorIdempotencyReceipt,
    type EditorPersistenceCommit,
    type EditorPersistencePort,
    type HistoryJumpRequest,
    type HistoryMutationRequest,
    type SubtitlePublicationTargetAnchor,
    type SubtitleTranscriptionPublicationRequest,
    StaleTranscriptionPublicationError,
} from '.';

const NOW = {
    iso: '2026-07-25T18:00:00.000Z',
    epochMs: Date.parse('2026-07-25T18:00:00.000Z'),
};
const PROJECT_ID = 'transcription-publication-project';
const SESSION_EPOCH = 'transcription-publication-epoch';
const ENDPOINT_DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const REQUEST_KEY = `sha256:${'b'.repeat(64)}` as Sha256Digest;

class MemoryPersistence implements EditorPersistencePort {
    readonly capabilities = { transcriptionPublication: true as const };
    readonly commits: EditorPersistenceCommit[] = [];
    readonly receipts = new Map<string, EditorIdempotencyReceipt>();
    readonly bodies = new Map<Sha256Digest, EditorialTranscriptRecordBodyV1>();
    readonly coverageHeads = new Map<string, Sha256Digest[]>();
    failCommit = false;
    commitError: unknown = null;

    async getReceipt(
        projectId: string,
        toolName: string,
        idempotencyKey: string,
    ): Promise<EditorIdempotencyReceipt | null> {
        return structuredClone(
            this.receipts.get(receiptKey(projectId, toolName, idempotencyKey)) ?? null,
        );
    }

    async commit(input: EditorPersistenceCommit): Promise<void> {
        if (this.commitError) throw this.commitError;
        if (this.failCommit) throw new Error('injected transcription commit failure');
        const publication = input.transcriptionPublication;
        if (publication?.kind === 'editorial') {
            for (const record of publication.records) {
                const family = coverageFamily(record.coverageRecord);
                const current = this.coverageHeads.get(family) ?? [];
                if (JSON.stringify(current) !== JSON.stringify(record.expectedCoverageRecordIds)) {
                    throw new Error('injected stale coverage CAS');
                }
            }
        }
        const committed = structuredClone(input);
        this.commits.push(committed);
        this.receipts.set(
            receiptKey(input.projectId, input.receipt.toolName, input.receipt.key),
            structuredClone(input.receipt.value),
        );
        if (publication?.kind === 'editorial') {
            publication.records.forEach((record) => {
                this.bodies.set(record.recordId, structuredClone(record.body));
                const family = coverageFamily(record.coverageRecord);
                this.coverageHeads.set(
                    family,
                    Array.from(new Set([
                        ...record.expectedCoverageRecordIds,
                        record.coverageRecord.recordId,
                    ])).sort(),
                );
            });
        }
    }
}

function createHarness(input: {
    manifest?: EditorManifestV4;
    persistence?: MemoryPersistence;
    sessionEpoch?: string;
    initialSessionRevision?: number;
    initialEventSequence?: number;
} = {}) {
    const manifest = input.manifest ?? publicationManifest();
    const persistence = input.persistence ?? new MemoryPersistence();
    const events: EditorEngineEvent[] = [];
    const listener = vi.fn();
    const ports: EditorEnginePorts = {
        persistence,
        assets: {
            hydrate: async () => ({ videoSources: [], audioSources: [] }),
        },
        transcripts: {
            hydrate: async ({ references }) => Object.fromEntries(
                references.flatMap((reference) => {
                    const body = persistence.bodies.get(reference.recordId as Sha256Digest);
                    return body ? [[reference.recordId, structuredClone(body)]] : [];
                }),
            ) as never,
        },
        clock: new FixedEditorClock(NOW),
        ids: new DeterministicEditorIdGenerator(PROJECT_ID),
        events: {
            emit: (event) => {
                events.push(structuredClone(event));
            },
        },
    };
    const engine = createEditorEngine({
        projectId: PROJECT_ID,
        sessionEpoch: input.sessionEpoch ?? SESSION_EPOCH,
        initialManifest: manifest,
        initialSessionRevision: input.initialSessionRevision,
        initialEventSequence: input.initialEventSequence,
        ports,
        closePorts: false,
    });
    engine.subscribe(listener);
    return { engine, persistence, events, listener };
}

function publicationManifest(overrides: Partial<EditorManifestV4> = {}): EditorManifestV4 {
    const target = createSubtitleTrackV4Fixture({
        id: 'subtitle-target',
        name: 'Captions',
        subtitles: [],
    });
    return createEditorManifestV4Fixture({
        revision: 4,
        audioGraphRevision: 2,
        subtitleTracks: [target],
        activeSubtitleTrackId: target.id,
        transcriptionByTrackId: {},
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
        ...overrides,
    });
}

async function editorialFixture(input: {
    sourceId?: string;
    sourceFingerprint?: string;
    word?: string;
    requestKey?: Sha256Digest;
    acquisitionProfileDigest?: Sha256Digest;
    coverageEndpointDigest?: Sha256Digest;
    descriptorEndpointDigest?: Sha256Digest;
} = {}): Promise<{
    descriptor: EditorialTranscriptDescriptorV2;
    body: EditorialTranscriptRecordBodyV1;
    coverage: TranscriptionCoverageRecordV2;
}> {
    const sourceFingerprint = input.sourceFingerprint ?? 'editorial-source-fingerprint';
    const canonical = await createCanonicalEditorialTranscriptRecord({
        sourceFingerprint,
        sampleCount: 160_000,
        canonicalModel: 'qwen-edit-max',
        language: 'es',
        speakerMode: 'none',
        noAudioStream: false,
        words: [{
            text: input.word ?? 'detached editorial words',
            alignedStartSample: 16_000,
            alignedEndSample: 24_000,
            editableStartSample: 16_000,
            editableEndSample: 24_000,
            probability: 0.99,
            speakerLabel: null,
        }],
        speechRegions: [{
            providerRegionId: 1,
            startSample: 16_000,
            endSample: 24_000,
            evidence: 'alignment_acoustic',
            wordStartIndex: 0,
            wordEndIndex: 1,
            vadPeakProbability: 0.99,
            vadMeanProbability: 0.9,
            startEnergyConfirmed: true,
            endEnergyConfirmed: true,
        }],
        editBoundaries: [{
            providerRegionId: 1,
            type: 'speech_start',
            sample: 16_000,
            evidence: 'alignment_acoustic',
            energyConfirmed: true,
        }, {
            providerRegionId: 1,
            type: 'speech_end',
            sample: 24_000,
            evidence: 'alignment_acoustic',
            energyConfirmed: true,
        }],
        speakers: [],
    });
    const endpointIdentityDigest = input.coverageEndpointDigest ?? ENDPOINT_DIGEST;
    const acquisitionProfileDigest = input.acquisitionProfileDigest
        ?? await createAcquisitionProfileDigest({
            sourceFingerprint,
            sourceSampleRate: 16_000,
            sourceSampleCount: 160_000,
            coreCoverage: [{ startSample: 0, endSample: 160_000 }],
            contextSamples: 0,
            language: 'es',
            speakerMode: 'none',
            endpointIdentityDigest,
            requestedModel: 'qwen-1.7b-edit-max',
            responseSchema: 'edit-max-v1',
            pcmAlgorithmVersion: 1,
            providerProfileVersion: 1,
        });
    const coverage = await createTranscriptionCoverageRecordV2({
        sourceFingerprint,
        sourceSampleRate: 16_000,
        sourceSampleCount: 160_000,
        acquisitionProfileDigest,
        endpointIdentityDigest,
        contextSamples: 0,
        requestedModel: 'qwen-1.7b-edit-max',
        responseSchema: 'edit-max-v1',
        pcmAlgorithmVersion: 1,
        providerProfileVersion: 1,
        language: 'es',
        speakerMode: 'none',
        coreCoverage: [{ startSample: 0, endSample: 160_000 }],
        acquisitionWindows: [],
        mergedTranscriptRecordId: canonical.recordId,
    });
    return {
        body: canonical.body,
        coverage,
        descriptor: createEditorialTranscriptDescriptorV2({
            recordId: canonical.recordId,
            coverageRecord: coverage,
            requestKey: input.requestKey ?? REQUEST_KEY,
            sourceId: input.sourceId ?? 'video_source_editorial',
            sourceFingerprint,
            endpointIdentityDigest: input.descriptorEndpointDigest ?? ENDPOINT_DIGEST,
            body: canonical.body,
            acquisition: 'provider',
            createdAt: NOW.iso,
        }),
    };
}

function editorialRequest(
    snapshot: EditorEngineSnapshot,
    fixture: Awaited<ReturnType<typeof editorialFixture>>,
    overrides: Partial<EditorialTranscriptionPublicationRequest> = {},
): EditorialTranscriptionPublicationRequest {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_transcription_publish_editorial',
        sessionEpoch: snapshot.revisions.sessionEpoch,
        expected: expectedRevisions(snapshot),
        idempotencyKey: 'publish-editorial-1',
        publications: [{
            descriptor: fixture.descriptor,
            expectedCoverageRecordIds: [],
        }],
        ...overrides,
    };
}

function editorialHydration(
    fixture: Awaited<ReturnType<typeof editorialFixture>>,
    currentCoverageRecordIds: Sha256Digest[] = [],
): EditorialTranscriptionPublicationHydration {
    return {
        records: [{
            recordId: fixture.descriptor.recordId,
            body: fixture.body,
            coverageRecord: fixture.coverage,
            currentCoverageRecordIds,
            availableChunkRecordIds: [],
        }],
    };
}

function subtitleRequest(
    snapshot: EditorEngineSnapshot,
    input: {
        idempotencyKey?: string;
        tracks?: SubtitleTrackV4[];
        publications?: SubtitleTranscriptionPublicationRequest['publications'];
    } = {},
): SubtitleTranscriptionPublicationRequest {
    const tracks = input.tracks ?? snapshot.manifest.subtitleTracks;
    const target = tracks[0];
    const cue = {
        id: 'subtitle-generated',
        startTime: 0.2,
        endTime: 1.2,
        text: 'Generated subtitle',
    };
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_transcription_publish_subtitles',
        sessionEpoch: snapshot.revisions.sessionEpoch,
        expected: expectedRevisions(snapshot),
        idempotencyKey: input.idempotencyKey ?? 'publish-subtitle-1',
        sourceAnchor: {
            audioGraphSignature: audioGraphSignature(snapshot.manifest),
            activeSubtitleTrackId: snapshot.manifest.activeSubtitleTrackId,
        },
        publications: input.publications ?? [{
            kind: 'single-track',
            targetTrackId: target.id,
            targetAnchors: [targetAnchor(snapshot.manifest, target)],
            payload: {
                subtitles: [cue],
                transcription: {
                    raw: [cue],
                    groups: { generated: [cue] },
                    containerIds: ['generated'],
                },
            },
            metadata: {
                provider: 'local',
                model: 'test-model',
                generatedAt: NOW.iso,
            },
        }],
    };
}

function targetAnchor(
    manifest: EditorManifestV4,
    track: SubtitleTrackV4,
): SubtitlePublicationTargetAnchor {
    const provenance = manifest.transcriptionByTrackId[track.id];
    return {
        trackId: track.id,
        trackSignature: getStableValueSignature(track),
        provenanceSignature: provenance ? getStableValueSignature(provenance) : null,
    };
}

function expectedRevisions(snapshot: EditorEngineSnapshot) {
    return {
        sessionRevision: snapshot.revisions.sessionRevision,
        documentRevision: snapshot.revisions.documentRevision,
        audioGraphRevision: snapshot.revisions.audioGraphRevision,
        ...(snapshot.revisions.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.revisions.narrativeRevision }),
    };
}

function audioGraphSignature(manifest: EditorManifestV4): string {
    return getCanonicalEditorAudioGraphSignature(
        manifestToPlanningDocument(manifest, createDescriptorAssetHydration(manifest)),
    );
}

function historyRequest(
    snapshot: EditorEngineSnapshot,
    action: string,
): HistoryMutationRequest {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_history_apply',
        sessionEpoch: snapshot.revisions.sessionEpoch,
        expected: expectedRevisions(snapshot),
        idempotencyKey: `history-${action}`,
    };
}

function receiptKey(projectId: string, toolName: string, key: string): string {
    return `${projectId}\u0000${toolName}\u0000${key}`;
}

function coverageFamily(record: TranscriptionCoverageRecordV2): string {
    return `${record.sourceFingerprint}\u0000${record.acquisitionProfileDigest}`;
}

describe('EditorEngine transcription publication', () => {
    it('publishes editorial descriptors through one commit without touching subtitles or narrative', async () => {
        const harness = createHarness();
        const before = harness.engine.getSnapshot();
        const fixture = await editorialFixture();
        const result = await harness.engine.publishEditorialTranscription(
            editorialRequest(before, fixture),
            editorialHydration(fixture),
        );

        expect(result.ok).toBe(true);
        expect(harness.persistence.commits).toHaveLength(1);
        expect(harness.events).toHaveLength(1);
        expect(harness.listener).toHaveBeenCalledTimes(1);
        const after = harness.engine.getSnapshot();
        expect(after.manifest.editorialTranscriptDescriptors).toEqual([fixture.descriptor]);
        expect(after.manifest.subtitleTracks).toEqual(before.manifest.subtitleTracks);
        expect(after.manifest.transcriptionByTrackId).toEqual(before.manifest.transcriptionByTrackId);
        expect(after.manifest.narrative).toEqual(before.manifest.narrative);
        expect(after.manifest.audioGraphRevision).toBe(before.manifest.audioGraphRevision);
        expect(harness.persistence.commits[0].transcriptionPublication).toMatchObject({
            kind: 'editorial',
            records: [{ recordId: fixture.descriptor.recordId }],
        });
        expect(harness.persistence.commits[0].transcriptPins.durableRecordIds)
            .toEqual([fixture.descriptor.recordId]);

        const durableSurfaces = {
            manifest: harness.persistence.commits[0].next.manifest,
            history: harness.persistence.commits[0].history,
            receipt: harness.persistence.commits[0].receipt,
            event: harness.persistence.commits[0].event,
        };
        expect(JSON.stringify(durableSurfaces)).not.toContain('detached editorial words');
    });

    it('resolves an exact editorial receipt before hydration, capabilities, epoch, and revisions', async () => {
        const persistence = new MemoryPersistence();
        const first = createHarness({ persistence });
        const fixture = await editorialFixture();
        const request = editorialRequest(first.engine.getSnapshot(), fixture);
        const committed = await first.engine.publishEditorialTranscription(
            request,
            editorialHydration(fixture),
        );
        expect(committed.ok).toBe(true);
        const committedSnapshot = first.engine.getSnapshot();

        const restarted = createHarness({
            persistence,
            manifest: committedSnapshot.manifest,
            sessionEpoch: 'new-epoch-after-restart',
            initialSessionRevision: committedSnapshot.revisions.sessionRevision,
        });
        Object.defineProperty(persistence, 'capabilities', { value: {}, configurable: true });
        const replay = await restarted.engine.publishEditorialTranscription(request);

        expect(replay).toMatchObject({
            ok: true,
            replayed: true,
            publicationKind: 'editorial',
            recordIds: [fixture.descriptor.recordId],
        });
        expect(persistence.commits).toHaveLength(1);
    });

    it('rejects an idempotency hash conflict before publication', async () => {
        const harness = createHarness();
        const fixture = await editorialFixture();
        const request = editorialRequest(harness.engine.getSnapshot(), fixture);
        expect((await harness.engine.publishEditorialTranscription(
            request,
            editorialHydration(fixture),
        )).ok).toBe(true);

        const conflict = await harness.engine.publishEditorialTranscription({
            ...request,
            publications: [{
                ...request.publications[0],
                expectedCoverageRecordIds: [fixture.coverage.recordId],
            }],
        });
        expect(conflict).toMatchObject({
            ok: false,
            error: { code: 'IDEMPOTENCY_KEY_CONFLICT' },
        });
        expect(harness.persistence.commits).toHaveLength(1);
    });

    it('rejects body identity mismatch and stale source or coverage anchors without partial commits', async () => {
        const fixture = await editorialFixture();
        const mismatched = await editorialFixture({ word: 'different canonical body' });
        const bodyHarness = createHarness();
        const bodyFailure = await bodyHarness.engine.publishEditorialTranscription(
            editorialRequest(bodyHarness.engine.getSnapshot(), fixture),
            {
                records: [{
                    ...editorialHydration(fixture).records[0],
                    body: mismatched.body,
                }],
            },
        );
        expect(bodyFailure).toMatchObject({
            ok: false,
            error: { code: 'SOURCE_CHANGED' },
        });
        expect(bodyHarness.persistence.commits).toHaveLength(0);

        const staleHarness = createHarness();
        const staleFailure = await staleHarness.engine.publishEditorialTranscription(
            editorialRequest(staleHarness.engine.getSnapshot(), fixture),
            editorialHydration(fixture, [fixture.coverage.recordId]),
        );
        expect(staleFailure).toMatchObject({
            ok: false,
            error: { code: 'STALE_TRANSCRIPTION_PUBLICATION', retryable: true },
        });
        expect(staleHarness.persistence.commits).toHaveLength(0);
    });

    it('rejects a hash-valid coverage sidecar from a different endpoint profile', async () => {
        const fixture = await editorialFixture({
            coverageEndpointDigest: `sha256:${'f'.repeat(64)}` as Sha256Digest,
            descriptorEndpointDigest: ENDPOINT_DIGEST,
        });
        const harness = createHarness();
        const result = await harness.engine.publishEditorialTranscription(
            editorialRequest(harness.engine.getSnapshot(), fixture),
            editorialHydration(fixture),
        );
        expect(result).toMatchObject({
            ok: false,
            error: { code: 'SOURCE_CHANGED' },
        });
        expect(harness.persistence.commits).toHaveLength(0);
    });

    it('rejects a hash-valid coverage sidecar whose acquisition profile digest is stale', async () => {
        const fixture = await editorialFixture();
        const coverage = await createTranscriptionCoverageRecordV2({
            sourceFingerprint: fixture.coverage.sourceFingerprint,
            sourceSampleRate: fixture.coverage.sourceSampleRate,
            sourceSampleCount: fixture.coverage.sourceSampleCount,
            acquisitionProfileDigest: fixture.coverage.acquisitionProfileDigest,
            endpointIdentityDigest: fixture.coverage.endpointIdentityDigest,
            contextSamples: 160,
            requestedModel: fixture.coverage.requestedModel,
            responseSchema: fixture.coverage.responseSchema,
            pcmAlgorithmVersion: fixture.coverage.pcmAlgorithmVersion,
            providerProfileVersion: 2,
            language: fixture.coverage.language,
            speakerMode: fixture.coverage.speakerMode,
            mergeAlgorithmVersion: fixture.coverage.mergeAlgorithmVersion,
            coreCoverage: fixture.coverage.coreCoverage,
            acquisitionWindows: fixture.coverage.acquisitionWindows,
            mergedTranscriptRecordId: fixture.coverage.mergedTranscriptRecordId,
        });
        await expect(verifyTranscriptionCoverageRecordV2(coverage)).resolves.toBeUndefined();
        const actualProfileDigest = await createAcquisitionProfileDigest({
            sourceFingerprint: coverage.sourceFingerprint,
            sourceSampleRate: coverage.sourceSampleRate,
            sourceSampleCount: coverage.sourceSampleCount,
            coreCoverage: coverage.coreCoverage,
            contextSamples: coverage.contextSamples,
            language: coverage.language,
            speakerMode: coverage.speakerMode,
            endpointIdentityDigest: coverage.endpointIdentityDigest,
            requestedModel: coverage.requestedModel,
            responseSchema: coverage.responseSchema,
            pcmAlgorithmVersion: coverage.pcmAlgorithmVersion,
            providerProfileVersion: coverage.providerProfileVersion,
            mergeAlgorithmVersion: coverage.mergeAlgorithmVersion,
        });
        expect(coverage.acquisitionProfileDigest).not.toBe(actualProfileDigest);
        const incompatible = {
            body: fixture.body,
            coverage,
            descriptor: createEditorialTranscriptDescriptorV2({
                recordId: fixture.descriptor.recordId,
                coverageRecord: coverage,
                requestKey: fixture.descriptor.requestKey,
                sourceId: fixture.descriptor.sourceId,
                sourceFingerprint: fixture.descriptor.sourceFingerprint,
                endpointIdentityDigest: fixture.descriptor.endpointIdentityDigest,
                body: fixture.body,
                acquisition: fixture.descriptor.acquisition,
                createdAt: fixture.descriptor.createdAt,
            }),
        };
        const harness = createHarness();
        const result = await harness.engine.publishEditorialTranscription(
            editorialRequest(harness.engine.getSnapshot(), incompatible),
            editorialHydration(incompatible),
        );
        expect(result).toMatchObject({
            ok: false,
            error: { code: 'SOURCE_CHANGED' },
        });
        expect(harness.persistence.commits).toHaveLength(0);
    });

    it('publishes subtitle cues and provenance without adding editorial descriptors or narrative state', async () => {
        const harness = createHarness();
        const before = harness.engine.getSnapshot();
        const result = await harness.engine.publishSubtitleTranscription(
            subtitleRequest(before),
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject({
            replayed: false,
            publicationKind: 'subtitle',
            trackIds: ['subtitle-target'],
        });
        expect(harness.persistence.commits).toHaveLength(1);
        expect(harness.persistence.commits[0].transcriptionPublication).toEqual({
            schemaVersion: 1,
            kind: 'subtitle',
            records: [],
        });
        const after = harness.engine.getSnapshot();
        expect(after.manifest.subtitleTracks[0].subtitles).toHaveLength(1);
        expect(after.manifest.transcriptionByTrackId['subtitle-target']).toMatchObject({
            provider: 'local',
            model: 'test-model',
            stale: false,
            sourceDocumentRevision: after.manifest.revision,
            sourceAudioGraphRevision: before.manifest.audioGraphRevision,
        });
        expect(after.manifest.editorialTranscriptDescriptors)
            .toEqual(before.manifest.editorialTranscriptDescriptors);
        expect(after.manifest.narrative).toEqual(before.manifest.narrative);
    });

    it('preserves existing editorial descriptors when subtitle transcription is published', async () => {
        const harness = createHarness();
        const fixture = await editorialFixture();
        expect((await harness.engine.publishEditorialTranscription(
            editorialRequest(harness.engine.getSnapshot(), fixture),
            editorialHydration(fixture),
        )).ok).toBe(true);
        const beforeSubtitle = harness.engine.getSnapshot();

        const result = await harness.engine.publishSubtitleTranscription(
            subtitleRequest(beforeSubtitle, { idempotencyKey: 'subtitle-after-editorial' }),
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(harness.engine.getSnapshot().manifest.editorialTranscriptDescriptors)
            .toEqual(beforeSubtitle.manifest.editorialTranscriptDescriptors);
    });

    it('does not hydrate or depend on editorial CAS bodies for subtitle-only publication', async () => {
        const fixture = await editorialFixture();
        const manifest = publicationManifest({
            editorialTranscriptDescriptors: [fixture.descriptor],
        });
        const harness = createHarness({ manifest });
        const snapshot = harness.engine.getSnapshot();
        const result = await harness.engine.publishSubtitleTranscription(
            subtitleRequest(snapshot, { idempotencyKey: 'subtitle-with-offline-editorial-cas' }),
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(harness.engine.getSnapshot().manifest.editorialTranscriptDescriptors)
            .toEqual([fixture.descriptor]);
    });

    it('creates deterministic one-track-per-speaker diarization in one history transaction', async () => {
        const build = async () => {
            const harness = createHarness();
            const snapshot = harness.engine.getSnapshot();
            const target = snapshot.manifest.subtitleTracks[0];
            const cue = (id: string, text: string) => ({
                id,
                startTime: 0,
                endTime: 1,
                text,
            });
            const request = subtitleRequest(snapshot, {
                idempotencyKey: 'publish-diarized',
                publications: [{
                    kind: 'diarized',
                    targetTrackId: target.id,
                    targetAnchors: [targetAnchor(snapshot.manifest, target)],
                    speakers: [{
                        speakerOrdinal: 1,
                        sourceSpeakerLabel: 'SPEAKER_B',
                        subtitles: [cue('cue-b', 'Speaker B')],
                        transcription: {
                            raw: [cue('cue-b', 'Speaker B')],
                            groups: {},
                            containerIds: [],
                        },
                    }, {
                        speakerOrdinal: 0,
                        sourceSpeakerLabel: 'SPEAKER_A',
                        subtitles: [cue('cue-a', 'Speaker A')],
                        transcription: {
                            raw: [cue('cue-a', 'Speaker A')],
                            groups: {},
                            containerIds: [],
                        },
                    }],
                    metadata: {
                        provider: 'local-diarization',
                        generatedAt: NOW.iso,
                    },
                }],
            });
            const result = await harness.engine.publishSubtitleTranscription(request);
            return { harness, result, snapshot: harness.engine.getSnapshot() };
        };
        const first = await build();
        const second = await build();

        expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
        expect(first.snapshot.manifest.subtitleTracks).toHaveLength(2);
        expect(first.snapshot.manifest.subtitleTracks.map((track) => track.id))
            .toEqual(second.snapshot.manifest.subtitleTracks.map((track) => track.id));
        expect(first.snapshot.manifest.subtitleTracks.map((track) => track.subtitles[0].text))
            .toEqual(['Speaker A', 'Speaker B']);
        expect(first.harness.persistence.commits).toHaveLength(1);
        expect(first.harness.persistence.commits[0].history.past).toHaveLength(1);
        expect(first.harness.events).toHaveLength(1);
    });

    it('fails locked, stale, and multi-target invalid publications atomically', async () => {
        const lockedTrack = createSubtitleTrackV4Fixture({
            id: 'locked-target',
            name: 'Locked',
            isLocked: true,
        });
        const openTrack = createSubtitleTrackV4Fixture({
            id: 'open-target',
            name: 'Open',
        });
        const manifest = publicationManifest({
            subtitleTracks: [openTrack, lockedTrack],
            activeSubtitleTrackId: openTrack.id,
        });
        const harness = createHarness({ manifest });
        const snapshot = harness.engine.getSnapshot();
        const single = (track: SubtitleTrackV4, id: string) => {
            const cue = { id, startTime: 0, endTime: 1, text: id };
            return {
                kind: 'single-track' as const,
                targetTrackId: track.id,
                targetAnchors: [targetAnchor(snapshot.manifest, track)],
                payload: {
                    subtitles: [cue],
                    transcription: { raw: [cue], groups: {}, containerIds: [] },
                },
                metadata: { provider: 'local', generatedAt: NOW.iso },
            };
        };
        const locked = await harness.engine.publishSubtitleTranscription(
            subtitleRequest(snapshot, {
                idempotencyKey: 'multi-target-locked',
                publications: [single(openTrack, 'open-cue'), single(lockedTrack, 'locked-cue')],
            }),
        );
        expect(locked).toMatchObject({ ok: false, error: { code: 'LOCKED_TARGET' } });
        expect(harness.persistence.commits).toHaveLength(0);
        expect(harness.engine.getSnapshot()).toEqual(snapshot);

        const staleRequest = subtitleRequest(snapshot, {
            idempotencyKey: 'stale-target',
            publications: [single(openTrack, 'stale-cue')],
        });
        staleRequest.publications[0].targetAnchors[0].trackSignature = 'fnv1a64:stale';
        const stale = await harness.engine.publishSubtitleTranscription(staleRequest);
        expect(stale).toMatchObject({
            ok: false,
            error: { code: 'STALE_TRANSCRIPTION_PUBLICATION', retryable: true },
        });
        expect(harness.persistence.commits).toHaveLength(0);
    });

    it('persists a receipt-only no-op without a fake revision, history entry, or event', async () => {
        const harness = createHarness();
        const fixture = await editorialFixture();
        const firstRequest = editorialRequest(harness.engine.getSnapshot(), fixture);
        expect((await harness.engine.publishEditorialTranscription(
            firstRequest,
            editorialHydration(fixture),
        )).ok).toBe(true);
        const afterFirst = harness.engine.getSnapshot();

        const noOpRequest = editorialRequest(afterFirst, fixture, {
            idempotencyKey: 'publish-editorial-no-op',
            publications: [{
                descriptor: fixture.descriptor,
                expectedCoverageRecordIds: [fixture.coverage.recordId],
            }],
        });
        const noOp = await harness.engine.publishEditorialTranscription(
            noOpRequest,
            editorialHydration(fixture, [fixture.coverage.recordId]),
        );

        expect(noOp).toMatchObject({
            ok: true,
            replayed: false,
            noOp: true,
            historyEntryId: null,
            eventId: null,
        });
        expect(harness.engine.getSnapshot().revisions).toEqual(afterFirst.revisions);
        expect(harness.persistence.commits).toHaveLength(2);
        expect(harness.persistence.commits[1].previous).toEqual(
            harness.persistence.commits[1].next,
        );
        expect(harness.events).toHaveLength(1);
        expect(harness.listener).toHaveBeenCalledTimes(1);
    });

    it('leaves state, history, event sequence, and listeners unchanged on commit failure', async () => {
        const harness = createHarness({ initialEventSequence: 7 });
        const before = harness.engine.getSnapshot();
        harness.persistence.failCommit = true;
        const result = await harness.engine.publishSubtitleTranscription(
            subtitleRequest(before),
        );
        expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(harness.persistence.commits).toHaveLength(0);
        expect(harness.events).toHaveLength(0);
        expect(harness.listener).not.toHaveBeenCalled();

        harness.persistence.failCommit = false;
        const retry = await harness.engine.publishSubtitleTranscription(
            subtitleRequest(before),
        );
        expect(retry.ok).toBe(true);
        expect(harness.events[0].sequence).toBe(8);
    });

    it('projects a terminal coverage CAS race as stable stale rather than cancellation', async () => {
        const harness = createHarness();
        const before = harness.engine.getSnapshot();
        const fixture = await editorialFixture();
        harness.persistence.commitError = new StaleTranscriptionPublicationError(
            'The managed coverage head changed.',
            [fixture.descriptor.sourceId],
        );
        const result = await harness.engine.publishEditorialTranscription(
            editorialRequest(before, fixture),
            editorialHydration(fixture),
        );
        expect(result).toMatchObject({
            ok: false,
            error: {
                code: 'STALE_TRANSCRIPTION_PUBLICATION',
                retryable: true,
            },
        });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(harness.events).toHaveLength(0);
    });

    it('restores editorial references and exact body pins through undo, redo, and jump', async () => {
        const harness = createHarness();
        const fixture = await editorialFixture();
        const published = await harness.engine.publishEditorialTranscription(
            editorialRequest(harness.engine.getSnapshot(), fixture),
            editorialHydration(fixture),
        );
        expect(published.ok).toBe(true);
        if (!published.ok) return;
        const entryId = published.historyEntryId!;

        const undone = await harness.engine.undo(
            historyRequest(harness.engine.getSnapshot(), 'undo-editorial'),
        );
        expect(undone.ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.editorialTranscriptDescriptors).toEqual([]);
        expect(harness.persistence.commits.at(-1)?.transcriptPins).toEqual({
            durableRecordIds: [],
            historyRecordIds: [],
            redoRecordIds: [fixture.descriptor.recordId],
        });

        const redone = await harness.engine.redo(
            historyRequest(harness.engine.getSnapshot(), 'redo-editorial'),
        );
        expect(redone.ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.editorialTranscriptDescriptors)
            .toEqual([fixture.descriptor]);
        expect(harness.persistence.commits.at(-1)?.transcriptPins).toEqual({
            durableRecordIds: [fixture.descriptor.recordId],
            historyRecordIds: [fixture.descriptor.recordId],
            redoRecordIds: [],
        });

        const snapshot = harness.engine.getSnapshot();
        const jump: HistoryJumpRequest = {
            ...historyRequest(snapshot, 'jump-before-editorial'),
            entryId,
            position: 'before',
        };
        const jumped = await harness.engine.jumpToHistory(jump);
        expect(jumped.ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.editorialTranscriptDescriptors).toEqual([]);
        expect(harness.persistence.commits.at(-1)?.transcriptPins.redoRecordIds)
            .toEqual([fixture.descriptor.recordId]);
    });

    it('restores subtitle cues and provenance through undo, redo, and jump', async () => {
        const harness = createHarness();
        const before = harness.engine.getSnapshot();
        const published = await harness.engine.publishSubtitleTranscription(
            subtitleRequest(before),
        );
        expect(published.ok, JSON.stringify(published)).toBe(true);
        if (!published.ok) return;
        const publishedSnapshot = harness.engine.getSnapshot();
        const entryId = published.historyEntryId!;
        expect(publishedSnapshot.manifest.subtitleTracks[0].subtitles).toHaveLength(1);
        expect(publishedSnapshot.manifest.transcriptionByTrackId['subtitle-target'])
            .toBeDefined();

        expect((await harness.engine.undo(
            historyRequest(publishedSnapshot, 'undo-subtitles'),
        )).ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.subtitleTracks[0].subtitles).toEqual([]);
        expect(harness.engine.getSnapshot().manifest.transcriptionByTrackId).toEqual({});

        expect((await harness.engine.redo(
            historyRequest(harness.engine.getSnapshot(), 'redo-subtitles'),
        )).ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.subtitleTracks[0].subtitles)
            .toEqual(publishedSnapshot.manifest.subtitleTracks[0].subtitles);
        expect(harness.engine.getSnapshot().manifest.transcriptionByTrackId)
            .toEqual(publishedSnapshot.manifest.transcriptionByTrackId);

        const snapshot = harness.engine.getSnapshot();
        const jump: HistoryJumpRequest = {
            ...historyRequest(snapshot, 'jump-before-subtitles'),
            entryId,
            position: 'before',
        };
        expect((await harness.engine.jumpToHistory(jump)).ok).toBe(true);
        expect(harness.engine.getSnapshot().manifest.subtitleTracks[0].subtitles).toEqual([]);
        expect(harness.engine.getSnapshot().manifest.transcriptionByTrackId).toEqual({});
    });

    it('rejects a malformed record in an atomic multi-source editorial publication', async () => {
        const secondSource = {
            ...publicationManifest().videoSourceDescriptors[0],
            id: 'video-source-second',
            fingerprint: 'second-source-fingerprint',
        };
        const manifest = publicationManifest({
            videoSourceDescriptors: [
                ...publicationManifest().videoSourceDescriptors,
                secondSource,
            ],
        });
        const first = await editorialFixture();
        const second = await editorialFixture({
            sourceId: secondSource.id,
            sourceFingerprint: secondSource.fingerprint,
            requestKey: `sha256:${'d'.repeat(64)}` as Sha256Digest,
        });
        const harness = createHarness({ manifest });
        const snapshot = harness.engine.getSnapshot();
        const request: EditorialTranscriptionPublicationRequest = {
            ...editorialRequest(snapshot, first),
            idempotencyKey: 'multi-source-editorial',
            publications: [{
                descriptor: first.descriptor,
                expectedCoverageRecordIds: [],
            }, {
                descriptor: second.descriptor,
                expectedCoverageRecordIds: [],
            }],
        };
        const hydration: EditorialTranscriptionPublicationHydration = {
            records: [
                editorialHydration(first).records[0],
                {
                    ...editorialHydration(second).records[0],
                    body: first.body,
                },
            ],
        };
        const result = await harness.engine.publishEditorialTranscription(request, hydration);
        expect(result).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED' } });
        expect(harness.persistence.commits).toHaveLength(0);
        expect(harness.engine.getSnapshot()).toEqual(snapshot);
    });
});
