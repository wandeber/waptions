import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "./constants.js";
import {
  buildCoreSemanticSchemaBundle,
  loadCommittedCoreSemanticSchemaBundle,
} from "./core-schema-loader.js";
import {
  assertCoreSemanticSchemaBundle,
  computeCoreSemanticSchemaSha256,
  computeCoreToolSchemasSha256,
  CORE_OPERATION_CASE_COUNT,
  CORE_OPERATION_COUNT,
} from "./semantic-schema-adapter.js";
import { ToolSchemaValidator } from "./schema-validator.js";
import { createToolCatalog } from "./tool-catalog.js";

const schemaDirectory = fileURLToPath(
  new URL("../schemas/2026-07-25/", import.meta.url),
);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(`${schemaDirectory}${name}`, "utf8"));
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

function schemaRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((child) => schemaRefs(child, refs));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        refs.push(child);
      } else {
        schemaRefs(child, refs);
      }
    }
  }
  return refs;
}

const bundle = loadCommittedCoreSemanticSchemaBundle();
const catalog = createToolCatalog(
  `ui://waptions/editor/v1/${"a".repeat(64)}/index.html`,
  bundle,
);

const state = {
  sessionId: "session-1",
  projectId: "project-1",
  sessionEpoch: "epoch-1",
  sessionRevision: 7,
  documentRevision: 4,
  audioGraphRevision: 3,
  narrativeRevision: 2,
  eventCursor: "event-9",
};

function mutationBase(extra: Record<string, unknown>) {
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
    idempotencyKey: "idempotency-1",
    ...extra,
  };
}

function expectInput(
  name: (typeof TOOL_NAMES)[number],
  value: Record<string, unknown>,
  valid: boolean,
): void {
  const validator = new ToolSchemaValidator();
  const contract = bundle.toolSchemas[name];
  validator.register(name, contract.inputSchema);
  expect(validator.validateInput(name, value).valid).toBe(valid);
}

describe("committed Core schema loader", () => {
  it("builds the real 63-case wrapper with exactly 65 discriminators", () => {
    expect(CORE_OPERATION_COUNT).toBe(65);
    expect(CORE_OPERATION_CASE_COUNT).toBe(63);
    expect(bundle.operationTypes).toHaveLength(65);
    expect(new Set(bundle.operationTypes)).toHaveLength(65);
    const wrapperCases = (
      (bundle.editOperationSchema.allOf as Array<{
        oneOf: unknown[];
      }>)[0].oneOf
    );
    expect(wrapperCases).toHaveLength(63);
    expect(
      wrapperCases.filter(
        (candidate) =>
          Array.isArray(
            (candidate as {
              properties?: { type?: { enum?: unknown } };
            }).properties?.type?.enum,
          ),
      ),
    ).toHaveLength(2);
    expect(() => assertCoreSemanticSchemaBundle(bundle)).not.toThrow();
  });

  it("rewrites every transitive common, operations, session, and tools ref locally", () => {
    for (const schema of [
      bundle.editOperationSchema,
      ...Object.values(bundle.toolSchemas).flatMap((contract) => [
        contract.inputSchema,
        contract.outputSchema,
      ]),
    ]) {
      const definitions = schema.$defs as Record<string, unknown>;
      for (const ref of schemaRefs(schema)) {
        expect(ref).toMatch(/^#\/\$defs\/[^/]+$/);
        expect(definitions).toHaveProperty(ref.slice("#/$defs/".length));
      }
    }
  });

  it("compiles every standalone public schema with Draft 2020-12", () => {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
    });
    expect(() => ajv.compile(bundle.editOperationSchema)).not.toThrow();
    for (const contract of Object.values(bundle.toolSchemas)) {
      expect(() => ajv.compile(contract.inputSchema)).not.toThrow();
      expect(() => ajv.compile(contract.outputSchema)).not.toThrow();
    }
  });

  it("hashes the canonical self-contained bundle deterministically", () => {
    const documents = {
      commonSchema: readJson("common.schema.json"),
      operationsSchema: readJson("operations.schema.json"),
      sessionSchema: readJson("session.schema.json"),
      toolsSchema: readJson("tools.schema.json"),
      toolRegistry: readJson("tool-registry.json"),
    };
    const reordered = buildCoreSemanticSchemaBundle({
      commonSchema: reverseObjectKeys(documents.commonSchema),
      operationsSchema: reverseObjectKeys(documents.operationsSchema),
      sessionSchema: reverseObjectKeys(documents.sessionSchema),
      toolsSchema: reverseObjectKeys(documents.toolsSchema),
      toolRegistry: documents.toolRegistry,
    });
    expect(reordered.schemaSha256).toBe(bundle.schemaSha256);
    expect(reordered.toolSchemasSha256).toBe(bundle.toolSchemasSha256);
    expect(reordered.operationTypes).toEqual(bundle.operationTypes);
  });

  it("includes reachable common constraints in the hash and rejects wrapper drift", () => {
    const common = readJson("common.schema.json") as {
      $defs: { OperationId: { maxLength: number } };
    };
    common.$defs.OperationId.maxLength -= 1;
    const changed = buildCoreSemanticSchemaBundle({
      commonSchema: common,
      operationsSchema: readJson("operations.schema.json"),
      sessionSchema: readJson("session.schema.json"),
      toolsSchema: readJson("tools.schema.json"),
      toolRegistry: readJson("tool-registry.json"),
    });
    expect(changed.schemaSha256).not.toBe(bundle.schemaSha256);

    const operations = readJson("operations.schema.json") as {
      $defs: {
        EditorSemanticOperation: {
          required: string[];
          properties: Record<string, unknown>;
        };
      };
    };
    operations.$defs.EditorSemanticOperation.required.push("legacy");
    operations.$defs.EditorSemanticOperation.properties.legacy = {
      type: "string",
    };
    expect(() =>
      buildCoreSemanticSchemaBundle({
        commonSchema: readJson("common.schema.json"),
        operationsSchema: operations,
        sessionSchema: readJson("session.schema.json"),
        toolsSchema: readJson("tools.schema.json"),
        toolRegistry: readJson("tool-registry.json"),
      }),
    ).toThrow("closed operationId/type/payload wrapper");
  });

  it("fails boundary assertion on missing refs, inventory drift, or receipt reclassification", () => {
    expect(() =>
      assertCoreSemanticSchemaBundle({
        ...bundle,
        operationTypes: bundle.operationTypes.slice(1),
      }),
    ).toThrow("incomplete");

    const missingRefBundle = structuredClone(bundle);
    delete (
      missingRefBundle.editOperationSchema.$defs as Record<string, unknown>
    ).Common__OperationId;
    missingRefBundle.schemaSha256 = computeCoreSemanticSchemaSha256(
      missingRefBundle.editOperationSchema,
    );
    expect(() =>
      assertCoreSemanticSchemaBundle(missingRefBundle),
    ).toThrow("missing definition Common__OperationId");

    const reclassified = structuredClone(bundle);
    reclassified.toolSchemas.waptions_edit_apply.mutation = false;
    reclassified.toolSchemasSha256 = computeCoreToolSchemasSha256(
      reclassified.toolSchemas,
    );
    expect(() =>
      assertCoreSemanticSchemaBundle(reclassified),
    ).toThrow("invalid mutation classification");

    const invalidAnnotations = structuredClone(bundle);
    (
      invalidAnnotations.toolSchemas.waptions_project_get
        .annotations as unknown as Record<string, unknown>
    ).readOnlyHint = "yes";
    invalidAnnotations.toolSchemasSha256 = computeCoreToolSchemasSha256(
      invalidAnnotations.toolSchemas,
    );
    expect(() =>
      assertCoreSemanticSchemaBundle(invalidAnnotations),
    ).toThrow("waptions_project_get is incomplete");
  });

  it("rejects attached tool schemas that differ from the bundled canonical catalog", () => {
    const tampered = structuredClone(bundle);
    tampered.toolSchemas.waptions_session_open.description =
      "A coordinator-supplied replacement description that must not be trusted.";
    tampered.toolSchemasSha256 = computeCoreToolSchemasSha256(
      tampered.toolSchemas,
    );

    expect(() =>
      createToolCatalog(
        `ui://waptions/editor/v1/${"b".repeat(64)}/index.html`,
        tampered,
      ),
    ).toThrow("do not match the bundled canonical schemas");
  });

  it("accepts real Core operation fixtures and rejects flattened or ambiguous payloads", () => {
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(bundle.editOperationSchema);
    const goldenCases = readJson("fixtures/golden-cases.json") as {
      valid: Array<{ path: string; schemaRef: string }>;
      invalid: Array<{ path: string; schemaRef: string }>;
    };
    for (const fixture of goldenCases.valid.filter(({ schemaRef }) =>
      schemaRef.endsWith("#/$defs/EditorSemanticOperation"),
    )) {
      expect(validate(readJson(`fixtures/${fixture.path}`))).toBe(true);
    }
    for (const fixture of goldenCases.invalid.filter(({ schemaRef }) =>
      schemaRef.endsWith("#/$defs/EditorSemanticOperation"),
    )) {
      expect(validate(readJson(`fixtures/${fixture.path}`))).toBe(false);
    }
    expect(
      validate({
        operationId: "explicit-fade",
        type: "audio-clip.set-fades",
        payload: {
          clipId: "audio-1",
          fadeInOutputSamples48k: 2_400,
          fadeOutOutputSamples48k: 4_800,
        },
      }),
    ).toBe(true);
    expect(
      validate({
        operationId: "legacy-trim",
        type: "audio-clip.trim",
        clipId: "audio-1",
        sourceStartSample48k: 0,
        sourceEndSample48k: 48_000,
      }),
    ).toBe(false);
    expect(
      validate({
        operationId: "ambiguous-trim",
        type: "audio-clip.trim",
        payload: {
          clipId: "audio-1",
          sourceStart: 0,
          sourceEnd: 1,
        },
      }),
    ).toBe(false);
    expect(
      validate({
        operationId: "ambiguous-fade",
        type: "audio-clip.set-fades",
        payload: {
          clipId: "audio-1",
          fadeIn: 0.1,
          fadeOut: 0.2,
        },
      }),
    ).toBe(false);
  });
});

describe("canonical Core public tool schemas", () => {
  it("derives the exact ordered registry inventory and metadata", () => {
    const registry = readJson("tool-registry.json") as {
      tools: Array<{
        name: string;
        description: string;
        annotations: Record<string, boolean>;
      }>;
    };
    expect(catalog.map(({ name }) => name)).toEqual(TOOL_NAMES);
    for (const [index, contract] of catalog.entries()) {
      expect(contract.description).toBe(registry.tools[index].description);
      expect(contract.annotations).toMatchObject(
        registry.tools[index].annotations,
      );
    }
    expect(
      catalog.filter((contract) => contract._meta !== undefined).map(
        ({ name }) => name,
      ),
    ).toEqual(["waptions_editor_render"]);
  });

  it("accepts canonical session, authority, media, history, transcription, export, and view inputs", () => {
    expectInput(
      "waptions_session_open",
      {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-1",
        idempotencyKey: "idempotency-1",
        name: "Project",
      },
      true,
    );
    expectInput(
      "waptions_path_grant",
      mutationBase({ action: { kind: "inspect" } }),
      true,
    );
    expectInput(
      "waptions_media_import",
      mutationBase({
        mediaHandles: ["media-handle-1"],
        placement: { kind: "register-only" },
      }),
      true,
    );
    expectInput(
      "waptions_history_apply",
      mutationBase({ action: { kind: "undo" } }),
      true,
    );
    expectInput(
      "waptions_transcription_start",
      mutationBase({
        transcriptionKind: "subtitle",
        targetTrackIds: ["subtitle-track-1"],
        language: null,
        speakerMode: "none",
        providerPolicy: { kind: "browser-local" },
      }),
      true,
    );
    expectInput(
      "waptions_export_start",
      mutationBase({
        exportKind: "reference-snapshot",
        destination: {
          schemaVersion: 1,
          destinationId: "destination-1",
          grantId: "grant-1",
          stagingHandleId: "staging-1",
          mode: "create-only",
          outputName: "snapshot.waptions",
          verifiedParentIdentity: "parent-1",
          expiresAt: "2026-07-25T12:00:00.000Z",
        },
      }),
      true,
    );
    expectInput(
      "waptions_view_update",
      mutationBase({
        viewId: "view-1",
        expectedViewRevision: 2,
        patch: { playheadFrame: 30 },
      }),
      true,
    );
    expectInput(
      "waptions_playback_control",
      mutationBase({
        viewId: "view-1",
        expectedPlaybackRevision: 2,
        action: { kind: "seek", frame: 30 },
      }),
      true,
    );
  });

  it("rejects the former parallel input shapes on visibly divergent tools", () => {
    expectInput(
      "waptions_session_open",
      {
        apiVersion: "2026-07-25",
        mode: "create",
        projectName: "Project",
        idempotencyKey: "idempotency-1",
      },
      false,
    );
    expectInput(
      "waptions_path_grant",
      mutationBase({ action: "inspect" }),
      false,
    );
    expectInput(
      "waptions_media_import",
      mutationBase({
        grantId: "grant-1",
        sources: [{ path: "/tmp/media.mp4" }],
        placement: "register-only",
      }),
      false,
    );
    expectInput(
      "waptions_history_apply",
      mutationBase({ action: "undo" }),
      false,
    );
    expectInput(
      "waptions_transcription_start",
      mutationBase({
        mode: "subtitle",
        trackIds: ["subtitle-track-1"],
        speakerMode: "none",
        providerPolicy: "browser-local",
      }),
      false,
    );
    expectInput(
      "waptions_export_start",
      mutationBase({
        format: "reference-snapshot",
        grantId: "grant-1",
        destinationPath: "/tmp/output.waptions",
      }),
      false,
    );
    expectInput(
      "waptions_view_update",
      mutationBase({
        viewId: "view-1",
        expectedViewRevision: 2,
        patch: { presentation: "pip" },
      }),
      false,
    );
    expectInput(
      "waptions_playback_control",
      mutationBase({
        viewId: "view-1",
        expectedPlaybackRevision: 2,
        action: "seek",
        frame: 30,
      }),
      false,
    );
  });

  it("uses exact closed typed outputs, including replay and committed state", () => {
    const project = bundle.toolSchemas.waptions_project_get;
    const valid = {
      ok: true,
      data: {
        projectId: "project-1",
        name: "Project",
        renderProfile: {
          fps: { numerator: 30, denominator: 1 },
          width: 1920,
          height: 1080,
          audioSampleRate: 48_000,
          isFrameRateLocked: true,
          isCanvasSizeLocked: true,
        },
        renderBackgroundColor: "#000000",
        counts: {
          tracks: 0,
          clips: 0,
          subtitles: 0,
          sources: 0,
          links: 0,
        },
        activeJobIds: [],
        references: [],
        page: { hasMore: false },
      },
      state,
      committedState: state,
      warnings: [],
      replayed: true,
    };
    const validator = new ToolSchemaValidator();
    expect(validator.validateOutput(project.outputSchema, valid)).toBe(true);
    expect(
      validator.validateOutput(project.outputSchema, {
        ...valid,
        data: {},
      }),
    ).toBe(false);
    expect(
      validator.validateOutput(project.outputSchema, {
        ...valid,
        replayed: undefined,
      }),
    ).toBe(false);
  });
});
