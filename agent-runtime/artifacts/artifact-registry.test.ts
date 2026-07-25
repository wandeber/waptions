import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readdir } from 'node:fs/promises';
import { ArtifactRegistry } from './artifact-registry';
import { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics';
import { ManagedFilesystemStore } from '../persistence/managed-filesystem-store';
import { temporaryRuntime, testEnvelope } from '../testing/runtime-test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('ArtifactRegistry', () => {
    it('streams hashes, serves bounded ranges, verifies capabilities, and expires artifacts', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-project');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 8));
        const staged = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('0123456789')]),
            { expiresAt: new Date(Date.now() + 60_000).toISOString() },
        );
        await store.transact({
            baseSessionRevision: 0,
            envelope: { ...envelope, sessionRevision: 1, artifactRevision: 1 },
            writes: [staged.registryWrite],
        });
        staged.accept();
        expect(staged.record.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        const range = await registry.readRange(envelope.projectId, staged.record.artifactId, 2, 6);
        expect(Buffer.from(range.bytes).toString()).toBe('2345');

        const token = registry.capability(
            envelope.projectId,
            staged.record.artifactId,
            Date.now() + 60_000,
        );
        expect(() => registry.verifyCapability(
            token,
            envelope.projectId,
            staged.record.artifactId,
        )).not.toThrow();

        const expiredRecord = {
            ...staged.record,
            expiresAt: new Date(Date.now() - 1).toISOString(),
        };
        await store.transact({
            baseSessionRevision: 1,
            envelope: { ...envelope, sessionRevision: 2, artifactRevision: 2 },
            writes: [{ ...staged.registryWrite, value: expiredRecord }],
        });
        await expect(registry.get(envelope.projectId, staged.record.artifactId)).rejects.toMatchObject({
            code: 'ARTIFACT_EXPIRED',
        });
        expect(await registry.cleanupExpired(envelope.projectId)).toEqual([staged.record.artifactId]);
    });

    it('enforces byte quotas and removes every partial or rejected publication', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-quota-project');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 9), undefined, {
            maximumArtifactBytes: 8,
            maximumSessionBytes: 16,
            maximumSessionCount: 2,
            maximumGlobalBytes: 16,
            maximumGlobalCount: 2,
            maximumConcurrentArtifacts: 2,
            maximumDurationMilliseconds: 1_000,
            maximumChunkBytes: 8,
        });
        await expect(registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('12345678'), Buffer.from('9')]),
        )).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

        const staged = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('valid')]),
        );
        await staged.reject();
        expect(await entries(store.projectPath(envelope.projectId, 'artifacts', 'staging'))).toEqual([]);
        expect(await entries(store.projectPath(envelope.projectId, 'artifacts', 'blobs'))).toEqual([]);
    });

    it('keeps a deduplicated blob while another staged owner can still publish it', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-dedup-project');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 19));
        const first = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('shared-bytes')]),
        );
        const second = await registry.stage(
            envelope.projectId,
            'thumbnail',
            'application/octet-stream',
            Readable.from([Buffer.from('shared-bytes')]),
        );

        await first.reject();
        expect(await entries(
            store.projectPath(envelope.projectId, 'artifacts', 'blobs'),
        )).toHaveLength(1);
        await store.transact({
            baseSessionRevision: 0,
            envelope: { ...envelope, sessionRevision: 1, artifactRevision: 1 },
            writes: [second.registryWrite],
        });
        second.accept();
        expect(Buffer.from((await registry.readRange(
            envelope.projectId,
            second.record.artifactId,
            0,
            second.record.byteLength,
        )).bytes).toString()).toBe('shared-bytes');
    });

    it('times out a stalled producer and tears down staging', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-deadline-project');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 10), undefined, {
            maximumArtifactBytes: 1_024,
            maximumSessionBytes: 2_048,
            maximumSessionCount: 2,
            maximumGlobalBytes: 2_048,
            maximumGlobalCount: 2,
            maximumConcurrentArtifacts: 2,
            maximumDurationMilliseconds: 50,
            maximumChunkBytes: 1_024,
        });
        const stalled = async function* () {
            yield Buffer.from('started');
            await new Promise(() => undefined);
        };
        await expect(registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            stalled(),
            { deadlineMilliseconds: 20 },
        )).rejects.toMatchObject({ code: 'COORDINATOR_UNAVAILABLE' });
        expect(await entries(store.projectPath(envelope.projectId, 'artifacts', 'staging'))).toEqual([]);
    });

    it('aborts a stalled producer, releases reservations, and records cleanup diagnostics', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-abort-project');
        await store.createProject(envelope);
        const diagnostics = new RuntimeDiagnostics();
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 13), diagnostics, {
            maximumArtifactBytes: 1_024,
            maximumSessionBytes: 2_048,
            maximumSessionCount: 2,
            maximumGlobalBytes: 2_048,
            maximumGlobalCount: 2,
            maximumConcurrentArtifacts: 1,
            maximumDurationMilliseconds: 1_000,
            maximumChunkBytes: 1_024,
        });
        let sourceBlocked!: () => void;
        const blocked = new Promise<void>((resolve) => {
            sourceBlocked = resolve;
        });
        const stalled = async function* () {
            yield Buffer.from('started');
            sourceBlocked();
            await new Promise(() => undefined);
        };
        const controller = new AbortController();
        const pending = registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            stalled(),
            { signal: controller.signal },
        );
        await blocked;
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(await entries(store.projectPath(envelope.projectId, 'artifacts', 'staging'))).toEqual([]);
        expect(diagnostics.snapshot()).toMatchObject({
            current: { artifactsInFlight: 0, artifactBytesInFlight: 0 },
            counters: { abortedOperations: 1 },
        });

        const replacement = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('replacement')]),
        );
        await replacement.reject();
    });

    it('bounds concurrent artifact streams independently of durable artifact count', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-concurrency-project');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 14), undefined, {
            maximumArtifactBytes: 1_024,
            maximumSessionBytes: 2_048,
            maximumSessionCount: 4,
            maximumGlobalBytes: 2_048,
            maximumGlobalCount: 4,
            maximumConcurrentArtifacts: 1,
            maximumDurationMilliseconds: 1_000,
            maximumChunkBytes: 1_024,
        });
        let sourceBlocked!: () => void;
        const blocked = new Promise<void>((resolve) => {
            sourceBlocked = resolve;
        });
        const stalled = async function* () {
            yield Buffer.from('started');
            sourceBlocked();
            await new Promise(() => undefined);
        };
        const controller = new AbortController();
        const first = registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            stalled(),
            { signal: controller.signal },
        );
        await blocked;
        await expect(registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('second')]),
        )).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
        controller.abort();
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('enforces persisted session and global count quotas across projects', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const firstEnvelope = testEnvelope('artifact-count-first');
        const secondEnvelope = testEnvelope('artifact-count-second', 'second-session');
        await Promise.all([
            store.createProject(firstEnvelope),
            store.createProject(secondEnvelope),
        ]);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 11), undefined, {
            maximumArtifactBytes: 8,
            maximumSessionBytes: 8,
            maximumSessionCount: 1,
            maximumGlobalBytes: 8,
            maximumGlobalCount: 1,
            maximumConcurrentArtifacts: 1,
            maximumDurationMilliseconds: 1_000,
            maximumChunkBytes: 8,
        });
        const first = await registry.stage(
            firstEnvelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('1234')]),
        );
        await store.transact({
            baseSessionRevision: 0,
            envelope: { ...firstEnvelope, sessionRevision: 1, artifactRevision: 1 },
            writes: [first.registryWrite],
        });
        first.accept();
        await expect(registry.stage(
            firstEnvelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('1')]),
        )).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
        await expect(registry.stage(
            secondEnvelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('1')]),
        )).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });

    it('enforces aggregate byte quotas after earlier artifacts are committed', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-byte-session');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 12), undefined, {
            maximumArtifactBytes: 8,
            maximumSessionBytes: 8,
            maximumSessionCount: 3,
            maximumGlobalBytes: 8,
            maximumGlobalCount: 3,
            maximumConcurrentArtifacts: 3,
            maximumDurationMilliseconds: 1_000,
            maximumChunkBytes: 8,
        });
        const first = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('123456')]),
        );
        await store.transact({
            baseSessionRevision: 0,
            envelope: { ...envelope, sessionRevision: 1, artifactRevision: 1 },
            writes: [first.registryWrite],
        });
        first.accept();
        await expect(registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('789')]),
        )).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });

    it('counts expired records until cleanup and rejects already-expired publication', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-expired-quota');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 15), undefined, {
            maximumArtifactBytes: 8,
            maximumSessionBytes: 8,
            maximumSessionCount: 1,
            maximumGlobalBytes: 8,
            maximumGlobalCount: 1,
            maximumConcurrentArtifacts: 1,
            maximumDurationMilliseconds: 1_000,
            maximumChunkBytes: 8,
        });
        await expect(registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('past')]),
            { expiresAt: new Date(Date.now() - 1).toISOString() },
        )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

        const first = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('first')]),
            { expiresAt: new Date(Date.now() + 50).toISOString() },
        );
        await store.transact({
            baseSessionRevision: 0,
            envelope: { ...envelope, sessionRevision: 1, artifactRevision: 1 },
            writes: [first.registryWrite],
        });
        first.accept();
        await new Promise((resolve) => setTimeout(resolve, 60));
        await expect(registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('next')]),
        )).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

        await registry.cleanupExpired(envelope.projectId);
        const replacement = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/octet-stream',
            Readable.from([Buffer.from('next')]),
        );
        await replacement.reject();
    });
});

async function entries(path: string): Promise<string[]> {
    try {
        return await readdir(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}
