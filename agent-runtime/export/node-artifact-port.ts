import {
    HeadlessRenderError,
    throwIfAborted,
    type HeadlessStagedOutputCapability,
} from '../render/contracts';
import type {
    HeadlessExportArtifactPort,
    HeadlessExportPartial,
    HeadlessExportTargetLease,
    HeadlessExportTargetReference,
    HeadlessMp4Inspection,
    HeadlessMp4VerifierPort,
} from './contracts';

/**
 * Descriptor-bound staged destination owned by the coordinator's path-grant authority.
 *
 * Implementations retain the already-open file handle and parent-directory identity. None of
 * these methods may reopen a caller-derived path. `publishCreateOnly` revalidates the parent and
 * target through the grant authority immediately before publishing.
 */
export interface NodeStagedDestinationHandle {
    readonly outputCapability: HeadlessStagedOutputCapability;
    readonly displayPath: string;
    reset(signal?: AbortSignal): Promise<void>;
    sync(signal?: AbortSignal): Promise<void>;
    inspect(
        verifier: HeadlessMp4VerifierPort,
        signal?: AbortSignal,
    ): Promise<HeadlessMp4Inspection>;
    publishCreateOnly(signal?: AbortSignal): Promise<void>;
    abort(): Promise<void>;
    hashCommittedSha256(signal?: AbortSignal): Promise<string>;
    committedSize(signal?: AbortSignal): Promise<number>;
}

/**
 * Coordinator-owned authority for already validated and staged destinations.
 *
 * The resolver returns an owned handle rather than temporary/final paths. This adapter therefore
 * cannot be tricked into truncating, syncing, hashing, or publishing a substituted filesystem
 * object after validation.
 */
export interface NodeStagedExportCapabilityResolverPort {
    acquire(
        jobId: string,
        target: HeadlessExportTargetReference,
        signal?: AbortSignal,
    ): Promise<NodeStagedDestinationHandle>;
    listPartials(
        recoveryScopeId: string,
        signal?: AbortSignal,
    ): Promise<HeadlessExportPartial[]>;
    removePartial(partialId: string): Promise<void>;
}

export class NodeHeadlessExportArtifactPort implements HeadlessExportArtifactPort {
    constructor(private readonly capabilities: NodeStagedExportCapabilityResolverPort) {}

    async acquireCreateOnly(
        jobId: string,
        target: HeadlessExportTargetReference,
        signal?: AbortSignal,
    ): Promise<HeadlessExportTargetLease> {
        throwIfAborted(signal);
        const handle = await this.capabilities.acquire(jobId, target, signal);
        try {
            throwIfAborted(signal);
            validateResolvedCapability(target, handle.outputCapability);
            if (typeof handle.displayPath !== 'string'
                || handle.displayPath.length === 0
                || handle.displayPath.length > 4_096
                || handle.displayPath.includes('\0')) {
                throw new HeadlessRenderError(
                    'INVALID_OUTPUT',
                    'The staged output handle returned an invalid display path.',
                );
            }
        } catch (error) {
            await handle.abort().catch(() => undefined);
            throw error;
        }
        let committed = false;
        let aborted = false;
        return {
            outputCapability: handle.outputCapability,
            displayPath: handle.displayPath,
            reset: async (resetSignal) => {
                assertLeaseOpen(committed, aborted);
                throwIfAborted(resetSignal);
                await handle.reset(resetSignal);
                throwIfAborted(resetSignal);
            },
            sync: async (syncSignal) => {
                assertLeaseOpen(committed, aborted);
                throwIfAborted(syncSignal);
                await handle.sync(syncSignal);
                throwIfAborted(syncSignal);
            },
            inspect: (verifier, inspectSignal) => {
                assertLeaseOpen(committed, aborted);
                return handle.inspect(verifier, inspectSignal);
            },
            commit: async (commitSignal) => {
                assertLeaseOpen(committed, aborted);
                throwIfAborted(commitSignal);
                await handle.publishCreateOnly(commitSignal);
                committed = true;
            },
            abort: async () => {
                if (committed || aborted) return;
                aborted = true;
                await handle.abort();
            },
            hashSha256: (hashSignal) => {
                if (!committed) throw new Error('Export output is not committed.');
                return handle.hashCommittedSha256(hashSignal);
            },
            size: (sizeSignal) => {
                if (!committed) throw new Error('Export output is not committed.');
                return handle.committedSize(sizeSignal);
            },
        };
    }

    listPartials(
        recoveryScopeId: string,
        signal?: AbortSignal,
    ): Promise<HeadlessExportPartial[]> {
        return this.capabilities.listPartials(recoveryScopeId, signal);
    }

    removePartial(partialId: string): Promise<void> {
        return this.capabilities.removePartial(partialId);
    }
}

function validateResolvedCapability(
    target: HeadlessExportTargetReference,
    capability: HeadlessStagedOutputCapability,
): void {
    if (target.version !== 1
        || !isOpaqueId(target.capabilityId)
        || !isOpaqueId(target.grantId)
        || Object.keys(target).sort().join(',') !== 'capabilityId,grantId,version'
        || capability.version !== 1
        || capability.kind !== 'create-only-staged-output'
        || capability.capabilityId !== target.capabilityId
        || capability.grantId !== target.grantId
        || !isOpaqueId(capability.stagingId)
        || Object.keys(capability).sort().join(',')
            !== 'capabilityId,grantId,kind,stagingId,version') {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'The staged output capability does not match its validated create-only grant.',
        );
    }
}

function assertLeaseOpen(committed: boolean, aborted: boolean): void {
    if (committed || aborted) throw new Error('The staged export capability is already terminal.');
}

function isOpaqueId(value: string): boolean {
    return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(value);
}
