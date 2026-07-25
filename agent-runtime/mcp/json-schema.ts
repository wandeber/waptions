export interface JsonSchema {
  [key: string]: unknown;
}

export const nonEmptyString: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
};

export const opaqueId: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
};

export const opaqueIdOrAlias: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^(?:[^$].*|\\$[A-Za-z][A-Za-z0-9_-]*\\.[A-Za-z][A-Za-z0-9_-]*)$",
};

export const nonNegativeInteger: JsonSchema = {
  type: "integer",
  minimum: 0,
};

export const positiveInteger: JsonSchema = {
  type: "integer",
  minimum: 1,
};

export const finiteNumber: JsonSchema = {
  type: "number",
};

export function enumSchema(values: readonly string[]): JsonSchema {
  return { type: "string", enum: [...values] };
}

export function arraySchema(
  items: JsonSchema,
  options: { minItems?: number; maxItems?: number; uniqueItems?: boolean } = {},
): JsonSchema {
  return {
    type: "array",
    items,
    ...options,
  };
}

export function strictObject(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  extra: Record<string, unknown> = {},
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    ...extra,
  };
}

export function withCommonProperties(
  base: JsonSchema,
  additional: Record<string, JsonSchema>,
  additionallyRequired: readonly string[] = [],
): JsonSchema {
  const properties = (base.properties ?? {}) as Record<string, JsonSchema>;
  const required = (base.required ?? []) as string[];
  return strictObject(
    { ...properties, ...additional },
    [...required, ...additionallyRequired],
  );
}
