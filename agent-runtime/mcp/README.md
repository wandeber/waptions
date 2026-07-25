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
  "warnings": []
}
```

`structuredContent` is authoritative. `content` is a short fallback and never
contains descriptors, paths, transcripts, bridge capabilities, signed URLs,
provider bodies, or credentials. Host-only expiring capabilities are allowed
only in MCP result metadata for `waptions_artifact_get` and
`waptions_editor_render`. Each tool has a closed outer `data` schema; nested
descriptors remain bounded and are rejected if they contain transcript bodies,
raw provider responses, byte bodies, credentials, signed URLs, or capabilities.
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

The Core owner supplies one hashed `CoreSemanticSchemaBundle`; production MCP
code does not define a second operation-name inventory. Server construction
fails unless the supplied schema is a closed 65-variant discriminated union,
its declared operation names match those discriminators, and its schema hash
matches. The MCP layer inserts that exact closed schema into
`waptions_edit_plan` and `waptions_edit_apply`; it does not translate legacy
fields or define a parallel operation union. Unit-explicit Core fields such as
48 kHz sample coordinates therefore remain unit-explicit at the public
boundary, and unknown or ambiguous units fail schema validation.

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
