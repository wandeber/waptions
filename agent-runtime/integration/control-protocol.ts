import type {
    CoordinatorEventSubscription,
    ManagedCoordinatorAdapter,
} from '../server/coordinator-adapter';
import type {
    MutationToolCall,
    JsonObject,
    ReadToolCall,
    ScopedMutationToolCall,
} from '../mcp/contracts';
import type {
    LocalTransportRequest,
    LocalTransportRequestContext,
} from '../transport/local-json-transport';
import { managedError } from '../coordinator/errors';
import {
    canonicalRequestHash,
    canonicalizeJson,
} from '../mcp/canonical-json';
import { loadCommittedCoreSemanticSchemaBundle } from '../mcp/core-schema-loader';
import { ToolSchemaValidator } from '../mcp/schema-validator';

export const COORDINATOR_CONTROL_PROTOCOL_VERSION = 1 as const;

export const COORDINATOR_CONTROL_METHODS = [
    'coordinator.health',
    'coordinator.execute-read',
    'coordinator.resolve-receipt-scope',
    'coordinator.execute-mutation',
    'coordinator.execute-session-open',
    'coordinator.wait-for-events',
] as const;

export type CoordinatorControlMethod =
    (typeof COORDINATOR_CONTROL_METHODS)[number];

export interface CoordinatorControlHealth {
    protocolVersion: typeof COORDINATOR_CONTROL_PROTOCOL_VERSION;
    ready: true;
}

export interface CoordinatorEventWaitRequest {
    sessionId: string;
    waitMilliseconds: number;
}

export interface CoordinatorEventWaitResult {
    available: boolean;
}

const MAX_EVENT_WAIT_MILLISECONDS = 30_000;
const SUBSCRIPTION_CLEANUP_WAIT_MILLISECONDS = 1_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * This is the complete private-process seam. The persistent runtime owns the
 * adapter and passes it here; MCP processes receive only the matching client.
 */
export function createCoordinatorControlHandler(
    coordinator: ManagedCoordinatorAdapter,
): (
    request: LocalTransportRequest,
    context: LocalTransportRequestContext,
) => Promise<unknown> {
    const schemas = loadCommittedCoreSemanticSchemaBundle();
    const validator = new ToolSchemaValidator();
    for (const name of schemas.toolNames) {
        validator.register(name, schemas.toolSchemas[name].inputSchema);
    }
    return async (request, context) => {
        switch (request.method as CoordinatorControlMethod) {
            case 'coordinator.health':
                assertNoParams(request.params);
                return {
                    protocolVersion: COORDINATOR_CONTROL_PROTOCOL_VERSION,
                    ready: true,
                } satisfies CoordinatorControlHealth;
            case 'coordinator.execute-read':
                return coordinator.executeRead(
                    readCallParam(request.params, schemas, validator),
                    { signal: context.signal },
                );
            case 'coordinator.resolve-receipt-scope':
                return coordinator.resolveReceiptScope(
                    mutationCallParam(request.params, schemas, validator),
                    { signal: context.signal },
                );
            case 'coordinator.execute-mutation':
                return coordinator.executeMutation(
                    scopedMutationCallParam(request.params, schemas, validator),
                    { signal: context.signal },
                );
            case 'coordinator.execute-session-open':
                {
                    const call = mutationCallParam(
                        request.params,
                        schemas,
                        validator,
                    );
                    if (call.toolName !== 'waptions_session_open') {
                        throw managedError(
                            'INVALID_REQUEST',
                            'Only session open may use the bootstrap control method.',
                        );
                    }
                    return coordinator.executeSessionOpen(
                        call,
                        { signal: context.signal },
                    );
                }
            case 'coordinator.wait-for-events':
                return waitForEvents(
                    coordinator,
                    eventWaitParam(request.params),
                    context.signal,
                );
            default:
                throw managedError(
                    'INVALID_REQUEST',
                    'Unknown coordinator control method.',
                );
        }
    };
}

type SemanticSchemas = ReturnType<typeof loadCommittedCoreSemanticSchemaBundle>;

function readCallParam(
    value: unknown,
    schemas: SemanticSchemas,
    validator: ToolSchemaValidator,
): ReadToolCall {
    return oneCallParam(
        value,
        false,
        false,
        schemas,
        validator,
    ) as unknown as ReadToolCall;
}

function mutationCallParam(
    value: unknown,
    schemas: SemanticSchemas,
    validator: ToolSchemaValidator,
): MutationToolCall {
    return oneCallParam(
        value,
        true,
        false,
        schemas,
        validator,
    ) as unknown as MutationToolCall;
}

function scopedMutationCallParam(
    value: unknown,
    schemas: SemanticSchemas,
    validator: ToolSchemaValidator,
): ScopedMutationToolCall {
    const call = oneCallParam(
        value,
        true,
        true,
        schemas,
        validator,
    );
    const scope = record(call.receiptScope);
    if (
        typeof scope.projectId !== 'string'
        || scope.projectId.length === 0
        || scope.projectId.length > 128
        || typeof scope.toolName !== 'string'
        || typeof scope.idempotencyKey !== 'string'
        || scope.toolName !== call.toolName
        || scope.idempotencyKey
            !== (call.identity as Record<string, unknown>).idempotencyKey
        || !hasExactKeys(scope, ['projectId', 'toolName', 'idempotencyKey'])
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'The scoped mutation receipt identity is invalid.',
        );
    }
    return call as unknown as ScopedMutationToolCall;
}

function oneCallParam(
    value: unknown,
    mutation: boolean,
    scoped: boolean,
    schemas: SemanticSchemas,
    validator: ToolSchemaValidator,
): Record<string, unknown> {
    const params = record(value);
    if (!hasExactKeys(params, ['call'])) {
        throw managedError(
            'INVALID_REQUEST',
            'Coordinator control parameters must contain exactly one call.',
        );
    }
    const call = record(params.call);
    const expectedKeys = [
        'canonicalRequest',
        ...(mutation ? ['identity'] : []),
        'mutation',
        ...(scoped ? ['receiptScope'] : []),
        'request',
        'requestHash',
        'toolName',
    ];
    const request = call.request as JsonObject;
    const toolName = typeof call.toolName === 'string'
        && Object.hasOwn(schemas.toolSchemas, call.toolName)
        ? call.toolName as keyof typeof schemas.toolSchemas
        : undefined;
    const validation = toolName
        ? validator.validateInput(toolName, call.request)
        : { valid: false as const };
    if (
        !hasExactKeys(call, expectedKeys)
        || call.mutation !== mutation
        || !toolName
        || schemas.toolSchemas[toolName].mutation !== mutation
        || (toolName === 'waptions_session_open') !== (
            mutation && !scoped
            && call.toolName === 'waptions_session_open'
        )
        || typeof call.canonicalRequest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(String(call.requestHash))
        || !isJsonObject(call.request)
        || !validation.valid
        || call.canonicalRequest !== canonicalizeJson(request)
        || call.requestHash !== canonicalRequestHash(request)
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'The canonical coordinator call is invalid.',
        );
    }
    if (
        mutation
        && !sameJsonValue(
            call.identity,
            mutationIdentityForRequest(request),
        )
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'The coordinator mutation identity does not match its request.',
        );
    }
    return call;
}

function mutationIdentityForRequest(request: JsonObject): JsonObject {
    return {
        ...(typeof request.sessionId === 'string'
            ? { sessionId: request.sessionId }
            : {}),
        ...(typeof request.sessionEpoch === 'string'
            ? { sessionEpoch: request.sessionEpoch }
            : {}),
        idempotencyKey: request.idempotencyKey,
        ...(isJsonObject(request.expected)
            ? { expected: request.expected }
            : {}),
    };
}

function sameJsonValue(left: unknown, right: JsonObject): boolean {
    return (
        isJsonObject(left)
        && canonicalizeJson(left as JsonObject) === canonicalizeJson(right)
    );
}

function eventWaitParam(value: unknown): CoordinatorEventWaitRequest {
    const params = record(value);
    if (
        !hasExactKeys(params, ['sessionId', 'waitMilliseconds'])
        || typeof params.sessionId !== 'string'
        || !SESSION_ID.test(params.sessionId)
        || !Number.isSafeInteger(params.waitMilliseconds)
        || Number(params.waitMilliseconds) <= 0
        || Number(params.waitMilliseconds) > MAX_EVENT_WAIT_MILLISECONDS
    ) {
        throw managedError(
            'INVALID_REQUEST',
            'The coordinator event wait request is invalid.',
        );
    }
    return params as unknown as CoordinatorEventWaitRequest;
}

async function waitForEvents(
    coordinator: ManagedCoordinatorAdapter,
    request: CoordinatorEventWaitRequest,
    signal: AbortSignal,
): Promise<CoordinatorEventWaitResult> {
    if (!coordinator.subscribeToEvents) {
        return { available: false };
    }
    let subscription: CoordinatorEventSubscription | undefined;
    let subscriptionPromise: Promise<CoordinatorEventSubscription> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
        const available = await new Promise<boolean>((resolve, reject) => {
            let settled = false;
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            abortListener = () => {
                if (settled) return;
                settled = true;
                reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            if (signal.aborted) {
                abortListener();
                return;
            }
            signal.addEventListener('abort', abortListener, { once: true });
            timer = setTimeout(() => finish(false), request.waitMilliseconds);
            timer.unref?.();
            subscriptionPromise = coordinator.subscribeToEvents!(
                request.sessionId,
                () => finish(true),
                { signal },
            );
            subscriptionPromise.then(
                (value) => {
                    subscription = value;
                },
                reject,
            );
        });
        return { available };
    } finally {
        if (timer) clearTimeout(timer);
        if (abortListener) signal.removeEventListener('abort', abortListener);
        if (!subscription && subscriptionPromise) {
            subscription = await settleSubscriptionForCleanup(
                subscriptionPromise,
            );
        }
        await subscription?.close();
    }
}

async function settleSubscriptionForCleanup(
    pending: Promise<CoordinatorEventSubscription>,
): Promise<CoordinatorEventSubscription | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(
            () => resolve(undefined),
            SUBSCRIPTION_CLEANUP_WAIT_MILLISECONDS,
        );
        timer.unref?.();
    });
    const subscription = await Promise.race([
        pending.catch(() => undefined),
        timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (!subscription) {
        // A late adapter setup still gets closed; the request path does not
        // remain leased indefinitely waiting for a broken implementation.
        void pending.then((late) => late.close()).catch(() => undefined);
    }
    return subscription;
}

function assertNoParams(value: unknown): void {
    if (value !== undefined) {
        throw managedError(
            'INVALID_REQUEST',
            'The coordinator health request accepts no parameters.',
        );
    }
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw managedError(
            'INVALID_REQUEST',
            'Coordinator control parameters must be an object.',
        );
    }
    return value as Record<string, unknown>;
}

function hasExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (
        actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index])
    );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
