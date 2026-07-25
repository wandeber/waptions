import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { ArtifactRegistry } from './artifact-registry';
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
});
