import type {
  CoordinatorResult,
  DurableReceiptScopeResolution,
  MutationToolCall,
  ReadToolCall,
  ScopedMutationToolCall,
  StateToken,
} from "../../mcp/contracts.js";
import {
  computeCoreSemanticSchemaSha256,
  type CoreSemanticSchemaBundle,
} from "../../mcp/semantic-schema-adapter.js";
import { TEST_CORE_OPERATION_TYPES } from "./core-operation-names.js";
import type {
  CoordinatorEventSubscription,
  ManagedCoordinatorAdapter,
} from "../coordinator-adapter.js";

export const TEST_OPERATION_SCHEMA = {
  oneOf: TEST_CORE_OPERATION_TYPES.map((type) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      operationId: {
        type: "string",
        minLength: 1,
      },
      type: {
        const: type,
      },
      ...(type === "project.set-name"
        ? {
            name: { type: "string", minLength: 1 },
          }
        : {}),
      ...(type === "audio-clip.trim"
        ? {
            clipId: { type: "string", minLength: 1 },
            sourceStartSample48k: { type: "integer", minimum: 0 },
            sourceEndSample48k: { type: "integer", minimum: 0 },
          }
        : {}),
      ...(type === "audio-clip.set-fades"
        ? {
            clipId: { type: "string", minLength: 1 },
            fadeInSamples48k: { type: "integer", minimum: 0 },
            fadeOutSamples48k: { type: "integer", minimum: 0 },
          }
        : {}),
    },
    required: [
      "operationId",
      "type",
      ...(type === "project.set-name" ? ["name"] : []),
      ...(type === "audio-clip.trim"
        ? ["clipId", "sourceStartSample48k", "sourceEndSample48k"]
        : []),
      ...(type === "audio-clip.set-fades"
        ? ["clipId", "fadeInSamples48k", "fadeOutSamples48k"]
        : []),
    ],
  })),
} as const;

export const TEST_SEMANTIC_SCHEMAS: CoreSemanticSchemaBundle = {
  apiVersion: "2026-07-25",
  editOperationSchema: TEST_OPERATION_SCHEMA,
  operationTypes: TEST_CORE_OPERATION_TYPES,
  schemaSha256: computeCoreSemanticSchemaSha256(TEST_OPERATION_SCHEMA),
};

export const TEST_STATE: StateToken = {
  sessionId: "session-1",
  projectId: "project-1",
  sessionEpoch: "epoch-1",
  sessionRevision: 7,
  documentRevision: 4,
  audioGraphRevision: 3,
  narrativeRevision: 2,
  eventCursor: "event-9",
};

export class FakeCoordinatorAdapter implements ManagedCoordinatorAdapter {
  readonly calls: string[] = [];
  readResult: CoordinatorResult = {
    ok: true,
    data: {},
    state: TEST_STATE,
    warnings: [],
  };
  mutationResult: CoordinatorResult = {
    ok: true,
    data: { applied: true },
    state: TEST_STATE,
    warnings: [],
    replayed: false,
  };
  receiptResolution?: DurableReceiptScopeResolution;
  eventCallback?: () => void;

  async executeRead(
    call: ReadToolCall,
  ): Promise<CoordinatorResult> {
    this.calls.push(`read:${call.toolName}`);
    return this.readResult;
  }

  async resolveReceiptScope(
    call: MutationToolCall,
  ): Promise<DurableReceiptScopeResolution> {
    this.calls.push(`scope:${call.toolName}`);
    if (this.receiptResolution) {
      return this.receiptResolution;
    }
    return {
      ok: true,
      scope: {
        projectId: TEST_STATE.projectId,
        toolName: call.toolName,
        idempotencyKey: call.identity.idempotencyKey,
      },
    };
  }

  async executeMutation(
    call: ScopedMutationToolCall,
  ): Promise<CoordinatorResult> {
    this.calls.push(
      `mutation:${call.receiptScope.projectId}:${call.toolName}:${call.receiptScope.idempotencyKey}`,
    );
    return this.mutationResult;
  }

  async executeSessionOpen(
    call: MutationToolCall,
  ): Promise<CoordinatorResult> {
    this.calls.push(`bootstrap:${call.toolName}`);
    return this.mutationResult;
  }

  async subscribeToEvents(
    _sessionId: string,
    onEventAvailable: () => void,
  ): Promise<CoordinatorEventSubscription> {
    this.eventCallback = onEventAvailable;
    return {
      close: async () => {
        this.eventCallback = undefined;
      },
    };
  }
}
