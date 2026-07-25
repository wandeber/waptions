import type {
  CoordinatorResult,
  JsonObject,
  JsonValue,
} from "./contracts.js";

export const RUNTIME_EVENT_TYPES = [
  "session.recovered",
  "project.snapshot",
  "project.changed",
  "project.mutated",
  "history.changed",
  "job.changed",
  "job.completed",
  "job.succeeded",
  "artifact.created",
  "diagnostics.changed",
  "presence.changed",
  "view.changed",
  "source.changed",
  "source.invalidated",
  "grant.changed",
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export const PUBLIC_EVENT_TYPES = [
  "session.recovered",
  "project.snapshot",
  "project.mutated",
  "history.changed",
  "job.changed",
  "artifact.created",
  "diagnostics.changed",
  "presence.changed",
  "view.changed",
  "source.invalidated",
] as const;

export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

export const RUNTIME_JOB_STATES = [
  "pending",
  "queued",
  "active",
  "running",
  "completed",
  "succeeded",
  "error",
  "failed",
  "canceled",
  "cancelled",
  "stale",
  "interrupted",
] as const;

export type RuntimeJobState = (typeof RUNTIME_JOB_STATES)[number];
export type PublicJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale"
  | "interrupted";

export class RuntimeVocabularyError extends Error {}

function assertNever(value: never): never {
  throw new RuntimeVocabularyError(
    `Unmapped runtime vocabulary value: ${String(value)}`,
  );
}

export function mapRuntimeEventType(
  type: RuntimeEventType,
): PublicEventType {
  switch (type) {
    case "session.recovered":
      return "session.recovered";
    case "project.snapshot":
    case "grant.changed":
      return "project.snapshot";
    case "project.changed":
    case "project.mutated":
      return "project.mutated";
    case "history.changed":
      return "history.changed";
    case "job.changed":
    case "job.completed":
    case "job.succeeded":
      return "job.changed";
    case "artifact.created":
      return "artifact.created";
    case "diagnostics.changed":
      return "diagnostics.changed";
    case "presence.changed":
      return "presence.changed";
    case "view.changed":
      return "view.changed";
    case "source.changed":
    case "source.invalidated":
      return "source.invalidated";
    default:
      return assertNever(type);
  }
}

export function mapRuntimeJobState(
  state: RuntimeJobState,
): PublicJobState {
  switch (state) {
    case "pending":
    case "queued":
      return "queued";
    case "active":
    case "running":
      return "running";
    case "completed":
    case "succeeded":
      return "succeeded";
    case "error":
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "stale":
      return "stale";
    case "interrupted":
      return "interrupted";
    default:
      return assertNever(state);
  }
}

function normalizeValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeValue(child)]),
  ) as JsonObject;

  if (
    typeof normalized.jobId === "string" &&
    typeof normalized.state === "string"
  ) {
    if (
      !RUNTIME_JOB_STATES.includes(
        normalized.state as RuntimeJobState,
      )
    ) {
      throw new RuntimeVocabularyError(
        `Unknown runtime job state: ${normalized.state}`,
      );
    }
    normalized.state = mapRuntimeJobState(
      normalized.state as RuntimeJobState,
    );
  }

  if (
    typeof normalized.cursor === "string" &&
    typeof normalized.type === "string"
  ) {
    if (
      !RUNTIME_EVENT_TYPES.includes(
        normalized.type as RuntimeEventType,
      )
    ) {
      throw new RuntimeVocabularyError(
        `Unknown runtime event type: ${normalized.type}`,
      );
    }
    normalized.type = mapRuntimeEventType(
      normalized.type as RuntimeEventType,
    );
  }

  return normalized;
}

/**
 * Runtime internals may use implementation-oriented event/job names. The MCP
 * boundary exposes one frozen public vocabulary and fails closed on an
 * unhandled value instead of leaking or silently relabeling it.
 */
export function normalizeCoordinatorVocabulary(
  result: CoordinatorResult,
): CoordinatorResult {
  if (!result.ok) {
    return result;
  }
  return {
    ...result,
    data: normalizeValue(result.data) as JsonObject,
  };
}
