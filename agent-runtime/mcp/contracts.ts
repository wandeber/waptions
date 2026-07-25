import type {
  StableErrorCode,
  WaptionsToolName,
} from "./constants.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface StateToken {
  sessionId: string;
  projectId: string;
  sessionEpoch: string;
  sessionRevision: number;
  documentRevision: number;
  audioGraphRevision: number;
  narrativeRevision?: number;
  eventCursor: string;
}

export interface ToolWarning {
  code: string;
  message: string;
  operationId?: string;
}

export interface ToolError {
  code: StableErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export interface CoordinatorSuccess {
  ok: true;
  data: JsonObject;
  /** Global session discovery has no single authoritative state token. */
  state?: StateToken;
  /** State stored with the original durable receipt, when replayed. */
  committedState?: StateToken;
  warnings?: ToolWarning[];
  /**
   * Mutations replaying an epoch-independent durable receipt set this flag.
   * The dispatcher projects it to the Core-owned top-level `replayed` field.
   */
  replayed?: boolean;
  /**
   * Host-only metadata may contain an expiring editor bridge capability.
   * The dispatcher accepts it only from `waptions_editor_render` and never
   * copies it into structuredContent, fallback text, events, or model context.
   */
  privateMeta?: JsonObject;
}

export interface CoordinatorFailure {
  ok: false;
  error: ToolError;
  state?: StateToken;
}

export type CoordinatorResult = CoordinatorSuccess | CoordinatorFailure;

export interface ToolSuccess {
  ok: true;
  data: JsonObject;
  state?: StateToken;
  committedState?: StateToken;
  warnings: ToolWarning[];
  replayed: boolean;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
  state?: StateToken;
}

export type StructuredToolResult = ToolSuccess | ToolFailure;

export interface CanonicalToolCall {
  toolName: WaptionsToolName;
  request: JsonObject;
  canonicalRequest: string;
  requestHash: `sha256:${string}`;
}

export interface MutationIdentity {
  sessionId?: string;
  sessionEpoch?: string;
  idempotencyKey: string;
  expected?: {
    sessionRevision: number;
    documentRevision: number;
    audioGraphRevision?: number;
    narrativeRevision?: number;
  };
}

export interface ReadToolCall extends CanonicalToolCall {
  mutation: false;
}

export interface MutationToolCall extends CanonicalToolCall {
  mutation: true;
  identity: MutationIdentity;
}

export interface DurableReceiptScope {
  projectId: string;
  toolName: WaptionsToolName;
  idempotencyKey: string;
}

export type DurableReceiptScopeResolution =
  | {
      ok: true;
      scope: DurableReceiptScope;
    }
  | CoordinatorFailure;

export interface ScopedMutationToolCall extends MutationToolCall {
  receiptScope: DurableReceiptScope;
}

export type CoordinatorToolCall = ReadToolCall | MutationToolCall;

export interface ToolCallPresentation {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent: StructuredToolResult;
  isError?: boolean;
  _meta?: JsonObject;
}

export interface JobDescriptor {
  jobId: string;
  kind: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "stale"
    | "interrupted";
  sequence: number;
  createdAt: string;
  updatedAt: string;
  stage?: string;
  fraction?: number;
  message?: string;
  artifactIds?: string[];
  error?: ToolError;
}

export interface ArtifactDescriptor {
  artifactId: string;
  kind: string;
  byteLength: number;
  sha256: `sha256:${string}`;
  createdAt: string;
  expiresAt?: string;
  localPath?: string;
}

export interface EventDescriptor {
  cursor: string;
  type:
    | "session.recovered"
    | "project.snapshot"
    | "project.mutated"
    | "history.changed"
    | "job.changed"
    | "artifact.created"
    | "diagnostics.changed"
    | "presence.changed"
    | "view.changed"
    | "source.invalidated";
  occurredAt: string;
  state: StateToken;
  summary: JsonObject;
}
