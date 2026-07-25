import type {
  CanonicalToolCall,
  CoordinatorResult,
} from "../mcp/contracts.js";
import type { WaptionsToolName } from "../mcp/constants.js";
import type { CoordinatorCallContext } from "../server/coordinator-adapter.js";

export type CanonicalToolHandler = (
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
) => Promise<CoordinatorResult>;

export interface CanonicalToolRouterDependencies {
  readonly handlers: Readonly<
    Record<WaptionsToolName, CanonicalToolHandler>
  >;
}

function assertNever(toolName: never): never {
  throw new Error(`Unhandled canonical tool: ${String(toolName)}`);
}

/**
 * Route an already validated and canonicalized call without changing its
 * request body, canonical representation, request hash, or adapter envelope.
 */
export class CanonicalToolRouter {
  constructor(
    private readonly dependencies: CanonicalToolRouterDependencies,
  ) {}

  route(
    call: CanonicalToolCall,
    context: CoordinatorCallContext,
  ): Promise<CoordinatorResult> {
    switch (call.toolName) {
      case "waptions_session_list":
        return this.dependencies.handlers.waptions_session_list(
          call,
          context,
        );
      case "waptions_session_open":
        return this.dependencies.handlers.waptions_session_open(
          call,
          context,
        );
      case "waptions_session_manage":
        return this.dependencies.handlers.waptions_session_manage(
          call,
          context,
        );
      case "waptions_path_grant":
        return this.dependencies.handlers.waptions_path_grant(
          call,
          context,
        );
      case "waptions_project_get":
        return this.dependencies.handlers.waptions_project_get(
          call,
          context,
        );
      case "waptions_project_import":
        return this.dependencies.handlers.waptions_project_import(
          call,
          context,
        );
      case "waptions_project_validate":
        return this.dependencies.handlers.waptions_project_validate(
          call,
          context,
        );
      case "waptions_media_probe":
        return this.dependencies.handlers.waptions_media_probe(
          call,
          context,
        );
      case "waptions_media_import":
        return this.dependencies.handlers.waptions_media_import(
          call,
          context,
        );
      case "waptions_media_review":
        return this.dependencies.handlers.waptions_media_review(
          call,
          context,
        );
      case "waptions_media_release":
        return this.dependencies.handlers.waptions_media_release(
          call,
          context,
        );
      case "waptions_timeline_query":
        return this.dependencies.handlers.waptions_timeline_query(
          call,
          context,
        );
      case "waptions_edit_plan":
        return this.dependencies.handlers.waptions_edit_plan(
          call,
          context,
        );
      case "waptions_edit_apply":
        return this.dependencies.handlers.waptions_edit_apply(
          call,
          context,
        );
      case "waptions_history_get":
        return this.dependencies.handlers.waptions_history_get(
          call,
          context,
        );
      case "waptions_history_apply":
        return this.dependencies.handlers.waptions_history_apply(
          call,
          context,
        );
      case "waptions_transcription_start":
        return this.dependencies.handlers.waptions_transcription_start(
          call,
          context,
        );
      case "waptions_job_list":
        return this.dependencies.handlers.waptions_job_list(
          call,
          context,
        );
      case "waptions_job_get":
        return this.dependencies.handlers.waptions_job_get(
          call,
          context,
        );
      case "waptions_job_cancel":
        return this.dependencies.handlers.waptions_job_cancel(
          call,
          context,
        );
      case "waptions_export_start":
        return this.dependencies.handlers.waptions_export_start(
          call,
          context,
        );
      case "waptions_artifact_list":
        return this.dependencies.handlers.waptions_artifact_list(
          call,
          context,
        );
      case "waptions_artifact_get":
        return this.dependencies.handlers.waptions_artifact_get(
          call,
          context,
        );
      case "waptions_events_read":
        return this.dependencies.handlers.waptions_events_read(
          call,
          context,
        );
      case "waptions_view_get":
        return this.dependencies.handlers.waptions_view_get(
          call,
          context,
        );
      case "waptions_view_update":
        return this.dependencies.handlers.waptions_view_update(
          call,
          context,
        );
      case "waptions_playback_control":
        return this.dependencies.handlers.waptions_playback_control(
          call,
          context,
        );
      case "waptions_diagnostics_get":
        return this.dependencies.handlers.waptions_diagnostics_get(
          call,
          context,
        );
      case "waptions_editor_render":
        return this.dependencies.handlers.waptions_editor_render(
          call,
          context,
        );
      default:
        return assertNever(call.toolName);
    }
  }
}
