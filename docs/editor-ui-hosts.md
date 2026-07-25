# Editor UI host integration

Waptions exposes one UI-only controller contract from `src/lib/editor-ui` and one reusable React
surface from `src/components/editor-surface`. The contract is intentionally independent from the
V4 persistence graph and from MCP tool schemas. A host maps its authoritative state and semantic
commands into the bounded `EditorUiSnapshot` and `EditorUiCommand` projection.

## Host mapping

| Host | State and command adapter | Media access | Presentation |
| --- | --- | --- | --- |
| Standalone | Zustand/IndexedDB adapter | Browser `File` and object URLs | Fullscreen editor route |
| Managed web | One-time pairing bridge and scoped view token | Coordinator-signed range URLs | Inline or fullscreen |
| MCP App | MCP Apps JSON-RPC and `tools/call` | Coordinator-signed range URLs | Inline, fullscreen, or preview-focused PiP |
| Headless view | Immutable snapshot and progress updates | Artifact resolver | Read-only PiP-style progress view |

The standalone adapter exists to keep the current route compatible while the editor components are
migrated away from global stores. Managed and MCP hosts use the controller-driven surface directly.
All structural actions use the same semantic `EditorUiCommand` union. The MCP adapter maps command
families to the focused Waptions tools (`waptions_edit_apply`, `waptions_history_apply`,
`waptions_playback_control`, transcription/export tools, and `waptions_view_update`) without
redeclaring their protocol schemas.

`mapEditorUiCommand` is the only UI-to-Core vocabulary boundary. UI controls must dispatch the
canonical operation names (`project.set-name`, `track.delete`, the discriminated
`video-clip.*`/`audio-clip.*` families, `subtitle.*`, `narrative.*`, and `link.*`) rather than
inventing aliases. The mapper validates timing domains before a request can cross the host:

| Operation field | Canonical domain |
| --- | --- |
| Video placement, split, and trim | Integer project timeline frames |
| Audio placement | Integer project timeline frames |
| Audio split and fades, including video-linked audio | Integer 48 kHz output samples |
| Imported audio trim source range | Native source samples plus the explicit native sample rate |
| Video-linked audio trim source range | Source seconds, explicitly discriminated as video media |
| Subtitle timing | Integer 48 kHz output samples |
| Narrative boundaries and margins | Integer 16 kHz samples |

Audio trim deliberately carries a discriminated `sourceRange`; a caller cannot send ambiguous
`sourceStart`, `sourceEnd`, `fadeIn`, or `fadeOut` fields whose units depend on clip subtype.
Every durable command is then emitted as `{ operationId, type, payload }`. The operation ID is
derived from the stable UI `commandId`, so retries keep the same identity. Imported-audio trim maps
to Core's explicit `native-samples` range with `audioSourceId`, `nativeSampleRateHz`,
`startNativeSample`, and `endNativeSample`; detached video audio maps to an explicit `seconds`
range with `videoSourceId`. UI fade controls stay canonical in 48 kHz output samples. Independent
audio forwards those values as `fadeInOutputSamples48k`/`fadeOutOutputSamples48k`; linked video
audio is converted in this one mapper to Core's explicit frame fields using the snapshot's project
frame rate. No subtype-dependent `fadeIn`, `sourceStart`, or unitless timing key crosses the
boundary.

## Synchronization contract

`ExternalEditorUiController` is a React external store:

- the first render loads one coherent snapshot;
- only events whose `previousCursor` equals the current cursor are applied;
- cursor gaps, epoch changes, missing snapshots, or backwards revisions trigger a bounded refresh;
- optimistic drag/trim state is view-local until one command commits;
- a conflict restores the authoritative snapshot and surfaces an actionable alert;
- project snapshots preserve view-local playhead, zoom, scroll, row heights, pane, inspector,
  presentation, focus, and selection;
- playback events may advance the playhead without replacing the rest of the view state;
- presentation changes never key or remount the editor surface.

The managed route is `/managed/[sessionId]?capability=<one-time-capability>`. It removes the
capability from browser history before pairing with `http://localhost:59941`. The pairing response
returns an opaque scoped view token used only inside the bridge. Capability tokens must not be put
back into URLs, logs, events, model context, or project state.

## MCP App bridge

`createMcpAppTransport` speaks JSON-RPC 2.0 through the parent window. It uses standard
`tools/call`, event polling through `waptions_events_read`, `ui/request-display-mode` when the host
supports it, and `ui/update-model-context`. Inline mode is the complete editor; fullscreen is an
optimization, and PiP deliberately focuses on preview, transport, presenter/follow state, and jobs.
The App performs `ui/initialize` exactly once before `ui/notifications/initialized`, negotiates
`inline`/`fullscreen`/`pip`, responds to `ui/resource-teardown`, and consumes
`ui/notifications/host-context-changed`. UI `picture-in-picture` is translated to MCP `pip`.
Model context is sent as `{ structuredContent }`.

The result of `waptions_editor_render` is bootstrap data only. Subsequent reads use the bounded
`editor-ui` projection from `waptions_project_get`; calling the rendering tool from inside its own
App would attach a second resource and remount the editor. Tool-result notifications after launch
never replace the immutable `sessionId`/`viewId`, and transports close a bridge only when they
created it.

The App consumes the render result's host-only `_meta.bridge.capabilityToken` separately from
`structuredContent`. `createLocalBridgeMediaResolver` exchanges it once with
`http://localhost:59941/v1/pair`, then resolves opaque source/artifact IDs to scoped, expiring HTTP
range URLs. The resolver accepts only the CSP-approved bridge origin, URL-encodes IDs, omits
credentials, and never publishes the pairing token, resource capability, or signed URL to model
context. Managed-web containers may inject the same `EditorUiMediaResolver` contract after their
own pairing exchange through `window.__WAPTIONS_MANAGED_EDITOR_MEDIA_RESOLVER__`; the route never
stores or reconstructs media capability URLs. The preview resolves each active video layer
independently, composites the visible layers, overlays active subtitle cues, and releases every
resolved resource when its source leaves the playhead. A single visible layer owns temporary
linked-audio playback until the host supplies the authoritative mixed audio stream.

Non-document tools retain their frozen MCP vocabulary at the same boundary: view mutations send a
single `patch` guarded by `expectedViewRevision`; playback sends `frame`,
`set-master-volume`/`set-master-mute`, and `expectedPlaybackRevision`; history jumps send
`historyEntryId`. The snapshot projection carries both transient revisions so reconnects cannot
silently replay view or transport actions against stale state.

MCP tool responses are authoritative envelopes shaped as `{ ok, data, state, warnings }`. The
adapter reads only the typed `data.editorUiSnapshot`, `data.editorUiCommandResult`, and
`data.editorUiEvents` projections, then overlays the authoritative state token, including
`narrativeRevision`. Event names and job states are normalized in one place; both `succeeded` and
`completed` become a completed UI job, while cursor expiry, an event gap, an epoch change, or an
unknown/incomplete projection causes a snapshot refresh.

The only model context payload is produced by `buildEditorUiModelContext`. It contains the bounded
project identity/name, selected IDs and types, timecode, revision numbers, up to eight active jobs,
and the recent semantic action. It cannot contain transcript text, clip labels, the full graph,
media or artifact URLs, local paths, credentials, or provider responses.

The MCP resource packaging owner consumes the source entry under `agent-runtime/app`; it remains
responsible for the immutable build-hashed `ui://` URI, CSP, byte manifest, and server registration.
