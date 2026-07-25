import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  MAX_STRUCTURED_INPUT_BYTES,
  MAX_STRUCTURED_OUTPUT_BYTES,
  TOOL_NAMES,
} from "./constants.js";
import { createMcpAppResource } from "./app-resource.js";
import { canonicalRequestHash, canonicalizeJson } from "./canonical-json.js";
import type {
  JsonObject,
  ScopedMutationToolCall,
} from "./contracts.js";
import { WaptionsToolDispatcher } from "./dispatcher.js";
import { loadCommittedCoreSemanticSchemaBundle } from "./core-schema-loader.js";
import { createToolCatalog } from "./tool-catalog.js";
import { ToolSchemaValidator } from "./schema-validator.js";
import {
  FakeCoordinatorAdapter,
  TEST_STATE,
} from "../server/test-fixtures/fakes.js";

const appResource = createMcpAppResource("<!doctype html><p>editor</p>");
const semanticSchemas = loadCommittedCoreSemanticSchemaBundle();
const catalog = createToolCatalog(appResource.uri, semanticSchemas);

function projectReadRequest(extra: Record<string, unknown> = {}) {
  return {
    apiVersion: "2026-07-25",
    sessionId: "session-1",
    ...extra,
  };
}

function mutationRequest(extra: Record<string, unknown> = {}) {
  return {
    apiVersion: "2026-07-25",
    sessionId: "session-1",
    sessionEpoch: "epoch-1",
    expected: {
      sessionRevision: 7,
      documentRevision: 4,
      audioGraphRevision: 3,
      narrativeRevision: 2,
    },
    idempotencyKey: "idem-key-0001",
    ...extra,
  };
}

const renameOperation = {
  operationId: "rename1",
  type: "project.set-name",
  payload: { name: "Renamed" },
};

describe("semantic MCP tool catalog", () => {
  it("publishes exactly the 29 canonical tools with closed schemas", () => {
    expect(catalog.map(({ name }) => name)).toEqual(TOOL_NAMES);
    for (const contract of catalog) {
      expect(contract.description.length).toBeGreaterThan(20);
      expect(contract.inputSchema.type).toBe("object");
      expect(contract.outputSchema.type).toBe("object");
      expect(contract.annotations).toEqual({
        title: expect.any(String),
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(
        new ToolSchemaValidator().validateOutput(contract.outputSchema, {
          ok: true,
          data: { unexpectedPublicBody: true },
          state: TEST_STATE,
          warnings: [],
          replayed: false,
        }),
      ).toBe(false);
    }
  });

  it("attaches current MCP Apps metadata only to editor_render", () => {
    const withUi = catalog.filter((contract) => contract._meta !== undefined);
    expect(withUi).toHaveLength(1);
    expect(withUi[0].name).toBe("waptions_editor_render");
    expect(withUi[0]._meta).toEqual({
      ui: {
        resourceUri: appResource.uri,
        visibility: ["model", "app"],
      },
    });
  });

  it("derives the immutable resource URI from exact HTML bytes and freezes localhost bridge CSP", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(appResource.canonicalAssets), "utf8")
      .digest("hex");
    expect(appResource.uri).toBe(
      `ui://waptions/editor/v1/${digest}/index.html`,
    );
    expect(appResource.mimeType).toBe("text/html;profile=mcp-app");
    expect(appResource.readMeta).toEqual({
      ui: {
        csp: {
          connectDomains: ["http://localhost:59941"],
          resourceDomains: ["http://localhost:59941"],
          frameDomains: [],
          baseUriDomains: [],
        },
        permissions: {},
        prefersBorder: true,
      },
    });
  });
});

describe("tool dispatcher", () => {
  it("accepts exactly one explicit-path or granted-directory media probe selection", () => {
    const validator = new ToolSchemaValidator();
    validator.register(
      "waptions_media_probe",
      semanticSchemas.toolSchemas.waptions_media_probe.inputSchema,
    );
    const selected = validator.validateInput(
      "waptions_media_probe",
      projectReadRequest({
        grantId: "grant-1",
        selection: {
          kind: "granted-directory",
          maximumResults: 5,
          maximumCandidates: 256,
          requireVideo: true,
        },
      }),
    );
    const ambiguous = validator.validateInput(
      "waptions_media_probe",
      projectReadRequest({
        grantId: "grant-1",
        paths: ["/tmp/media.mp4"],
        selection: {
          kind: "granted-directory",
          maximumResults: 1,
        },
      }),
    );

    expect(selected).toMatchObject({ valid: true });
    expect(ambiguous).toMatchObject({ valid: false, code: "INVALID_REQUEST" });
  });

  it("rejects unknown fields and returns a Core-valid failure", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_project_get",
      projectReadRequest({ unknown: true }),
      new AbortController().signal,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    const contract = semanticSchemas.toolSchemas.waptions_project_get;
    expect(
      new ToolSchemaValidator().validateOutput(
        contract.outputSchema,
        result.structuredContent,
      ),
    ).toBe(true);
    expect(coordinator.calls).toEqual([]);
  });

  it("returns Core-valid API-version and input-size failures without coordinator calls", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const unsupported = await dispatcher.call(
      "waptions_project_get",
      {
        apiVersion: "old",
        sessionId: "session-1",
      },
      new AbortController().signal,
    );
    expect(unsupported.structuredContent).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_API_VERSION" },
    });

    const oversized = await dispatcher.call(
      "waptions_project_get",
      projectReadRequest({
        section: "x".repeat(MAX_STRUCTURED_INPUT_BYTES),
      }),
      new AbortController().signal,
    );
    expect(oversized.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        details: { limitBytes: MAX_STRUCTURED_INPUT_BYTES },
      },
    });
    const outputSchema =
      semanticSchemas.toolSchemas.waptions_project_get.outputSchema;
    const validator = new ToolSchemaValidator();
    expect(
      validator.validateOutput(
        outputSchema,
        unsupported.structuredContent,
      ),
    ).toBe(true);
    expect(
      validator.validateOutput(outputSchema, oversized.structuredContent),
    ).toBe(true);
    expect(coordinator.calls).toEqual([]);
  });

  it("rejects non-JSON arguments without throwing or calling the coordinator", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_project_get",
      undefined,
      new AbortController().signal,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", retryable: false },
    });
    expect(
      new ToolSchemaValidator().validateOutput(
        semanticSchemas.toolSchemas.waptions_project_get.outputSchema,
        result.structuredContent,
      ),
    ).toBe(true);
    expect(coordinator.calls).toEqual([]);
  });

  it("routes tools from Core MutationBase rather than readOnly annotations", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const signal = new AbortController().signal;

    await dispatcher.call(
      "waptions_project_validate",
      projectReadRequest({ scopes: ["structural"], deep: false }),
      signal,
    );
    await dispatcher.call(
      "waptions_media_probe",
      projectReadRequest({
        grantId: "grant-1",
        paths: ["/tmp/media.mp4"],
        hashPolicy: "if-needed",
      }),
      signal,
    );
    await dispatcher.call(
      "waptions_edit_plan",
      {
        apiVersion: "2026-07-25",
        sessionId: "session-1",
        sessionEpoch: "epoch-1",
        expected: { sessionRevision: 7, documentRevision: 4 },
        operations: [renameOperation],
        history: { label: "Rename", category: "project" },
      },
      signal,
    );
    await dispatcher.call(
      "waptions_path_grant",
      mutationRequest({ action: { kind: "inspect" } }),
      signal,
    );
    await dispatcher.call(
      "waptions_session_open",
      {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-2",
        idempotencyKey: "bootstrap-key",
        name: "Project",
      },
      signal,
    );

    expect(coordinator.calls).toEqual([
      "read:waptions_project_validate",
      "read:waptions_media_probe",
      "read:waptions_edit_plan",
      "scope:waptions_path_grant",
      "mutation:project-1:waptions_path_grant:idem-key-0001",
      "bootstrap:waptions_session_open",
    ]);
  });

  it("preserves the complete canonical request and hash across the adapter boundary", async () => {
    class CapturingCoordinator extends FakeCoordinatorAdapter {
      call?: ScopedMutationToolCall;

      override async executeMutation(call: ScopedMutationToolCall) {
        this.call = call;
        return super.executeMutation(call);
      }
    }
    const coordinator = new CapturingCoordinator();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const request = mutationRequest({
      operations: [renameOperation],
      history: { label: "Rename", category: "project" },
    });
    const result = await dispatcher.call(
      "waptions_edit_apply",
      request,
      new AbortController().signal,
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(coordinator.call?.request).toEqual(request);
    expect(coordinator.call?.canonicalRequest).toBe(
      canonicalizeJson(request),
    );
    expect(coordinator.call?.requestHash).toBe(
      canonicalRequestHash(request),
    );
    expect(coordinator.call?.receiptScope).toEqual({
      projectId: "project-1",
      toolName: "waptions_edit_apply",
      idempotencyKey: "idem-key-0001",
    });
  });

  it("preserves a typed session lookup failure while resolving receipt scope", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.receiptResolution = {
      ok: false,
      error: {
        code: "SESSION_NOT_FOUND",
        message: "Managed session was not found.",
        retryable: false,
      },
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_edit_apply",
      mutationRequest({ operations: [renameOperation] }),
      new AbortController().signal,
    );

    expect(result.structuredContent).toEqual({
      ok: false,
      error: {
        code: "SESSION_NOT_FOUND",
        message: "Managed session was not found.",
        retryable: false,
      },
    });
    expect(coordinator.calls).toEqual(["scope:waptions_edit_apply"]);
  });

  it("fails closed on a mismatched coordinator receipt scope", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.receiptResolution = {
      ok: true,
      scope: {
        projectId: "project-1",
        toolName: "waptions_media_import",
        idempotencyKey: "different-key",
      },
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_edit_apply",
      mutationRequest({ operations: [renameOperation] }),
      new AbortController().signal,
    );

    expect(result.structuredContent).toEqual({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message:
          "The coordinator returned a response that violated the bounded descriptor contract.",
        retryable: false,
      },
    });
    expect(coordinator.calls).toEqual(["scope:waptions_edit_apply"]);
  });

  it("returns canonical typed descriptors without UI attachment for no-UI calls", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_project_get",
      projectReadRequest(),
      new AbortController().signal,
    );

    expect(result._meta).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        projectId: "project-1",
        counts: {
          tracks: 0,
          clips: 0,
        },
      },
      state: TEST_STATE,
      warnings: [],
      replayed: false,
    });
    expect(result.content[0].text).not.toContain("descriptor");
  });

  it("projects global session discovery without a synthetic project state", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: true,
      data: { items: [], page: { hasMore: false } },
      state: TEST_STATE,
      warnings: [],
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_session_list",
      { apiVersion: "2026-07-25" },
      new AbortController().signal,
    );
    expect(result.structuredContent).toEqual({
      ok: true,
      data: { items: [], page: { hasMore: false } },
      warnings: [],
      replayed: false,
    });
  });

  it("accepts state tokens without a narrative domain revision", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const state = { ...TEST_STATE };
    delete state.narrativeRevision;
    coordinator.readResult = {
      ...coordinator.readResult,
      state,
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_project_get",
      projectReadRequest(),
      new AbortController().signal,
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      state,
    });
  });

  it("projects replayed and committed state at the canonical top level", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    if (!coordinator.mutationResult.ok) {
      throw new Error("Fake mutation result must be successful.");
    }
    coordinator.mutationResult = {
      ...coordinator.mutationResult,
      replayed: true,
      committedState: { ...TEST_STATE, sessionRevision: 6 },
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_edit_apply",
      mutationRequest({ operations: [renameOperation] }),
      new AbortController().signal,
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      replayed: true,
      committedState: { sessionRevision: 6 },
    });
    expect(
      result.structuredContent.ok &&
        Object.hasOwn(result.structuredContent.data, "replayed"),
    ).toBe(false);
  });

  it("fails closed when coordinator output contains secrets or oversized bodies", async () => {
    const unsafeBodies: JsonObject[] = [
      { api_key: "sk-proj-this-must-never-escape" },
      {
        project: {
          transcriptBody: "full transcript must remain in an artifact",
          providerResponse: "raw provider body",
        },
      },
      { oversized: "x".repeat(MAX_STRUCTURED_OUTPUT_BYTES) },
    ];
    for (const data of unsafeBodies) {
      const coordinator = new FakeCoordinatorAdapter();
      coordinator.readResult = {
        ok: true,
        data,
        state: TEST_STATE,
      };
      const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
      const result = await dispatcher.call(
        "waptions_project_get",
        projectReadRequest(),
        new AbortController().signal,
      );
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      });
      expect(JSON.stringify(result).length).toBeLessThan(4096);
      expect(JSON.stringify(result)).not.toContain("sk-proj");
    }
  });

  it("rejects private Apps metadata on artifact_get", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: true,
      data: {},
      state: TEST_STATE,
      privateMeta: {
        ui: {
          resourceUri: appResource.uri,
        },
      },
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_artifact_get",
      projectReadRequest({
        artifactId: "artifact-1",
        presentation: "metadata",
      }),
      new AbortController().signal,
    );

    expect(result._meta).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", retryable: false },
    });
    expect(coordinator.calls).toEqual(["read:waptions_artifact_get"]);
  });

  it("keeps expiring UI bearer capabilities in host-only render metadata", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.mutationResult = {
      ok: true,
      data: {
        resourceUri: appResource.uri,
        mimeType: "text/html;profile=mcp-app",
        viewId: "view-1",
        presentation: "inline",
        capabilityId: "capability-1",
        capabilityExpiresAt: "2026-07-25T12:00:00.000Z",
      },
      state: TEST_STATE,
      warnings: [],
      privateMeta: {
        bridge: {
          capabilityToken: "opaque-capability",
          expiresAt: "2026-07-25T12:00:00.000Z",
        },
      },
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_editor_render",
      mutationRequest({
        viewId: "view-1",
        presentation: "inline",
      }),
      new AbortController().signal,
    );

    expect(result._meta).toMatchObject({
      bridge: { capabilityToken: "opaque-capability" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { capabilityId: "capability-1" },
      replayed: false,
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "opaque-capability",
    );
    expect(result.content[0].text).not.toContain("opaque-capability");
  });
});
