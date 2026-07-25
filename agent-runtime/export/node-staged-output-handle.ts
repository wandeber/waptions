import type { HeadlessStagedOutputCapability } from '../render/contracts';

export type NodeStagedOutputHandleAccess = 'read-only' | 'read-write';

/**
 * A fresh descriptor-bound view of one coordinator-owned staged output.
 *
 * The resolver, not the render backend, maps the opaque capability to an inode. Callers inherit
 * only `fileDescriptor`; no path or display name crosses this boundary.
 */
export interface AcquiredNodeStagedOutputHandle {
    readonly outputCapability: HeadlessStagedOutputCapability;
    readonly fileDescriptor: number;
    readonly access: NodeStagedOutputHandleAccess;
    size(signal?: AbortSignal): Promise<number>;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    sync(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
}
export interface NodeStagedOutputHandleResolverPort {
    acquire(
        outputCapability: HeadlessStagedOutputCapability,
        access: NodeStagedOutputHandleAccess,
        signal?: AbortSignal,
    ): Promise<AcquiredNodeStagedOutputHandle>;
}
