import type {
    HeadlessMediaIdentity,
    VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';

/**
 * One freshly acquired, seekable view of an immutable render source.
 *
 * The coordinator-owned resolver is responsible for binding the path-free verified source set to
 * a descriptor. The backend inherits only this descriptor and never receives or reopens a path.
 */
export interface AcquiredImmutableSourceHandle {
    readonly identity: HeadlessMediaIdentity;
    readonly fileDescriptor: number;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
}
export interface ImmutableSourceHandleResolverPort {
    acquire(
        mediaSources: VerifiedRenderMediaSourceSet,
        expectedIdentity: HeadlessMediaIdentity,
        signal?: AbortSignal,
    ): Promise<AcquiredImmutableSourceHandle>;
}
