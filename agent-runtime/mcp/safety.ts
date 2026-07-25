import { Buffer } from "node:buffer";

import {
  MAX_ERROR_DETAIL_ITEMS,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_PRIVATE_META_BYTES,
  MAX_STRUCTURED_OUTPUT_BYTES,
} from "./constants.js";
import type {
  CoordinatorResult,
  JsonObject,
  JsonValue,
  ToolError,
} from "./contracts.js";

const SENSITIVE_KEY =
  /(?:api[_-]?key|authorization|cookie|credential|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|capability[_-]?token|pairing[_-]?capability|signed[_-]?url|transcript[_-]?(?:body|text)|full[_-]?transcript|provider[_-]?(?:response|body)|raw[_-]?endpoint[_-]?response|(?:media|artifact|source)[_-]?bytes|binary[_-]?data|base64[_-]?data)/i;
const SENSITIVE_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{12,})/i;
const HOST_SECRET_KEY =
  /^(?:capabilityToken|pairingCapability|signedUrl|resourceUrl)$/;

export class UnsafeCoordinatorPayloadError extends Error {}

function assertSafeJson(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth: number,
  allowHostSecrets = false,
): asserts value is JsonValue {
  if (depth > 32) {
    throw new UnsafeCoordinatorPayloadError(
      `Coordinator payload exceeds the maximum nesting depth at ${path}.`,
    );
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (typeof value === "string") {
    const key = path.slice(path.lastIndexOf(".") + 1);
    if (
      SENSITIVE_VALUE.test(value) &&
      !(allowHostSecrets && HOST_SECRET_KEY.test(key))
    ) {
      throw new UnsafeCoordinatorPayloadError(
        `Coordinator payload contains a secret-like value at ${path}.`,
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new UnsafeCoordinatorPayloadError(
        `Coordinator payload contains a cycle at ${path}.`,
      );
    }
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) {
      assertSafeJson(
        value[index],
        `${path}[${index}]`,
        seen,
        depth + 1,
        allowHostSecrets,
      );
    }
    seen.delete(value);
    return;
  }

  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) {
      throw new UnsafeCoordinatorPayloadError(
        `Coordinator payload contains a cycle at ${path}.`,
      );
    }
    seen.add(objectValue);
    for (const [key, item] of Object.entries(objectValue)) {
      if (
        SENSITIVE_KEY.test(key) &&
        !(allowHostSecrets && HOST_SECRET_KEY.test(key))
      ) {
        throw new UnsafeCoordinatorPayloadError(
          `Coordinator payload contains a forbidden secret field at ${path}.${key}.`,
        );
      }
      assertSafeJson(
        item,
        `${path}.${key}`,
        seen,
        depth + 1,
        allowHostSecrets,
      );
    }
    seen.delete(objectValue);
    return;
  }

  throw new UnsafeCoordinatorPayloadError(
    `Coordinator payload contains non-JSON data at ${path}.`,
  );
}

export function assertSafeCoordinatorResult(
  result: CoordinatorResult,
): asserts result is CoordinatorResult {
  const publicResult = result.ok
    ? {
        ok: true,
        data: result.data,
        state: result.state,
        warnings: result.warnings ?? [],
      }
    : {
        ok: false,
        error: result.error,
        ...(result.state ? { state: result.state } : {}),
      };
  assertSafeJson(publicResult, "$", new Set(), 0);

  const outputBytes = Buffer.byteLength(
    JSON.stringify(publicResult),
    "utf8",
  );
  if (outputBytes > MAX_STRUCTURED_OUTPUT_BYTES) {
    throw new UnsafeCoordinatorPayloadError(
      `Structured output is ${outputBytes} bytes; the maximum is ${MAX_STRUCTURED_OUTPUT_BYTES}.`,
    );
  }

  if (result.ok && result.privateMeta) {
    assertSafeJson(result.privateMeta, "$._meta", new Set(), 0, true);
    const privateBytes = Buffer.byteLength(
      JSON.stringify(result.privateMeta),
      "utf8",
    );
    if (privateBytes > MAX_PRIVATE_META_BYTES) {
      throw new UnsafeCoordinatorPayloadError(
        `Private result metadata is ${privateBytes} bytes; the maximum is ${MAX_PRIVATE_META_BYTES}.`,
      );
    }
  }
}

export function boundToolError(error: ToolError): ToolError {
  const message =
    error.message.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
      : error.message;

  if (!error.details) {
    return { ...error, message };
  }

  const details = Object.fromEntries(
    Object.entries(error.details).slice(0, MAX_ERROR_DETAIL_ITEMS),
  ) as JsonObject;

  return { ...error, message, details };
}
