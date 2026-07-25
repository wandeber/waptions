import type {
  ErrorObject,
  ValidateFunction,
} from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  MAX_ERROR_DETAIL_ITEMS,
  MAX_STRUCTURED_INPUT_BYTES,
  WAPTIONS_API_VERSION,
} from "./constants.js";
import type { JsonObject } from "./contracts.js";
import type { JsonSchema } from "./json-schema.js";

export type ValidationResult =
  | { valid: true; value: JsonObject }
  | {
      valid: false;
      code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_API_VERSION";
      message: string;
      details?: JsonObject;
    };

function boundedIssues(errors: ErrorObject[] | null | undefined): JsonObject {
  const issues = (errors ?? [])
    .slice(0, MAX_ERROR_DETAIL_ITEMS)
    .map((error) => ({
      path: error.instancePath || "/",
      code: error.keyword,
      message: error.message ?? "Schema validation failed.",
    }));
  return {
    issues,
  };
}

export class ToolSchemaValidator {
  private readonly ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  private readonly validators = new Map<string, ValidateFunction>();

  register(name: string, schema: JsonSchema): void {
    this.validators.set(name, this.ajv.compile(schema));
  }

  validateInput(name: string, value: unknown): ValidationResult {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return {
        valid: false,
        code: "INVALID_REQUEST",
        message: "Tool input must be finite, acyclic JSON.",
      };
    }
    if (typeof serialized !== "string") {
      return {
        valid: false,
        code: "INVALID_REQUEST",
        message: "Tool input must be finite, acyclic JSON.",
      };
    }

    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_STRUCTURED_INPUT_BYTES) {
      return {
        valid: false,
        code: "PAYLOAD_TOO_LARGE",
        message: `Structured input exceeds the ${MAX_STRUCTURED_INPUT_BYTES}-byte limit.`,
        details: {
          limitBytes: MAX_STRUCTURED_INPUT_BYTES,
        },
      };
    }

    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return {
        valid: false,
        code: "INVALID_REQUEST",
        message: "Tool input must be a JSON object.",
      };
    }

    const input = value as Record<string, unknown>;
    if (input.apiVersion !== WAPTIONS_API_VERSION) {
      return {
        valid: false,
        code: "UNSUPPORTED_API_VERSION",
        message: `apiVersion must be ${WAPTIONS_API_VERSION}.`,
      };
    }

    const validator = this.validators.get(name);
    if (!validator) {
      return {
        valid: false,
        code: "INVALID_REQUEST",
        message: "The requested tool does not have a registered schema.",
      };
    }

    if (!validator(value)) {
      return {
        valid: false,
        code: "INVALID_REQUEST",
        message: "Tool input does not match the closed semantic schema.",
        details: boundedIssues(validator.errors),
      };
    }

    return { valid: true, value: value as JsonObject };
  }

  validateOutput(schema: JsonSchema, value: unknown): boolean {
    return this.ajv.compile(schema)(value) as boolean;
  }
}
