import { randomBytes, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { ArtifactRecord } from '../../artifacts/artifact-registry';
import { managedError } from '../../coordinator/errors';
import type { ManagedCoordinator } from '../../coordinator/managed-coordinator';
import {
    BridgeAuthorizationError,
    type BridgeCapabilityScope,
    type BridgeCoordinatorAdapter,
    type BridgeResourceHandle,
    type BridgeResourceScope,
} from '../../http-bridge/contracts';
import {
    startLocalHttpBridge,
    type LocalHttpBridge,
} from '../../http-bridge/server';
import { canonicalDigest } from '../../persistence/canonical-json';
import type {
    ManagedArtifactAccessAuthority,
    ManagedEditorRenderAuthority,
} from '../managed-tool-handlers';
import type {
    ManagedCoreCommand,
    ManagedCoreEditorState,
    ManagedCoreResult,
} from '../core-editor-port';
import {
    createProductionEditorRenderAuthority,
} from '../editor-render/production-editor-render-authority';
import type {
    EditorRenderAttachmentResult,
    EditorRenderBridgeServer,
    EditorRenderCapabilityScope,
    EditorRenderCoordinatorPort,
    EditorRenderPresentation,
} from '../editor-render/contracts';

type ProductionCoordinator = ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
>;

export interface ProductionAppResource {
    readonly uri: string;
    readonly mimeType: 'text/html;profile=mcp-app';
    readonly buildHash: string;
}

export interface ProductionBridgeRuntime {
    readonly bridge: LocalHttpBridge;
    readonly editorRender: ManagedEditorRenderAuthority;
    readonly artifactAccess: ManagedArtifactAccessAuthority;
    close(): Promise<void>;
}

interface PairingRecord {
    readonly capabilityId: string;
    readonly sessionId: string;
    readonly projectId: string;
    readonly viewId: string;
    readonly participantId: string;
    readonly presentation: EditorRenderPresentation;
    readonly sessionEpoch: string;
    readonly resources: readonly BridgeResourceScope[];
    readonly expiresAtMilliseconds: number;
    consumed: boolean;
}

export async function createProductionBridgeRuntime(
    coordinator: ProductionCoordinator,
    appResource: ProductionAppResource,
): Promise<ProductionBridgeRuntime> {
    validateAppResource(appResource);
    const pairings = new Map<string, PairingRecord>();
    const allowedOrigins = Object.freeze([
        'https://chatgpt.com',
        'https://chat.openai.com',
    ]);
    const adapter: BridgeCoordinatorAdapter = {
        consumePairingCapability: async (request) => {
            const pairing = pairings.get(request.pairingCapability);
            if (
                !pairing
                || pairing.consumed
                || pairing.expiresAtMilliseconds <= Date.now()
                || !allowedOrigins.includes(request.origin)
            ) {
                throw new BridgeAuthorizationError(
                    'CAPABILITY_INVALID',
                    'The editor pairing capability is invalid.',
                );
            }
            pairing.consumed = true;
            pairings.delete(request.pairingCapability);
            await authorizeLiveView(coordinator, pairing);
            return {
                scope: {
                    sessionId: pairing.sessionId,
                    projectId: pairing.projectId,
                    viewId: pairing.viewId,
                    sessionEpoch: pairing.sessionEpoch,
                    origin: request.origin,
                    methods: ['GET', 'HEAD'],
                    resources: [...pairing.resources],
                    expiresAt: new Date(pairing.expiresAtMilliseconds).toISOString(),
                },
                maxTtlSeconds: Math.max(
                    1,
                    Math.min(
                        300,
                        Math.floor((pairing.expiresAtMilliseconds - Date.now()) / 1_000),
                    ),
                ),
            };
        },
        authorizeBridgeView: async (scope) => {
            await authorizeLiveView(coordinator, scope);
        },
        openBridgeResource: async (request) => {
            if (!request.scope.resources.some((resource) => (
                resource.kind === request.resource.kind
                && resource.resourceId === request.resource.resourceId
            ))) {
                throw new BridgeAuthorizationError(
                    'CAPABILITY_SCOPE_MISMATCH',
                    'The requested bridge resource is outside the capability.',
                );
            }
            if (request.resource.kind === 'artifact') {
                return openArtifact(coordinator, request.scope.projectId, request.resource.resourceId);
            }
            return openMedia(coordinator, request.scope.projectId, request.resource.resourceId);
        },
    };
    const bridge = await startLocalHttpBridge({
        coordinator: adapter,
        capabilitySecret: randomBytes(32),
        allowedOrigins,
    });

    const bridgeServer: EditorRenderBridgeServer = {
        issuePairingCapability: async (scope, context) => {
            context.signal.throwIfAborted();
            const pairingCapability =
                `pair-secret:${randomUUID()}:${randomUUID()}`;
            pairings.set(
                pairingCapability,
                await pairingRecord(coordinator, scope),
            );
            return { pairingCapability, scope };
        },
        revokePairingCapability: async (capabilityId) => {
            for (const [secret, pairing] of pairings) {
                if (pairing.capabilityId === capabilityId) {
                    pairings.delete(secret);
                }
            }
        },
    };
    const editorRender = createProductionEditorRenderAuthority({
            app: {
                buildHash: appResource.buildHash,
                resourceUri: appResource.uri,
                mimeType: appResource.mimeType,
            },
            coordinator: createEditorRenderCoordinator(coordinator),
            bridgeServer,
        });

    return {
        bridge,
        editorRender,
        close: async () => {
            await editorRender.close();
            await bridge.close();
        },
        artifactAccess: {
            readRange: async (projectId, artifact, offset, endExclusive) => {
                const range = await coordinator.artifacts.readRange(
                    projectId,
                    artifact.artifactId,
                    offset,
                    endExclusive,
                );
                return {
                    bytes: range.bytes,
                    start: range.start,
                    endExclusive: range.endExclusive,
                    totalBytes: range.totalBytes,
                    digest: artifact.digest,
                };
            },
            signedRangeUrl: async (projectId, artifact, context) => {
                const project = coordinator.getProject(projectId);
                const participantId = context.connectionId
                    ? coordinator.participantForConnection(context.connectionId)
                    : null;
                const view = participantId
                    ? coordinator.presence.list(projectId).find(
                        (candidate) => candidate.participantId === participantId,
                    )
                    : undefined;
                if (!view) {
                    throw managedError(
                        'INVALID_REQUEST',
                        'A live editor view is required for a signed artifact URL.',
                    );
                }
                const issued = bridge.issueResourceCapability({
                    sessionId: project.envelope.sessionId,
                    projectId,
                    viewId: view.viewId,
                    sessionEpoch: project.state.sessionEpoch,
                    origin: allowedOrigins[0],
                    methods: ['GET', 'HEAD'],
                    resources: [{
                        kind: 'artifact',
                        resourceId: artifact.artifactId,
                    }],
                }, 60);
                return {
                    signedRangeUrl: bridge.createSignedResourceUrl(
                        { kind: 'artifact', resourceId: artifact.artifactId },
                        issued.token,
                    ),
                    expiresAt: issued.scope.expiresAt,
                };
            },
        },
    };
}

interface DurableEditorViewRecord {
    readonly schemaVersion: 1;
    readonly projectId: string;
    readonly viewId: string;
    readonly viewRevision: number;
    readonly connectedAt: string;
    readonly heartbeatAt: string;
    readonly followPresenter: boolean;
    readonly selectedIds: readonly string[];
    readonly selectionKind?: 'tracks' | 'clips' | 'subtitles' | 'narrative';
    readonly playheadSample: number;
    readonly zoom: number;
    readonly scrollLeft: number;
    readonly focusedPanel?: string;
    readonly presentation: EditorRenderPresentation;
}

function createEditorRenderCoordinator(
    coordinator: ProductionCoordinator,
): EditorRenderCoordinatorPort {
    return {
        attachOrUpdateViewReceiptFirst: async (
            input,
            context,
        ): Promise<EditorRenderAttachmentResult> => {
            context.signal.throwIfAborted();
            const participantId = context.connectionId
                ? coordinator.participantForConnection(context.connectionId)
                : null;
            if (!participantId) {
                return {
                    ok: false,
                    error: {
                        code: 'INVALID_REQUEST',
                        message:
                            'The editor caller is not attached to this session.',
                        retryable: false,
                    },
                };
            }
            const result = await coordinator.mutateRegistry(
                input.projectId,
                input.request,
                async (envelope) => {
                    const existing = (
                        await coordinator.store
                            .readNamespace<DurableEditorViewRecord>(
                                input.projectId,
                                'views',
                            )
                    ).find((view) => view.viewId === input.viewId);
                    const now = new Date().toISOString();
                    const view: DurableEditorViewRecord = existing
                        ? {
                            ...existing,
                            viewRevision: existing.viewRevision + 1,
                            heartbeatAt: now,
                            presentation: input.presentation,
                        }
                        : {
                            schemaVersion: 1,
                            projectId: input.projectId,
                            viewId: input.viewId,
                            viewRevision: 0,
                            connectedAt: now,
                            heartbeatAt: now,
                            followPresenter: false,
                            selectedIds: [],
                            playheadSample: 0,
                            zoom: 1,
                            scrollLeft: 0,
                            presentation: input.presentation,
                        };
                    const capabilityId =
                        `editor-render:${randomUUID()}`;
                    const capabilityExpiresAt = new Date(
                        Date.now() + input.capabilityTtlSeconds * 1_000,
                    ).toISOString();
                    return {
                        update: (current) => current,
                        writes: [{
                            relativePath:
                                `views/${canonicalDigest({
                                    viewId: input.viewId,
                                }).slice(7)}.json`,
                            value: view,
                        }],
                        result: {
                            projectId: input.projectId,
                            sessionId: envelope.sessionId,
                            sessionEpoch: input.request.sessionEpoch,
                            viewId: input.viewId,
                            participantId,
                            presentation: input.presentation,
                            capabilityId,
                            capabilityExpiresAt,
                        },
                        eventKind: 'view.changed' as const,
                        eventData: {
                            viewId: input.viewId,
                            viewRevision: view.viewRevision,
                            changedFields: ['presentation'],
                        },
                        afterCommit: () => {
                            coordinator.presence.attach(
                                input.projectId,
                                input.viewId,
                                participantId,
                            );
                        },
                    };
                },
            );
            if (!result.ok) {
                return {
                    ok: false,
                    error: result.error,
                    ...(result.state ? { state: result.state } : {}),
                };
            }
            if (result.data.participantId !== participantId) {
                return {
                    ok: false,
                    error: {
                        code: 'INVALID_REQUEST',
                        message:
                            'The editor render receipt belongs to another participant.',
                        retryable: false,
                    },
                    state: result.state,
                };
            }
            if (!coordinator.presence.list(input.projectId).some((view) => (
                view.viewId === result.data.viewId
                && view.participantId === participantId
            ))) {
                coordinator.presence.attach(
                    input.projectId,
                    result.data.viewId,
                    participantId,
                );
            }
            return {
                ok: true,
                receipt: {
                    ...result.data,
                    state: result.state,
                    ...(result.committedState
                        ? { committedState: result.committedState }
                        : {}),
                    replayed: result.replayed,
                },
            };
        },
    };
}

async function pairingRecord(
    coordinator: ProductionCoordinator,
    scope: EditorRenderCapabilityScope,
): Promise<PairingRecord> {
    const project = coordinator.getProject(scope.projectId);
    const artifacts = await coordinator.artifacts.list(scope.projectId);
    const resources: BridgeResourceScope[] = [
        ...project.envelope.sourceRegistry
            .filter((source) => !source.releasedAt)
            .slice(0, 256)
            .map((source) => ({
                kind: 'media' as const,
                resourceId: source.sourceId,
            })),
        ...artifacts.slice(0, 244).map((artifact) => ({
            kind: 'artifact' as const,
            resourceId: artifact.artifactId,
        })),
    ];
    return {
        capabilityId: scope.capabilityId,
        sessionId: scope.sessionId,
        projectId: scope.projectId,
        viewId: scope.viewId,
        participantId: scope.participantId,
        presentation: scope.presentation,
        sessionEpoch: scope.sessionEpoch,
        resources,
        expiresAtMilliseconds: Date.parse(scope.expiresAt),
        consumed: false,
    };
}

async function authorizeLiveView(
    coordinator: ProductionCoordinator,
    scope: Pick<
        BridgeCapabilityScope,
        'sessionId' | 'projectId' | 'viewId' | 'sessionEpoch'
    >,
): Promise<void> {
    const project = coordinator.getProject(scope.projectId);
    const live = coordinator.presence.list(scope.projectId).some(
        (view) => view.viewId === scope.viewId,
    );
    if (
        project.envelope.sessionId !== scope.sessionId
        || project.state.sessionEpoch !== scope.sessionEpoch
        || project.envelope.archivedAt
        || !live
    ) {
        throw new BridgeAuthorizationError(
            'CAPABILITY_SCOPE_MISMATCH',
            'The editor view is no longer live.',
        );
    }
}

async function openArtifact(
    coordinator: ProductionCoordinator,
    projectId: string,
    artifactId: string,
): Promise<BridgeResourceHandle> {
    const artifact = await coordinator.artifacts.get(projectId, artifactId);
    return {
        size: artifact.byteLength,
        etag: artifact.digest,
        contentType: artifact.mediaType,
        read: (range) => artifactStream(coordinator, artifact, range),
        close: async () => undefined,
    };
}

async function* artifactStream(
    coordinator: ProductionCoordinator,
    artifact: ArtifactRecord,
    range: { start: number; endExclusive: number },
): AsyncIterable<Uint8Array> {
    let offset = range.start;
    while (offset < range.endExclusive) {
        const end = Math.min(range.endExclusive, offset + 1024 * 1024);
        const part = await coordinator.artifacts.readRange(
            artifact.projectId,
            artifact.artifactId,
            offset,
            end,
        );
        yield part.bytes;
        offset = end;
    }
}

async function openMedia(
    coordinator: ProductionCoordinator,
    projectId: string,
    sourceId: string,
): Promise<BridgeResourceHandle> {
    const retained = await coordinator.openRetainedSource(projectId, sourceId);
    let closed = false;
    return {
        size: retained.identity.size,
        etag: retained.digest,
        contentType: 'application/octet-stream',
        read: (range, signal) => handleStream(
            retained.handle,
            range,
            signal,
            () => closed,
        ),
        close: async () => {
            if (closed) return;
            closed = true;
            await retained.close();
        },
    };
}

async function* handleStream(
    handle: FileHandle,
    range: { start: number; endExclusive: number },
    signal: AbortSignal,
    isClosed: () => boolean,
): AsyncIterable<Uint8Array> {
    let offset = range.start;
    while (offset < range.endExclusive) {
        if (signal.aborted || isClosed()) throw signal.reason ?? new Error('Media stream closed.');
        const length = Math.min(1024 * 1024, range.endExclusive - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) {
            throw new BridgeAuthorizationError(
                'NOT_FOUND',
                'The retained media range was truncated.',
            );
        }
        yield buffer;
        offset += length;
    }
}

function validateAppResource(appResource: ProductionAppResource): void {
    if (
        !/^ui:\/\/waptions\/editor\/v1\/[a-f0-9]{64}\/index\.html$/.test(
            appResource.uri,
        )
        || appResource.mimeType !== 'text/html;profile=mcp-app'
        || !/^[a-f0-9]{64}$/.test(appResource.buildHash)
        || !appResource.uri.includes(appResource.buildHash)
    ) {
        throw new Error('The verified packaged editor resource is invalid.');
    }
}
