import { describe, expect, it, vi } from 'vitest';
import { createVideoSourceFingerprint } from '@/lib/video-timeline';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { createEditorManifestV4Fixture } from '@/types/editorial.test-fixtures';
import type {
    AudioSourceDescriptor,
    EditorManifestV4,
    VideoSourceDescriptorV3,
} from '@/types/video';
import { createDescriptorAssetHydration } from './editor-command-planner';
import {
    createEditorEngine,
    DeterministicEditorIdGenerator,
    EDITOR_OPERATION_TYPES,
    FixedEditorClock,
    type EditorAssetHydration,
    type EditorEngineEvent,
    type EditorEnginePorts,
    type EditorEngineSnapshot,
    type EditorIdempotencyReceipt,
    type EditorMediaImportPlacement,
    type EditorMediaImportRequest,
    type EditorPersistenceCommit,
    type EditorPersistencePort,
    type HistoryMutationRequest,
} from '.';

const NOW = {
    iso: '2026-07-25T16:00:00.000Z',
    epochMs: Date.parse('2026-07-25T16:00:00.000Z'),
};
const PROJECT_ID = 'media-import-project';
const SESSION_EPOCH = 'media-import-epoch';

class MemoryPersistence implements EditorPersistencePort {
    readonly commits: EditorPersistenceCommit[] = [];
    readonly receipts = new Map<string, EditorIdempotencyReceipt>();
    failCommit = false;

    constructor(private readonly onCommit: (commit: EditorPersistenceCommit) => void) {}

    async getReceipt(
        projectId: string,
        toolName: string,
        idempotencyKey: string,
    ): Promise<EditorIdempotencyReceipt | null> {
        return structuredClone(
            this.receipts.get(`${projectId}\u0000${toolName}\u0000${idempotencyKey}`) ?? null,
        );
    }

    async commit(input: EditorPersistenceCommit): Promise<void> {
        if (this.failCommit) throw new Error('injected media-import commit failure');
        const commit = structuredClone(input);
        this.commits.push(commit);
        this.receipts.set(
            `${input.projectId}\u0000${input.receipt.toolName}\u0000${input.receipt.key}`,
            structuredClone(input.receipt.value),
        );
        this.onCommit(commit);
    }
}

function createHarness(manifest = emptyManifest()) {
    const knownVideo = new Map<string, EditorAssetHydration['videoSources'][number]>();
    const knownAudio = new Map<string, EditorAssetHydration['audioSources'][number]>();
    const initialHydration = createDescriptorAssetHydration(manifest);
    initialHydration.videoSources.forEach((source) => knownVideo.set(source.id, source));
    initialHydration.audioSources.forEach((source) => knownAudio.set(source.id, source));
    const remember = (hydration: EditorAssetHydration): void => {
        hydration.videoSources.forEach((source) => knownVideo.set(source.id, structuredClone(source)));
        hydration.audioSources.forEach((source) => knownAudio.set(source.id, structuredClone(source)));
    };
    const persistence = new MemoryPersistence((commit) => remember(commit.sourceRegistrations));
    const emitted: EditorEngineEvent[] = [];
    const listener = vi.fn();
    const assetCalls: Array<{ videoSourceIds: string[]; audioSourceIds: string[] }> = [];
    const ports: EditorEnginePorts = {
        persistence,
        assets: {
            hydrate: async ({ videoSourceIds, audioSourceIds }) => {
                assetCalls.push({
                    videoSourceIds: [...videoSourceIds],
                    audioSourceIds: [...audioSourceIds],
                });
                return {
                    videoSources: videoSourceIds.flatMap((id) => {
                        const source = knownVideo.get(id);
                        return source ? [structuredClone(source)] : [];
                    }),
                    audioSources: audioSourceIds.flatMap((id) => {
                        const source = knownAudio.get(id);
                        return source ? [structuredClone(source)] : [];
                    }),
                };
            },
        },
        transcripts: {
            hydrate: async () => ({}),
        },
        clock: new FixedEditorClock(NOW),
        ids: new DeterministicEditorIdGenerator(PROJECT_ID),
        events: {
            emit: (event) => {
                emitted.push(structuredClone(event));
            },
        },
    };
    const engine = createEditorEngine({
        projectId: PROJECT_ID,
        sessionEpoch: SESSION_EPOCH,
        initialManifest: manifest,
        ports,
        closePorts: false,
    });
    engine.subscribe(listener);
    return {
        engine,
        persistence,
        emitted,
        listener,
        assetCalls,
        knownVideo,
        knownAudio,
    };
}

function emptyManifest(overrides: Partial<EditorManifestV4> = {}): EditorManifestV4 {
    return createEditorManifestV4Fixture({
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
        videoSourceDescriptors: [],
        videoClips: [],
        audioSourceDescriptors: [],
        audioTracks: [],
        ...overrides,
    });
}

function videoDescriptor(input: {
    id: string;
    name: string;
    duration?: number;
    hasAudio?: boolean;
}): VideoSourceDescriptorV3 {
    const metadata = {
        name: input.name,
        type: 'video/mp4',
        size: 1_000 + input.id.length,
        lastModified: 1_700_000_000_000 + input.id.length,
    };
    return {
        id: input.id,
        originalName: metadata.name,
        mimeType: metadata.type,
        size: metadata.size,
        lastModified: metadata.lastModified,
        fingerprint: createVideoSourceFingerprint(metadata),
        duration: input.duration ?? 1,
        fps: 30,
        width: 1_920,
        height: 1_080,
        bitrate: 5_000_000,
        hasAudio: input.hasAudio ?? true,
    };
}

function audioDescriptor(input: {
    id: string;
    name: string;
    duration?: number;
}): AudioSourceDescriptor {
    const duration = input.duration ?? 1;
    const metadata = {
        name: input.name,
        type: 'audio/wav',
        size: 2_000 + input.id.length,
        lastModified: 1_700_000_100_000 + input.id.length,
    };
    return {
        id: input.id,
        originalName: metadata.name,
        mimeType: metadata.type,
        size: metadata.size,
        lastModified: metadata.lastModified,
        fingerprint: createVideoSourceFingerprint(metadata),
        duration,
        nativeSampleRate: 48_000,
        nativeSampleCount: duration * 48_000,
        nativeChannelCount: 2,
        bitrate: 1_536_000,
        codec: 'pcm_s16le',
    };
}

function hydration(input: {
    video?: VideoSourceDescriptorV3[];
    audio?: AudioSourceDescriptor[];
    digestById?: Record<string, `sha256:${string}`>;
}): EditorAssetHydration {
    const hydrate = <T extends VideoSourceDescriptorV3 | AudioSourceDescriptor>(
        descriptor: T,
    ) => ({
        ...structuredClone(descriptor),
        handle: {
            schemaVersion: 1,
            handleId: `handle-${descriptor.id}`,
            capabilityId: `capability-${descriptor.id}`,
            identity: {
                schemaVersion: 1,
                contentDigest: input.digestById?.[descriptor.id] ?? digest(descriptor.id),
                descriptorFingerprint: descriptor.fingerprint,
                byteLength: descriptor.size,
                immutableVersion: `immutable-${descriptor.id}`,
                streamMetadataRefs: [],
            },
            verifiedAt: NOW.iso,
        },
        fileMetadata: {
            name: descriptor.originalName,
            type: descriptor.mimeType,
            size: descriptor.size,
            lastModified: descriptor.lastModified,
        },
    });
    return {
        videoSources: (input.video ?? []).map(
            (descriptor) => hydrate(descriptor),
        ) as EditorAssetHydration['videoSources'],
        audioSources: (input.audio ?? []).map(
            (descriptor) => hydrate(descriptor),
        ) as EditorAssetHydration['audioSources'],
    };
}

function digest(seed: string): `sha256:${string}` {
    const nibble = Array.from(seed).reduce((sum, value) => sum + value.codePointAt(0)!, 0) % 16;
    return `sha256:${nibble.toString(16).repeat(64)}`;
}

function importRequest(
    snapshot: EditorEngineSnapshot,
    input: {
        video?: VideoSourceDescriptorV3[];
        audio?: AudioSourceDescriptor[];
        placement?: EditorMediaImportPlacement;
        key: string;
    },
): EditorMediaImportRequest {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_media_import',
        sessionEpoch: SESSION_EPOCH,
        expected: expectedRevisions(snapshot),
        idempotencyKey: input.key,
        sources: {
            videoSourceDescriptors: structuredClone(input.video ?? []),
            audioSourceDescriptors: structuredClone(input.audio ?? []),
        },
        placement: input.placement ?? { kind: 'register-only' },
    };
}

function expectedRevisions(snapshot: EditorEngineSnapshot): EditorMediaImportRequest['expected'] {
    return {
        sessionRevision: snapshot.revisions.sessionRevision,
        documentRevision: snapshot.revisions.documentRevision,
        audioGraphRevision: snapshot.revisions.audioGraphRevision,
        ...(snapshot.revisions.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: snapshot.revisions.narrativeRevision }),
    };
}

function historyRequest(
    snapshot: EditorEngineSnapshot,
    key: string,
): HistoryMutationRequest {
    return {
        apiVersion: '2026-07-25',
        toolName: 'waptions_history_apply',
        sessionEpoch: SESSION_EPOCH,
        expected: expectedRevisions(snapshot),
        idempotencyKey: key,
    };
}

describe('EditorEngine internal atomic media import', () => {
    it('keeps the public semantic operation vocabulary at exactly 65 operations', () => {
        expect(EDITOR_OPERATION_TYPES).toHaveLength(65);
        expect(EDITOR_OPERATION_TYPES).not.toContain('media.import');
    });

    it('publishes neither descriptors, history, events, registrations, nor revisions when commit fails', async () => {
        const harness = createHarness();
        const source = videoDescriptor({ id: 'video-atomic', name: 'Atomic 1.mp4' });
        const before = harness.engine.getSnapshot();
        const request = importRequest(before, { video: [source], key: 'atomic-failure' });
        harness.persistence.failCommit = true;

        const failed = await harness.engine.importMedia(request, hydration({ video: [source] }));

        expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
        expect(harness.engine.getSnapshot()).toEqual(before);
        expect(harness.persistence.commits).toHaveLength(0);
        expect(harness.knownVideo.has(source.id)).toBe(false);
        expect(harness.emitted).toHaveLength(0);
        expect(harness.listener).not.toHaveBeenCalled();

        harness.persistence.failCommit = false;
        const committed = await harness.engine.importMedia(request, hydration({ video: [source] }));
        expect(committed).toMatchObject({ ok: true, replayed: false, noOp: false });
        expect(harness.persistence.commits[0].event?.sequence).toBe(1);
    });

    it('resolves exact receipts before hydration, epoch, and revision guards and rejects key conflicts', async () => {
        const harness = createHarness();
        const source = videoDescriptor({ id: 'video-replay', name: 'Replay.mp4' });
        const before = harness.engine.getSnapshot();
        const request = importRequest(before, { video: [source], key: 'replay-key' });
        const first = await harness.engine.importMedia(request, hydration({ video: [source] }));
        expect(first).toMatchObject({ ok: true, replayed: false });

        const replay = await harness.engine.importMedia(request);
        expect(replay).toMatchObject({
            ok: true,
            replayed: true,
            sourceIds: [source.id],
            placedClipIds: [],
        });
        expect(harness.persistence.commits).toHaveLength(1);

        const conflicting = await harness.engine.importMedia({
            ...request,
            placement: {
                kind: 'place',
                ordering: 'natural',
                timelineStartFrame: 300,
            },
        });
        expect(conflicting).toMatchObject({
            ok: false,
            error: { code: 'IDEMPOTENCY_KEY_CONFLICT' },
        });
    });

    it('fails closed on hydration, descriptor, content, and media-class identity mismatches', async () => {
        const harness = createHarness();
        const source = videoDescriptor({ id: 'identity-source', name: 'Identity.mp4' });
        const before = harness.engine.getSnapshot();
        const mismatchedHydration = hydration({ video: [source] });
        mismatchedHydration.videoSources[0].handle.identity.byteLength += 1;
        const hydrationFailure = await harness.engine.importMedia(
            importRequest(before, { video: [source], key: 'hydration-mismatch' }),
            mismatchedHydration,
        );
        expect(hydrationFailure).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED' } });
        expect(harness.persistence.commits).toHaveLength(0);

        const registered = await harness.engine.importMedia(
            importRequest(before, { video: [source], key: 'register-identity' }),
            hydration({ video: [source] }),
        );
        expect(registered.ok).toBe(true);
        const current = harness.engine.getSnapshot();

        const descriptorMismatch = { ...source, duration: source.duration + 1 };
        const descriptorFailure = await harness.engine.importMedia(
            importRequest(current, { video: [descriptorMismatch], key: 'descriptor-mismatch' }),
            hydration({ video: [descriptorMismatch] }),
        );
        expect(descriptorFailure).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED' } });

        const contentFailure = await harness.engine.importMedia(
            importRequest(current, { video: [source], key: 'content-mismatch' }),
            hydration({
                video: [source],
                digestById: { [source.id]: `sha256:${'f'.repeat(64)}` },
            }),
        );
        expect(contentFailure).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED' } });

        const wrongClass = audioDescriptor({ id: source.id, name: 'Identity.wav' });
        const classFailure = await harness.engine.importMedia(
            importRequest(current, { audio: [wrongClass], key: 'class-mismatch' }),
            hydration({ audio: [wrongClass] }),
        );
        expect(classFailure).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED' } });
        expect(harness.persistence.commits).toHaveLength(1);
    });

    it('places mixed sources in canonical natural order and creates deterministic linked occurrences', async () => {
        const video10 = videoDescriptor({
            id: 'video-10',
            name: 'Scene 10.mp4',
            duration: 2,
            hasAudio: false,
        });
        const audio2 = audioDescriptor({ id: 'audio-2', name: 'Scene 2.wav' });
        const video1 = videoDescriptor({
            id: 'video-1',
            name: 'Scene 1.mp4',
            duration: 1,
            hasAudio: true,
        });
        const sources = { video: [video10, video1], audio: [audio2] };
        const placement: EditorMediaImportPlacement = {
            kind: 'place',
            ordering: 'natural',
            timelineStartFrame: 300,
        };
        const first = createHarness();
        const second = createHarness();
        const firstResult = await first.engine.importMedia(
            importRequest(first.engine.getSnapshot(), { ...sources, placement, key: 'mixed-natural' }),
            hydration(sources),
        );
        const secondResult = await second.engine.importMedia(
            importRequest(second.engine.getSnapshot(), { ...sources, placement, key: 'mixed-natural' }),
            hydration(sources),
        );

        expect(firstResult).toMatchObject({
            ok: true,
            noOp: false,
            sourceIds: ['video-1', 'audio-2', 'video-10'],
        });
        expect(secondResult.ok).toBe(true);
        if (!firstResult.ok || !secondResult.ok) throw new Error('Expected successful imports.');
        expect(secondResult.placedClipIds).toEqual(firstResult.placedClipIds);
        const snapshot = firstResult.snapshot;
        const firstVideo = snapshot.manifest.videoClips.find((clip) => clip.sourceId === video1.id)!;
        const secondVideo = snapshot.manifest.videoClips.find((clip) => clip.sourceId === video10.id)!;
        const audioTrack = snapshot.manifest.audioTracks[0];
        expect(firstVideo).toMatchObject({
            timelineStartFrame: 300,
            audio: { linkState: 'linked' },
        });
        expect(audioTrack).toMatchObject({ name: 'Audio 1', locked: false });
        expect(audioTrack.clips[0]).toMatchObject({
            timelineStartFrame: 330,
            source: { kind: 'audio-source', audioSourceId: audio2.id },
        });
        expect(secondVideo).toMatchObject({
            timelineStartFrame: 360,
            audio: null,
        });
        expect(first.persistence.commits).toHaveLength(1);
        expect(first.persistence.commits[0].history.past).toHaveLength(1);
        expect(first.persistence.commits[0].event?.sequence).toBe(1);
        expect(first.listener).toHaveBeenCalledTimes(1);
    });

    it('locks the first video render profile atomically and rejects audio-first unlocked projects', async () => {
        const unlocked = emptyManifest({
            renderProfile: createDefaultRenderProfile(),
        });
        const harness = createHarness(unlocked);
        const source = {
            ...videoDescriptor({
                id: 'video-first-profile',
                name: 'First profile.mp4',
                hasAudio: false,
            }),
            fps: 30_000 / 1_001,
            width: 1_280,
            height: 720,
        };
        const before = harness.engine.getSnapshot();
        const imported = await harness.engine.importMedia(
            importRequest(before, {
                video: [source],
                key: 'first-video-profile',
                placement: {
                    kind: 'place',
                    ordering: 'natural',
                    timelineStartFrame: 0,
                },
            }),
            hydration({ video: [source] }),
        );

        expect(imported).toMatchObject({
            ok: true,
            snapshot: {
                manifest: {
                    renderProfile: {
                        fps: { numerator: 30_000, denominator: 1_001 },
                        width: 1_280,
                        height: 720,
                        isFrameRateLocked: true,
                        isCanvasSizeLocked: true,
                    },
                },
                revisions: {
                    sessionRevision: before.revisions.sessionRevision + 1,
                    documentRevision: before.revisions.documentRevision + 1,
                    audioGraphRevision: before.revisions.audioGraphRevision + 1,
                },
            },
        });
        expect(harness.persistence.commits).toHaveLength(1);
        expect(harness.persistence.commits[0].history.past).toHaveLength(1);
        expect(harness.persistence.commits[0].event?.sequence).toBe(1);

        const audioHarness = createHarness(unlocked);
        const audio = audioDescriptor({ id: 'audio-first', name: 'Audio first.wav' });
        const beforeAudio = audioHarness.engine.getSnapshot();
        const rejected = await audioHarness.engine.importMedia(
            importRequest(beforeAudio, {
                audio: [audio],
                key: 'audio-first-unlocked',
                placement: {
                    kind: 'place',
                    ordering: 'natural',
                    timelineStartFrame: 0,
                },
            }),
            hydration({ audio: [audio] }),
        );
        expect(rejected).toMatchObject({
            ok: false,
            error: {
                code: 'INVALID_REQUEST',
                message: 'Import a video first to establish the project frame rate and canvas size.',
            },
        });
        expect(audioHarness.persistence.commits).toHaveLength(0);
        expect(audioHarness.engine.getSnapshot()).toEqual(beforeAudio);
    });

    it('rejects locked, missing, and overlapping targets without partial registration', async () => {
        const source = videoDescriptor({ id: 'video-target', name: 'Target.mp4' });
        const locked = createHarness(emptyManifest({
            videoTracks: [{
                id: 'locked-video',
                name: 'Locked',
                visible: true,
                locked: true,
            }],
        }));
        const lockedResult = await locked.engine.importMedia(
            importRequest(locked.engine.getSnapshot(), {
                video: [source],
                key: 'locked-target',
                placement: {
                    kind: 'place',
                    ordering: 'natural',
                    timelineStartFrame: 0,
                    videoTrackId: 'locked-video',
                },
            }),
            hydration({ video: [source] }),
        );
        expect(lockedResult).toMatchObject({ ok: false, error: { code: 'LOCKED_TARGET' } });
        expect(locked.persistence.commits).toHaveLength(0);

        const audio = audioDescriptor({ id: 'audio-missing', name: 'Missing.wav' });
        const missing = createHarness();
        const missingResult = await missing.engine.importMedia(
            importRequest(missing.engine.getSnapshot(), {
                audio: [audio],
                key: 'missing-target',
                placement: {
                    kind: 'place',
                    ordering: 'natural',
                    timelineStartFrame: 0,
                    audioTrackId: 'missing-audio-track',
                },
            }),
            hydration({ audio: [audio] }),
        );
        expect(missingResult).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(missing.persistence.commits).toHaveLength(0);

        const occupiedSource = videoDescriptor({
            id: 'occupied',
            name: 'Occupied.mp4',
            hasAudio: false,
        });
        const occupied = emptyManifest({
            videoSourceDescriptors: [occupiedSource],
            videoClips: [{
                id: 'occupied-clip',
                sourceId: occupiedSource.id,
                trackId: 'video_track_editorial',
                timelineStartFrame: 0,
                sourceStart: 0,
                sourceEnd: 1,
                audio: null,
            }],
        });
        const overlap = createHarness(occupied);
        const overlapResult = await overlap.engine.importMedia(
            importRequest(overlap.engine.getSnapshot(), {
                video: [source],
                key: 'overlap-target',
                placement: {
                    kind: 'place',
                    ordering: 'natural',
                    timelineStartFrame: 0,
                    videoTrackId: 'video_track_editorial',
                },
            }),
            hydration({ video: [source] }),
        );
        expect(overlapResult).toMatchObject({ ok: false, error: { code: 'OVERLAP_CONFLICT' } });
        expect(overlap.persistence.commits).toHaveLength(0);
        expect(overlap.engine.getSnapshot().manifest.videoSourceDescriptors)
            .toEqual([occupiedSource]);
    });

    it('makes identical register-only imports durable no-ops but reuses descriptors for new placements', async () => {
        const harness = createHarness();
        const source = videoDescriptor({
            id: 'video-reimport',
            name: 'Reimport.mp4',
            hasAudio: false,
        });
        const first = await harness.engine.importMedia(
            importRequest(harness.engine.getSnapshot(), {
                video: [source],
                key: 'first-register',
            }),
            hydration({ video: [source] }),
        );
        expect(first).toMatchObject({ ok: true, noOp: false });

        const noOp = await harness.engine.importMedia(
            importRequest(harness.engine.getSnapshot(), {
                video: [source],
                key: 'second-register',
            }),
            hydration({ video: [source] }),
        );
        expect(noOp).toMatchObject({
            ok: true,
            noOp: true,
            noOpReason: 'sources-already-registered',
        });
        expect(harness.persistence.commits[1]).toMatchObject({
            event: null,
            sourceRegistrations: { videoSources: [], audioSources: [] },
        });
        const afterNoOp = harness.engine.getSnapshot();
        expect(afterNoOp.revisions).toEqual(first.ok ? first.snapshot.revisions : null);
        expect(afterNoOp.history.past).toHaveLength(1);

        const placed = await harness.engine.importMedia(
            importRequest(afterNoOp, {
                video: [source],
                key: 'place-reused',
                placement: {
                    kind: 'place',
                    ordering: 'natural',
                    timelineStartFrame: 300,
                },
            }),
            hydration({ video: [source] }),
        );
        expect(placed).toMatchObject({ ok: true, noOp: false });
        if (!placed.ok) throw new Error('Expected successful placement.');
        expect(placed.snapshot.manifest.videoSourceDescriptors).toHaveLength(1);
        expect(placed.snapshot.manifest.videoClips).toHaveLength(1);
        expect(harness.persistence.commits[2].sourceRegistrations.videoSources).toHaveLength(0);
    });

    it('keeps register-only history undoable and pins sources precisely across current, history, and redo', async () => {
        const harness = createHarness();
        const source = videoDescriptor({ id: 'video-pinned', name: 'Pinned.mp4' });
        const imported = await harness.engine.importMedia(
            importRequest(harness.engine.getSnapshot(), {
                video: [source],
                key: 'pin-register',
            }),
            hydration({ video: [source] }),
        );
        expect(imported.ok).toBe(true);
        expect(harness.persistence.commits[0].sourcePins).toEqual({
            current: { videoSourceIds: [source.id], audioSourceIds: [] },
            history: { videoSourceIds: [source.id], audioSourceIds: [] },
            redo: { videoSourceIds: [], audioSourceIds: [] },
        });

        const undone = await harness.engine.undo(
            historyRequest(harness.engine.getSnapshot(), 'pin-undo'),
        );
        expect(undone).toMatchObject({ ok: true, noOp: false });
        expect(harness.engine.getSnapshot().manifest.videoSourceDescriptors).toHaveLength(0);
        expect(harness.persistence.commits[1].sourcePins).toEqual({
            current: { videoSourceIds: [], audioSourceIds: [] },
            history: { videoSourceIds: [], audioSourceIds: [] },
            redo: { videoSourceIds: [source.id], audioSourceIds: [] },
        });

        const redone = await harness.engine.redo(
            historyRequest(harness.engine.getSnapshot(), 'pin-redo'),
        );
        expect(redone).toMatchObject({ ok: true, noOp: false });
        expect(harness.engine.getSnapshot().manifest.videoSourceDescriptors).toEqual([source]);
        expect(harness.persistence.commits[2].sourcePins).toEqual({
            current: { videoSourceIds: [source.id], audioSourceIds: [] },
            history: { videoSourceIds: [source.id], audioSourceIds: [] },
            redo: { videoSourceIds: [], audioSourceIds: [] },
        });
    });

    it('advances Core revisions once per changed import and preserves contiguous event sequences', async () => {
        const harness = createHarness();
        const video = videoDescriptor({
            id: 'revision-video',
            name: 'Revision 1.mp4',
            hasAudio: false,
        });
        const before = harness.engine.getSnapshot();
        const registered = await harness.engine.importMedia(
            importRequest(before, { video: [video], key: 'revision-register' }),
            hydration({ video: [video] }),
        );
        expect(registered).toMatchObject({
            ok: true,
            snapshot: {
                revisions: {
                    sessionRevision: before.revisions.sessionRevision + 1,
                    documentRevision: before.revisions.documentRevision + 1,
                    audioGraphRevision: before.revisions.audioGraphRevision,
                },
            },
        });

        const audio = audioDescriptor({ id: 'revision-audio', name: 'Revision 2.wav' });
        const placed = await harness.engine.importMedia(
            importRequest(harness.engine.getSnapshot(), {
                audio: [audio],
                key: 'revision-place',
                placement: {
                    kind: 'place',
                    ordering: 'natural',
                    timelineStartFrame: 300,
                },
            }),
            hydration({ audio: [audio] }),
        );
        expect(placed).toMatchObject({
            ok: true,
            snapshot: {
                revisions: {
                    sessionRevision: before.revisions.sessionRevision + 2,
                    documentRevision: before.revisions.documentRevision + 2,
                    audioGraphRevision: before.revisions.audioGraphRevision + 1,
                },
            },
        });
        expect(harness.emitted.map((event) => event.sequence)).toEqual([1, 2]);
        expect(harness.persistence.commits.map((commit) => commit.event?.sequence)).toEqual([1, 2]);
    });
});
