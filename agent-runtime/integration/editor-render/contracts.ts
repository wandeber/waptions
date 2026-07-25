import type { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import type { ManagedMutationEnvelope } from "../../coordinator/types.js";
import type { StateToken, ToolError } from "../../mcp/contracts.js";
import type { CoordinatorCallContext } from "../../server/coordinator-adapter.js";

export const EDITOR_RENDER_PRESENTATIONS = [
  "inline",
  "fullscreen",
  "picture-in-picture",
] as const;

export type EditorRenderPresentation =
  (typeof EDITOR_RENDER_PRESENTATIONS)[number];

/**
 * Identity authenticated by the packaged-runtime manifest. Composition passes
 * the verified identity through unchanged; this authority never derives it
 * from a runtime HTML path or a mutable development asset.
 */
export interface PackagedEditorAppIdentity {
  readonly buildHash: string;
  readonly resourceUri: string;
  readonly mimeType: typeof RESOURCE_MIME_TYPE;
}

export interface EditorRenderAttachmentRequest {
  readonly projectId: string;
  readonly request: ManagedMutationEnvelope;
  readonly viewId: string;
  readonly presentation: EditorRenderPresentation;
  readonly capabilityTtlSeconds: number;
}

/**
 * This public receipt deliberately contains an opaque capability identifier,
 * never its pairing secret. It is the complete semantic result persisted by
 * the coordinator for idempotency replay.
 */
export interface EditorRenderAttachmentReceipt {
  readonly projectId: string;
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly viewId: string;
  readonly participantId: string;
  readonly presentation: EditorRenderPresentation;
  readonly capabilityId: string;
  readonly capabilityExpiresAt: string;
  readonly state: StateToken;
  readonly committedState?: StateToken;
  readonly replayed: boolean;
}

export type EditorRenderAttachmentResult =
  | {
      readonly ok: true;
      readonly receipt: EditorRenderAttachmentReceipt;
    }
  | {
      readonly ok: false;
      readonly error: ToolError;
      readonly state?: StateToken;
    };

/**
 * Production composition adapts the durable coordinator to this narrow port.
 * The method owns receipt lookup before session guards and atomically attaches
 * or refreshes the in-memory presence plus its durable view projection.
 */
export interface EditorRenderCoordinatorPort {
  attachOrUpdateViewReceiptFirst(
    input: EditorRenderAttachmentRequest,
    context: CoordinatorCallContext,
  ): Promise<EditorRenderAttachmentResult>;
}

/**
 * Full pairing authority required by the local HTTP bridge. The public bridge
 * scope intentionally includes the participant and presentation even though
 * signed range capabilities only need session/project/view identity.
 */
export interface EditorRenderCapabilityScope {
  readonly projectId: string;
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly viewId: string;
  readonly participantId: string;
  readonly presentation: EditorRenderPresentation;
  readonly capabilityId: string;
  readonly expiresAt: string;
}

export interface IssuedEditorRenderPairingCapability {
  /** Host-only opaque value posted by the MCP App to /v1/pair/exchange. */
  readonly pairingCapability: string;
  readonly scope: EditorRenderCapabilityScope;
}

/**
 * Adapter supplied by the production HTTP-bridge owner. It retains the raw
 * pairing secret only in its transient capability store and may revoke it on
 * coordinator shutdown or bridge restart.
 */
export interface EditorRenderBridgeServer {
  issuePairingCapability(
    scope: EditorRenderCapabilityScope,
    context: { signal: AbortSignal },
  ): Promise<IssuedEditorRenderPairingCapability>;
  revokePairingCapability?(
    capabilityId: string,
    context: { signal: AbortSignal },
  ): Promise<void>;
}

export interface ProductionEditorRenderAuthorityOptions {
  readonly app: PackagedEditorAppIdentity;
  readonly bridgeServer: EditorRenderBridgeServer;
  readonly coordinator: EditorRenderCoordinatorPort;
  readonly now?: () => number;
  readonly defaultCapabilityTtlSeconds?: number;
  readonly maxCapabilityTtlSeconds?: number;
}
