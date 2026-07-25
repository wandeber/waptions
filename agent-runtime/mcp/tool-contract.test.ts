import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  MAX_STRUCTURED_INPUT_BYTES,
  MAX_STRUCTURED_OUTPUT_BYTES,
  TOOL_NAMES,
} from "./constants.js";
import { createMcpAppResource } from "./app-resource.js";
import { WaptionsToolDispatcher } from "./dispatcher.js";
import {
  assertCoreSemanticSchemaBundle,
  CORE_OPERATION_COUNT,
} from "./semantic-schema-adapter.js";
import { createToolCatalog } from "./tool-catalog.js";
import { ToolSchemaValidator } from "./schema-validator.js";
import {
  FakeCoordinatorAdapter,
  TEST_SEMANTIC_SCHEMAS,
  TEST_STATE,
} from "../server/test-fixtures/fakes.js";
import {
  TEST_CORE_OPERATION_TYPES,
} from "../server/test-fixtures/core-operation-names.js";

const appResource = createMcpAppResource("<!doctype html><p>editor</p>");
const catalog = createToolCatalog(
  appResource.uri,
  TEST_SEMANTIC_SCHEMAS,
);

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

describe("semantic MCP tool catalog", () => {
  it("requires the complete 65-operation Core inventory and matching schema hash", () => {
    expect(CORE_OPERATION_COUNT).toBe(65);
    expect(() =>
      assertCoreSemanticSchemaBundle({
        ...TEST_SEMANTIC_SCHEMAS,
        operationTypes: TEST_CORE_OPERATION_TYPES.slice(1),
      }),
    ).toThrow("complete closed operation union");
    expect(() =>
      assertCoreSemanticSchemaBundle({
        ...TEST_SEMANTIC_SCHEMAS,
        schemaSha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("schema hash");
    const openSchema = {};
    expect(() =>
      assertCoreSemanticSchemaBundle({
        ...TEST_SEMANTIC_SCHEMAS,
        editOperationSchema: openSchema,
        schemaSha256: `sha256:${createHash("sha256")
          .update("{}")
          .digest("hex")}`,
      }),
    ).toThrow("closed operation union");
  });

  it("publishes exactly the 29 planned tools with closed schemas and annotations", () => {
    expect(catalog.map(({ name }) => name)).toEqual(TOOL_NAMES);
    for (const contract of catalog) {
      expect(contract.description.length).toBeGreaterThan(20);
      expect(contract.inputSchema).toBeTypeOf("object");
      expect(contract.outputSchema).toBeTypeOf("object");
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

  it("injects the exact Core schema rather than a parallel operation schema", () => {
    for (const name of ["waptions_edit_plan", "waptions_edit_apply"]) {
      const contract = catalog.find((candidate) => candidate.name === name);
      const properties = contract?.inputSchema.properties as Record<
        string,
        { items?: unknown }
      >;
      expect(properties.operations.items).toEqual(
        TEST_SEMANTIC_SCHEMAS.editOperationSchema,
      );
    }
  });
});

describe("tool dispatcher", () => {
  it("rejects unknown fields before calling the coordinator", async () => {
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
    expect(coordinator.calls).toEqual([]);
  });

  it("returns stable API-version and input-size failures without coordinator calls", async () => {
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
        include: ["x".repeat(MAX_STRUCTURED_INPUT_BYTES)],
      }),
      new AbortController().signal,
    );
    expect(oversized.structuredContent).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(coordinator.calls).toEqual([]);
  });

  it("rejects unknown operation fields through the Core schema", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_edit_plan",
      {
        apiVersion: "2026-07-25",
        sessionId: "session-1",
        sessionEpoch: "epoch-1",
        expected: {
          sessionRevision: 7,
          documentRevision: 4,
        },
        operations: [
          {
            operationId: "op1",
            type: "project.set-name",
            name: "Renamed",
            parallelSemanticField: true,
          },
        ],
        historyLabel: "No-op",
        semanticCategory: "test",
      },
      new AbortController().signal,
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(coordinator.calls).toEqual([]);
  });

  it("requires target-bound confirmation whenever export uses overwrite authority", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_export_start",
      mutationRequest({
        format: "mp4-h264-aac",
        grantId: "write-grant",
        destinationPath: "/tmp/output.mp4",
        overwriteGrantId: "overwrite-grant",
      }),
      new AbortController().signal,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(coordinator.calls).toEqual([]);
  });

  it("accepts Core unit-explicit audio fields and rejects ambiguous units", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const base = {
      apiVersion: "2026-07-25",
      sessionId: "session-1",
      sessionEpoch: "epoch-1",
      expected: {
        sessionRevision: 7,
        documentRevision: 4,
      },
      historyLabel: "Trim audio",
      semanticCategory: "audio",
    };
    const explicit = await dispatcher.call(
      "waptions_edit_plan",
      {
        ...base,
        operations: [
          {
            operationId: "trim1",
            type: "audio-clip.trim",
            clipId: "audio-1",
            sourceStartSample48k: 48_000,
            sourceEndSample48k: 96_000,
          },
        ],
      },
      new AbortController().signal,
    );
    expect(explicit.structuredContent).toMatchObject({ ok: true });

    const ambiguous = await dispatcher.call(
      "waptions_edit_plan",
      {
        ...base,
        operations: [
          {
            operationId: "trim2",
            type: "audio-clip.trim",
            clipId: "audio-1",
            sourceStart: 1,
            sourceEnd: 2,
          },
        ],
      },
      new AbortController().signal,
    );
    expect(ambiguous.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    const explicitFades = await dispatcher.call(
      "waptions_edit_plan",
      {
        ...base,
        operations: [
          {
            operationId: "fade1",
            type: "audio-clip.set-fades",
            clipId: "audio-1",
            fadeInSamples48k: 2_400,
            fadeOutSamples48k: 4_800,
          },
        ],
      },
      new AbortController().signal,
    );
    expect(explicitFades.structuredContent).toMatchObject({ ok: true });

    const ambiguousFades = await dispatcher.call(
      "waptions_edit_plan",
      {
        ...base,
        operations: [
          {
            operationId: "fade2",
            type: "audio-clip.set-fades",
            clipId: "audio-1",
            fadeIn: 0.05,
            fadeOut: 0.1,
          },
        ],
      },
      new AbortController().signal,
    );
    expect(ambiguousFades.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("uses the project-scoped durable receipt identity before mutation execution", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_edit_apply",
      mutationRequest({
        operations: [
          {
            operationId: "op1",
            type: "project.set-name",
            name: "Renamed",
          },
        ],
        historyLabel: "Test no-op",
        semanticCategory: "test",
      }),
      new AbortController().signal,
    );

    expect(result.structuredContent).toEqual({
      ok: true,
      data: { applied: true, replayed: false },
      state: TEST_STATE,
      warnings: [],
    });
    expect(coordinator.calls).toEqual([
      "scope:waptions_edit_apply",
      "mutation:project-1:waptions_edit_apply:idem-key-0001",
    ]);
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
      mutationRequest({
        operations: [
          {
            operationId: "op1",
            type: "project.set-name",
            name: "Renamed",
          },
        ],
        historyLabel: "Rename",
        semanticCategory: "project",
      }),
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

  it("returns descriptor results without UI attachment for no-UI calls", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_project_get",
      projectReadRequest(),
      new AbortController().signal,
    );

    expect(result._meta).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      data: {},
      state: TEST_STATE,
      warnings: [],
    });
    expect(Object.keys(result.structuredContent)).toEqual([
      "ok",
      "data",
      "state",
      "warnings",
    ]);
    expect(result.content[0].text).not.toContain("descriptor");
  });

  it("accepts state tokens without a narrative domain revision", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    const state = { ...TEST_STATE };
    delete state.narrativeRevision;
    coordinator.readResult = {
      ok: true,
      data: {},
      state,
      warnings: [],
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

  it("fails closed when coordinator output contains a secret", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: true,
      data: { api_key: "sk-proj-this-must-never-escape" },
      state: TEST_STATE,
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_project_get",
      projectReadRequest(),
      new AbortController().signal,
    );
    const serialized = JSON.stringify(result);

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(serialized).not.toContain("sk-proj");
    expect(serialized).not.toContain("api_key");
  });

  it("keeps capability-shaped fields out of public structured content", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: true,
      data: { capabilityToken: "opaque-but-host-only" },
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
    expect(JSON.stringify(result)).not.toContain("opaque-but-host-only");
  });

  it("rejects transcript bodies and raw provider responses", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: true,
      data: {
        project: {
          transcriptBody: "full transcript must remain in an artifact",
          providerResponse: "raw provider body",
        },
      },
      state: TEST_STATE,
    };
    const dispatcher = new WaptionsToolDispatcher(catalog, coordinator);
    const result = await dispatcher.call(
      "waptions_project_get",
      projectReadRequest(),
      new AbortController().signal,
    );
    const serialized = JSON.stringify(result);

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(serialized).not.toContain("full transcript");
    expect(serialized).not.toContain("raw provider");
  });

  it("fails closed when descriptor output exceeds one MiB", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: true,
      data: { oversized: "x".repeat(MAX_STRUCTURED_OUTPUT_BYTES) },
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
  });

  it("fails closed when a coordinator failure exceeds the output bound", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid request.",
        retryable: false,
        details: { providerBody: "x".repeat(MAX_STRUCTURED_OUTPUT_BYTES) },
      },
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
  });

  it("keeps expiring UI capabilities in host-only metadata for editor_render", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.mutationResult = {
      ok: true,
      data: { viewId: "view-1" },
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
        createView: false,
      }),
      new AbortController().signal,
    );

    expect(result._meta).toMatchObject({
      bridge: { capabilityToken: "opaque-capability" },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "opaque-capability",
    );
    expect(result.content[0].text).not.toContain("opaque-capability");
  });

  it("rejects private metadata on ordinary data tools", async () => {
    const coordinator = new FakeCoordinatorAdapter();
    coordinator.readResult = {
      ok: true,
      data: {},
      state: TEST_STATE,
      privateMeta: { capabilityToken: "not-authorized-here" },
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
    expect(JSON.stringify(result)).not.toContain("not-authorized-here");
  });
});
