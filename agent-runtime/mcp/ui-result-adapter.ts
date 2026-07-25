import type {
  JsonObject,
  StateToken,
  StructuredToolResult,
  ToolWarning,
} from "./contracts.js";

export interface UiToolSuccess {
  ok: true;
  data: JsonObject;
  state: StateToken;
  warnings: ToolWarning[];
}

export interface UiToolFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  state?: StateToken;
}

export type UiToolResult = UiToolSuccess | UiToolFailure;

/**
 * The UI consumes the same authoritative public envelope as the model. Private
 * MCP result metadata is handled by the host bridge and is intentionally not
 * accepted here, which prevents capabilities and signed URLs from entering UI
 * state, event summaries, or model context accidentally.
 */
export function toUiToolResult(
  result: StructuredToolResult,
): UiToolResult {
  if (result.ok) {
    return {
      ok: true,
      data: result.data,
      state: result.state,
      warnings: result.warnings,
    };
  }
  return {
    ok: false,
    code: result.error.code,
    message: result.error.message,
    retryable: result.error.retryable,
    ...(result.state ? { state: result.state } : {}),
  };
}

export interface UiModelContextInput {
  projectName: string;
  selection: Array<{ id: string; type: string }>;
  timecode: string;
  state: StateToken;
  activeJobs: Array<{ jobId: string; kind: string; state: string }>;
  recentSemanticAction?: string;
}

export function createBoundedUiModelContext(
  input: UiModelContextInput,
): JsonObject {
  return {
    projectName: input.projectName.slice(0, 256),
    selection: input.selection.slice(0, 100).map((selection) => ({
      id: selection.id.slice(0, 256),
      type: selection.type.slice(0, 128),
    })),
    timecode: input.timecode.slice(0, 64),
    revisions: {
      sessionRevision: input.state.sessionRevision,
      documentRevision: input.state.documentRevision,
      audioGraphRevision: input.state.audioGraphRevision,
      ...(input.state.narrativeRevision !== undefined
        ? { narrativeRevision: input.state.narrativeRevision }
        : {}),
    },
    activeJobs: input.activeJobs.slice(0, 50).map((job) => ({
      jobId: job.jobId.slice(0, 256),
      kind: job.kind.slice(0, 128),
      state: job.state.slice(0, 64),
    })),
    ...(input.recentSemanticAction
      ? {
          recentSemanticAction: input.recentSemanticAction.slice(0, 512),
        }
      : {}),
  };
}
