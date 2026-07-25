import type { PathGrantAuthority } from '../../path-grants/path-grant-authority';
import type {
    ManagedProjectImportPathAuthority,
    ManagedProjectImportReadLease,
} from './contracts';

const MAX_READ_BYTES = 8 * 1024 * 1024;

/** Adapts the existing verified read-grant boundary without exposing its private source path. */
export class PathGrantProjectImportSourceAuthority implements ManagedProjectImportPathAuthority {
    constructor(private readonly grants: PathGrantAuthority) {}

    async openPath(input: Parameters<ManagedProjectImportPathAuthority['openPath']>[0])
    : Promise<ManagedProjectImportReadLease> {
        const verified = await this.grants.openRead(
            input.grantId,
            { sessionId: input.sessionId, sessionEpoch: input.sessionEpoch },
            input.path,
            { signal: input.signal },
        );
        let closed = false;
        return {
            capabilityId: `project-import:${verified.grantId}:${verified.digest}`,
            byteLength: verified.identity.size,
            async read(position, length, signal) {
                if (closed) throw new Error('Managed project import source is closed.');
                if (!Number.isSafeInteger(position) || position < 0
                    || !Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES
                    || position + length > verified.identity.size) {
                    throw new RangeError('Managed project import read is outside its authorized bounds.');
                }
                if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
                await verified.verifyUnchanged();
                const buffer = new Uint8Array(length);
                const result = await verified.handle.read(buffer, 0, length, position);
                if (result.bytesRead !== length) {
                    throw new Error('Managed project import source ended unexpectedly.');
                }
                return buffer;
            },
            assertCurrent: () => verified.verifyUnchanged(),
            async close() {
                if (closed) return;
                closed = true;
                await verified.close();
            },
        };
    }
}
