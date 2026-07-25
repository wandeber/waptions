import type {
    ArtifactRange,
    ArtifactRecord,
    ArtifactRegistry,
} from '../../artifacts/artifact-registry';
import type { BridgeCapabilitySigner } from '../../http-bridge/capability';
import type {
    BridgeCapabilityScope,
    BridgeResourceHandle,
    BridgeResourceScope,
} from '../../http-bridge/contracts';

const MAX_RANGE_BYTES = 4 * 1024 * 1024;

export interface PublicArtifactMetadata {
    readonly schemaVersion: 1;
    readonly artifactId: string;
    readonly projectId: string;
    readonly kind: string;
    readonly mediaType: string;
    readonly contentDigest: `sha256:${string}`;
    readonly byteLength: number;
    readonly createdAt: string;
    readonly expiresAt?: string;
    readonly storageRef: string;
}

export interface AuthenticatedArtifactViewContext {
    readonly sessionId: string;
    readonly projectId: string;
    readonly viewId: string;
    readonly sessionEpoch: string;
    readonly origin: string;
    assertLive(signal?: AbortSignal): Promise<void>;
}

export class ManagedArtifactAccessAdapter {
    constructor(
        private readonly artifacts: ArtifactRegistry,
        private readonly bridge: BridgeCapabilitySigner,
    ) {}

    async metadata(projectId: string, artifactId: string): Promise<PublicArtifactMetadata> {
        return projectArtifact(await this.artifacts.get(projectId, artifactId));
    }

    async readRange(input: {
        readonly projectId: string;
        readonly artifactId: string;
        readonly start: number;
        readonly endExclusive: number;
    }): Promise<ArtifactRange> {
        if (input.endExclusive - input.start > MAX_RANGE_BYTES) {
            throw new RangeError('Artifact range exceeds the 4 MiB bound.');
        }
        return this.artifacts.readRange(
            input.projectId,
            input.artifactId,
            input.start,
            input.endExclusive,
        );
    }

    async issueBridgeCapability(input: {
        readonly view: AuthenticatedArtifactViewContext;
        readonly artifactId: string;
        readonly requestedTtlSeconds?: number;
        readonly signal?: AbortSignal;
    }): Promise<{
        readonly capability: string;
        readonly expiresAt: string;
        readonly resource: BridgeResourceScope;
    }> {
        await input.view.assertLive(input.signal);
        await this.artifacts.get(input.view.projectId, input.artifactId);
        const resource: BridgeResourceScope = {
            kind: 'artifact',
            resourceId: input.artifactId,
        };
        const issued = this.bridge.issue({
            sessionId: input.view.sessionId,
            projectId: input.view.projectId,
            viewId: input.view.viewId,
            sessionEpoch: input.view.sessionEpoch,
            origin: input.view.origin,
            methods: ['GET', 'HEAD'],
            resources: [resource],
        }, input.requestedTtlSeconds ?? 60);
        return {
            capability: issued.token,
            expiresAt: issued.scope.expiresAt,
            resource,
        };
    }

    async openBridgeArtifact(input: {
        readonly scope: BridgeCapabilityScope;
        readonly resource: BridgeResourceScope;
        readonly signal?: AbortSignal;
    }): Promise<BridgeResourceHandle> {
        if (input.resource.kind !== 'artifact'
            || !input.scope.resources.some((resource) => (
                resource.kind === 'artifact'
                && resource.resourceId === input.resource.resourceId
            ))) {
            throw new Error('Bridge artifact is outside the capability scope.');
        }
        const record = await this.artifacts.get(
            input.scope.projectId,
            input.resource.resourceId,
        );
        return {
            size: record.byteLength,
            etag: record.digest,
            contentType: record.mediaType,
            read: (range, signal) => this.bridgeRange(
                record.projectId,
                record.artifactId,
                range.start,
                range.endExclusive,
                signal,
            ),
            close: async () => undefined,
        };
    }

    private async *bridgeRange(
        projectId: string,
        artifactId: string,
        start: number,
        endExclusive: number,
        signal: AbortSignal,
    ): AsyncIterable<Uint8Array> {
        if (!Number.isSafeInteger(start)
            || !Number.isSafeInteger(endExclusive)
            || start < 0
            || endExclusive <= start) {
            throw new RangeError('Bridge artifact range is invalid.');
        }
        let cursor = start;
        while (cursor < endExclusive) {
            if (signal.aborted) throw signal.reason;
            const next = Math.min(endExclusive, cursor + MAX_RANGE_BYTES);
            const range = await this.artifacts.readRange(projectId, artifactId, cursor, next);
            yield range.bytes;
            cursor = next;
        }
    }
}

function projectArtifact(record: ArtifactRecord): PublicArtifactMetadata {
    const contentDigest = normalizeDigest(record.digest);
    return Object.freeze({
        schemaVersion: 1,
        artifactId: record.artifactId,
        projectId: record.projectId,
        kind: record.kind,
        mediaType: record.mediaType,
        contentDigest,
        byteLength: record.byteLength,
        createdAt: record.createdAt,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        // This is a public opaque registry reference, not the internal relative blob path.
        storageRef: `artifact:${record.artifactId}`,
    });
}

function normalizeDigest(value: string): `sha256:${string}` {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
        throw new Error('Artifact digest is invalid.');
    }
    return value as `sha256:${string}`;
}
