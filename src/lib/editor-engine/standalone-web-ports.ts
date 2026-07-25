import { hydrateEditorDocumentV4 } from '@/lib/editor-document-v4-migration';
import {
    EditorialTranscriptRepository,
} from '@/lib/storage/editorial-transcript-repository';
import {
    StorageService,
    type EditorPersistentAsset,
    type StandaloneEditorEngineHeadV1,
    type StandaloneEditorSelectionHistoryV1,
} from '@/lib/storage/storage-service';
import type {
    EditorialTranscriptDescriptorV1,
    ResolvedEditorialTranscriptMapV1,
    Sha256Digest,
} from '@/types/editorial';
import type {
    AudioSourceAsset,
    EditorDocumentV4,
    EditorManifestV4,
    TransientMediaSelectionV4,
    VideoSourceAssetV3,
} from '@/types/video';
import type {
    ImmutableMediaIdentityV1,
    VerifiedMediaHandleV1,
} from '@/types/waptions-agent-protocol';
import type { EditorEngineEvent } from './editor-events';
import type {
    EditorAssetHydration,
    EditorAssetRepositoryPort,
    EditorIdempotencyReceipt,
    EditorPersistenceCommit,
    EditorPersistencePort,
    EditorialTranscriptRepositoryPort,
} from './editor-ports';

type StandaloneSourceKind = 'video-source' | 'audio-source';

export class StandaloneEditorAssetRepositoryPort implements EditorAssetRepositoryPort {
    private readonly videoSources = new Map<string, VideoSourceAssetV3>();
    private readonly audioSources = new Map<string, AudioSourceAsset>();
    private readonly handles = new Map<string, Promise<VerifiedMediaHandleV1>>();

    constructor(
        document: Pick<EditorDocumentV4, 'videoSources' | 'audioSources'>,
        private readonly storage?: StorageService,
        private readonly projectId?: string,
    ) {
        document.videoSources.forEach((source) => this.videoSources.set(source.id, source));
        document.audioSources.forEach((source) => this.audioSources.set(source.id, source));
    }

    async hydrate(input: {
        manifest: EditorManifestV4;
        videoSourceIds: readonly string[];
        audioSourceIds: readonly string[];
    }): Promise<EditorAssetHydration> {
        const videoSources = await Promise.all(input.videoSourceIds.map(async (sourceId) => {
            const descriptor = input.manifest.videoSourceDescriptors.find((value) => value.id === sourceId);
            if (!descriptor) throw new Error(`Video source "${sourceId}" is unavailable.`);
            const source = await this.resolveVideoSource(descriptor);
            assertSourceMatchesDescriptor(source, descriptor);
            return {
                ...structuredClone(descriptor),
                handle: await this.getHandle('video-source', source),
                fileMetadata: fileMetadata(source.file),
            };
        }));
        const audioSources = await Promise.all(input.audioSourceIds.map(async (sourceId) => {
            const descriptor = input.manifest.audioSourceDescriptors.find((value) => value.id === sourceId);
            if (!descriptor) throw new Error(`Audio source "${sourceId}" is unavailable.`);
            const source = await this.resolveAudioSource(descriptor);
            assertSourceMatchesDescriptor(source, descriptor);
            return {
                ...structuredClone(descriptor),
                handle: await this.getHandle('audio-source', source),
                fileMetadata: fileMetadata(source.file),
            };
        }));
        return { videoSources, audioSources };
    }

    async prepareMediaImport(
        videoSources: readonly VideoSourceAssetV3[],
        audioSources: readonly AudioSourceAsset[],
    ): Promise<EditorAssetHydration> {
        return {
            videoSources: await Promise.all(videoSources.map(async (source) => {
                assertSourceMatchesDescriptor(source, source);
                return {
                    ...withoutFile(source),
                    handle: await createVerifiedFileHandle('video-source', source),
                    fileMetadata: fileMetadata(source.file),
                };
            })),
            audioSources: await Promise.all(audioSources.map(async (source) => {
                assertSourceMatchesDescriptor(source, source);
                return {
                    ...withoutFile(source),
                    handle: await createVerifiedFileHandle('audio-source', source),
                    fileMetadata: fileMetadata(source.file),
                };
            })),
        };
    }

    resolveStagedRegistrations(
        registrations: EditorAssetHydration,
        staged: readonly EditorPersistentAsset[],
    ): EditorPersistentAsset[] {
        const byKey = new Map(staged.map((entry) => [
            `${entry.kind}:${entry.asset.id}`,
            entry,
        ]));
        return [
            ...registrations.videoSources.map((registration) => {
                const entry = byKey.get(`video-source:${registration.id}`);
                if (!entry || entry.kind !== 'video-source') {
                    throw new Error(`Imported video File "${registration.id}" is unavailable.`);
                }
                assertSourceMatchesDescriptor(entry.asset, registration);
                return entry;
            }),
            ...registrations.audioSources.map((registration) => {
                const entry = byKey.get(`audio-source:${registration.id}`);
                if (!entry || entry.kind !== 'audio-source') {
                    throw new Error(`Imported audio File "${registration.id}" is unavailable.`);
                }
                assertSourceMatchesDescriptor(entry.asset, registration);
                return entry;
            }),
        ];
    }

    adoptCommittedAssets(assets: readonly EditorPersistentAsset[]): void {
        assets.forEach((entry) => {
            if (entry.kind === 'video-source') {
                this.videoSources.set(entry.asset.id, entry.asset);
            } else {
                this.audioSources.set(entry.asset.id, entry.asset);
            }
        });
    }

    hydrateRuntimeDocument(
        manifest: EditorManifestV4,
        selection: TransientMediaSelectionV4,
    ): EditorDocumentV4 {
        const videoSources = manifest.videoSourceDescriptors.map((descriptor) => {
            const source = this.videoSources.get(descriptor.id);
            if (!source) throw new Error(`Video source "${descriptor.id}" is unavailable.`);
            assertSourceMatchesDescriptor(source, descriptor);
            return source;
        });
        const audioSources = manifest.audioSourceDescriptors.map((descriptor) => {
            const source = this.audioSources.get(descriptor.id);
            if (!source) throw new Error(`Audio source "${descriptor.id}" is unavailable.`);
            assertSourceMatchesDescriptor(source, descriptor);
            return source;
        });
        return {
            ...hydrateEditorDocumentV4(manifest, videoSources, audioSources),
            transientSelection: structuredClone(selection),
        };
    }

    private getHandle(
        kind: StandaloneSourceKind,
        source: VideoSourceAssetV3 | AudioSourceAsset,
    ): Promise<VerifiedMediaHandleV1> {
        const key = `${kind}:${source.id}:${source.fingerprint}`;
        const existing = this.handles.get(key);
        if (existing) return existing;
        const created = createVerifiedFileHandle(kind, source);
        this.handles.set(key, created);
        return created;
    }

    private async resolveVideoSource(
        descriptor: EditorManifestV4['videoSourceDescriptors'][number],
    ): Promise<VideoSourceAssetV3> {
        const existing = this.videoSources.get(descriptor.id);
        if (existing) return existing;
        if (!this.storage || !this.projectId) {
            throw new Error(`Video source "${descriptor.id}" is unavailable.`);
        }
        const loaded = await this.storage.loadStandaloneEditorVideoSource(
            this.projectId,
            descriptor,
        );
        this.videoSources.set(loaded.id, loaded);
        return loaded;
    }

    private async resolveAudioSource(
        descriptor: EditorManifestV4['audioSourceDescriptors'][number],
    ): Promise<AudioSourceAsset> {
        const existing = this.audioSources.get(descriptor.id);
        if (existing) return existing;
        if (!this.storage || !this.projectId) {
            throw new Error(`Audio source "${descriptor.id}" is unavailable.`);
        }
        const loaded = await this.storage.loadStandaloneEditorAudioSource(
            this.projectId,
            descriptor,
        );
        this.audioSources.set(loaded.id, loaded);
        return loaded;
    }
}

export class StandaloneEditorialTranscriptRepositoryPort
implements EditorialTranscriptRepositoryPort<ResolvedEditorialTranscriptMapV1> {
    constructor(private readonly repository: EditorialTranscriptRepository) {}

    async hydrate(input: {
        references: readonly {
            recordId: string;
            descriptorVersion: number;
            sourceId: string;
            descriptor: Readonly<Record<string, unknown>>;
        }[];
    }): Promise<ResolvedEditorialTranscriptMapV1> {
        const bodies = await Promise.all(input.references.map(async (reference) => {
            const descriptor = reference.descriptor as unknown as EditorialTranscriptDescriptorV1;
            const body = await this.repository.getRecord(reference.recordId as Sha256Digest, {
                descriptor,
                referenced: true,
            });
            if (!body) throw new Error(`Transcript record "${reference.recordId}" is unavailable.`);
            return [reference.recordId, body] as const;
        }));
        return Object.freeze(Object.fromEntries(bodies)) as ResolvedEditorialTranscriptMapV1;
    }
}

export class StandaloneEditorPersistencePort implements EditorPersistencePort {
    private selectionByHistoryEntryId: Record<string, StandaloneEditorSelectionHistoryV1>;
    private pendingSelection: StandaloneEditorSelectionHistoryV1 | null = null;
    private pendingSourceAssets: EditorPersistentAsset[] = [];
    private pinGeneration: number;
    private history = { past: [], future: [] } as EditorPersistenceCommit['history'];

    constructor(
        private readonly storage: StorageService,
        private readonly transcripts: EditorialTranscriptRepository,
        private readonly projectId: string,
        head: StandaloneEditorEngineHeadV1 | null,
        private readonly onPostCommitError?: (error: unknown) => void,
        initial?: {
            history: EditorPersistenceCommit['history'];
            selectionByHistoryEntryId: Record<string, StandaloneEditorSelectionHistoryV1>;
        },
        private readonly assets?: StandaloneEditorAssetRepositoryPort,
    ) {
        this.selectionByHistoryEntryId = structuredClone(
            head?.selectionByHistoryEntryId ?? initial?.selectionByHistoryEntryId ?? {},
        );
        this.pinGeneration = head?.pinGeneration ?? 0;
        this.history = structuredClone(head?.history ?? initial?.history ?? this.history);
    }

    stageSelection(before: TransientMediaSelectionV4, after: TransientMediaSelectionV4): void {
        this.pendingSelection = {
            before: structuredClone(before),
            after: structuredClone(after),
        };
    }

    discardStagedSelection(): void {
        this.pendingSelection = null;
    }

    stageSourceAssets(assets: readonly EditorPersistentAsset[]): void {
        this.pendingSourceAssets = [...assets];
    }

    discardStagedSourceAssets(): void {
        this.pendingSourceAssets = [];
    }

    selectionForEvent(
        event: EditorEngineEvent,
        fallback: TransientMediaSelectionV4,
        snapshotHistory: { past: Array<{ id: string }> },
    ): TransientMediaSelectionV4 {
        if (!event.historyEntryId) return structuredClone(fallback);
        const context = this.selectionByHistoryEntryId[event.historyEntryId];
        if (!context) return structuredClone(fallback);
        if (event.type === 'project.mutated' || event.action === 'redo') {
            return structuredClone(context.after);
        }
        if (event.action === 'undo') return structuredClone(context.before);
        return structuredClone(
            snapshotHistory.past.at(-1)?.id === event.historyEntryId
                ? context.after
                : context.before,
        );
    }

    getHistory(): EditorPersistenceCommit['history'] {
        return structuredClone(this.history);
    }

    selectionForHistory(
        historyEntryId: string | null,
        position: 'before' | 'after',
        fallback: TransientMediaSelectionV4,
    ): TransientMediaSelectionV4 {
        if (!historyEntryId) return structuredClone(fallback);
        const context = this.selectionByHistoryEntryId[historyEntryId];
        return structuredClone(context?.[position] ?? fallback);
    }

    async getReceipt(
        projectId: string,
        toolName: EditorPersistenceCommit['toolName'],
        idempotencyKey: string,
    ): Promise<EditorIdempotencyReceipt | null> {
        if (projectId !== this.projectId) return null;
        return this.storage.getStandaloneEditorEngineReceipt(
            projectId,
            toolName,
            idempotencyKey,
        );
    }

    async commit(input: EditorPersistenceCommit): Promise<void> {
        if (input.projectId !== this.projectId) {
            throw new Error('Standalone editor persistence project mismatch.');
        }
        const pinGeneration = this.pinGeneration + 1;
        const sourceAssets = this.assets?.resolveStagedRegistrations(
            input.sourceRegistrations,
            this.pendingSourceAssets,
        ) ?? [];
        if (!this.assets
            && (input.sourceRegistrations.videoSources.length > 0
                || input.sourceRegistrations.audioSources.length > 0)) {
            throw new Error('Standalone media registrations require an asset repository.');
        }
        const allRecordIds = unique([
            ...input.transcriptPins.durableRecordIds,
            ...input.transcriptPins.historyRecordIds,
            ...input.transcriptPins.redoRecordIds,
        ]) as Sha256Digest[];
        if (allRecordIds.length > 0) {
            await this.transcripts.setPendingGenerationPins(
                this.projectId,
                pinGeneration,
                allRecordIds,
            );
        }

        const selections = structuredClone(this.selectionByHistoryEntryId);
        if (input.event?.type === 'project.mutated' && this.pendingSelection) {
            selections[input.event.historyEntryId] = structuredClone(this.pendingSelection);
        }
        const retainedHistoryIds = new Set([
            ...input.history.past,
            ...input.history.future,
        ].map((entry) => entry.summary.id));
        Object.keys(selections).forEach((entryId) => {
            if (!retainedHistoryIds.has(entryId)) delete selections[entryId];
        });
        const head: StandaloneEditorEngineHeadV1 = {
            schemaVersion: 1,
            snapshot: structuredClone(input.next),
            history: structuredClone(input.history),
            sessionState: structuredClone(input.sessionState),
            transaction: structuredClone(input.transaction),
            event: structuredClone(input.event),
            transcriptPins: structuredClone(input.transcriptPins),
            sourcePins: structuredClone(input.sourcePins),
            pinGeneration,
            selectionByHistoryEntryId: selections,
        };
        try {
            await this.storage.commitStandaloneEditorEngineHead({
                projectId: this.projectId,
                head,
                receipt: input.receipt.value,
                sourceAssets,
            });
        } catch (error) {
            if (allRecordIds.length > 0) {
                await this.transcripts.clearPendingGenerationPins(
                    this.projectId,
                    pinGeneration,
                ).catch(() => undefined);
            }
            throw error;
        }

        this.pinGeneration = pinGeneration;
        this.assets?.adoptCommittedAssets(sourceAssets);
        this.selectionByHistoryEntryId = selections;
        this.history = structuredClone(input.history);
        this.pendingSelection = null;
        this.pendingSourceAssets = [];
        try {
            await this.transcripts.publishDurableProjectPins({
                projectId: this.projectId,
                generation: pinGeneration,
                durableRecordIds: input.transcriptPins.durableRecordIds as Sha256Digest[],
                historyRecordIds: input.transcriptPins.historyRecordIds as Sha256Digest[],
                redoRecordIds: input.transcriptPins.redoRecordIds as Sha256Digest[],
                walRecordIds: [],
            });
        } catch (error) {
            // The project head and receipt are already durable. Keeping the conservative pending
            // pins is safer than reporting a false engine failure after the commit boundary.
            this.onPostCommitError?.(error);
        }
    }
}

async function createVerifiedFileHandle(
    kind: StandaloneSourceKind,
    source: VideoSourceAssetV3 | AudioSourceAsset,
): Promise<VerifiedMediaHandleV1> {
    const contentDigest = await sha256File(source.file);
    const identity: ImmutableMediaIdentityV1 = {
        schemaVersion: 1,
        contentDigest,
        descriptorFingerprint: source.fingerprint,
        byteLength: source.size,
        immutableVersion: `${source.fingerprint}:${contentDigest}`,
        streamMetadataRefs: [],
    };
    return {
        schemaVersion: 1,
        handleId: `standalone:${kind}:${source.id}:${contentDigest}`,
        capabilityId: `standalone-file:${kind}:${source.id}:${source.fingerprint}`,
        identity,
        verifiedAt: new Date().toISOString(),
    };
}

async function sha256File(file: File): Promise<`sha256:${string}`> {
    const digest = new IncrementalSha256();
    if (typeof file.stream === 'function') {
        const reader = file.stream().getReader();
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                digest.update(chunk.value);
            }
        } finally {
            reader.releaseLock();
        }
    } else {
        digest.update(new Uint8Array(await file.arrayBuffer()));
    }
    return `sha256:${digest.finish()}`;
}

class IncrementalSha256 {
    private readonly hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    private readonly tail = new Uint8Array(64);
    private tailLength = 0;
    private byteLength = 0;

    update(bytes: Uint8Array): void {
        this.byteLength += bytes.byteLength;
        let offset = 0;
        if (this.tailLength > 0) {
            const needed = Math.min(64 - this.tailLength, bytes.byteLength);
            this.tail.set(bytes.subarray(0, needed), this.tailLength);
            this.tailLength += needed;
            offset += needed;
            if (this.tailLength === 64) {
                this.process(this.tail);
                this.tailLength = 0;
            }
        }
        while (offset + 64 <= bytes.byteLength) {
            this.process(bytes.subarray(offset, offset + 64));
            offset += 64;
        }
        if (offset < bytes.byteLength) {
            this.tail.set(bytes.subarray(offset), 0);
            this.tailLength = bytes.byteLength - offset;
        }
    }

    finish(): string {
        const final = new Uint8Array(this.tailLength >= 56 ? 128 : 64);
        final.set(this.tail.subarray(0, this.tailLength));
        final[this.tailLength] = 0x80;
        const view = new DataView(final.buffer);
        view.setUint32(
            final.byteLength - 8,
            Math.floor(this.byteLength / 0x20000000),
            false,
        );
        view.setUint32(final.byteLength - 4, (this.byteLength * 8) >>> 0, false);
        for (let offset = 0; offset < final.byteLength; offset += 64) {
            this.process(final.subarray(offset, offset + 64));
        }
        return Array.from(this.hash)
            .map((word) => word.toString(16).padStart(8, '0'))
            .join('');
    }

    private process(block: Uint8Array): void {
        const words = new Uint32Array(64);
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(index * 4, false);
        }
        for (let index = 16; index < 64; index += 1) {
            const left = words[index - 15];
            const right = words[index - 2];
            const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
            const s1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let a = this.hash[0];
        let b = this.hash[1];
        let c = this.hash[2];
        let d = this.hash[3];
        let e = this.hash[4];
        let f = this.hash[5];
        let g = this.hash[6];
        let h = this.hash[7];
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        this.hash[0] = (this.hash[0] + a) >>> 0;
        this.hash[1] = (this.hash[1] + b) >>> 0;
        this.hash[2] = (this.hash[2] + c) >>> 0;
        this.hash[3] = (this.hash[3] + d) >>> 0;
        this.hash[4] = (this.hash[4] + e) >>> 0;
        this.hash[5] = (this.hash[5] + f) >>> 0;
        this.hash[6] = (this.hash[6] + g) >>> 0;
        this.hash[7] = (this.hash[7] + h) >>> 0;
    }
}

function assertSourceMatchesDescriptor(
    source: VideoSourceAssetV3 | AudioSourceAsset,
    descriptor: Pick<
        VideoSourceAssetV3 | AudioSourceAsset,
        'id' | 'originalName' | 'mimeType' | 'size' | 'lastModified' | 'fingerprint'
    >,
): void {
    if (
        source.id !== descriptor.id
        || source.originalName !== descriptor.originalName
        || source.mimeType !== descriptor.mimeType
        || source.size !== descriptor.size
        || source.lastModified !== descriptor.lastModified
        || source.fingerprint !== descriptor.fingerprint
        || source.file.name !== descriptor.originalName
        || source.file.type !== descriptor.mimeType
        || source.file.size !== descriptor.size
        || source.file.lastModified !== descriptor.lastModified
    ) {
        throw new Error(`Source File "${source.id}" no longer matches its immutable descriptor.`);
    }
}

function fileMetadata(file: File) {
    return {
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
    };
}

function withoutFile<T extends VideoSourceAssetV3 | AudioSourceAsset>(source: T): Omit<T, 'file'> {
    const { file, ...descriptor } = source;
    void file;
    return descriptor;
}

function unique(values: readonly string[]): string[] {
    return Array.from(new Set(values)).sort();
}

function rotateRight(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
}

const SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
