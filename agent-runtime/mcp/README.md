# Waptions semantic MCP layer

This package exposes the descriptor-first semantic contract from
`WCE-PLAN-2`. It is an adapter over the persistent managed-session coordinator,
not a project store and not a second mutation authority.

## Public contract

Every tool accepts `apiVersion: "2026-07-25"`. Session mutations carry the
current epoch, expected session/document-domain revisions, and an idempotency
key. Successful calls expose exactly:

```json
{
  "ok": true,
  "data": {},
  "state": {
    "sessionId": "opaque",
    "projectId": "opaque",
    "sessionEpoch": "opaque",
    "sessionRevision": 0,
    "documentRevision": 0,
    "audioGraphRevision": 0,
    "narrativeRevision": 0,
    "eventCursor": "opaque"
  },
  "warnings": [],
  "replayed": false
}
```

`structuredContent` is authoritative. `content` is a short fallback and never
contains descriptors, paths, transcripts, bridge capabilities, signed URLs,
provider bodies, or credentials. The Core schema permits `committedState` on
replayed results and defines the global `waptions_session_list` success without
a project state token. The signed-range presentation of
`waptions_artifact_get` is the only structured result containing its
short-lived localhost URL; UI bearer tokens remain host-only MCP result
metadata on `waptions_editor_render`. Each tool has a closed `data` schema; nested
descriptors remain bounded and are rejected if they contain transcript bodies,
raw provider responses, byte bodies, credentials, or bearer capabilities.
`narrativeRevision` is present only for projects with a narrative domain.

The public catalog contains exactly:

- `waptions_session_list`, `waptions_session_open`,
  `waptions_session_manage`, `waptions_path_grant`
- `waptions_project_get`, `waptions_project_import`,
  `waptions_project_validate`
- `waptions_media_probe`, `waptions_media_import`,
  `waptions_media_review`, `waptions_media_release`
- `waptions_timeline_query`, `waptions_edit_plan`, `waptions_edit_apply`
- `waptions_history_get`, `waptions_history_apply`
- `waptions_transcription_start`
- `waptions_job_list`, `waptions_job_get`, `waptions_job_cancel`
- `waptions_export_start`
- `waptions_artifact_list`, `waptions_artifact_get`
- `waptions_events_read`
- `waptions_view_get`, `waptions_view_update`,
  `waptions_playback_control`
- `waptions_diagnostics_get`, `waptions_editor_render`

Only `waptions_editor_render` has `_meta.ui.resourceUri`. Data and mutation
tools never attach a resource, so ordinary tool calls cannot remount the
editor.

## Core and coordinator boundaries

Production MCP code imports Core's committed `common`, `operations`, `session`,
and `tools` schemas plus `tool-registry.json`; it does not define a second
operation or tool contract. The loader extracts
`$defs.EditorSemanticOperation`, preserves the closed
`{ operationId, type, payload }` wrapper, and validates its 63 discriminated
cases as exactly 65 operation types. External schema references are rewritten
to deterministic namespaced local `$defs`, including transitive common
references, before the self-contained schema is hashed.

The same resolver builds each public `ToolInput*` and `ToolOutput*` schema from
`tools.schema.json`, including transitive operation and durable
job/event/artifact definitions from the session schema. Names, descriptions,
and annotations come from `tool-registry.json`. Every standalone schema is
compiled as JSON Schema Draft 2020-12 so `unevaluatedProperties: false`
continues to reject unknown fields. Unit-explicit Core payloads therefore
remain unit-explicit at the public boundary, and flattened, ambiguous, or
unknown-unit payloads fail validation.

For a session mutation, the coordinator adapter resolves the durable receipt
scope `(projectId, toolName, idempotencyKey)` before mutation execution.
`executeMutation` owns receipt lookup-before-guards, CAS, WAL, mutation, event,
and receipt atomicity. `waptions_session_open` uses a dedicated bootstrap call
that must reserve or resolve the stable `projectId` before applying the same
receipt scope. The stdio process has no receipt database.

Runtime event and job names are normalized through an exhaustive, fail-closed
mapping. In particular, `project.changed` becomes `project.mutated`,
`source.changed` becomes `source.invalidated`, grant changes invalidate the
project snapshot, recovery remains `session.recovered`, and both `completed`
and `succeeded` jobs are public `succeeded` jobs.

## Limits and MCP App resource

- Structured input: 512 KiB.
- Structured output: 1 MiB.
- Default page: 200 items; maximum: 500.
- Compound edits: maximum 256 operations.

The MCP App resource is
`ui://waptions/editor/v1/<sha256-of-html>/index.html` with
`text/html;profile=mcp-app`. Current nested MCP Apps metadata is used. The
resource CSP allows only the coordinator HTTP bridge at
`http://localhost:59941`; production packaging replaces the deterministic
contract placeholder with the P5B editor payload. The immutable resource URI
uses the hash of the canonical payload manifest, while the manifest separately
records every asset hash.
