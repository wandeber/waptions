import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { ArtifactRegistry } from '../../artifacts/artifact-registry';
import { BridgeCapabilitySigner } from '../../http-bridge/capability';
import { ManagedFilesystemStore } from '../../persistence/managed-filesystem-store';
import { temporaryRuntime, testEnvelope } from '../../testing/runtime-test-helpers';
import { ManagedArtifactAccessAdapter } from './artifact-access-adapter';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('managed artifact access adapter', () => {
    it('projects path-free metadata, bounds ranges, and binds bridge access to the authenticated view', async () => {
        const runtime = await temporaryRuntime();
        cleanups.push(runtime.cleanup);
        const store = new ManagedFilesystemStore(runtime.path);
        await store.initialize();
        const envelope = testEnvelope('artifact-access-project');
        await store.createProject(envelope);
        const registry = new ArtifactRegistry(store, Buffer.alloc(32, 4));
        const staged = await registry.stage(
            envelope.projectId,
            'waveform',
            'application/json',
            Readable.from([Buffer.from('0123456789')]),
        );
        await store.transact({
            baseSessionRevision: 0,
            envelope: {
                ...envelope,
                sessionRevision: 1,
                artifactRevision: 1,
            },
            writes: [staged.registryWrite],
        });
        staged.accept();
        const signer = new BridgeCapabilitySigner({
            secret: Buffer.alloc(32, 5),
        });
        const adapter = new ManagedArtifactAccessAdapter(registry, signer);
        const metadata = await adapter.metadata(envelope.projectId, staged.record.artifactId);
        expect(metadata).toMatchObject({
            artifactId: staged.record.artifactId,
            contentDigest: staged.record.digest,
            storageRef: `artifact:${staged.record.artifactId}`,
        });
        expect(JSON.stringify(metadata)).not.toContain('relativeBlobPath');
        const range = await adapter.readRange({
            projectId: envelope.projectId,
            artifactId: staged.record.artifactId,
            start: 2,
            endExclusive: 6,
        });
        expect(Buffer.from(range.bytes).toString()).toBe('2345');

        let liveChecks = 0;
        const issued = await adapter.issueBridgeCapability({
            view: {
                sessionId: envelope.sessionId,
                projectId: envelope.projectId,
                viewId: 'authenticated-view',
                sessionEpoch: 'epoch-1',
                origin: 'http://localhost:59940',
                assertLive: async () => {
                    liveChecks += 1;
                },
            },
            artifactId: staged.record.artifactId,
        });
        const scope = signer.verify(issued.capability, {
            origin: 'http://localhost:59940',
            method: 'GET',
            resource: issued.resource,
        });
        expect(liveChecks).toBe(1);
        expect(scope.viewId).toBe('authenticated-view');
        expect(() => signer.verify(issued.capability, {
            origin: 'http://localhost:59940',
            method: 'GET',
            resource: { kind: 'artifact', resourceId: 'another-artifact' },
        })).toThrow();

        const bridge = await adapter.openBridgeArtifact({
            scope,
            resource: issued.resource,
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of bridge.read(
            { start: 0, endExclusive: 10 },
            new AbortController().signal,
        )) {
            chunks.push(chunk);
        }
        expect(Buffer.concat(chunks).toString()).toBe('0123456789');
    });
});
