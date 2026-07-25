import {
  MAX_ERROR_MESSAGE_LENGTH,
  type WaptionsToolName,
} from "./constants.js";
import {
  canonicalRequestHash,
  canonicalizeJson,
} from "./canonical-json.js";
import type {
  JsonObject,
  MutationIdentity,
  StructuredToolResult,
  ToolCallPresentation,
  ToolFailure,
} from "./contracts.js";
import {
  assertSafeCoordinatorResult,
  boundToolError,
  UnsafeCoordinatorPayloadError,
} from "./safety.js";
import {
  normalizeCoordinatorVocabulary,
  RuntimeVocabularyError,
} from "./runtime-vocabulary.js";
import { ToolSchemaValidator } from "./schema-validator.js";
import {
  getToolContract,
  type ToolContract,
} from "./tool-catalog.js";
import type { ManagedCoordinatorAdapter } from "../server/coordinator-adapter.js";

function failure(
  code: ToolFailure["error"]["code"],
  message: string,
  retryable: boolean,
  details?: JsonObject,
): ToolFailure {
  return {
    ok: false,
    error: boundToolError({
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    }),
  };
}

function fallbackText(
  toolName: WaptionsToolName,
  result: StructuredToolResult,
): string {
  if (!result.ok) {
    return `${toolName} failed: ${result.error.code}. ${result.error.message}`;
  }

  const replay =
    result.ok && result.replayed
      ? " A durable idempotency receipt was replayed."
      : "";
  return result.state
    ? `${toolName} succeeded at session revision ${result.state.sessionRevision} and document revision ${result.state.documentRevision}.${replay}`
    : `${toolName} succeeded.${replay}`;
}

function mutationIdentity(request: JsonObject): MutationIdentity {
  const expected =
    typeof request.expected === "object" &&
    request.expected !== null &&
    !Array.isArray(request.expected)
      ? (request.expected as MutationIdentity["expected"])
      : undefined;

  return {
    sessionId:
      typeof request.sessionId === "string" ? request.sessionId : undefined,
    sessionEpoch:
      typeof request.sessionEpoch === "string"
        ? request.sessionEpoch
        : undefined,
    idempotencyKey: request.idempotencyKey as string,
    expected,
  };
}

export class WaptionsToolDispatcher {
  private readonly validator = new ToolSchemaValidator();

  constructor(
    private readonly catalog: readonly ToolContract[],
    private readonly coordinator: ManagedCoordinatorAdapter,
  ) {
    for (const contract of catalog) {
      this.validator.register(contract.name, contract.inputSchema);
    }
  }

  async call(
    toolName: string,
    rawArguments: unknown,
    signal: AbortSignal,
  ): Promise<ToolCallPresentation> {
    const contract = getToolContract(this.catalog, toolName);
    if (!contract) {
      const result = failure(
        "INVALID_REQUEST",
        "Unknown Waptions semantic tool.",
        false,
      );
      return {
        content: [{ type: "text", text: "Unknown Waptions semantic tool." }],
        structuredContent: result,
        isError: true,
      };
    }

    const validation = this.validator.validateInput(toolName, rawArguments);
    if (!validation.valid) {
      const result = failure(
        validation.code,
        validation.message,
        false,
        validation.details,
      );
      return {
        content: [{ type: "text", text: fallbackText(contract.name, result) }],
        structuredContent: result,
        isError: true,
      };
    }

    const request = validation.value;
    let coordinatorResult;
    try {
      const canonicalRequest = canonicalizeJson(request);
      const baseCall = {
        toolName: contract.name,
        request,
        canonicalRequest,
        requestHash: canonicalRequestHash(request),
      };
      if (contract.mutation) {
        const mutationCall = {
          ...baseCall,
          mutation: true as const,
          identity: mutationIdentity(request),
        };
        if (contract.name === "waptions_session_open") {
          coordinatorResult = await this.coordinator.executeSessionOpen(
            mutationCall,
            { signal },
          );
        } else {
          const resolution = await this.coordinator.resolveReceiptScope(
            mutationCall,
            { signal },
          );
          if (!resolution.ok) {
            coordinatorResult = resolution;
          } else {
            const receiptScope = resolution.scope;
            if (
              receiptScope.toolName !== contract.name ||
              receiptScope.idempotencyKey !==
                mutationCall.identity.idempotencyKey
            ) {
              throw new UnsafeCoordinatorPayloadError(
                "Coordinator returned an invalid receipt scope.",
              );
            }
            coordinatorResult = await this.coordinator.executeMutation(
              {
                ...mutationCall,
                receiptScope,
              },
              { signal },
            );
          }
        }
      } else {
        coordinatorResult = await this.coordinator.executeRead(
            {
              ...baseCall,
              mutation: false,
            },
            { signal },
          );
      }
      coordinatorResult = normalizeCoordinatorVocabulary(coordinatorResult);
      assertSafeCoordinatorResult(coordinatorResult);
      if (
        coordinatorResult.ok &&
        coordinatorResult.privateMeta &&
        contract.name !== "waptions_editor_render"
      ) {
        throw new UnsafeCoordinatorPayloadError(
          "Private result metadata is allowed only for editor rendering.",
        );
      }
    } catch (error) {
      const unsafe =
        error instanceof UnsafeCoordinatorPayloadError ||
        error instanceof RuntimeVocabularyError;
      const result = failure(
        unsafe ? "INTERNAL_ERROR" : "COORDINATOR_UNAVAILABLE",
        unsafe
          ? "The coordinator returned a response that violated the bounded descriptor contract."
          : "The managed-session coordinator could not complete the request.",
        !unsafe,
      );
      return {
        content: [{ type: "text", text: fallbackText(contract.name, result) }],
        structuredContent: result,
        isError: true,
      };
    }

    const structuredContent: StructuredToolResult = coordinatorResult.ok
      ? {
          ok: true,
          data: coordinatorResult.data,
          ...(contract.name !== "waptions_session_list" &&
          coordinatorResult.state
            ? { state: coordinatorResult.state }
            : {}),
          ...(coordinatorResult.committedState
            ? { committedState: coordinatorResult.committedState }
            : {}),
          warnings: coordinatorResult.warnings ?? [],
          replayed: contract.mutation
            ? (coordinatorResult.replayed ?? false)
            : false,
        }
      : {
          ok: false,
          error: boundToolError(coordinatorResult.error),
          ...(coordinatorResult.state
            ? { state: coordinatorResult.state }
            : {}),
        };

    if (!this.validator.validateOutput(contract.outputSchema, structuredContent)) {
      const result = failure(
        "INTERNAL_ERROR",
        "The coordinator response did not match the tool output schema.",
        false,
      );
      return {
        content: [{ type: "text", text: fallbackText(contract.name, result) }],
        structuredContent: result,
        isError: true,
      };
    }

    const text = fallbackText(contract.name, structuredContent).slice(
      0,
      MAX_ERROR_MESSAGE_LENGTH * 2,
    );

    return {
      content: [{ type: "text", text }],
      structuredContent,
      ...(!structuredContent.ok ? { isError: true } : {}),
      ...(coordinatorResult.ok && coordinatorResult.privateMeta
        ? { _meta: coordinatorResult.privateMeta }
        : {}),
    };
  }
}
