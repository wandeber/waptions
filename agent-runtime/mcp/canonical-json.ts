import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "./contracts.js";

function canonicalizeValue(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("Canonical JSON does not support cyclic arrays.");
    }
    seen.add(value);
    const serialized = `[${value
      .map((item) => canonicalizeValue(item, seen))
      .join(",")}]`;
    seen.delete(value);
    return serialized;
  }

  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) {
      throw new TypeError("Canonical JSON does not support cyclic objects.");
    }
    seen.add(objectValue);
    const entries = Object.keys(objectValue)
      .sort()
      .map((key) => {
        const child = objectValue[key];
        if (child === undefined) {
          throw new TypeError("Canonical JSON does not support undefined values.");
        }
        return `${JSON.stringify(key)}:${canonicalizeValue(child, seen)}`;
      });
    seen.delete(objectValue);
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(
    `Canonical JSON does not support values of type ${typeof value}.`,
  );
}

export function canonicalizeJson(value: JsonValue): string {
  return canonicalizeValue(value, new Set());
}

export function canonicalRequestHash(
  request: JsonObject,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(request), "utf8")
    .digest("hex")}`;
}
