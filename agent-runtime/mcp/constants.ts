export const WAPTIONS_API_VERSION = "2026-07-25" as const;

export const MCP_SERVER_NAME = "waptions";
export const MCP_SERVER_VERSION = "2026.7.25";

export const MAX_STRUCTURED_INPUT_BYTES = 512 * 1024;
export const MAX_STRUCTURED_OUTPUT_BYTES = 1024 * 1024;
export const MAX_PRIVATE_META_BYTES = 64 * 1024;
export const DEFAULT_PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 500;
export const MAX_COMPOUND_OPERATIONS = 256;
export const MAX_ERROR_MESSAGE_LENGTH = 512;
export const MAX_ERROR_DETAIL_ITEMS = 50;

export const TOOL_NAMES = [
  "waptions_session_list",
  "waptions_session_open",
  "waptions_session_manage",
  "waptions_path_grant",
  "waptions_project_get",
  "waptions_project_import",
  "waptions_project_validate",
  "waptions_media_probe",
  "waptions_media_import",
  "waptions_media_review",
  "waptions_media_release",
  "waptions_timeline_query",
  "waptions_edit_plan",
  "waptions_edit_apply",
  "waptions_history_get",
  "waptions_history_apply",
  "waptions_transcription_start",
  "waptions_job_list",
  "waptions_job_get",
  "waptions_job_cancel",
  "waptions_export_start",
  "waptions_artifact_list",
  "waptions_artifact_get",
  "waptions_events_read",
  "waptions_view_get",
  "waptions_view_update",
  "waptions_playback_control",
  "waptions_diagnostics_get",
  "waptions_editor_render",
] as const;

export type WaptionsToolName = (typeof TOOL_NAMES)[number];

export const STABLE_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_API_VERSION",
  "PAYLOAD_TOO_LARGE",
  "SESSION_NOT_FOUND",
  "SESSION_EPOCH_MISMATCH",
  "SESSION_REVISION_CONFLICT",
  "REVISION_CONFLICT",
  "NARRATIVE_REVISION_CONFLICT",
  "AUDIO_REVISION_CONFLICT",
  "IDEMPOTENCY_KEY_CONFLICT",
  "PLAN_NOT_FOUND",
  "PLAN_EXPIRED",
  "PLAN_INPUT_CHANGED",
  "NOT_FOUND",
  "INVALID_DOCUMENT",
  "INVALID_OPERATION",
  "OVERLAP_CONFLICT",
  "LOCKED_TARGET",
  "ORDER_NOT_MEANINGFUL",
  "SOURCE_CHANGED",
  "SOURCE_UNREADABLE",
  "PATH_NOT_GRANTED",
  "WRITE_DESTINATION_NOT_GRANTED",
  "OVERWRITE_NOT_AUTHORIZED",
  "PATH_IDENTITY_CHANGED",
  "UNSUPPORTED_MEDIA",
  "NO_AUDIO",
  "CODEC_UNAVAILABLE",
  "TRANSCRIPTION_POLICY_REJECTED",
  "TRANSCRIPTION_ENDPOINT_UNREACHABLE",
  "SSRF_POLICY_REJECTED",
  "JOB_NOT_CANCELLABLE",
  "EVENT_CURSOR_EXPIRED",
  "ARTIFACT_EXPIRED",
  "CAPABILITY_EXPIRED",
  "RESOURCE_LIMIT_EXCEEDED",
  "COORDINATOR_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

export const EVENT_RESOURCE_URI_TEMPLATE =
  "waptions://sessions/{sessionId}/events";
