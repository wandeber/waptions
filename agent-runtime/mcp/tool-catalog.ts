import {
  DEFAULT_PAGE_SIZE,
  MAX_COMPOUND_OPERATIONS,
  MAX_PAGE_SIZE,
  STABLE_ERROR_CODES,
  TOOL_NAMES,
  WAPTIONS_API_VERSION,
  type WaptionsToolName,
} from "./constants.js";
import {
  arraySchema,
  enumSchema,
  nonEmptyString,
  nonNegativeInteger,
  opaqueId,
  positiveInteger,
  strictObject,
  type JsonSchema,
} from "./json-schema.js";
import {
  assertCoreSemanticSchemaBundle,
  type CoreSemanticSchemaBundle,
} from "./semantic-schema-adapter.js";

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolContract {
  name: WaptionsToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ToolAnnotations;
  mutation: boolean;
  _meta?: {
    ui: {
      resourceUri: string;
      visibility: ["model", "app"];
    };
  };
}

const booleanSchema: JsonSchema = { type: "boolean" };
const coreOperationSchemaPlaceholder: JsonSchema = {
  not: {},
  description:
    "Replaced at server construction with the exact Core-owned semantic operation schema.",
};
const apiVersionProperty: JsonSchema = {
  type: "string",
  const: WAPTIONS_API_VERSION,
};
const cursorSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
};
const pageLimitSchema: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  default: DEFAULT_PAGE_SIZE,
};
const sha256Schema: JsonSchema = {
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
};
const absolutePathSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 16_384,
  pattern: "^(?:/|[A-Za-z]:[\\\\/])",
};

const expectedSchema = strictObject(
  {
    sessionRevision: nonNegativeInteger,
    documentRevision: nonNegativeInteger,
    audioGraphRevision: nonNegativeInteger,
    narrativeRevision: nonNegativeInteger,
  },
  ["sessionRevision", "documentRevision"],
);

const stateTokenSchema = strictObject(
  {
    sessionId: opaqueId,
    projectId: opaqueId,
    sessionEpoch: opaqueId,
    sessionRevision: nonNegativeInteger,
    documentRevision: nonNegativeInteger,
    audioGraphRevision: nonNegativeInteger,
    narrativeRevision: nonNegativeInteger,
    eventCursor: cursorSchema,
  },
  [
    "sessionId",
    "projectId",
    "sessionEpoch",
    "sessionRevision",
    "documentRevision",
    "audioGraphRevision",
    "eventCursor",
  ],
);

const warningSchema = strictObject(
  {
    code: nonEmptyString,
    message: { type: "string", maxLength: 512 },
    details: {
      type: "object",
      maxProperties: 50,
      additionalProperties: true,
    },
  },
  ["code", "message"],
);

const errorSchema = strictObject(
  {
    code: enumSchema(STABLE_ERROR_CODES),
    message: { type: "string", maxLength: 512 },
    retryable: booleanSchema,
    details: {
      type: "object",
      maxProperties: 50,
      additionalProperties: true,
    },
  },
  ["code", "message", "retryable"],
);

const descriptorSchema: JsonSchema = {
  type: "object",
  maxProperties: 128,
  additionalProperties: true,
};
const descriptorArraySchema = arraySchema(descriptorSchema, {
  maxItems: MAX_PAGE_SIZE,
});
const idArraySchema = arraySchema(opaqueId, {
  maxItems: MAX_PAGE_SIZE,
  uniqueItems: true,
});

const TOOL_DATA_PROPERTIES: Record<
  WaptionsToolName,
  Record<string, JsonSchema>
> = {
  waptions_session_list: {
    sessions: descriptorArraySchema,
    nextCursor: cursorSchema,
  },
  waptions_session_open: {
    session: descriptorSchema,
    recovered: booleanSchema,
  },
  waptions_session_manage: {
    session: descriptorSchema,
    detached: booleanSchema,
    archived: booleanSchema,
    deleted: booleanSchema,
  },
  waptions_path_grant: {
    grant: descriptorSchema,
    grants: descriptorArraySchema,
    revoked: booleanSchema,
  },
  waptions_project_get: {
    project: descriptorSchema,
    renderProfile: descriptorSchema,
    counts: descriptorSchema,
    activeJobs: descriptorArraySchema,
    tracks: descriptorArraySchema,
    clips: descriptorArraySchema,
    sources: descriptorArraySchema,
    links: descriptorArraySchema,
    nextCursor: cursorSchema,
  },
  waptions_project_import: {
    project: descriptorSchema,
    job: descriptorSchema,
  },
  waptions_project_validate: {
    validation: descriptorSchema,
    job: descriptorSchema,
  },
  waptions_media_probe: {
    probes: descriptorArraySchema,
    job: descriptorSchema,
  },
  waptions_media_import: {
    sources: descriptorArraySchema,
    placements: descriptorArraySchema,
  },
  waptions_media_review: {
    jobs: descriptorArraySchema,
    artifacts: descriptorArraySchema,
  },
  waptions_media_release: {
    mode: enumSchema(["release-runtime", "garbage-collect"]),
    applied: booleanSchema,
    retainedRoots: descriptorArraySchema,
    releasedSourceIds: idArraySchema,
  },
  waptions_timeline_query: {
    domain: nonEmptyString,
    items: descriptorArraySchema,
    nextCursor: cursorSchema,
  },
  waptions_edit_plan: {
    planId: opaqueId,
    planDigest: sha256Schema,
    expiresAt: nonEmptyString,
    normalizedOperations: descriptorArraySchema,
    predictedEffects: descriptorSchema,
    aliases: descriptorSchema,
  },
  waptions_edit_apply: {
    applied: booleanSchema,
    operationResults: descriptorArraySchema,
    aliases: descriptorSchema,
    historyEntry: descriptorSchema,
  },
  waptions_history_get: {
    entries: descriptorArraySchema,
    currentIndex: nonNegativeInteger,
    nextCursor: cursorSchema,
  },
  waptions_history_apply: {
    action: enumSchema(["undo", "redo", "jump"]),
    historyEntryId: opaqueId,
    currentIndex: nonNegativeInteger,
  },
  waptions_transcription_start: {
    job: descriptorSchema,
  },
  waptions_job_list: {
    jobs: descriptorArraySchema,
    nextCursor: cursorSchema,
  },
  waptions_job_get: {
    job: descriptorSchema,
  },
  waptions_job_cancel: {
    job: descriptorSchema,
    cancellationRequested: booleanSchema,
  },
  waptions_export_start: {
    job: descriptorSchema,
    artifact: descriptorSchema,
  },
  waptions_artifact_list: {
    artifacts: descriptorArraySchema,
    nextCursor: cursorSchema,
  },
  waptions_artifact_get: {
    artifact: descriptorSchema,
    localPath: absolutePathSchema,
  },
  waptions_events_read: {
    events: descriptorArraySchema,
    nextCursor: cursorSchema,
    retentionStartCursor: cursorSchema,
  },
  waptions_view_get: {
    view: descriptorSchema,
    presence: descriptorArraySchema,
  },
  waptions_view_update: {
    view: descriptorSchema,
  },
  waptions_playback_control: {
    playback: descriptorSchema,
  },
  waptions_diagnostics_get: {
    diagnostics: descriptorSchema,
  },
  waptions_editor_render: {
    viewId: opaqueId,
    presentation: enumSchema(["inline", "fullscreen", "pip"]),
    attached: booleanSchema,
  },
};

function toolOutputSchema(
  name: WaptionsToolName,
  mutation: boolean,
): JsonSchema {
  const dataSchema = strictObject(
    {
      ...TOOL_DATA_PROPERTIES[name],
      ...(mutation ? { replayed: booleanSchema } : {}),
    },
    [],
    { maxProperties: 32 },
  );
  return {
    type: "object",
    oneOf: [
      strictObject(
        {
          ok: { const: true },
          data: dataSchema,
          state: stateTokenSchema,
          warnings: arraySchema(warningSchema, { maxItems: 100 }),
        },
        ["ok", "data", "state", "warnings"],
      ),
      strictObject(
        {
          ok: { const: false },
          error: errorSchema,
          state: stateTokenSchema,
        },
        ["ok", "error"],
      ),
    ],
  };
}

const mutationProperties: Record<string, JsonSchema> = {
  apiVersion: apiVersionProperty,
  sessionId: opaqueId,
  sessionEpoch: opaqueId,
  expected: expectedSchema,
  idempotencyKey: {
    type: "string",
    minLength: 8,
    maxLength: 256,
  },
};

function mutationInput(
  properties: Record<string, JsonSchema>,
  required: readonly string[],
  extra: Record<string, unknown> = {},
): JsonSchema {
  return strictObject(
    { ...mutationProperties, ...properties },
    [
      "apiVersion",
      "sessionId",
      "sessionEpoch",
      "expected",
      "idempotencyKey",
      ...required,
    ],
    extra,
  );
}

function sessionReadInput(
  properties: Record<string, JsonSchema> = {},
  required: readonly string[] = [],
  extra: Record<string, unknown> = {},
): JsonSchema {
  return strictObject(
    {
      apiVersion: apiVersionProperty,
      sessionId: opaqueId,
      ...properties,
    },
    ["apiVersion", "sessionId", ...required],
    extra,
  );
}

function pagedSessionReadInput(
  properties: Record<string, JsonSchema> = {},
  required: readonly string[] = [],
): JsonSchema {
  return sessionReadInput(
    {
      cursor: cursorSchema,
      limit: pageLimitSchema,
      ...properties,
    },
    required,
  );
}

function annotations(
  title: string,
  options: Partial<Omit<ToolAnnotations, "title">> = {},
): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    ...options,
  };
}

function tool(
  name: WaptionsToolName,
  title: string,
  description: string,
  inputSchema: JsonSchema,
  toolAnnotations: ToolAnnotations,
  mutation: boolean,
): ToolContract {
  return {
    name,
    title,
    description,
    inputSchema,
    outputSchema: toolOutputSchema(name, mutation),
    annotations: toolAnnotations,
    mutation,
  };
}

const confirmationSchema = strictObject(
  {
    action: nonEmptyString,
    targetId: opaqueId,
    targetDigest: sha256Schema,
  },
  ["action", "targetId"],
);

const sessionOpenSchema: JsonSchema = {
  type: "object",
  oneOf: [
    strictObject(
      {
        apiVersion: apiVersionProperty,
        idempotencyKey: {
          type: "string",
          minLength: 8,
          maxLength: 256,
        },
        mode: { const: "create" },
        projectName: nonEmptyString,
        participantId: opaqueId,
      },
      ["apiVersion", "idempotencyKey", "mode", "projectName"],
    ),
    strictObject(
      {
        apiVersion: apiVersionProperty,
        idempotencyKey: {
          type: "string",
          minLength: 8,
          maxLength: 256,
        },
        mode: enumSchema(["attach", "recover"]),
        projectId: opaqueId,
        participantId: opaqueId,
      },
      ["apiVersion", "idempotencyKey", "mode", "projectId"],
    ),
  ],
};

const toolContractsWithoutApp: ToolContract[] = [
  tool(
    "waptions_session_list",
    "List managed sessions",
    "Page descriptor-only managed Waptions projects, sessions, and recovery state.",
    strictObject(
      {
        apiVersion: apiVersionProperty,
        cursor: cursorSchema,
        limit: pageLimitSchema,
        includeArchived: booleanSchema,
      },
      ["apiVersion"],
    ),
    annotations("List managed sessions"),
    false,
  ),
  tool(
    "waptions_session_open",
    "Open managed session",
    "Create a blank managed V4 project or attach to/recover an existing project by opaque ID. Creation uses bootstrap idempotency because no session exists yet.",
    sessionOpenSchema,
    annotations("Open managed session", {
      readOnlyHint: false,
      idempotentHint: true,
    }),
    true,
  ),
  tool(
    "waptions_session_manage",
    "Manage managed session",
    "Rename, detach, archive, restore, or explicitly delete a managed project. Delete requires target-bound confirmation.",
    mutationInput(
      {
        action: enumSchema([
          "rename",
          "detach",
          "archive",
          "restore",
          "delete",
        ]),
        name: nonEmptyString,
        participantId: opaqueId,
        confirmation: confirmationSchema,
      },
      ["action"],
      {
        allOf: [
          {
            if: { properties: { action: { const: "rename" } } },
            then: { required: ["name"] },
          },
          {
            if: { properties: { action: { const: "detach" } } },
            then: { required: ["participantId"] },
          },
          {
            if: { properties: { action: { const: "delete" } } },
            then: { required: ["confirmation"] },
          },
        ],
      },
    ),
    annotations("Manage managed session", {
      readOnlyHint: false,
      destructiveHint: true,
    }),
    true,
  ),
  tool(
    "waptions_path_grant",
    "Manage path grants",
    "Inspect, add, or revoke session-scoped read roots, create-only write destinations, and exact overwrite-file authority. The coordinator owns canonical path validation.",
    mutationInput(
      {
        action: enumSchema(["inspect", "add", "revoke"]),
        grantId: opaqueId,
        kind: enumSchema([
          "read-root",
          "write-destination",
          "overwrite-file",
        ]),
        path: absolutePathSchema,
        allowCreate: booleanSchema,
        confirmation: confirmationSchema,
      },
      ["action"],
      {
        allOf: [
          {
            if: { properties: { action: { const: "add" } } },
            then: {
              required: ["kind", "path", "allowCreate", "confirmation"],
            },
          },
          {
            if: { properties: { action: { const: "revoke" } } },
            then: { required: ["grantId", "confirmation"] },
          },
        ],
      },
    ),
    annotations("Manage path grants", {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_project_get",
    "Get project descriptor",
    "Return a bounded descriptor-first project summary, revisions, render profile, counts, active jobs, and paged graph references.",
    pagedSessionReadInput({
      include: arraySchema(
        enumSchema([
          "render-profile",
          "counts",
          "active-jobs",
          "tracks",
          "clips",
          "sources",
          "links",
        ]),
        { maxItems: 7, uniqueItems: true },
      ),
    }),
    annotations("Get project descriptor"),
    false,
  ),
  tool(
    "waptions_project_import",
    "Import project",
    "Start bounded import of a V1-V4 .waptions bundle or descriptor-only managed manifest from an authorized source.",
    mutationInput(
      {
        sourceKind: enumSchema(["bundle", "managed-manifest"]),
        grantId: opaqueId,
        sourcePath: absolutePathSchema,
        targetMode: enumSchema(["new-project", "replace-current"]),
        confirmation: confirmationSchema,
      },
      ["sourceKind", "grantId", "sourcePath", "targetMode"],
      {
        allOf: [
          {
            if: { properties: { targetMode: { const: "replace-current" } } },
            then: { required: ["confirmation"] },
          },
        ],
      },
    ),
    annotations("Import project", {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_project_validate",
    "Validate project",
    "Validate structural, hydrated, source, history/WAL, transcript/pin, and renderability invariants. Deep validation starts a durable job.",
    mutationInput(
      {
        depth: enumSchema(["shallow", "deep"]),
        checks: arraySchema(
          enumSchema([
            "structural",
            "hydrated",
            "sources",
            "history-wal",
            "transcripts-pins",
            "renderability",
          ]),
          { minItems: 1, maxItems: 6, uniqueItems: true },
        ),
      },
      ["depth"],
    ),
    annotations("Validate project", {
      readOnlyHint: false,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_media_probe",
    "Probe media",
    "Probe canonical authorized filesystem paths without changing the document. Expensive probes are durable jobs and all results remain descriptor-only.",
    mutationInput(
      {
        grantId: opaqueId,
        paths: arraySchema(absolutePathSchema, {
          minItems: 1,
          maxItems: 500,
          uniqueItems: true,
        }),
        naturalSort: booleanSchema,
        includeHashes: booleanSchema,
      },
      ["grantId", "paths"],
    ),
    annotations("Probe media", {
      readOnlyHint: false,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_media_import",
    "Import media",
    "Atomically register immutable source descriptors and optionally place initial clips using natural ordering.",
    mutationInput(
      {
        grantId: opaqueId,
        sources: arraySchema(
          strictObject(
            {
              path: absolutePathSchema,
              expectedSha256: sha256Schema,
            },
            ["path"],
          ),
          { minItems: 1, maxItems: 500 },
        ),
        placement: enumSchema(["register-only", "append-natural-order"]),
        videoTrackId: opaqueId,
        audioTrackId: opaqueId,
      },
      ["grantId", "sources", "placement"],
    ),
    annotations("Import media", {
      readOnlyHint: false,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_media_review",
    "Review media",
    "Start bounded review jobs that emit contact-sheet, thumbnail, waveform, silence, speech, scene, transcript-assisted, or proxy artifacts.",
    mutationInput(
      {
        sourceIds: arraySchema(opaqueId, {
          minItems: 1,
          maxItems: 500,
          uniqueItems: true,
        }),
        reviewKinds: arraySchema(
          enumSchema([
            "contact-sheet",
            "thumbnail-strip",
            "waveform",
            "audio-map",
            "silence-map",
            "speech-map",
            "scene-candidates",
            "transcription-assisted",
            "review-proxy",
          ]),
          { minItems: 1, maxItems: 9, uniqueItems: true },
        ),
        intervals: arraySchema(
          strictObject(
            {
              sourceId: opaqueId,
              startSeconds: { type: "number", minimum: 0 },
              endSeconds: { type: "number", exclusiveMinimum: 0 },
            },
            ["sourceId", "startSeconds", "endSeconds"],
          ),
          { maxItems: 500 },
        ),
      },
      ["sourceIds", "reviewKinds"],
    ),
    annotations("Review media", {
      readOnlyHint: false,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_media_release",
    "Release managed media",
    "Dry-run or apply runtime release or reachability-safe durable source garbage collection. Apply requires target-bound confirmation.",
    mutationInput(
      {
        mode: enumSchema(["release-runtime", "garbage-collect"]),
        apply: booleanSchema,
        sourceIds: arraySchema(opaqueId, {
          maxItems: 500,
          uniqueItems: true,
        }),
        confirmation: confirmationSchema,
      },
      ["mode", "apply"],
      {
        allOf: [
          {
            if: { properties: { apply: { const: true } } },
            then: { required: ["confirmation"] },
          },
        ],
      },
    ),
    annotations("Release managed media", {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_timeline_query",
    "Query timeline",
    "Page tracks, clips, subtitles, narrative blocks or words, links, intervals, selection, or content boundaries at one consistent revision.",
    pagedSessionReadInput(
      {
        domain: enumSchema([
          "tracks",
          "clips",
          "subtitles",
          "narrative-blocks",
          "narrative-words",
          "links",
          "intervals",
          "selection",
          "content-boundary",
        ]),
        trackIds: arraySchema(opaqueId, {
          maxItems: 500,
          uniqueItems: true,
        }),
        interval: strictObject(
          {
            startFrame: nonNegativeInteger,
            endFrame: nonNegativeInteger,
          },
          ["startFrame", "endFrame"],
        ),
      },
      ["domain"],
    ),
    annotations("Query timeline"),
    false,
  ),
  tool(
    "waptions_edit_plan",
    "Plan semantic edit",
    "Purely normalize and validate an atomic compound semantic edit, returning predicted effects, warnings, aliases, and a 15-minute plan descriptor.",
    strictObject(
      {
        apiVersion: apiVersionProperty,
        sessionId: opaqueId,
        sessionEpoch: opaqueId,
        expected: expectedSchema,
        operations: arraySchema(coreOperationSchemaPlaceholder, {
          minItems: 1,
          maxItems: MAX_COMPOUND_OPERATIONS,
        }),
        historyLabel: nonEmptyString,
        semanticCategory: nonEmptyString,
      },
      [
        "apiVersion",
        "sessionId",
        "sessionEpoch",
        "expected",
        "operations",
        "historyLabel",
        "semanticCategory",
      ],
    ),
    annotations("Plan semantic edit"),
    false,
  ),
  tool(
    "waptions_edit_apply",
    "Apply semantic edit",
    "Atomically apply an exact plan or inline compound operations with CAS, durable idempotency, one semantic history transition, link transforms, and V4 validation.",
    mutationInput(
      {
        planId: opaqueId,
        planDigest: sha256Schema,
        operations: arraySchema(coreOperationSchemaPlaceholder, {
          minItems: 1,
          maxItems: MAX_COMPOUND_OPERATIONS,
        }),
        historyLabel: nonEmptyString,
        semanticCategory: nonEmptyString,
      },
      [],
      {
        oneOf: [
          { required: ["planId", "planDigest"] },
          {
            required: ["operations", "historyLabel", "semanticCategory"],
          },
        ],
      },
    ),
    annotations("Apply semantic edit", {
      readOnlyHint: false,
      destructiveHint: true,
    }),
    true,
  ),
  tool(
    "waptions_history_get",
    "Get semantic history",
    "Page bounded semantic history and redo descriptors and the current history index without loading full snapshots.",
    pagedSessionReadInput({
      direction: enumSchema(["undo", "redo", "both"]),
    }),
    annotations("Get semantic history"),
    false,
  ),
  tool(
    "waptions_history_apply",
    "Apply history transition",
    "Undo, redo, or jump to a semantic history entry with CAS, durable idempotency, and exact transcript-pin semantics.",
    mutationInput(
      {
        action: enumSchema(["undo", "redo", "jump"]),
        historyEntryId: opaqueId,
      },
      ["action"],
      {
        allOf: [
          {
            if: { properties: { action: { const: "jump" } } },
            then: { required: ["historyEntryId"] },
          },
        ],
      },
    ),
    annotations("Apply history transition", {
      readOnlyHint: false,
    }),
    true,
  ),
  tool(
    "waptions_transcription_start",
    "Start transcription",
    "Start subtitle or independent editorial transcription over explicit tracks/ranges with language, speaker mode, and provider policy.",
    mutationInput(
      {
        mode: enumSchema(["subtitle", "editorial"]),
        trackIds: arraySchema(opaqueId, {
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
        }),
        ranges: arraySchema(
          strictObject(
            {
              startSample: nonNegativeInteger,
              endSample: positiveInteger,
              sampleRate: { type: "integer", enum: [16_000, 48_000] },
            },
            ["startSample", "endSample", "sampleRate"],
          ),
          { minItems: 1, maxItems: 500 },
        ),
        language: nonEmptyString,
        speakerMode: enumSchema(["none", "detect", "known-speakers"]),
        providerPolicy: enumSchema([
          "browser-local",
          "managed-local-endpoint",
          "custom-openai-compatible",
        ]),
        providerId: opaqueId,
      },
      ["mode", "trackIds", "ranges", "language", "speakerMode", "providerPolicy"],
      {
        allOf: [
          {
            if: {
              properties: {
                providerPolicy: {
                  enum: [
                    "managed-local-endpoint",
                    "custom-openai-compatible",
                  ],
                },
              },
            },
            then: { required: ["providerId"] },
          },
        ],
      },
    ),
    annotations("Start transcription", {
      readOnlyHint: false,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_job_list",
    "List jobs",
    "Page durable project jobs filtered by kind and state.",
    pagedSessionReadInput({
      kinds: arraySchema(nonEmptyString, {
        maxItems: 50,
        uniqueItems: true,
      }),
      states: arraySchema(
        enumSchema([
          "queued",
          "running",
          "succeeded",
          "failed",
          "cancelled",
          "stale",
          "interrupted",
        ]),
        { maxItems: 7, uniqueItems: true },
      ),
    }),
    annotations("List jobs"),
    false,
  ),
  tool(
    "waptions_job_get",
    "Get job",
    "Read one durable job descriptor and bounded progress/result metadata.",
    sessionReadInput({ jobId: opaqueId }, ["jobId"]),
    annotations("Get job"),
    false,
  ),
  tool(
    "waptions_job_cancel",
    "Cancel job",
    "Idempotently request cancellation of a cancellable durable job.",
    mutationInput({ jobId: opaqueId }, ["jobId"]),
    annotations("Cancel job", {
      readOnlyHint: false,
      destructiveHint: true,
    }),
    true,
  ),
  tool(
    "waptions_export_start",
    "Start export",
    "Start H.264/AAC MP4, WebM, portable bundle, reference snapshot, or proof export to an authorized destination.",
    mutationInput(
      {
        format: enumSchema([
          "mp4-h264-aac",
          "webm",
          "portable-bundle",
          "reference-snapshot",
          "proof",
        ]),
        grantId: opaqueId,
        destinationPath: absolutePathSchema,
        overwriteGrantId: opaqueId,
        confirmation: confirmationSchema,
      },
      ["format", "grantId", "destinationPath"],
      {
        allOf: [
          {
            if: { required: ["overwriteGrantId"] },
            then: { required: ["confirmation"] },
          },
        ],
      },
    ),
    annotations("Start export", {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    }),
    true,
  ),
  tool(
    "waptions_artifact_list",
    "List artifacts",
    "Page durable project artifact descriptors and hashes.",
    pagedSessionReadInput({
      kinds: arraySchema(nonEmptyString, {
        maxItems: 50,
        uniqueItems: true,
      }),
    }),
    annotations("List artifacts"),
    false,
  ),
  tool(
    "waptions_artifact_get",
    "Get artifact descriptor",
    "Return bounded artifact metadata, an authorized canonical local path, or host-only metadata for a short-lived signed range URL. Large bytes are never inlined.",
    sessionReadInput(
      {
        artifactId: opaqueId,
        access: enumSchema(["metadata", "local-path", "signed-range-url"]),
        viewId: opaqueId,
      },
      ["artifactId", "access"],
    ),
    annotations("Get artifact descriptor", {
      openWorldHint: true,
    }),
    false,
  ),
  tool(
    "waptions_events_read",
    "Read session events",
    "Read ordered bounded events after an opaque cursor. Retention gaps return EVENT_CURSOR_EXPIRED with the current state token.",
    sessionReadInput(
      {
        afterCursor: cursorSchema,
        limit: pageLimitSchema,
      },
      [],
    ),
    annotations("Read session events"),
    false,
  ),
  tool(
    "waptions_view_get",
    "Get view state",
    "Read one bounded view and presence descriptor without project history.",
    sessionReadInput({ viewId: opaqueId }, ["viewId"]),
    annotations("Get view state"),
    false,
  ),
  tool(
    "waptions_view_update",
    "Update view state",
    "Update selection, playhead, zoom, scroll, row heights, layout, focus, or presentation without creating project history.",
    mutationInput(
      {
        viewId: opaqueId,
        expectedViewRevision: nonNegativeInteger,
        patch: strictObject(
          {
            selectionIds: arraySchema(opaqueId, {
              maxItems: 500,
              uniqueItems: true,
            }),
            playheadFrame: nonNegativeInteger,
            zoom: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
            scrollX: { type: "number", minimum: 0 },
            scrollY: { type: "number", minimum: 0 },
            rowHeights: {
              type: "object",
              maxProperties: 256,
              additionalProperties: {
                type: "number",
                minimum: 24,
                maximum: 1000,
              },
            },
            layout: enumSchema(["timeline", "text", "split"]),
            focusedPanel: nonEmptyString,
            presentation: enumSchema(["inline", "fullscreen", "pip"]),
          },
          [],
          { minProperties: 1 },
        ),
      },
      ["viewId", "expectedViewRevision", "patch"],
    ),
    annotations("Update view state", {
      readOnlyHint: false,
    }),
    true,
  ),
  tool(
    "waptions_playback_control",
    "Control playback",
    "Semantically control play, pause, seek, rate, master volume/mute, presenter ownership, and follow state without changing project history or the V4 audio graph.",
    mutationInput(
      {
        viewId: opaqueId,
        expectedPlaybackRevision: nonNegativeInteger,
        action: enumSchema([
          "play",
          "pause",
          "seek",
          "set-rate",
          "set-master-volume",
          "set-master-mute",
          "claim-presenter",
          "release-presenter",
          "follow",
          "unfollow",
        ]),
        frame: nonNegativeInteger,
        rate: { type: "number", minimum: 0.1, maximum: 16 },
        volume: { type: "number", minimum: 0, maximum: 1 },
        muted: booleanSchema,
        presenterViewId: opaqueId,
      },
      ["viewId", "expectedPlaybackRevision", "action"],
      {
        allOf: [
          {
            if: { properties: { action: { const: "seek" } } },
            then: { required: ["frame"] },
          },
          {
            if: { properties: { action: { const: "set-rate" } } },
            then: { required: ["rate"] },
          },
          {
            if: {
              properties: { action: { const: "set-master-volume" } },
            },
            then: { required: ["volume"] },
          },
          {
            if: {
              properties: { action: { const: "set-master-mute" } },
            },
            then: { required: ["muted"] },
          },
          {
            if: { properties: { action: { const: "follow" } } },
            then: { required: ["presenterViewId"] },
          },
        ],
      },
    ),
    annotations("Control playback", {
      readOnlyHint: false,
    }),
    true,
  ),
  tool(
    "waptions_diagnostics_get",
    "Get runtime diagnostics",
    "Return bounded current/peak memory, cache, decoder, job, coordinator, cancellation, eviction, late-disposal, and leak-assertion descriptors.",
    sessionReadInput({
      include: arraySchema(
        enumSchema([
          "memory",
          "cache",
          "decoders",
          "jobs",
          "coordinator",
          "leaks",
        ]),
        { maxItems: 6, uniqueItems: true },
      ),
    }),
    annotations("Get runtime diagnostics"),
    false,
  ),
  tool(
    "waptions_editor_render",
    "Open Waptions editor",
    "Attach the immutable MCP App to a managed session/view and issue only short-lived host-only UI capabilities. This is the only tool that attaches UI metadata.",
    mutationInput(
      {
        viewId: opaqueId,
        presentation: enumSchema(["inline", "fullscreen", "pip"]),
        createView: booleanSchema,
      },
      ["presentation", "createView"],
      {
        allOf: [
          {
            if: { properties: { createView: { const: false } } },
            then: { required: ["viewId"] },
          },
        ],
      },
    ),
    annotations("Open Waptions editor", {
      readOnlyHint: false,
      openWorldHint: true,
    }),
    true,
  ),
];

const knownNames = new Set(toolContractsWithoutApp.map(({ name }) => name));
if (
  toolContractsWithoutApp.length !== TOOL_NAMES.length ||
  TOOL_NAMES.some((name) => !knownNames.has(name))
) {
  throw new Error("The MCP tool catalog must contain every planned tool once.");
}

export function createToolCatalog(
  appResourceUri: string,
  semanticSchemas: CoreSemanticSchemaBundle,
): ToolContract[] {
  assertCoreSemanticSchemaBundle(semanticSchemas);
  return toolContractsWithoutApp.map((contract) =>
    contract.name === "waptions_editor_render"
      ? {
          ...contract,
          _meta: {
            ui: {
              resourceUri: appResourceUri,
              visibility: ["model", "app"],
            },
          },
        }
      : contract.name === "waptions_edit_plan" ||
          contract.name === "waptions_edit_apply"
        ? replaceOperationSchema(contract, semanticSchemas.editOperationSchema)
        : contract,
  );
}

function replaceOperationSchema(
  contract: ToolContract,
  editOperationSchema: JsonSchema,
): ToolContract {
  const inputSchema = structuredClone(contract.inputSchema);
  const properties = inputSchema.properties as
    | Record<string, JsonSchema>
    | undefined;
  const operations = properties?.operations;
  if (!operations) {
    throw new Error(`${contract.name} is missing its operations collection.`);
  }
  operations.items = editOperationSchema;
  return { ...contract, inputSchema };
}

export function getToolContract(
  catalog: readonly ToolContract[],
  name: string,
): ToolContract | undefined {
  return catalog.find((contract) => contract.name === name);
}
