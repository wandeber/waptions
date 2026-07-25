import { createHash } from "node:crypto";

import {
  TOOL_NAMES,
  WAPTIONS_API_VERSION,
  type WaptionsToolName,
} from "./constants.js";
import { canonicalizeJson } from "./canonical-json.js";
import type { JsonValue } from "./contracts.js";
import type { JsonSchema } from "./json-schema.js";

export const CORE_OPERATION_COUNT = 65;
export const CORE_OPERATION_CASE_COUNT = 63;

export interface CoreToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface CoreToolSchemaContract {
  name: WaptionsToolName;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: CoreToolAnnotations;
  mutation: boolean;
}

export interface CoreSemanticSchemaBundle {
  apiVersion: typeof WAPTIONS_API_VERSION;
  editOperationSchema: JsonSchema;
  operationTypes: readonly string[];
  schemaSha256: `sha256:${string}`;
  toolNames: readonly WaptionsToolName[];
  toolSchemas: Readonly<Record<WaptionsToolName, CoreToolSchemaContract>>;
  toolSchemasSha256: `sha256:${string}`;
}

function sha256(value: JsonValue): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(value), "utf8")
    .digest("hex")}`;
}

export function computeCoreSemanticSchemaSha256(
  schema: JsonSchema,
): `sha256:${string}` {
  return sha256(schema as JsonValue);
}

export function computeCoreToolSchemasSha256(
  toolSchemas: CoreSemanticSchemaBundle["toolSchemas"],
): `sha256:${string}` {
  return sha256(toolSchemas as unknown as JsonValue);
}

function asSchemaRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function localDefinition(
  schema: Record<string, unknown>,
  ref: unknown,
): Record<string, unknown> {
  if (typeof ref !== "string") {
    throw new Error("Core semantic operation payload must use a local $ref.");
  }
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (!match) {
    throw new Error(
      "Core semantic schema bundle contains an unresolved external $ref.",
    );
  }
  const definitions = asSchemaRecord(
    schema.$defs,
    "Core semantic schema bundle is missing its local definitions.",
  );
  return asSchemaRecord(
    definitions[match[1]],
    `Core semantic schema bundle is missing definition ${match[1]}.`,
  );
}

function assertLocalReferences(schema: Record<string, unknown>): void {
  const definitions = asSchemaRecord(
    schema.$defs,
    "Core self-contained schema is missing its local definitions.",
  );
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        if (typeof child !== "string") {
          throw new Error("Core schema $ref values must be strings.");
        }
        const match = /^#\/\$defs\/([^/]+)$/.exec(child);
        if (!match) {
          throw new Error(
            "Core semantic schema bundle contains an unresolved external $ref.",
          );
        }
        if (!Object.hasOwn(definitions, match[1])) {
          throw new Error(
            `Core semantic schema bundle is missing definition ${match[1]}.`,
          );
        }
      }
      visit(child);
    }
  };
  visit(schema);
}

function containsLocalRef(value: unknown, expectedRef: string): boolean {
  if (Array.isArray(value)) {
    return value.some((child) => containsLocalRef(child, expectedRef));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && child === expectedRef) {
      return true;
    }
    if (containsLocalRef(child, expectedRef)) {
      return true;
    }
  }
  return false;
}

function closesPayloadObject(
  schema: Record<string, unknown>,
  candidate: Record<string, unknown>,
  seen: Set<Record<string, unknown>>,
): boolean {
  if (seen.has(candidate)) {
    return false;
  }
  seen.add(candidate);

  if (candidate.$ref !== undefined) {
    return closesPayloadObject(
      schema,
      localDefinition(schema, candidate.$ref),
      seen,
    );
  }
  if (
    candidate.additionalProperties === false ||
    candidate.unevaluatedProperties === false
  ) {
    return true;
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = candidate[keyword];
    if (
      Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every((branch) =>
        closesPayloadObject(
          schema,
          asSchemaRecord(
            branch,
            "Core semantic payload union contains an invalid branch.",
          ),
          new Set(seen),
        ),
      )
    ) {
      return true;
    }
  }
  const allOf = candidate.allOf;
  return (
    Array.isArray(allOf) &&
    allOf.some((branch) =>
      closesPayloadObject(
        schema,
        asSchemaRecord(
          branch,
          "Core semantic payload composition contains an invalid branch.",
        ),
        new Set(seen),
      ),
    )
  );
}

/**
 * Extract the authoritative operation inventory from Core's closed
 * `{ operationId, type, payload }` wrapper. Core intentionally has 63
 * discriminated cases because two cases each cover two equivalent operation
 * types with an enum.
 */
export function extractCoreOperationTypes(schema: JsonSchema): string[] {
  const root = asSchemaRecord(
    schema,
    "Core semantic operation schema must be an object.",
  );
  assertLocalReferences(root);

  const properties = asSchemaRecord(
    root.properties,
    "Core semantic operation wrapper is missing properties.",
  );
  const required = root.required;
  const propertyNames = Object.keys(properties);
  const typeProperty = asSchemaRecord(
    properties.type,
    "Core semantic operation wrapper is missing its type discriminator.",
  );
  const payloadProperty = asSchemaRecord(
    properties.payload,
    "Core semantic operation wrapper is missing its payload property.",
  );
  const wrapperTypes = typeProperty.enum;
  if (
    root.type !== "object" ||
    root.additionalProperties !== false ||
    !Array.isArray(required) ||
    required.length !== 3 ||
    !["operationId", "type", "payload"].every((name) =>
      required.includes(name),
    ) ||
    propertyNames.length !== 3 ||
    !["operationId", "type", "payload"].every((name) =>
      propertyNames.includes(name),
    ) ||
    properties.operationId === undefined ||
    payloadProperty.type !== "object" ||
    !Array.isArray(wrapperTypes) ||
    wrapperTypes.length !== CORE_OPERATION_COUNT ||
    wrapperTypes.some((type) => typeof type !== "string") ||
    new Set(wrapperTypes).size !== CORE_OPERATION_COUNT
  ) {
    throw new Error(
      "Core semantic operation schema must expose the closed operationId/type/payload wrapper.",
    );
  }

  const allOf = root.allOf;
  const discriminatedUnion =
    Array.isArray(allOf) && allOf.length === 1
      ? asSchemaRecord(
          allOf[0],
          "Core semantic operation wrapper has an invalid discriminator composition.",
        )
      : undefined;
  const cases = discriminatedUnion?.oneOf;
  if (
    !Array.isArray(cases) ||
    cases.length !== CORE_OPERATION_CASE_COUNT
  ) {
    throw new Error(
      "Core semantic operation schema does not expose the complete closed operation union.",
    );
  }

  const discriminators: string[] = [];
  let enumCaseCount = 0;
  for (const candidate of cases) {
    const operationCase = asSchemaRecord(
      candidate,
      "Core semantic operation case is invalid.",
    );
    const caseProperties = asSchemaRecord(
      operationCase.properties,
      "Core semantic operation case is missing properties.",
    );
    const caseType = asSchemaRecord(
      caseProperties.type,
      "Core semantic operation case is missing its discriminator.",
    );
    const enumValues = caseType.enum;
    const hasConst = typeof caseType.const === "string";
    const hasEnum = Array.isArray(enumValues);
    const enumTypes =
      Array.isArray(enumValues) &&
      enumValues.length === 2 &&
      enumValues.every((type) => typeof type === "string")
        ? (enumValues as string[])
        : undefined;
    const caseTypes =
      hasConst !== hasEnum
        ? hasConst
          ? [caseType.const as string]
          : enumTypes
        : undefined;
    if (!caseTypes) {
      throw new Error(
        "Core semantic operation case must use a string const or enum discriminator.",
      );
    }
    if (hasEnum) {
      enumCaseCount += 1;
    }
    const payload = asSchemaRecord(
      caseProperties.payload,
      "Core semantic operation case is missing its payload schema.",
    );
    const payloadDefinition = localDefinition(root, payload.$ref);
    if (!closesPayloadObject(root, payloadDefinition, new Set())) {
      throw new Error(
        "Core semantic operation payload definitions must be closed.",
      );
    }
    discriminators.push(...caseTypes);
  }

  const discriminatorSet = new Set(discriminators);
  if (
    discriminators.length !== CORE_OPERATION_COUNT ||
    discriminatorSet.size !== CORE_OPERATION_COUNT ||
    enumCaseCount !== 2 ||
    (wrapperTypes as string[]).some((type) => !discriminatorSet.has(type))
  ) {
    throw new Error(
      "Core semantic operation inventory does not match its closed schema union.",
    );
  }
  return [...(wrapperTypes as string[])];
}

/**
 * Validate the Core-owned schemas at the MCP integration boundary. This module
 * never defines operation payloads or public tool data; it only verifies the
 * deterministic self-contained projection built from Core's committed JSON.
 */
export function assertCoreSemanticSchemaBundle(
  bundle: CoreSemanticSchemaBundle,
): void {
  if (bundle.apiVersion !== WAPTIONS_API_VERSION) {
    throw new Error("Core semantic schema apiVersion does not match MCP.");
  }
  if (
    typeof bundle.editOperationSchema !== "object" ||
    bundle.editOperationSchema === null ||
    !Array.isArray(bundle.operationTypes) ||
    bundle.operationTypes.length !== CORE_OPERATION_COUNT ||
    new Set(bundle.operationTypes).size !== CORE_OPERATION_COUNT
  ) {
    throw new Error("Core semantic operation schema bundle is incomplete.");
  }

  const discriminators = extractCoreOperationTypes(
    bundle.editOperationSchema,
  );
  if (
    discriminators.some(
      (type, index) => bundle.operationTypes[index] !== type,
    )
  ) {
    throw new Error(
      "Core semantic operation inventory does not match its closed schema union.",
    );
  }
  if (
    computeCoreSemanticSchemaSha256(bundle.editOperationSchema) !==
    bundle.schemaSha256
  ) {
    throw new Error("Core semantic operation schema hash does not match.");
  }

  const toolNames = Object.keys(bundle.toolSchemas);
  if (
    !Array.isArray(bundle.toolNames) ||
    bundle.toolNames.length !== TOOL_NAMES.length ||
    toolNames.length !== TOOL_NAMES.length ||
    new Set(bundle.toolNames).size !== TOOL_NAMES.length ||
    TOOL_NAMES.some(
      (name, index) =>
        bundle.toolNames[index] !== name ||
        !Object.hasOwn(bundle.toolSchemas, name) ||
        bundle.toolSchemas[name].name !== name,
    )
  ) {
    throw new Error(
      "Core public tool schema inventory does not match the MCP catalog.",
    );
  }
  for (const name of TOOL_NAMES) {
    const contract = bundle.toolSchemas[name];
    const annotationKeys = [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ] as const;
    if (
      typeof contract.description !== "string" ||
      contract.description.length === 0 ||
      typeof contract.inputSchema !== "object" ||
      contract.inputSchema === null ||
      typeof contract.outputSchema !== "object" ||
      contract.outputSchema === null ||
      typeof contract.annotations !== "object" ||
      contract.annotations === null ||
      Object.keys(contract.annotations).length !== annotationKeys.length ||
      annotationKeys.some(
        (key) => typeof contract.annotations[key] !== "boolean",
      )
    ) {
      throw new Error(`Core public tool schema ${name} is incomplete.`);
    }
    const inputSchema = asSchemaRecord(
      contract.inputSchema,
      `Core public tool input schema ${name} is invalid.`,
    );
    const outputSchema = asSchemaRecord(
      contract.outputSchema,
      `Core public tool output schema ${name} is invalid.`,
    );
    if (
      inputSchema.type !== "object" ||
      outputSchema.type !== "object"
    ) {
      throw new Error(
        `Core public tool schema ${name} must expose MCP object roots.`,
      );
    }
    assertLocalReferences(inputSchema);
    assertLocalReferences(outputSchema);
    const expectedMutation =
      name === "waptions_session_open" ||
      containsLocalRef(
        inputSchema,
        "#/$defs/Tools__MutationBase",
      );
    if (contract.mutation !== expectedMutation) {
      throw new Error(
        `Core public tool schema ${name} has an invalid mutation classification.`,
      );
    }
  }
  if (
    computeCoreToolSchemasSha256(bundle.toolSchemas) !==
    bundle.toolSchemasSha256
  ) {
    throw new Error("Core public tool schema hash does not match.");
  }
}
