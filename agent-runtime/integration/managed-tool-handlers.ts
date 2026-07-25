import { validateEditorManifestV4 } from "../../src/lib/editor-document-v4.js";
import { secondsToFrames } from "../../src/lib/render-profile.js";
import { getAudioClipDurationFrames } from "../../src/lib/timeline-snap.js";
import {
  getVideoClipDurationFramesV4,
} from "../../src/lib/video-placement-v4.js";
import type {
  EditorCommandBatchRequest,
  EditorCommandPlan,
  EditorCommandResult,
  EditorHistorySummary,
  HistoryJumpRequest,
  HistoryMutationRequest,
} from "../../src/lib/editor-engine/index.js";
import type {
  EditorManifestV4,
  RenderProfile,
} from "../../src/types/video.js";
import type {
  ManagedMutationEnvelope,
  ManagedMutationResult,
  ManagedProjectEnvelopeV1,
} from "../coordinator/types.js";
import {
  ManagedCoordinator,
  type ManagedSessionOpenInput,
} from "../coordinator/managed-coordinator.js";
import { managedError } from "../coordinator/errors.js";
import type { DurableJobRecord } from "../jobs/durable-job-scheduler.js";
import type {
  CanonicalToolCall,
  CoordinatorResult,
  JsonObject,
  StateToken,
  ToolWarning,
} from "../mcp/contracts.js";
import type { SessionPathGrantRecord } from "../path-grants/path-grant-authority.js";
import { canonicalDigest } from "../persistence/canonical-json.js";
import type { CoordinatorCallContext } from "../server/coordinator-adapter.js";
import {
  projectArtifactRecord,
  projectEventRecord,
  projectJobRecord,
  projectPlaybackData,
  projectStateToken,
  projectViewSnapshot,
  timelineFrameToOutputSample,
  type ViewSelection,
} from "./canonical-projections.js";
import type {
  ManagedCoreCommand,
  ManagedCoreEditorState,
  ManagedCoreResult,
} from "./core-editor-port.js";
import { createEmptyManagedCoreSnapshot } from "./core-editor-port.js";
import type {
  CanonicalToolRouterDependencies,
} from "./canonical-tool-router.js";

type ManagedCoreCoordinator = ManagedCoordinator<
  ManagedCoreEditorState,
  ManagedCoreCommand,
  ManagedCoreResult
>;

type DelegatedToolName =
  | "waptions_project_import"
  | "waptions_media_probe"
  | "waptions_media_import"
  | "waptions_media_review"
  | "waptions_media_release"
  | "waptions_transcription_start"
  | "waptions_export_start";

/**
 * Expensive or capability-owning operations remain behind one required
 * injected port. Implementations must return the canonical adapter envelope;
 * this integration layer never substitutes unavailable placeholders.
 */
export type ManagedDelegatedToolPort = Readonly<
  Pick<CanonicalToolRouterDependencies["handlers"], DelegatedToolName>
>;

/**
 * Rendering needs durable replay semantics for structured data while minting
 * fresh host-only capability metadata on every response.
 */
export interface ManagedEditorRenderAuthority {
  renderEditorReceiptFirst(
    projectId: string,
    request: ManagedMutationEnvelope,
    input: {
      viewId: string;
      presentation: "inline" | "fullscreen" | "picture-in-picture";
      capabilityTtlSeconds?: number;
    },
    context: CoordinatorCallContext,
  ): Promise<CoordinatorResult>;
}

export interface ManagedToolHandlerDependencies {
  coordinator: ManagedCoreCoordinator;
  delegated: ManagedDelegatedToolPort;
  editorRender: ManagedEditorRenderAuthority;
}

interface DurableViewRecord {
  schemaVersion: 1;
  projectId: string;
  viewId: string;
  viewRevision: number;
  connectedAt: string;
  heartbeatAt: string;
  followPresenter: boolean;
  selectedIds: string[];
  selectionKind?: "tracks" | "clips" | "subtitles" | "narrative";
  playheadSample: number;
  zoom: number;
  scrollLeft: number;
  focusedPanel?: string;
  presentation: "inline" | "fullscreen" | "picture-in-picture";
  participantIds: string[];
}

interface GraphReference {
  id: string;
  kind: string;
  trackId?: string;
  startFrame?: number;
  endFrame?: number;
  label?: string;
}

export function createManagedToolHandlers(
  dependencies: ManagedToolHandlerDependencies,
): CanonicalToolRouterDependencies["handlers"] {
  const { coordinator, delegated } = dependencies;

  return {
    waptions_session_list: (call, context) =>
      sessionList(coordinator, call, context),
    waptions_session_open: (call, context) =>
      sessionOpen(dependencies, call, context),
    waptions_session_manage: (call, context) =>
      sessionManage(coordinator, call, context),
    waptions_path_grant: (call, context) =>
      pathGrant(coordinator, call, context),
    waptions_project_get: (call, context) =>
      projectGet(coordinator, call, context),
    waptions_project_import: delegated.waptions_project_import,
    waptions_project_validate: (call, context) =>
      projectValidate(coordinator, call, context),
    waptions_media_probe: delegated.waptions_media_probe,
    waptions_media_import: delegated.waptions_media_import,
    waptions_media_review: delegated.waptions_media_review,
    waptions_media_release: delegated.waptions_media_release,
    waptions_timeline_query: (call, context) =>
      timelineQuery(coordinator, call, context),
    waptions_edit_plan: (call, context) =>
      editPlan(coordinator, call, context),
    waptions_edit_apply: (call, context) =>
      editApply(coordinator, call, context),
    waptions_history_get: (call, context) =>
      historyGet(coordinator, call, context),
    waptions_history_apply: (call, context) =>
      historyApply(coordinator, call, context),
    waptions_transcription_start: delegated.waptions_transcription_start,
    waptions_job_list: (call, context) =>
      jobList(coordinator, call, context),
    waptions_job_get: (call, context) =>
      jobGet(coordinator, call, context),
    waptions_job_cancel: (call, context) =>
      jobCancel(dependencies, call, context),
    waptions_export_start: delegated.waptions_export_start,
    waptions_artifact_list: (call, context) =>
      artifactList(coordinator, call, context),
    waptions_artifact_get: (call, context) =>
      artifactGet(coordinator, call, context),
    waptions_events_read: (call, context) =>
      eventsRead(coordinator, call, context),
    waptions_view_get: (call, context) =>
      viewGet(coordinator, call, context),
    waptions_view_update: (call, context) =>
      viewUpdate(coordinator, call, context),
    waptions_playback_control: (call, context) =>
      playbackControl(coordinator, call, context),
    waptions_diagnostics_get: (call, context) =>
      diagnosticsGet(coordinator, call, context),
    waptions_editor_render: (call, context) =>
      editorRender(dependencies, call, context),
  };
}

async function sessionList(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const request = call.request;
  const requestedStatus = optionalString(request, "status") ?? "all";
  const summaries = coordinator.listSessions()
    .map((summary) => sessionSummary(coordinator, summary.projectId))
    .filter((summary) =>
      requestedStatus === "all" || summary.status === requestedStatus
    );
  const page = paginate(summaries, request);
  return success({
    items: page.items,
    page: page.page,
  });
}

async function sessionOpen(
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const request = call.request;
  const action = requiredString(request, "action") as ManagedSessionOpenInput<
    ManagedCoreEditorState
  >["action"];
  const projectId = requiredString(request, "projectId");
  const name = action === "create"
    ? requiredString(request, "name")
    : undefined;
  const initialSnapshot = action === "create"
    ? createSessionSnapshot(
        dependencies.coordinator,
        projectId,
        name!,
        request,
      )
    : undefined;
  const result = await dependencies.coordinator.openSessionReceiptFirst({
    apiVersion: "2026-07-25",
    action,
    projectId,
    idempotencyKey: requiredString(request, "idempotencyKey"),
    canonicalRequestHash: call.requestHash,
    ...(name === undefined ? {} : { name }),
    ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
  });
  return managedMutationResult(result, (data) => ({
    action: data.action,
    created: data.created,
    recovered: data.recovered,
    participantId: data.participantId,
    session: sessionSummary(
      dependencies.coordinator,
      data.project.projectId,
    ),
  }));
}

async function sessionManage(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const request = call.request;
  const action = requiredObject(request, "action");
  const kind = requiredString(action, "kind");
  const projectId = projectIdForCall(coordinator, call);
  if (kind === "detach") {
    return failure(
      "Detach is host-local and this runtime has no durable detach authority.",
      coordinator.getProject(projectId).state,
    );
  }
  const mutation = managedRequest(call, { action: kind });
  const result = await coordinator.mutateRegistry(
    projectId,
    mutation,
    (envelope) => {
      const now = new Date().toISOString();
      return {
        update: (current) => {
          switch (kind) {
            case "rename":
              return { ...current, name: requiredString(action, "name") };
            case "archive":
              return { ...current, archivedAt: now };
            case "restore":
              if (current.deletedAt !== undefined) {
                throw managedError(
                  "INVALID_REQUEST",
                  "A tombstoned project cannot be restored.",
                );
              }
              return {
                ...current,
                archivedAt: undefined,
              };
            case "delete":
              if (
                requiredString(action, "confirmProjectId")
                !== current.projectId
              ) {
                throw managedError(
                  "INVALID_REQUEST",
                  "The project deletion confirmation does not match.",
                );
              }
              return {
                ...current,
                archivedAt: current.archivedAt ?? now,
                deletedAt: now,
              };
            default:
              throw managedError(
                "INVALID_REQUEST",
                "The session action is not supported.",
              );
          }
        },
        result: {
          action: kind,
          status: {
            rename: "renamed",
            detach: "detached",
            archive: "archived",
            restore: "restored",
            delete: "tombstoned",
          }[kind] ?? "updated",
        },
        eventKind: "project.snapshot" as const,
        eventData: {
          manifestDigest: envelope.editor.manifestDigest,
          reason: "refreshed",
        },
      };
    },
  );
  return managedMutationResult(result, (data) => data);
}

async function pathGrant(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const request = call.request;
  const action = requiredObject(request, "action");
  const kind = requiredString(action, "kind");
  const projectId = projectIdForCall(coordinator, call);
  const mutation = managedRequest(call, { action: kind });

  if (kind === "add") {
    const publicKind = requiredString(action, "grantKind");
    if (
      publicKind === "write-destination"
      && requiredBoolean(action, "allowCreate") === false
    ) {
      throw managedError(
        "INVALID_REQUEST",
        "The managed destination authority only supports create-only grants.",
      );
    }
    const runtimeKind = publicKind === "write-destination"
      ? "create-only-destination"
      : publicKind === "overwrite-file"
      ? "exact-overwrite"
      : "read-root";
    const result = await coordinator.mutateRegistry(
      projectId,
      mutation,
      async (envelope) => {
        const prepared = await coordinator.pathGrants.prepareCreate(
          envelope.sessionId,
          coordinator.epoch,
          runtimeKind,
          requiredString(action, "path"),
          publicKind === "overwrite-file",
        );
        const grant = prepared.record;
        return {
          update: (current) => ({
            ...current,
            grantRevision: current.grantRevision + 1,
          }),
          writes: [{
            relativePath: `grants/${grant.grantId}.json`,
            value: grant,
          }],
          result: {
            action: "add",
            grants: [projectPathGrant(grant)],
          },
          eventKind: "project.snapshot" as const,
          eventData: {
            manifestDigest: envelope.editor.manifestDigest,
            reason: "refreshed",
          },
          afterCommit: () => {
            prepared.commit();
          },
        };
      },
    );
    return managedMutationResult(result, (data) => data);
  }

  if (kind === "revoke") {
    const grantId = requiredString(action, "grantId");
    if (requiredString(action, "confirmGrantId") !== grantId) {
      throw managedError(
        "INVALID_REQUEST",
        "The grant revocation confirmation does not match.",
      );
    }
    const result = await coordinator.mutateRegistry(
      projectId,
      mutation,
      async (envelope) => {
        const grants =
          await coordinator.store.readNamespace<SessionPathGrantRecord>(
            projectId,
            "grants",
          );
        const existing = grants.find((grant) => grant.grantId === grantId);
        if (!existing) {
          throw managedError(
            "NOT_FOUND",
            "The managed path grant does not exist.",
          );
        }
        const prepared = coordinator.pathGrants.prepareRevoke(
          existing.grantId,
          {
            sessionId: existing.sessionId,
            sessionEpoch: existing.sessionEpoch,
          },
        );
        const grant = prepared.record;
        return {
          update: (current) => ({
            ...current,
            grantRevision: current.grantRevision + 1,
          }),
          writes: [{
            relativePath: `grants/${grant.grantId}.json`,
            value: grant,
          }],
          result: {
            action: "revoke",
            grants: [projectPathGrant(grant)],
          },
          eventKind: "project.snapshot" as const,
          eventData: {
            manifestDigest: envelope.editor.manifestDigest,
            reason: "refreshed",
          },
          afterCommit: () => {
            prepared.commit();
          },
        };
      },
    );
    return managedMutationResult(result, (data) => data);
  }

  if (kind !== "inspect") {
    throw managedError("INVALID_REQUEST", "The path grant action is invalid.");
  }
  const result = await coordinator.mutateRegistry(
    projectId,
    mutation,
    async (envelope) => {
      const requestedGrantId = optionalString(action, "grantId");
      const grants = (
        await coordinator.store.readNamespace<SessionPathGrantRecord>(
          projectId,
          "grants",
        )
      ).filter((grant) =>
        requestedGrantId === undefined || grant.grantId === requestedGrantId
      );
      return {
        update: (current) => current,
        result: {
          action: "inspect",
          grants: grants.map(projectPathGrant),
        },
        eventKind: "project.snapshot" as const,
        eventData: {
          manifestDigest: envelope.editor.manifestDigest,
          reason: "refreshed",
        },
      };
    },
  );
  return managedMutationResult(result, (data) => data);
}

async function projectGet(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const manifest = envelope.editor.state.snapshot.manifest;
  const section = optionalString(call.request, "section") ?? "summary";
  const references = projectReferences(
    manifest,
    section,
    coordinator.jobs.list(envelope.projectId),
  );
  const page = paginate(references, call.request);
  const jobs = coordinator.jobs.list(envelope.projectId);
  return success({
    projectId: envelope.projectId,
    name: envelope.name,
    renderProfile: manifest.renderProfile,
    renderBackgroundColor: manifest.renderBackgroundColor,
    counts: manifestCounts(manifest),
    activeJobIds: jobs
      .filter((job) =>
        !["succeeded", "failed", "cancelled", "stale"].includes(job.state)
      )
      .map((job) => job.jobId)
      .slice(0, 256),
    references: page.items,
    page: page.page,
  }, state);
}

async function projectValidate(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const scopes = optionalStringArray(call.request, "scopes")
    ?? ["structural"];
  const unsupportedScopes = scopes.filter((scope) => scope !== "structural");
  if (unsupportedScopes.length > 0) {
    return failure(
      `Synchronous validation does not support scopes: ${
        unsupportedScopes.join(", ")
      }.`,
      state,
    );
  }
  if (call.request.deep === true) {
    return failure(
      "Deep validation is unavailable in the synchronous managed runtime.",
      state,
    );
  }
  const validation = validateEditorManifestV4(
    envelope.editor.state.snapshot.manifest,
  );
  return success({
    valid: validation.valid,
    issues: validation.issues.slice(0, 500).map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.message,
    })),
  }, state);
}

async function timelineQuery(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const entityKind = requiredString(call.request, "entityKind");
  const manifest = envelope.editor.state.snapshot.manifest;
  const trackIds = optionalStringArray(call.request, "trackIds");
  const startFrame = optionalNumber(call.request, "startFrame");
  const endFrame = optionalNumber(call.request, "endFrame");
  if (
    startFrame !== undefined
    && endFrame !== undefined
    && endFrame <= startFrame
  ) {
    return failure(
      "Timeline query bounds must define a non-empty half-open interval.",
      state,
    );
  }
  const references = timelineReferences(manifest, entityKind)
    .filter((reference) =>
      trackIds === undefined
      || reference.trackId === undefined
      || trackIds.includes(reference.trackId)
    )
    .filter((reference) =>
      startFrame === undefined
      || reference.endFrame === undefined
      || reference.endFrame > startFrame
    )
    .filter((reference) =>
      endFrame === undefined
      || reference.startFrame === undefined
      || reference.startFrame < endFrame
    );
  const page = paginate(references, call.request);
  return success({
    entityKind,
    items: page.items,
    page: page.page,
  }, state);
}

async function editPlan(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const request = editorBatchRequest(call, `plan:${call.requestHash}`);
  const result = await coordinator.planEditor(envelope.projectId, {
    kind: "plan",
    request,
  });
  if (!isCommandPlan(result)) {
    throw managedError(
      "INTERNAL_ERROR",
      "Core returned an unexpected edit-plan result.",
    );
  }
  if (!result.ok) return coreFailure(result, state);

  const warnings = result.warnings.map((message) =>
    toolWarning("INPUT_NORMALIZED", message)
  );
  const planData = {
    planId: result.planId,
    requestDigest: result.requestHash,
    baseState: projectStateToken(state),
    normalizedOperations: result.normalizedOperations,
    aliases: result.aliases,
    predicted: result.predicted,
    affectedIds: result.affectedIds,
    history: result.history,
    warnings,
    ...(result.noOpReason === undefined
      ? {}
      : { noOpReason: result.noOpReason }),
    expiresAt: result.expiresAt,
  };
  return success({
    ...planData,
    planDigest: canonicalDigest(planData),
  }, state);
}

async function editApply(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const projectId = projectIdForCall(coordinator, call);
  const command: ManagedCoreCommand = {
    kind: "dispatch",
    request: editorBatchRequest(
      call,
      requiredString(call.request, "idempotencyKey"),
    ),
  };
  const result = await coordinator.mutateEditor(
    projectId,
    managedRequest(call, command),
  );
  return managedMutationResult(result, projectEditApplyResult);
}

async function historyGet(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const history = envelope.editor.state.snapshot.history;
  const direction = optionalString(call.request, "direction") ?? "both";
  const combined = direction === "past"
    ? history.past.map((entry) => ({ direction: "past" as const, entry }))
    : direction === "future"
    ? history.future.map((entry) => ({ direction: "future" as const, entry }))
    : [
        ...history.past.map((entry) => ({
          direction: "past" as const,
          entry,
        })),
        ...history.future.map((entry) => ({
          direction: "future" as const,
          entry,
        })),
      ];
  const page = paginate(combined, call.request);
  return success({
    currentIndex: history.currentIndex,
    past: page.items
      .filter((item) => item.direction === "past")
      .map((item) => projectHistorySummary(item.entry)),
    future: page.items
      .filter((item) => item.direction === "future")
      .map((item) => projectHistorySummary(item.entry)),
    page: page.page,
  }, state);
}

async function historyApply(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const projectId = projectIdForCall(coordinator, call);
  const action = requiredObject(call.request, "action");
  const kind = requiredString(action, "kind");
  const idempotencyKey = requiredString(call.request, "idempotencyKey");
  const base = {
    apiVersion: "2026-07-25" as const,
    toolName: "waptions_history_apply" as const,
    sessionEpoch: requiredString(call.request, "sessionEpoch"),
    expected: expectedRevisions(call.request),
    idempotencyKey,
  };
  let command: ManagedCoreCommand;
  if (kind === "jump") {
    const request: HistoryJumpRequest = {
      ...base,
      entryId: requiredString(action, "entryId"),
      position: requiredString(action, "position") as "before" | "after",
    };
    command = { kind: "jump", request };
  } else {
    const request: HistoryMutationRequest = {
      ...base,
      ...(optionalNumber(action, "steps") === undefined
        ? {}
        : { steps: optionalNumber(action, "steps") }),
    };
    if (kind === "undo") command = { kind: "undo", request };
    else if (kind === "redo") command = { kind: "redo", request };
    else {
      throw managedError(
        "INVALID_REQUEST",
        "The history action is invalid.",
      );
    }
  }
  const result = await coordinator.mutateEditor(
    projectId,
    managedRequest(call, command),
  );
  return managedMutationResult(result, projectEditApplyResult);
}

async function jobList(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const kind = optionalString(call.request, "kind");
  const requestedState = optionalString(call.request, "state");
  const jobs = coordinator.jobs.list(envelope.projectId)
    .map(projectJobRecord)
    .filter((job) => kind === undefined || job.kind === kind)
    .filter((job) =>
      requestedState === undefined || job.state === requestedState
    );
  const page = paginate(jobs, call.request);
  return success({ items: page.items, page: page.page }, state);
}

async function jobGet(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const job = coordinator.jobs.get(requiredString(call.request, "jobId"));
  if (!job || job.projectId !== envelope.projectId) {
    throw managedError("NOT_FOUND", "The managed job does not exist.");
  }
  return success({ job: projectJobRecord(job) }, state);
}

async function jobCancel(
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  const projectId = projectIdForCall(dependencies.coordinator, call);
  context.signal.throwIfAborted();
  const result = await dependencies.coordinator.cancelJobReceiptFirst(
    projectId,
    managedRequest(call, {
      jobId: requiredString(call.request, "jobId"),
    }),
    requiredString(call.request, "jobId"),
  );
  return managedMutationResult(result, ({ job }) => ({
    job: projectJobRecord(job),
  }));
}

async function artifactList(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const artifacts = (await coordinator.artifacts.list(envelope.projectId))
    .map(projectArtifactRecord);
  const page = paginate(artifacts, call.request);
  return success({ items: page.items, page: page.page }, state);
}

async function artifactGet(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const presentation = requiredString(call.request, "presentation");
  if (presentation !== "metadata") {
    throw managedError(
      "INVALID_REQUEST",
      "Only metadata artifact presentation is available at this boundary.",
    );
  }
  const { envelope, state } = projectForCall(coordinator, call);
  const artifact = await coordinator.artifacts.get(
    envelope.projectId,
    requiredString(call.request, "artifactId"),
  );
  return success({
    presentation: "metadata",
    artifact: projectArtifactRecord(artifact),
  }, state);
}

async function eventsRead(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const limit = optionalNumber(call.request, "limit") ?? 200;
  const page = await coordinator.events.read(
    envelope.projectId,
    envelope.sessionId,
    optionalString(call.request, "afterCursor"),
    limit,
  );
  const hasMore = page.events.length === limit
    ? (
      await coordinator.events.read(
        envelope.projectId,
        envelope.sessionId,
        page.nextCursor,
        1,
      )
    ).events.length > 0
    : false;
  return success({
    events: page.events.map(projectEventRecord),
    nextCursor: page.nextCursor,
    hasMore,
  }, state);
}

async function viewGet(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(coordinator, call);
  const view = await findDurableView(
    coordinator,
    envelope.projectId,
    requiredString(call.request, "viewId"),
  );
  if (!view) throw managedError("NOT_FOUND", "The durable view does not exist.");
  return success({
    view: projectDurableView(view, renderProfile(envelope)),
  }, state);
}

async function viewUpdate(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const projectId = projectIdForCall(coordinator, call);
  const viewId = requiredString(call.request, "viewId");
  const expectedViewRevision = requiredNumber(
    call.request,
    "expectedViewRevision",
  );
  const patch = requiredObject(call.request, "patch");
  const request = managedRequest(call, { viewId, patch });
  const result = await coordinator.mutateRegistry(
    projectId,
    request,
    async (envelope) => {
      const existing = await findDurableView(coordinator, projectId, viewId);
      const current = existing ?? initialDurableView(projectId, viewId);
      if (current.viewRevision !== expectedViewRevision) {
        throw managedError(
          "REVISION_CONFLICT",
          "The durable view revision changed.",
          false,
          {
            domain: "view",
            expectedRevision: expectedViewRevision,
            actualRevision: current.viewRevision,
          },
        );
      }
      const next = applyViewPatch(
        current,
        patch,
        renderProfile(envelope),
      );
      const projected = projectDurableView(next, renderProfile(envelope));
      return {
        update: (project) => project,
        writes: [{
          relativePath: durableViewRelativePath(viewId),
          value: next,
        }],
        result: { view: projected },
        eventKind: "view.changed" as const,
        eventData: {
          viewId,
          viewRevision: next.viewRevision,
          changedFields: viewChangedFields(patch),
        },
      };
    },
  );
  return managedMutationResult(result, (data) => data);
}

async function playbackControl(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const projectId = projectIdForCall(coordinator, call);
  const viewId = requiredString(call.request, "viewId");
  const expectedPlaybackRevision = requiredNumber(
    call.request,
    "expectedPlaybackRevision",
  );
  const action = requiredObject(call.request, "action");
  const actionKind = requiredString(action, "kind");
  const request = managedRequest(call, { viewId, action });
  const result = await coordinator.mutateRegistry(
    projectId,
    request,
    async (envelope) => {
      if (envelope.playback.revision !== expectedPlaybackRevision) {
        throw managedError(
          "REVISION_CONFLICT",
          "The durable playback revision changed.",
          false,
          {
            domain: "playback",
            expectedRevision: expectedPlaybackRevision,
            actualRevision: envelope.playback.revision,
          },
        );
      }
      const existingView = await findDurableView(
        coordinator,
        projectId,
        viewId,
      );
      if (!existingView) {
        throw managedError("NOT_FOUND", "The durable view does not exist.");
      }
      const profile = renderProfile(envelope);
      const nextView: DurableViewRecord = {
        ...existingView,
        followPresenter: actionKind === "follow"
          ? true
          : actionKind === "unfollow"
          ? false
          : existingView.followPresenter,
        heartbeatAt: new Date().toISOString(),
        viewRevision: ["follow", "unfollow"].includes(actionKind)
          ? existingView.viewRevision + 1
          : existingView.viewRevision,
      };
      const playback = {
        ...envelope.playback,
        ...playbackPatch(actionKind, action, viewId, profile, envelope),
        revision: envelope.playback.revision + 1,
      };
      return {
        update: (project) => ({ ...project, playback }),
        ...(["follow", "unfollow"].includes(actionKind)
          ? {
              writes: [{
                relativePath: durableViewRelativePath(viewId),
                value: nextView,
              }],
            }
          : {}),
        result: {
          playback: projectPlaybackData(playback, profile, nextView),
        },
        eventKind: "project.mutated" as const,
        eventData: {
          commandId: requiredString(call.request, "idempotencyKey"),
          operationIds: [],
          affectedIds: [viewId],
        },
      };
    },
  );
  return managedMutationResult(result, ({ playback }) => ({ ...playback }));
}

async function diagnosticsGet(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { state } = projectForCall(coordinator, call);
  return failure(
    "Canonical diagnostics are unavailable because the runtime does not "
      + "expose every required metric or an authoritative diagnostics revision.",
    state,
  );
}

async function editorRender(
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  const projectId = projectIdForCall(dependencies.coordinator, call);
  const presentation = requiredString(
    call.request,
    "presentation",
  ) as "inline" | "fullscreen" | "picture-in-picture";
  return dependencies.editorRender.renderEditorReceiptFirst(
    projectId,
    managedRequest(call, {
      viewId: requiredString(call.request, "viewId"),
      presentation,
    }),
    {
      viewId: requiredString(call.request, "viewId"),
      presentation,
      ...(optionalNumber(call.request, "capabilityTtlSeconds") === undefined
        ? {}
        : {
            capabilityTtlSeconds: optionalNumber(
              call.request,
              "capabilityTtlSeconds",
            ),
          }),
    },
    context,
  );
}

function success(
  data: Readonly<Record<string, unknown>>,
  state?: StateToken,
): CoordinatorResult {
  return {
    ok: true,
    data: jsonObject(data),
    ...(state ? { state: projectStateToken(state) } : {}),
    warnings: [],
    replayed: false,
  };
}

function failure(
  message: string,
  state?: StateToken,
): CoordinatorResult {
  return {
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message,
      retryable: false,
    },
    ...(state ? { state: projectStateToken(state) } : {}),
  };
}

function managedMutationResult<Result>(
  result: ManagedMutationResult<Result>,
  project: (data: Result) => Readonly<Record<string, unknown>>,
): CoordinatorResult {
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
      },
      ...(result.state
        ? { state: projectStateToken(result.state) }
        : {}),
    };
  }
  return {
    ok: true,
    data: jsonObject(project(result.data)),
    state: projectStateToken(result.state),
    ...(result.committedState
      ? { committedState: projectStateToken(result.committedState) }
      : {}),
    warnings: result.warnings.map((message) =>
      toolWarning("PARTIAL_RESULT", message)
    ),
    replayed: result.replayed,
  };
}

function coreFailure(
  result: Extract<EditorCommandPlan | EditorCommandResult, { ok: false }>,
  state: StateToken,
): CoordinatorResult {
  return {
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
    },
    state: projectStateToken(state),
  };
}

function toolWarning(
  code: ToolWarning["code"],
  message: string,
): ToolWarning {
  return {
    code,
    message: message.slice(0, 1_024) || "The result was normalized.",
  };
}

function projectForCall(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
): {
  envelope: ManagedProjectEnvelopeV1<ManagedCoreEditorState>;
  state: StateToken;
} {
  const projectId = projectIdForCall(coordinator, call);
  const project = coordinator.getProject(projectId);
  return {
    envelope: project.envelope,
    state: project.state,
  };
}

function projectIdForCall(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
): string {
  return coordinator.resolveProjectId(requiredString(call.request, "sessionId"));
}

function managedRequest<Command>(
  call: CanonicalToolCall,
  command: Command,
): ManagedMutationEnvelope<Command> {
  return {
    apiVersion: "2026-07-25",
    sessionId: requiredString(call.request, "sessionId"),
    sessionEpoch: requiredString(call.request, "sessionEpoch"),
    expected: expectedRevisions(call.request),
    idempotencyKey: requiredString(call.request, "idempotencyKey"),
    toolName: call.toolName,
    // This is the dispatcher-provided hash of the complete public request.
    canonicalRequestHash: call.requestHash,
    command,
  };
}

function expectedRevisions(
  request: Readonly<Record<string, unknown>>,
): ManagedMutationEnvelope["expected"] {
  const expected = requiredObject(request, "expected");
  return {
    sessionRevision: requiredNumber(expected, "sessionRevision"),
    documentRevision: requiredNumber(expected, "documentRevision"),
    ...(optionalNumber(expected, "audioGraphRevision") === undefined
      ? {}
      : {
          audioGraphRevision: optionalNumber(
            expected,
            "audioGraphRevision",
          ),
        }),
    ...(optionalNumber(expected, "narrativeRevision") === undefined
      ? {}
      : {
          narrativeRevision: optionalNumber(
            expected,
            "narrativeRevision",
          ),
        }),
  };
}

function editorBatchRequest(
  call: CanonicalToolCall,
  idempotencyKey: string,
): EditorCommandBatchRequest {
  return {
    apiVersion: "2026-07-25",
    toolName: call.toolName as "waptions_edit_plan" | "waptions_edit_apply",
    sessionEpoch: requiredString(call.request, "sessionEpoch"),
    expected: expectedRevisions(call.request),
    idempotencyKey,
    ...(Array.isArray(call.request.operations)
      ? { operations: structuredClone(call.request.operations) as never }
      : {}),
    ...(typeof call.request.planId === "string"
      ? { planId: call.request.planId }
      : {}),
    ...(isRecord(call.request.history)
      ? {
          history: {
            label: requiredString(call.request.history, "label"),
            category: requiredString(call.request.history, "category"),
          },
        }
      : {}),
  };
}

function isCommandPlan(result: ManagedCoreResult): result is EditorCommandPlan {
  return !result.ok || "normalizedOperations" in result;
}

function projectEditApplyResult(
  result: ManagedCoreResult,
): Readonly<Record<string, unknown>> {
  if (!result.ok || !("commandId" in result)) {
    throw managedError(
      "INTERNAL_ERROR",
      "Core returned an unexpected edit result.",
    );
  }
  return {
    commandId: result.commandId,
    ...(result.planId === undefined ? {} : { planId: result.planId }),
    noOp: result.noOp,
    ...(result.noOpReason === undefined
      ? {}
      : { noOpReason: result.noOpReason }),
    historyEntryId: result.historyEntryId,
    eventId: result.eventId,
    aliases: result.aliases,
  };
}

function projectHistorySummary(
  entry: EditorHistorySummary,
): Readonly<Record<string, unknown>> {
  return {
    entryId: entry.id,
    label: entry.label,
    category: entry.category,
    occurredAt: entry.occurredAt,
    operationIds: entry.operationIds,
    fromRevision: entry.from.documentRevision,
    toRevision: entry.to.documentRevision,
  };
}

function sessionSummary(
  coordinator: ManagedCoreCoordinator,
  projectId: string,
): Readonly<Record<string, unknown>> & {
  status: "active" | "archived" | "tombstoned";
} {
  const { envelope, state } = coordinator.getProject(projectId);
  const status = envelope.deletedAt
    ? "tombstoned"
    : envelope.archivedAt
    ? "archived"
    : "active";
  return {
    sessionId: envelope.sessionId,
    projectId: envelope.projectId,
    name: envelope.name,
    status,
    recoveryState: envelope.recoveryCount > 0 ? "recovered" : "clean",
    updatedAt: envelope.updatedAt,
    state: projectStateToken(state),
  };
}

function createSessionSnapshot(
  coordinator: ManagedCoreCoordinator,
  projectId: string,
  name: string,
  request: Readonly<Record<string, unknown>>,
) {
  const snapshot = createEmptyManagedCoreSnapshot(
    projectId,
    coordinator.epoch,
    name,
  );
  const manifest = snapshot.state.snapshot.manifest;
  if (isRecord(request.renderProfile)) {
    manifest.renderProfile = structuredClone(
      request.renderProfile,
    ) as unknown as RenderProfile;
  }
  if (typeof request.renderBackgroundColor === "string") {
    manifest.renderBackgroundColor = request.renderBackgroundColor;
  }
  snapshot.manifestDigest = canonicalDigest(manifest);
  return snapshot;
}

function projectPathGrant(
  grant: SessionPathGrantRecord,
): Readonly<Record<string, unknown>> {
  return {
    grantId: grant.grantId,
    kind: grant.kind === "create-only-destination"
      ? "write-destination"
      : grant.kind === "exact-overwrite"
      ? "overwrite-file"
      : "read-root",
    canonicalPath: grant.canonicalPath,
    allowCreate: grant.kind === "create-only-destination",
    createdAt: grant.createdAt,
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
  };
}

function manifestCounts(
  manifest: EditorManifestV4,
): Readonly<Record<string, number>> {
  return {
    tracks:
      manifest.videoTracks.length
      + manifest.audioTracks.length
      + manifest.subtitleTracks.length,
    clips:
      manifest.videoClips.length
      + manifest.audioTracks.reduce(
        (count, track) => count + track.clips.length,
        0,
      ),
    subtitles: manifest.subtitleTracks.reduce(
      (count, track) => count + track.subtitles.length,
      0,
    ),
    sources:
      manifest.videoSourceDescriptors.length
      + manifest.audioSourceDescriptors.length,
    links: manifest.dependentLinks.length,
  };
}

function projectReferences(
  manifest: EditorManifestV4,
  section: string,
  jobs: readonly DurableJobRecord[],
): GraphReference[] {
  if (section === "summary") return [];
  if (section === "tracks") return timelineReferences(manifest, "tracks");
  if (section === "sources") {
    return [
      ...manifest.videoSourceDescriptors.map((source) => ({
        id: source.id,
        kind: "video-source",
        label: boundedLabel(source.originalName),
      })),
      ...manifest.audioSourceDescriptors.map((source) => ({
        id: source.id,
        kind: "audio-source",
        label: boundedLabel(source.originalName),
      })),
    ];
  }
  if (section === "jobs") {
    return jobs.map((job) => ({
      id: job.jobId,
      kind: `job:${job.kind}`,
      label: boundedLabel(job.stage),
    }));
  }
  return [
    ...timelineReferences(manifest, "clips"),
    ...timelineReferences(manifest, "subtitles"),
    ...timelineReferences(manifest, "narrative-blocks"),
    ...timelineReferences(manifest, "links"),
  ];
}

function timelineReferences(
  manifest: EditorManifestV4,
  entityKind: string,
): GraphReference[] {
  if (entityKind === "tracks") {
    return [
      ...manifest.videoTracks.map((track) => ({
        id: track.id,
        kind: "video-track",
        trackId: track.id,
        label: boundedLabel(track.name),
      })),
      ...manifest.audioTracks.map((track) => ({
        id: track.id,
        kind: "audio-track",
        trackId: track.id,
        label: boundedLabel(track.name),
      })),
      ...manifest.subtitleTracks.map((track) => ({
        id: track.id,
        kind: "subtitle-track",
        trackId: track.id,
        label: boundedLabel(track.name),
      })),
    ];
  }
  if (entityKind === "clips" || entityKind === "intervals") {
    return [
      ...manifest.videoClips.map((clip) => ({
        id: clip.id,
        kind: "video-clip",
        trackId: clip.trackId,
        startFrame: clip.timelineStartFrame,
        endFrame: clip.timelineStartFrame
          + getVideoClipDurationFramesV4(clip, manifest.renderProfile),
      })),
      ...manifest.audioTracks.flatMap((track) =>
        track.clips.map((clip) => {
          const durationFrames = getAudioClipDurationFrames(
            clip,
            manifest.renderProfile.fps,
            manifest.videoSourceDescriptors,
            manifest.audioSourceDescriptors,
          );
          return {
            id: clip.id,
            kind: "audio-clip",
            trackId: track.id,
            startFrame: clip.timelineStartFrame,
            ...(durationFrames === null
              ? {}
              : {
                  endFrame: clip.timelineStartFrame + durationFrames,
                }),
          };
        })
      ),
    ];
  }
  if (entityKind === "subtitles") {
    return manifest.subtitleTracks.flatMap((track) =>
      track.subtitles.map((subtitle) => {
        const startFrame = secondsToFrames(
          Math.max(0, subtitle.startTime),
          manifest.renderProfile.fps,
          "floor",
        );
        const endFrame = secondsToFrames(
          Math.max(0, subtitle.endTime),
          manifest.renderProfile.fps,
          "ceil",
        );
        return {
          id: subtitle.id,
          kind: "subtitle",
          trackId: track.id,
          startFrame,
          endFrame: Math.max(startFrame + 1, endFrame),
          label: boundedLabel(subtitle.text),
        };
      })
    );
  }
  if (entityKind === "narrative-blocks") {
    const narrative = manifest.narrative;
    return narrative
      ? narrative.blockIds.flatMap((blockId) => {
          const block = narrative.blocks[blockId];
          return block
            ? [{
                id: block.id,
                kind: `narrative-${block.kind}`,
                trackId: block.trackId,
                startFrame: block.timelineStartFrame,
              }]
            : [];
        })
      : [];
  }
  if (entityKind === "narrative-words") {
    const narrative = manifest.narrative;
    return narrative
      ? narrative.blockIds.flatMap((blockId) => {
          const block = narrative.blocks[blockId];
          return block?.kind === "speech"
            ? block.sourceWordIds.map((wordId) => ({
                id: wordId,
                kind: "narrative-word",
                trackId: block.trackId,
              }))
            : [];
        })
      : [];
  }
  if (entityKind === "links") {
    return manifest.dependentLinks.map((link) => ({
      id: link.id,
      kind: `link:${link.target.kind}`,
      label: boundedLabel(link.followPolicy),
    }));
  }
  if (entityKind === "content-boundary") {
    const references = [
      ...timelineReferences(manifest, "clips"),
      ...timelineReferences(manifest, "subtitles"),
    ];
    return [{
      id: "content-boundary",
      kind: "content-boundary",
      startFrame: 0,
      endFrame: references.reduce(
        (end, reference) => Math.max(end, reference.endFrame ?? 0),
        0,
      ),
    }];
  }
  if (entityKind === "selection") return [];
  return [];
}

function boundedLabel(value: string): string {
  return value.slice(0, 512);
}

async function findDurableView(
  coordinator: ManagedCoreCoordinator,
  projectId: string,
  viewId: string,
): Promise<DurableViewRecord | undefined> {
  return (
    await coordinator.store.readNamespace<DurableViewRecord>(
      projectId,
      "views",
    )
  ).find((view) => view.viewId === viewId);
}

function initialDurableView(
  projectId: string,
  viewId: string,
): DurableViewRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId,
    viewId,
    viewRevision: 0,
    connectedAt: now,
    heartbeatAt: now,
    followPresenter: false,
    selectedIds: [],
    playheadSample: 0,
    zoom: 1,
    scrollLeft: 0,
    presentation: "inline",
    participantIds: [viewId],
  };
}

function applyViewPatch(
  current: DurableViewRecord,
  patch: Readonly<Record<string, unknown>>,
  profile: RenderProfile,
): DurableViewRecord {
  const selection = isRecord(patch.selection)
    ? projectSelection(patch.selection)
    : undefined;
  return {
    ...current,
    viewRevision: current.viewRevision + 1,
    heartbeatAt: new Date().toISOString(),
    ...(selection === undefined
      ? {}
      : {
          selectedIds: selection.kind === "none" ? [] : selection.ids,
          selectionKind: selection.kind === "none"
            ? undefined
            : selection.kind,
        }),
    ...(optionalNumber(patch, "playheadFrame") === undefined
      ? {}
      : {
          playheadSample: timelineFrameToOutputSample(
            requiredNumber(patch, "playheadFrame"),
            profile,
          ),
        }),
    ...(optionalNumber(patch, "zoom") === undefined
      ? {}
      : { zoom: requiredNumber(patch, "zoom") }),
    ...(optionalNumber(patch, "scrollLeft") === undefined
      ? {}
      : { scrollLeft: requiredNumber(patch, "scrollLeft") }),
    ...(optionalString(patch, "focusedPanel") === undefined
      ? {}
      : { focusedPanel: optionalString(patch, "focusedPanel") }),
    ...(optionalString(patch, "presentation") === undefined
      ? {}
      : {
          presentation: requiredString(
            patch,
            "presentation",
          ) as DurableViewRecord["presentation"],
        }),
  };
}

function projectSelection(
  selection: Readonly<Record<string, unknown>>,
): ViewSelection {
  const kind = requiredString(selection, "kind") as ViewSelection["kind"];
  return kind === "none"
    ? { kind: "none" }
    : {
        kind,
        ids: requiredStringArray(selection, "ids"),
      };
}

function projectDurableView(
  view: DurableViewRecord,
  profile: RenderProfile,
): ReturnType<typeof projectViewSnapshot> {
  return projectViewSnapshot(
    {
      viewId: view.viewId,
      projectId: view.projectId,
      viewRevision: view.viewRevision,
      connectedAt: view.connectedAt,
      heartbeatAt: view.heartbeatAt,
      followPresenter: view.followPresenter,
      selectedIds: view.selectedIds,
      playheadSample: view.playheadSample,
      viewport: {
        zoom: view.zoom,
        scrollLeft: view.scrollLeft,
      },
    },
    profile,
    {
      participantIds: view.participantIds,
      ...(view.selectionKind === undefined
        ? {}
        : { selectionKind: view.selectionKind }),
      ...(view.focusedPanel === undefined
        ? {}
        : { focusedPanel: view.focusedPanel }),
      presentation: view.presentation,
    },
  );
}

function durableViewRelativePath(viewId: string): string {
  return `views/${canonicalDigest({ viewId }).slice(7)}.json`;
}

function viewChangedFields(
  patch: Readonly<Record<string, unknown>>,
): string[] {
  const mapped: Record<string, string> = {
    selection: "selection",
    playheadFrame: "playhead",
    zoom: "zoom",
    scrollLeft: "scroll",
    focusedPanel: "focus",
    presentation: "presentation",
  };
  return Object.keys(patch).flatMap((key) =>
    mapped[key] === undefined ? [] : [mapped[key]]
  );
}

function playbackPatch(
  actionKind: string,
  action: Readonly<Record<string, unknown>>,
  viewId: string,
  profile: RenderProfile,
  envelope: ManagedProjectEnvelopeV1<ManagedCoreEditorState>,
): Partial<ManagedProjectEnvelopeV1<ManagedCoreEditorState>["playback"]> {
  switch (actionKind) {
    case "play":
      return { playing: true };
    case "pause":
      return { playing: false };
    case "seek":
      return {
        outputSample: timelineFrameToOutputSample(
          requiredNumber(action, "frame"),
          profile,
        ),
      };
    case "set-rate":
      return { rate: requiredNumber(action, "rate") };
    case "set-master-volume":
      return { masterVolume: requiredNumber(action, "volume") };
    case "set-master-mute":
      return { masterMuted: requiredBoolean(action, "muted") };
    case "claim-presenter":
      return { presenterViewId: viewId };
    case "release-presenter":
      return {
        presenterViewId: envelope.playback.presenterViewId === viewId
          ? null
          : envelope.playback.presenterViewId,
      };
    case "follow":
    case "unfollow":
      return {};
    default:
      throw managedError(
        "INVALID_REQUEST",
        "The playback action is invalid.",
      );
  }
}

function renderProfile(
  envelope: ManagedProjectEnvelopeV1<ManagedCoreEditorState>,
): RenderProfile {
  return envelope.editor.state.snapshot.manifest.renderProfile;
}

function paginate<Item>(
  items: readonly Item[],
  request: Readonly<Record<string, unknown>>,
): {
  items: Item[];
  page: { hasMore: boolean; nextCursor?: string };
} {
  const offset = parsePageCursor(optionalString(request, "cursor"));
  const limit = optionalNumber(request, "limit") ?? 200;
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < items.length;
  return {
    items: pageItems,
    page: {
      hasMore,
      ...(hasMore ? { nextCursor: `page.${nextOffset}` } : {}),
    },
  };
}

function parsePageCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^page\.([0-9]+)$/.exec(cursor);
  if (!match) {
    throw managedError("INVALID_REQUEST", "The page cursor is invalid.");
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw managedError("INVALID_REQUEST", "The page cursor is invalid.");
  }
  return offset;
}

function jsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  return structuredClone(value) as JsonObject;
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredObject(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = record[key];
  if (!isRecord(value)) {
    throw managedError("INVALID_REQUEST", `${key} must be an object.`);
  }
  return value;
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw managedError("INVALID_REQUEST", `${key} must be a string.`);
  }
  return value;
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw managedError("INVALID_REQUEST", `${key} must be a string.`);
  }
  return value;
}

function requiredNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw managedError("INVALID_REQUEST", `${key} must be a finite number.`);
  }
  return value;
}

function optionalNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw managedError("INVALID_REQUEST", `${key} must be a finite number.`);
  }
  return value;
}

function requiredBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw managedError("INVALID_REQUEST", `${key} must be a boolean.`);
  }
  return value;
}

function requiredStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string[] {
  const value = record[key];
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string")
  ) {
    throw managedError("INVALID_REQUEST", `${key} must be a string array.`);
  }
  return [...value] as string[];
}

function optionalStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  return record[key] === undefined
    ? undefined
    : requiredStringArray(record, key);
}
