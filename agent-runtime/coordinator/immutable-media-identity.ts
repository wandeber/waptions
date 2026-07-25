import { canonicalDigest } from '../persistence/canonical-json';

/**
 * Shared media identity passed between coordinator, Core, media workers, and jobs.
 *
 * It contains no filesystem path or grant secret. Byte access always travels separately through
 * a verified open-handle capability.
 */
export interface ImmutableMediaIdentity {
    sourceId: string;
    immutableVersion: string;
    byteLength: number;
    digest: string;
    streamSignature: string;
}

export function immutableMediaIdentityDigest(identity: ImmutableMediaIdentity): string {
    return canonicalDigest(identity, 16 * 1024);
}
