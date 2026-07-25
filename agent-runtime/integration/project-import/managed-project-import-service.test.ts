import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    createEditorialTranscriptDescriptorV2,
    createEditorialTranscriptRequestKey,
} from '../../../src/lib/editorial-transcription/identity';
import { createCanonicalMergedRangeRecord } from '../../../src/lib/editorial-transcription/orchestrator';
import { mergeRangeTranscriptChunks } from '../../../src/lib/editorial-transcription/range-merge';
import {
    createTranscriptionCoverageRecordV2,
    planIncrementalTranscriptionCoverage,
} from '../../../src/lib/editorial-transcription/range-coverage';
import { createRangeTranscriptChunkRecord } from '../../../src/lib/editorial-transcription/range-orchestrator';
import { canonicalizeJson } from '../../../src/lib/editorial-transcription/canonical-json';
import { createEmptyManagedCoreSnapshot } from '../core-editor-port';
import { writeManagedPortableBundle } from '../export/portable-bundle-writer';
import type { ManagedStreamingEntry } from '../export/contracts';
import type { ManagedStreamingSink } from '../export/streaming-output';
import type {
    ManagedProjectImportReadLease,
    ManagedProjectImportServiceDependencies,
} from './contracts';
import { ManagedProjectImportService } from './managed-project-import-service';
import { ManagedProjectImportZip } from './managed-zip-reader';

describe('managed project import service', () => {
    it('round-trips a portable-writer V4 bundle through receipt-first preparation', async () => {
        const bundle = await bundleBytes();
        const lease = memoryLease(bundle);
        const published = vi.fn(async (
            input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
        ) => {
            void input;
            return success();
        });
        const service = new ManagedProjectImportService(dependencies(lease, published));

        await expect(service.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
            .resolves.toEqual(success());
        expect(published).toHaveBeenCalledOnce();
        const prepared = published.mock.calls[0]![0].prepared;
        expect(prepared).toMatchObject({ formatVersion: 4, media: [], transcripts: [] });
        expect(JSON.stringify(prepared)).not.toContain('/private/');
    });

    it('rejects corrupt bytes, stored ZIP traversal, and compressed ZIP metadata before publication', async () => {
        const original = await bundleBytes();
        const corrupt = Uint8Array.from(original);
        corrupt[indexOf(corrupt, new TextEncoder().encode('"4.0"'))] ^= 1;
        const traversal = Uint8Array.from(original);
        const central = indexOf(traversal, Uint8Array.of(0x50, 0x4b, 0x01, 0x02));
        traversal.set(new TextEncoder().encode('../evil0.json'), central + 46);
        const compressed = Uint8Array.from(original);
        const compressedCentral = indexOf(compressed, Uint8Array.of(0x50, 0x4b, 0x01, 0x02));
        new DataView(compressed.buffer).setUint16(compressedCentral + 10, 8, true);

        for (const bytes of [corrupt, traversal, compressed]) {
            const published = vi.fn(async (
                input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
            ) => {
                void input;
                return success();
            });
            const service = new ManagedProjectImportService(dependencies(memoryLease(bytes), published));
            await expect(service.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
                .rejects.toThrow();
            expect(published).not.toHaveBeenCalled();
        }
    });

    it('rejects duplicate Unicode aliases from raw central-directory metadata', async () => {
        const bytes = await bundleBytes([
            bytesEntry('metadata.json', JSON.stringify(metadata())),
            bytesEntry('second0000000', 'unused'),
        ]);
        const duplicate = Uint8Array.from(bytes);
        replaceAll(duplicate, new TextEncoder().encode('second0000000'), new TextEncoder().encode('METAdata.json'));
        await expect(ManagedProjectImportZip.open(
            memoryLease(duplicate),
            importLimits(),
        )).rejects.toThrow(/duplicate or Unicode-conflicting/i);
    });

    it('does not reopen a stale grant and replays a receipt before source access', async () => {
        const bundle = await bundleBytes();
        const stale = memoryLease(bundle, { stale: true });
        const published = vi.fn(async (
            input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
        ) => {
            void input;
            return success();
        });
        const staleService = new ManagedProjectImportService(dependencies(stale, published));
        await expect(staleService.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
            .rejects.toThrow(/stale/i);
        expect(published).not.toHaveBeenCalled();

        const replay = { ...success(), replayed: true };
        const paths = { openPath: vi.fn(async () => memoryLease(bundle)) };
        const service = new ManagedProjectImportService({
            paths,
            receipts: { replay: vi.fn(async () => replay), publishReceiptFirst: published },
        });
        await expect(service.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
            .resolves.toEqual(replay);
        expect(paths.openPath).not.toHaveBeenCalled();
        expect(published).not.toHaveBeenCalled();
    });

    it('honours cancellation before any project publication', async () => {
        const published = vi.fn(async (
            input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
        ) => {
            void input;
            return success();
        });
        const service = new ManagedProjectImportService(dependencies(await bundleLease(), published));
        const controller = new AbortController();
        controller.abort(new DOMException('cancelled', 'AbortError'));
        await expect(service.handler(scopedCall('bundle-path'), { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(published).not.toHaveBeenCalled();
    });

    it('rejects mutated content-addressed coverage and chunk sidecars that retain their record IDs', async () => {
        const fixture = await rangeSidecarFixture();
        const mutations = [
            {
                entries: rangeBundleEntries(fixture, {
                    coverage: { ...fixture.coverage, requestedModel: 'tampered-model' },
                }),
                expected: /Editorial coverage sidecar is corrupt/,
            },
            {
                entries: rangeBundleEntries(fixture, {
                    chunk: {
                        ...fixture.chunk,
                        words: [{ ...fixture.chunk.words[0]!, text: 'tampered evidence' }],
                    },
                }),
                expected: /Editorial range chunk hash does not match its canonical body/,
            },
        ];
        for (const { entries, expected } of mutations) {
            const published = vi.fn(async (
                input: Parameters<ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst']>[0],
            ) => {
                void input;
                return success();
            });
            const service = new ManagedProjectImportService(dependencies(memoryLease(await bundleBytes(entries)), published));
            await expect(service.handler(scopedCall('bundle-path'), { signal: new AbortController().signal }))
                .rejects.toThrow(expected);
            expect(published).not.toHaveBeenCalled();
        }
    });

    it('reads large entries in bounded chunks and can restart from the immutable lease', async () => {
        const large = new Uint8Array(3 * 1024 * 1024).fill(7);
        const bytes = await bundleBytes([
            bytesEntry('metadata.json', JSON.stringify(metadata())),
            bytesEntry('large.bin', large),
        ]);
        const first = memoryLease(bytes);
        const archive = await ManagedProjectImportZip.open(first, importLimits());
        await archive.digest('large.bin');
        expect(first.maximumRead).toBeLessThanOrEqual(1024 * 1024);

        const restarted = memoryLease(bytes);
        const recovered = await ManagedProjectImportZip.open(restarted, importLimits());
        await expect(recovered.digest('large.bin')).resolves.toBe(await archive.digest('large.bin'));
        expect(restarted.maximumRead).toBeLessThanOrEqual(1024 * 1024);
    });
});

async function bundleBytes(entries = [bytesEntry('metadata.json', JSON.stringify(metadata()))]): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let bytesWritten = 0;
    const hash = createHash('sha256');
    const sink: ManagedStreamingSink = {
        get bytesWritten() { return bytesWritten; },
        async write(chunk) {
            chunks.push(chunk.slice());
            bytesWritten += chunk.byteLength;
            hash.update(chunk);
        },
        async sync() {},
        digest: () => `sha256:${hash.copy().digest('hex')}`,
    };
    await writeManagedPortableBundle({ entries, sink });
    const result = new Uint8Array(bytesWritten);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

async function bundleLease() {
    return memoryLease(await bundleBytes());
}

function metadata() {
    return {
        version: '4.0',
        project: { id: 'bundle-project', name: 'Imported bundle' },
        editorManifest: createEmptyManagedCoreSnapshot('bundle-project', 'epoch').state.snapshot.manifest,
        sourceFiles: { video: {}, audio: {} },
        editorialTranscriptFiles: {},
        presets: [],
    };
}

async function rangeSidecarFixture() {
    const source = {
        id: 'range-source',
        originalName: 'range.mp4',
        mimeType: 'video/mp4',
        size: 1,
        lastModified: 1_700_000_000_000,
        fingerprint: 'range-source-fingerprint',
        duration: 2,
        fps: 30,
        width: 1_920,
        height: 1_080,
        bitrate: 5_000_000,
        hasAudio: true,
    };
    const profile = {
        sourceFingerprint: source.fingerprint,
        sourceSampleRate: 16_000,
        sourceSampleCount: 32_000,
        coreCoverage: [{ startSample: 0, endSample: 32_000 }],
        contextSamples: 0,
        language: 'en',
        speakerMode: 'none' as const,
        endpointIdentityDigest: `sha256:${'d'.repeat(64)}` as const,
        requestedModel: 'qwen-1.7b-edit-max',
        responseSchema: 'edit-max-v1',
        pcmAlgorithmVersion: 1,
        providerProfileVersion: 1,
    };
    const plan = await planIncrementalTranscriptionCoverage({ profile });
    const window = plan.acquisitionWindows[0]!;
    const chunk = await createRangeTranscriptChunkRecord({
        sourceFingerprint: source.fingerprint,
        acquisitionProfileDigest: plan.acquisitionProfileDigest,
        window,
        localWords: [{
            text: 'range evidence',
            startSample: 0,
            endSample: 16_000,
            probability: 0.99,
            speaker: null,
        }],
    });
    const merged = mergeRangeTranscriptChunks([chunk], profile.coreCoverage);
    const transcript = await createCanonicalMergedRangeRecord({
        sourceFingerprint: source.fingerprint,
        sampleCount: profile.sourceSampleCount,
        language: profile.language,
        speakerMode: profile.speakerMode,
        canonicalModel: 'qwen-1.7b-edit-max-runtime',
        words: merged.words,
    });
    const coverage = await createTranscriptionCoverageRecordV2({
        sourceFingerprint: profile.sourceFingerprint,
        sourceSampleRate: profile.sourceSampleRate,
        sourceSampleCount: profile.sourceSampleCount,
        acquisitionProfileDigest: plan.acquisitionProfileDigest,
        endpointIdentityDigest: profile.endpointIdentityDigest,
        contextSamples: profile.contextSamples,
        requestedModel: profile.requestedModel,
        responseSchema: profile.responseSchema,
        pcmAlgorithmVersion: profile.pcmAlgorithmVersion,
        providerProfileVersion: profile.providerProfileVersion,
        language: profile.language,
        speakerMode: profile.speakerMode,
        coreCoverage: profile.coreCoverage,
        acquisitionWindows: [{ ...window, chunkRecordIds: [chunk.recordId] }],
        mergedTranscriptRecordId: transcript.recordId,
    });
    const descriptor = createEditorialTranscriptDescriptorV2({
        recordId: transcript.recordId,
        coverageRecord: coverage,
        requestKey: await createEditorialTranscriptRequestKey({
            sourceFingerprint: source.fingerprint,
            sampleCount: profile.sourceSampleCount,
            language: profile.language,
            speakerMode: profile.speakerMode,
            endpointIdentityDigest: profile.endpointIdentityDigest,
        }),
        sourceId: source.id,
        sourceFingerprint: source.fingerprint,
        endpointIdentityDigest: profile.endpointIdentityDigest,
        body: transcript.body,
        acquisition: 'provider',
        createdAt: '2026-07-25T00:00:00.000Z',
    });
    const manifest = structuredClone(createEmptyManagedCoreSnapshot('range-project', 'range-epoch').state.snapshot.manifest);
    manifest.videoSourceDescriptors = [source];
    manifest.editorialTranscriptDescriptors = [descriptor];
    return { source, transcript, coverage, chunk, manifest };
}

function rangeBundleEntries(
    fixture: Awaited<ReturnType<typeof rangeSidecarFixture>>,
    overrides: { coverage?: object; chunk?: object } = {},
): ManagedStreamingEntry[] {
    const coverage = overrides.coverage ?? fixture.coverage;
    const chunk = overrides.chunk ?? fixture.chunk;
    return [
        bytesEntry('metadata.json', JSON.stringify({
            version: '4.0',
            project: { id: 'range-project', name: 'Range import' },
            editorManifest: fixture.manifest,
            sourceFiles: { video: { [fixture.source.id]: 'media/range.mp4' }, audio: {} },
            editorialTranscriptFiles: { [fixture.transcript.recordId]: 'editorial/transcript.json' },
            editorialCoverageFiles: { [fixture.coverage.recordId]: 'editorial/coverage.json' },
            editorialChunkFiles: { [fixture.chunk.recordId]: 'editorial/chunk.json' },
            presets: [],
        })),
        bytesEntry('media/range.mp4', new Uint8Array([1])),
        bytesEntry('editorial/transcript.json', fixture.transcript.canonicalJson),
        bytesEntry('editorial/coverage.json', canonicalizeJson(coverage)),
        bytesEntry('editorial/chunk.json', canonicalizeJson(chunk)),
    ];
}

function bytesEntry(name: string, value: string | Uint8Array): ManagedStreamingEntry {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return {
        name,
        byteLength: bytes.byteLength,
        async *stream() {
            for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
                yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 1024 * 1024));
            }
        },
        async revalidate() {},
    };
}

function dependencies(
    lease: ManagedProjectImportReadLease,
    publishReceiptFirst: ManagedProjectImportServiceDependencies['receipts']['publishReceiptFirst'],
): ManagedProjectImportServiceDependencies {
    return {
        paths: { openPath: vi.fn(async () => lease) },
        receipts: { replay: vi.fn(async () => null), publishReceiptFirst },
        limits: importLimits(),
    };
}

function importLimits() {
    return {
        maximumArchiveBytes: 16 * 1024 * 1024,
        maximumEntries: 32,
        maximumCentralDirectoryBytes: 1024 * 1024,
        maximumMetadataBytes: 1024 * 1024,
        maximumDetachedBodyBytes: 1024 * 1024,
        maximumAggregateDetachedBodyBytes: 2 * 1024 * 1024,
        maximumEntryBytes: 8 * 1024 * 1024,
        maximumAggregateBytes: 12 * 1024 * 1024,
        maximumReadChunkBytes: 1024 * 1024,
    } as const;
}

function memoryLease(bytes: Uint8Array, options: { stale?: boolean } = {}) {
    let closed = false;
    const lease: ManagedProjectImportReadLease & { maximumRead: number } = {
        capabilityId: 'managed-import-test-capability',
        byteLength: bytes.byteLength,
        maximumRead: 0,
        async read(position, length) {
            if (closed) throw new Error('closed');
            lease.maximumRead = Math.max(lease.maximumRead, length);
            return bytes.slice(position, position + length);
        },
        async assertCurrent() {
            if (options.stale) throw new Error('stale read grant');
        },
        async close() { closed = true; },
    };
    return lease;
}

function scopedCall(kind: 'bundle-path' | 'manifest-path') {
    return {
        toolName: 'waptions_project_import',
        request: {
            apiVersion: '2026-07-25',
            sessionId: 'session-import',
            sessionEpoch: 'epoch-import',
            expected: { sessionRevision: 0, documentRevision: 0 },
            idempotencyKey: 'import-key',
            source: { kind, grantId: 'grant-import', path: '/private/project.waptions' },
        },
        canonicalRequest: '{}',
        requestHash: `sha256:${'a'.repeat(64)}`,
        mutation: true,
        identity: { sessionId: 'session-import', sessionEpoch: 'epoch-import', idempotencyKey: 'import-key' },
        receiptScope: {
            projectId: 'project-import',
            toolName: 'waptions_project_import',
            idempotencyKey: 'import-key',
        },
    } as const;
}

function success() {
    return { ok: true as const, data: { jobId: 'import-job' }, warnings: [] };
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
        for (let inner = 0; inner < needle.byteLength; inner += 1) {
            if (haystack[index + inner] !== needle[inner]) continue outer;
        }
        return index;
    }
    throw new Error('needle not found');
}

function replaceAll(bytes: Uint8Array, from: Uint8Array, to: Uint8Array): void {
    if (from.byteLength !== to.byteLength) throw new Error('replacement length must match');
    for (let offset = 0; offset <= bytes.byteLength - from.byteLength; offset += 1) {
        if (from.every((value, index) => bytes[offset + index] === value)) {
            bytes.set(to, offset);
            offset += from.byteLength - 1;
        }
    }
}
