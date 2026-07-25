import type {
    CoordinatorResult,
    DurableReceiptScopeResolution,
    MutationToolCall,
    ReadToolCall,
    ScopedMutationToolCall,
} from '../mcp/contracts.js';
import type {
    CoordinatorCallContext,
    CoordinatorEventSubscription,
    ManagedCoordinatorAdapter,
} from '../server/coordinator-adapter.js';
import { asManagedRuntimeError } from '../coordinator/errors.js';
import { CanonicalToolRouter } from './canonical-tool-router.js';

export interface RuntimeHostAuthority {
    resolveProjectId(sessionId: string): string | Promise<string>;
    subscribeToEvents?(
        sessionId: string,
        onEventAvailable: () => void,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorEventSubscription>;
    close?(): Promise<void>;
}

/**
 * Canonical MCP adapter owned by the persistent coordinator process.
 *
 * The host never hashes, rewrites, or revalidates semantic requests. The MCP dispatcher has
 * already produced the canonical request and full-request hash, and each handler receives that
 * exact call object. This class only resolves the receipt authority before mutation dispatch.
 */
export class ManagedRuntimeHost implements ManagedCoordinatorAdapter {
    constructor(
        private readonly authority: RuntimeHostAuthority,
        private readonly router: CanonicalToolRouter,
    ) {}

    executeRead(
        call: ReadToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        return this.execute(call, context);
    }

    async resolveReceiptScope(
        call: MutationToolCall,
        context: CoordinatorCallContext,
    ): Promise<DurableReceiptScopeResolution> {
        void context;
        try {
            const sessionId = call.identity.sessionId;
            if (!sessionId) {
                return failure('INVALID_REQUEST', 'The mutation requires a managed session.');
            }
            const projectId = await this.authority.resolveProjectId(sessionId);
            return {
                ok: true,
                scope: {
                    projectId,
                    toolName: call.toolName,
                    idempotencyKey: call.identity.idempotencyKey,
                },
            };
        } catch (error) {
            const managed = asManagedRuntimeError(error);
            return { ok: false, error: managed.toJSON() };
        }
    }

    executeMutation(
        call: ScopedMutationToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        return this.execute(call, context);
    }

    executeSessionOpen(
        call: MutationToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        return this.execute(call, context);
    }

    subscribeToEvents(
        sessionId: string,
        onEventAvailable: () => void,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorEventSubscription> {
        if (!this.authority.subscribeToEvents) {
            throw asManagedRuntimeError(new Error('Event subscriptions are unavailable.'));
        }
        return this.authority.subscribeToEvents(sessionId, onEventAvailable, context);
    }

    async close(): Promise<void> {
        await this.authority.close?.();
    }

    private async execute(
        call: ReadToolCall | MutationToolCall | ScopedMutationToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        try {
            return await this.router.route(call, context);
        } catch (error) {
            const managed = asManagedRuntimeError(error);
            return { ok: false, error: managed.toJSON() };
        }
    }
}

function failure(
    code: 'INVALID_REQUEST',
    message: string,
): DurableReceiptScopeResolution {
    return {
        ok: false,
        error: { code, message, retryable: false },
    };
}
