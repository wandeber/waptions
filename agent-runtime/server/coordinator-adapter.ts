import type {
  CoordinatorFailure,
  CoordinatorResult,
  DurableReceiptScopeResolution,
  MutationToolCall,
  ReadToolCall,
  ScopedMutationToolCall,
} from "../mcp/contracts.js";

export interface CoordinatorCallContext {
  signal: AbortSignal;
  /**
   * Opaque identity of the private coordinator IPC connection. It is never
   * accepted from a public tool request and exists only to bind a durable
   * session participant to the caller that opened it.
   */
  connectionId?: string;
}

export interface CoordinatorEventSubscription {
  close(): Promise<void>;
}

export interface ManagedCoordinatorAdapter {
  /**
   * Execute one consistent descriptor-first read. Implementations may warm
   * bounded immutable caches but must not publish authoritative session state.
   */
  executeRead(
    call: ReadToolCall,
    context: CoordinatorCallContext,
  ): Promise<CoordinatorResult>;

  /**
   * Resolve the immutable session-to-project identity without evaluating epoch
   * or document guards. The MCP layer uses the returned projectId to form the
   * only durable receipt scope: (projectId, toolName, idempotencyKey). Missing
   * sessions and other domain failures return their stable typed error rather
   * than throwing a coordinator-availability exception.
   */
  resolveReceiptScope(
    call: MutationToolCall,
    context: CoordinatorCallContext,
  ): Promise<DurableReceiptScopeResolution>;

  /**
   * Execute one authoritative mutation transaction.
   *
   * This boundary deliberately keeps durability in the single coordinator
   * authority. The implementation MUST:
   * 1. resolve the durable receipt by (projectId, toolName, idempotencyKey)
   *    before checking epoch or revisions;
   * 2. compare the complete canonical request hash supplied by the MCP layer;
   * 3. replay a matching receipt under the current StateToken or reject a
   *    different hash with IDEMPOTENCY_KEY_CONFLICT;
   * 4. validate a never-seen request's epoch and document-domain guards; and
   * 5. persist the semantic mutation and receipt in one recoverable
   *    transaction.
   *
   * The MCP stdio process must never add its own receipt store because that
   * would create a second project authority and break restart semantics.
   */
  executeMutation(
    call: ScopedMutationToolCall,
    context: CoordinatorCallContext,
  ): Promise<CoordinatorResult>;

  /**
   * Open/create is the only bootstrap mutation without an input sessionId.
   * The coordinator MUST resolve or reserve the stable projectId first and
   * then use the same DurableReceiptScope and receipt-before-guard ordering as
   * executeMutation. It may not use an epoch-scoped or tool-only receipt.
   */
  executeSessionOpen(
    call: MutationToolCall,
    context: CoordinatorCallContext,
  ): Promise<CoordinatorResult>;

  /**
   * Subscribe to a session's durable event stream. The callback is only an
   * invalidation signal; clients recover ordered event bodies with
   * waptions_events_read.
   */
  subscribeToEvents?(
    sessionId: string,
    onEventAvailable: () => void,
    context: CoordinatorCallContext,
  ): Promise<CoordinatorEventSubscription>;

  close?(): Promise<void>;
}

export class CoordinatorUnavailableAdapter
  implements ManagedCoordinatorAdapter
{
  private unavailable(): CoordinatorFailure {
    return {
      ok: false,
      error: {
        code: "COORDINATOR_UNAVAILABLE",
        message:
          "The Waptions managed-session coordinator is not attached to this MCP process.",
        retryable: true,
      },
    };
  }

  async executeRead(): Promise<CoordinatorResult> {
    return this.unavailable();
  }

  async resolveReceiptScope(): Promise<DurableReceiptScopeResolution> {
    return this.unavailable();
  }

  async executeMutation(): Promise<CoordinatorResult> {
    return this.unavailable();
  }

  async executeSessionOpen(): Promise<CoordinatorResult> {
    return this.unavailable();
  }
}
