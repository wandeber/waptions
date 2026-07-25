import { createHash } from "node:crypto";

import { WAPTIONS_API_VERSION } from "./constants.js";
import { canonicalizeJson } from "./canonical-json.js";
import type { JsonValue } from "./contracts.js";
import type { JsonSchema } from "./json-schema.js";

export const CORE_OPERATION_COUNT = 65;

export interface CoreSemanticSchemaBundle {
  apiVersion: typeof WAPTIONS_API_VERSION;
  editOperationSchema: JsonSchema;
  operationTypes: readonly string[];
  schemaSha256: `sha256:${string}`;
}

export function computeCoreSemanticSchemaSha256(
  schema: JsonSchema,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(schema as JsonValue), "utf8")
    .digest("hex")}`;
}

/**
 * Validate the Core-owned semantic schema at the MCP integration boundary.
 * This module does not define operation fields or mutation behavior; it only
 * prevents the public tool catalog from registering a missing, open, or
 * misidentified Core contract.
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
    bundle.operationTypes.length === 0 ||
    new Set(bundle.operationTypes).size !== bundle.operationTypes.length
  ) {
    throw new Error("Core semantic operation schema bundle is incomplete.");
  }
  const variants = bundle.editOperationSchema.oneOf;
  if (
    !Array.isArray(variants) ||
    variants.length !== CORE_OPERATION_COUNT ||
    bundle.operationTypes.length !== CORE_OPERATION_COUNT
  ) {
    throw new Error(
      "Core semantic operation schema does not expose the complete closed operation union.",
    );
  }
  const discriminators = variants.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("Core semantic operation variant is invalid.");
    }
    const variant = candidate as Record<string, unknown>;
    const properties = variant.properties as
      | Record<string, unknown>
      | undefined;
    const typeSchema = properties?.type as
      | Record<string, unknown>
      | undefined;
    const required = variant.required;
    if (
      variant.type !== "object" ||
      variant.additionalProperties !== false ||
      !Array.isArray(required) ||
      !required.includes("operationId") ||
      !required.includes("type") ||
      typeof typeSchema?.const !== "string"
    ) {
      throw new Error(
        "Core semantic operation variants must be closed objects with operationId and a constant type discriminator.",
      );
    }
    return typeSchema.const;
  });
  const discriminatorSet = new Set(discriminators);
  const declaredTypes = new Set(bundle.operationTypes);
  if (
    discriminatorSet.size !== CORE_OPERATION_COUNT ||
    declaredTypes.size !== CORE_OPERATION_COUNT ||
    discriminators.some((type) => !declaredTypes.has(type)) ||
    bundle.operationTypes.some((type) => !discriminatorSet.has(type))
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
}
