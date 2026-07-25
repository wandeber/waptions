import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { describe, expect, it } from "vitest";

import type { ManagedMutationEnvelope } from "../../coordinator/types.js";
import { loadCommittedCoreSemanticSchemaBundle } from "../../mcp/core-schema-loader.js";
import type { StateToken } from "../../mcp/contracts.js";
import { ToolSchemaValidator } from "../../mcp/schema-validator.js";
import {
  createProductionEditorRenderAuthority,
} from "./production-editor-render-authority.js";
import type {
  EditorRenderAttachmentRequest,
  EditorRenderAttachmentResult,
  EditorRenderBridgeServer,
  EditorRenderCapabilityScope,
  EditorRenderCoordinatorPort,
  IssuedEditorRenderPairingCapability,
} from "./contracts.js";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const APP_BUILD_HASH = "a".repeat(64);
const APP = {
  buildHash: APP_BUILD_HASH,
  resourceUri: `ui://waptions/editor/v1/${APP_BUILD_HASH}/index.html`,
  mimeType: RESOURCE_MIME_TYPE,
} as const;

const STATE: StateToken = {
  sessionId: "session-1",
  projectId: "project-1",
  sessionEpoch: "epoch-1",
  sessionRevision: 4,
  documentRevision: 7,
  audioGraphRevision: 3,
  eventCursor: "event-8",
};

const CONTEXT = { signal: new AbortController().signal };

describe("ProductionEditorRenderAuthority", () => {
  it("returns the canonical packaged App output and keeps the pairing secret private", async () => {
    const coordinator = new FakeCoordinator();
    const bridge = new FakeBridge();
    const authority = authorityFor(coordinator, bridge);

    const result = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      { viewId: "view-1", presentation: "inline" },
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      resourceUri: APP.resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      viewId: "view-1",
      presentation: "inline",
      capabilityId: "render-capability-1",
      capabilityExpiresAt: "2026-07-25T12:02:00.000Z",
    });
    expect(new ToolSchemaValidator().validateOutput(
      loadCommittedCoreSemanticSchemaBundle()
        .toolSchemas.waptions_editor_render.outputSchema,
      {
        ok: result.ok,
        data: result.data,
        state: result.state,
        committedState: result.committedState,
        warnings: result.warnings,
        replayed: result.replayed,
      },
    )).toBe(true);
    const secret = result.privateMeta?.bridge as { capabilityToken: string };
    expect(secret.capabilityToken).toMatch(/^pairing-secret-/);
    expect(JSON.stringify({ data: result.data, state: result.state })).not.toContain(
      secret.capabilityToken,
    );
  });

  it("replays the attachment receipt without another presence mutation while issuing a fresh host secret", async () => {
    const coordinator = new FakeCoordinator();
    const bridge = new FakeBridge();
    const authority = authorityFor(coordinator, bridge);

    const first = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      { viewId: "view-1", presentation: "inline" },
      CONTEXT,
    );
    const replay = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      { viewId: "view-1", presentation: "inline" },
      CONTEXT,
    );

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(coordinator.presenceMutations).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(first.data);
    expect(pairingSecret(replay)).not.toBe(pairingSecret(first));
  });

  it("bounds the TTL and binds the bridge pairing scope to the participant and presentation", async () => {
    const coordinator = new FakeCoordinator();
    const bridge = new FakeBridge();
    const authority = authorityFor(coordinator, bridge);

    const result = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      {
        viewId: "view-1",
        presentation: "fullscreen",
        capabilityTtlSeconds: 3_600,
      },
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    expect(coordinator.requests[0]?.capabilityTtlSeconds).toBe(300);
    expect(bridge.issued[0]).toEqual({
      projectId: "project-1",
      sessionId: "session-1",
      sessionEpoch: "epoch-1",
      viewId: "view-1",
      participantId: "participant-1",
      presentation: "fullscreen",
      capabilityId: "render-capability-1",
      expiresAt: "2026-07-25T12:05:00.000Z",
    });
  });

  it("fails closed when the bridge changes the participant scope", async () => {
    const coordinator = new FakeCoordinator();
    const bridge = new FakeBridge({ participantId: "participant-other" });
    const authority = authorityFor(coordinator, bridge);

    const result = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      { viewId: "view-1", presentation: "inline" },
      CONTEXT,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain("pairing-secret-");
  });

  it("revokes active public capability IDs and never preserves pairing values across bridge restart", async () => {
    const coordinator = new FakeCoordinator();
    const bridge = new FakeBridge();
    const authority = authorityFor(coordinator, bridge);
    const first = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      { viewId: "view-1", presentation: "inline" },
      CONTEXT,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstSecret = pairingSecret(first);
    expect(bridge.accepts(firstSecret)).toBe(true);

    bridge.restart();
    expect(bridge.accepts(firstSecret)).toBe(false);
    const afterRestart = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      { viewId: "view-1", presentation: "inline" },
      CONTEXT,
    );
    expect(afterRestart.ok).toBe(true);
    if (!afterRestart.ok) return;
    expect(bridge.accepts(pairingSecret(afterRestart))).toBe(true);

    await authority.close();
    expect(bridge.revoked).toEqual(["render-capability-1"]);
    expect(bridge.accepts(pairingSecret(afterRestart))).toBe(false);
  });

  it("never passes pairing values into coordinator receipts or events", async () => {
    const coordinator = new FakeCoordinator();
    const bridge = new FakeBridge();
    const authority = authorityFor(coordinator, bridge);
    const result = await authority.renderEditorReceiptFirst(
      "project-1",
      request(),
      { viewId: "view-1", presentation: "picture-in-picture" },
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(coordinator.durableReceipts)).not.toContain("pairing-secret-");
    expect(JSON.stringify(coordinator.events)).not.toContain("pairing-secret-");
    expect(JSON.stringify(coordinator.durableReceipts)).not.toContain("capabilityToken");
    expect(JSON.stringify(coordinator.events)).not.toContain("pairingCapability");
  });
});

class FakeCoordinator implements EditorRenderCoordinatorPort {
  readonly requests: EditorRenderAttachmentRequest[] = [];
  readonly durableReceipts: unknown[] = [];
  readonly events: unknown[] = [];
  presenceMutations = 0;

  private receipt?: Extract<EditorRenderAttachmentResult, { ok: true }>["receipt"];

  async attachOrUpdateViewReceiptFirst(
    input: EditorRenderAttachmentRequest,
  ): Promise<EditorRenderAttachmentResult> {
    this.requests.push(input);
    if (this.receipt) {
      return {
        ok: true,
        receipt: { ...this.receipt, replayed: true },
      };
    }
    this.presenceMutations += 1;
    const expiresAt = new Date(
      NOW + input.capabilityTtlSeconds * 1_000,
    ).toISOString();
    this.receipt = {
      projectId: input.projectId,
      sessionId: input.request.sessionId,
      sessionEpoch: input.request.sessionEpoch,
      viewId: input.viewId,
      participantId: "participant-1",
      presentation: input.presentation,
      capabilityId: "render-capability-1",
      capabilityExpiresAt: expiresAt,
      state: STATE,
      committedState: STATE,
      replayed: false,
    };
    this.durableReceipts.push({
      capabilityId: this.receipt.capabilityId,
      capabilityExpiresAt: this.receipt.capabilityExpiresAt,
      participantId: this.receipt.participantId,
    });
    this.events.push({
      type: "view.changed",
      viewId: input.viewId,
      presentation: input.presentation,
    });
    return { ok: true, receipt: this.receipt };
  }
}

class FakeBridge implements EditorRenderBridgeServer {
  readonly issued: EditorRenderCapabilityScope[] = [];
  readonly revoked: string[] = [];

  private readonly tokens = new Map<string, EditorRenderCapabilityScope>();
  private sequence = 0;

  constructor(
    private readonly scopePatch: Partial<EditorRenderCapabilityScope> = {},
  ) {}

  async issuePairingCapability(
    scope: EditorRenderCapabilityScope,
  ): Promise<IssuedEditorRenderPairingCapability> {
    const issued = { ...scope, ...this.scopePatch };
    const pairingCapability = `pairing-secret-${String(++this.sequence).padStart(16, "0")}`;
    this.issued.push(issued);
    this.tokens.set(pairingCapability, issued);
    return { pairingCapability, scope: issued };
  }

  async revokePairingCapability(capabilityId: string): Promise<void> {
    this.revoked.push(capabilityId);
    for (const [token, scope] of this.tokens) {
      if (scope.capabilityId === capabilityId) this.tokens.delete(token);
    }
  }

  accepts(token: string): boolean {
    return this.tokens.has(token);
  }

  restart(): void {
    this.tokens.clear();
  }
}

function authorityFor(
  coordinator: EditorRenderCoordinatorPort,
  bridgeServer: EditorRenderBridgeServer,
) {
  return createProductionEditorRenderAuthority({
    app: APP,
    coordinator,
    bridgeServer,
    now: () => NOW,
  });
}

function request(): ManagedMutationEnvelope {
  return {
    apiVersion: "2026-07-25",
    sessionId: "session-1",
    sessionEpoch: "epoch-1",
    expected: {
      sessionRevision: 4,
      documentRevision: 7,
      audioGraphRevision: 3,
    },
    idempotencyKey: "editor-render-1",
    toolName: "waptions_editor_render",
    canonicalRequestHash: `sha256:${"b".repeat(64)}`,
    command: {},
  };
}

function pairingSecret(result: Extract<Awaited<ReturnType<
  ReturnType<typeof authorityFor>["renderEditorReceiptFirst"]
>>, { ok: true }>): string {
  return ((result.privateMeta?.bridge as {
    capabilityToken: string;
  }).capabilityToken);
}
