import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import type { ManagedMutationEnvelope } from "../../coordinator/types.js";
import type { CoordinatorResult } from "../../mcp/contracts.js";
import type { CoordinatorCallContext } from "../../server/coordinator-adapter.js";
import type { ManagedEditorRenderAuthority } from "../managed-tool-handlers.js";
import {
  EDITOR_RENDER_PRESENTATIONS,
  type EditorRenderAttachmentReceipt,
  type EditorRenderCapabilityScope,
  type EditorRenderPresentation,
  type ProductionEditorRenderAuthorityOptions,
} from "./contracts.js";

const MIN_CAPABILITY_TTL_SECONDS = 30;
const DEFAULT_CAPABILITY_TTL_SECONDS = 120;
// The HTTP bridge capability signer enforces this same production ceiling.
const MAX_CAPABILITY_TTL_SECONDS = 5 * 60;

class ExpiredCapabilityError extends Error {}

/**
 * Production implementation of the existing editor-render seam. Durable
 * presence/view work is delegated to the coordinator before any bridge secret
 * is minted; this process keeps only public capability IDs for shutdown
 * revocation and never retains, logs, or persists pairing secrets.
 */
export class ProductionEditorRenderAuthority
  implements ManagedEditorRenderAuthority
{
  private readonly now: () => number;
  private readonly defaultCapabilityTtlSeconds: number;
  private readonly maxCapabilityTtlSeconds: number;
  private readonly issuedCapabilityIds = new Set<string>();
  private closed = false;

  constructor(
    private readonly options: ProductionEditorRenderAuthorityOptions,
  ) {
    assertPackagedIdentity(options.app);
    this.now = options.now ?? Date.now;
    this.maxCapabilityTtlSeconds = boundedMaximum(
      options.maxCapabilityTtlSeconds ?? MAX_CAPABILITY_TTL_SECONDS,
    );
    this.defaultCapabilityTtlSeconds = boundedTtl(
      options.defaultCapabilityTtlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS,
      this.maxCapabilityTtlSeconds,
    );
  }

  async renderEditorReceiptFirst(
    projectId: string,
    request: ManagedMutationEnvelope,
    input: {
      viewId: string;
      presentation: EditorRenderPresentation;
      capabilityTtlSeconds?: number;
    },
    context: CoordinatorCallContext,
  ): Promise<CoordinatorResult> {
    context.signal.throwIfAborted();
    if (this.closed) {
      return unavailable("The editor render authority is closed.");
    }

    const capabilityTtlSeconds = input.capabilityTtlSeconds === undefined
      ? this.defaultCapabilityTtlSeconds
      : boundedTtl(input.capabilityTtlSeconds, this.maxCapabilityTtlSeconds);

    const attachment = await this.options.coordinator
      .attachOrUpdateViewReceiptFirst({
        projectId,
        request,
        viewId: input.viewId,
        presentation: input.presentation,
        capabilityTtlSeconds,
      }, context);
    context.signal.throwIfAborted();

    if (!attachment.ok) {
      return {
        ok: false,
        error: attachment.error,
        ...(attachment.state ? { state: attachment.state } : {}),
      };
    }

    const receipt = attachment.receipt;
    try {
      assertReceiptScope(
        receipt,
        { projectId, request, viewId: input.viewId, presentation: input.presentation },
        capabilityTtlSeconds,
        this.now(),
      );
      const scope = receiptScope(receipt);
      const issued = await this.options.bridgeServer.issuePairingCapability(
        scope,
        { signal: context.signal },
      );
      context.signal.throwIfAborted();
      assertIssuedScope(issued.scope, scope);
      assertPairingCapability(issued.pairingCapability);
      this.issuedCapabilityIds.add(receipt.capabilityId);

      return {
        ok: true,
        data: {
          resourceUri: this.options.app.resourceUri,
          mimeType: this.options.app.mimeType,
          viewId: receipt.viewId,
          presentation: receipt.presentation,
          capabilityId: receipt.capabilityId,
          capabilityExpiresAt: receipt.capabilityExpiresAt,
        },
        state: receipt.state,
        ...(receipt.committedState
          ? { committedState: receipt.committedState }
          : {}),
        warnings: [],
        replayed: receipt.replayed,
        // The MCP dispatcher exposes this only as host metadata for this tool.
        privateMeta: {
          bridge: {
            pairingCapability: issued.pairingCapability,
            expiresAt: receipt.capabilityExpiresAt,
          },
        },
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return invalidAttachment(
        receipt.state,
        error instanceof ExpiredCapabilityError
          ? "The editor bridge capability has expired. Render the editor again."
          : "The editor render attachment did not match the production capability scope.",
        error instanceof ExpiredCapabilityError
          ? "CAPABILITY_EXPIRED"
          : "INTERNAL_ERROR",
      );
    }
  }

  /**
   * Capability IDs are public receipt data, so retaining them only supports a
   * best-effort immediate revoke on process shutdown. Pairing values are never
   * retained and are therefore also lost on restart.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const controller = new AbortController();
    const revoke = this.options.bridgeServer.revokePairingCapability;
    if (revoke) {
      await Promise.allSettled(
        Array.from(this.issuedCapabilityIds, (capabilityId) =>
          revoke.call(this.options.bridgeServer, capabilityId, {
            signal: controller.signal,
          })
        ),
      );
    }
    this.issuedCapabilityIds.clear();
  }
}

export function createProductionEditorRenderAuthority(
  options: ProductionEditorRenderAuthorityOptions,
): ProductionEditorRenderAuthority {
  return new ProductionEditorRenderAuthority(options);
}

function assertPackagedIdentity(
  app: ProductionEditorRenderAuthorityOptions["app"],
): void {
  if (
    !/^[a-f0-9]{64}$/.test(app.buildHash)
    || app.resourceUri !== `ui://waptions/editor/v1/${app.buildHash}/index.html`
    || app.mimeType !== RESOURCE_MIME_TYPE
  ) {
    throw new Error("The packaged MCP App identity is invalid.");
  }
}

function boundedMaximum(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_CAPABILITY_TTL_SECONDS) {
    throw new Error("The maximum editor capability lifetime is invalid.");
  }
  return Math.min(value, MAX_CAPABILITY_TTL_SECONDS);
}

function boundedTtl(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_CAPABILITY_TTL_SECONDS) {
    throw new Error("The editor capability lifetime is invalid.");
  }
  return Math.min(value, maximum);
}

function assertReceiptScope(
  receipt: EditorRenderAttachmentReceipt,
  expected: {
    projectId: string;
    request: ManagedMutationEnvelope;
    viewId: string;
    presentation: EditorRenderPresentation;
  },
  capabilityTtlSeconds: number,
  now: number,
): void {
  if (
    receipt.projectId !== expected.projectId
    || receipt.sessionId !== expected.request.sessionId
    || receipt.sessionEpoch !== expected.request.sessionEpoch
    || receipt.state.projectId !== expected.projectId
    || receipt.state.sessionId !== expected.request.sessionId
    || receipt.state.sessionEpoch !== expected.request.sessionEpoch
    || receipt.viewId !== expected.viewId
    || receipt.presentation !== expected.presentation
    || !EDITOR_RENDER_PRESENTATIONS.includes(receipt.presentation)
    || !opaqueId(receipt.participantId)
    || !opaqueId(receipt.capabilityId)
  ) {
    throw new Error("The receipt scope is invalid.");
  }
  const expiresAt = Date.parse(receipt.capabilityExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new ExpiredCapabilityError();
  }
  if (expiresAt > now + capabilityTtlSeconds * 1_000) {
    throw new Error("The receipt capability lifetime exceeds its bound.");
  }
}

function receiptScope(
  receipt: EditorRenderAttachmentReceipt,
): EditorRenderCapabilityScope {
  return {
    projectId: receipt.projectId,
    sessionId: receipt.sessionId,
    sessionEpoch: receipt.sessionEpoch,
    viewId: receipt.viewId,
    participantId: receipt.participantId,
    presentation: receipt.presentation,
    capabilityId: receipt.capabilityId,
    expiresAt: receipt.capabilityExpiresAt,
  };
}

function assertIssuedScope(
  issued: EditorRenderCapabilityScope,
  expected: EditorRenderCapabilityScope,
): void {
  if (
    issued.projectId !== expected.projectId
    || issued.sessionId !== expected.sessionId
    || issued.sessionEpoch !== expected.sessionEpoch
    || issued.viewId !== expected.viewId
    || issued.participantId !== expected.participantId
    || issued.presentation !== expected.presentation
    || issued.capabilityId !== expected.capabilityId
    || issued.expiresAt !== expected.expiresAt
  ) {
    throw new Error("The issued pairing capability scope is invalid.");
  }
}

function assertPairingCapability(value: string): void {
  if (value.length < 16 || value.length > 16 * 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("The issued pairing capability is invalid.");
  }
}

function opaqueId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function unavailable(message: string): CoordinatorResult {
  return {
    ok: false,
    error: {
      code: "COORDINATOR_UNAVAILABLE",
      message,
      retryable: true,
    },
  };
}

function invalidAttachment(
  state: EditorRenderAttachmentReceipt["state"],
  message: string,
  code: "CAPABILITY_EXPIRED" | "INTERNAL_ERROR",
): CoordinatorResult {
  return {
    ok: false,
    error: { code, message, retryable: false },
    state,
  };
}
