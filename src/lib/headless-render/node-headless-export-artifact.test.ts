import { describe, expect, it, vi } from 'vitest';
import {
    NodeHeadlessExportArtifactPort,
    type NodeStagedDestinationHandle,
    type NodeStagedExportCapabilityResolverPort,
} from '../../../agent-runtime/export';
import { HeadlessRenderError } from '../../../agent-runtime/render';

const TARGET = {
    version: 1 as const,
    capabilityId: 'capability:node-test',
    grantId: 'grant:node-test',
};

function createHandle(
    overrides: Partial<NodeStagedDestinationHandle> = {},
): NodeStagedDestinationHandle {
    const outputCapability = {
        version: 1 as const,
        kind: 'create-only-staged-output' as const,
        capabilityId: TARGET.capabilityId,
        grantId: TARGET.grantId,
        stagingId: 'staging:node-test',
    };
    return {
        outputCapability,
        displayPath: '/authorized-display-only/result.mp4',
        reset: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn((verifier, signal) => verifier.inspect(outputCapability, signal)),
        publishCreateOnly: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
        hashCommittedSha256: vi.fn().mockResolvedValue(`sha256:${'a'.repeat(64)}`),
        committedSize: vi.fn().mockResolvedValue(12),
        ...overrides,
    };
}

function createResolver(
    handle: NodeStagedDestinationHandle,
): NodeStagedExportCapabilityResolverPort & {
    acquire: ReturnType<typeof vi.fn<NodeStagedExportCapabilityResolverPort['acquire']>>;
    listPartials: ReturnType<typeof vi.fn<NodeStagedExportCapabilityResolverPort['listPartials']>>;
    removePartial: ReturnType<typeof vi.fn<NodeStagedExportCapabilityResolverPort['removePartial']>>;
} {
    return {
        acquire: vi
            .fn<NodeStagedExportCapabilityResolverPort['acquire']>()
            .mockResolvedValue(handle),
        listPartials: vi
            .fn<NodeStagedExportCapabilityResolverPort['listPartials']>()
            .mockResolvedValue([]),
        removePartial: vi
            .fn<NodeStagedExportCapabilityResolverPort['removePartial']>()
            .mockResolvedValue(undefined),
    };
}

describe('descriptor-bound headless export artifact publication', () => {
    it('resets, syncs, publishes, hashes, and sizes through the owned staged handle', async () => {
        const handle = createHandle();
        const port = new NodeHeadlessExportArtifactPort(createResolver(handle));

        const lease = await port.acquireCreateOnly('job_node', TARGET);
        await lease.reset();
        await lease.sync();
        await lease.commit();

        expect(handle.reset).toHaveBeenCalledOnce();
        expect(handle.sync).toHaveBeenCalledOnce();
        expect(handle.publishCreateOnly).toHaveBeenCalledOnce();
        expect(await lease.size()).toBe(12);
        expect(await lease.hashSha256()).toBe(`sha256:${'a'.repeat(64)}`);
        expect(handle.hashCommittedSha256).toHaveBeenCalledOnce();
        expect(lease.outputCapability).toMatchObject({
            capabilityId: TARGET.capabilityId,
            grantId: TARGET.grantId,
        });
    });

    it.each([
        [
            'target replacement',
            new HeadlessRenderError('OUTPUT_EXISTS', 'The create-only target was replaced.'),
        ],
        [
            'parent symlink replacement',
            new HeadlessRenderError('INVALID_OUTPUT', 'The validated parent became a symlink.'),
        ],
    ])('fails closed when the grant authority detects %s before publication', async (
        _case,
        failure,
    ) => {
        const handle = createHandle({
            publishCreateOnly: vi.fn().mockRejectedValue(failure),
        });
        const port = new NodeHeadlessExportArtifactPort(createResolver(handle));
        const lease = await port.acquireCreateOnly('job_adversarial', TARGET);

        await expect(lease.commit()).rejects.toBe(failure);
        await lease.abort();
        expect(handle.abort).toHaveBeenCalledOnce();
        expect(handle.hashCommittedSha256).not.toHaveBeenCalled();
        expect(handle.committedSize).not.toHaveBeenCalled();
    });

    it('rejects a handle that does not match the validated grant capability', async () => {
        const handle = createHandle();
        handle.outputCapability.grantId = 'grant:different';
        const port = new NodeHeadlessExportArtifactPort(createResolver(handle));

        await expect(port.acquireCreateOnly('job_mismatch', TARGET))
            .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
        expect(handle.abort).toHaveBeenCalledOnce();
    });

    it('delegates crash recovery by opaque scope and partial IDs', async () => {
        const resolver = createResolver(createHandle());
        resolver.listPartials.mockResolvedValue([{
            jobId: 'job_orphan',
            partialId: 'partial:orphan',
            modifiedAtMs: 1,
        }]);
        const port = new NodeHeadlessExportArtifactPort(resolver);

        await expect(port.listPartials('recovery-scope:test')).resolves.toMatchObject([{
            partialId: 'partial:orphan',
        }]);
        await port.removePartial('partial:orphan');
        expect(resolver.listPartials).toHaveBeenCalledWith('recovery-scope:test', undefined);
        expect(resolver.removePartial).toHaveBeenCalledWith('partial:orphan');
    });
});
