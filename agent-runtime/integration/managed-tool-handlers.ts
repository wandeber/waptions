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
import type { ArtifactRecord } from "../artifacts/artifact-registry.js";
import type {
  ManagedMutationEnvelope,
  ManagedMutationResult,
  ManagedProjectEnvelopeV1,
} from "../coordinator/types.js";
import type {
  ManagedViewPresence,
} from "../coordinator/view-presence-store.js";
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
import {
  STABLE_ERROR_CODES,
  type StableErrorCode,
} from "../mcp/constants.js";
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
      participantId: string;
      presentation: "inline" | "fullscreen" | "picture-in-picture";
      capabilityTtlSeconds?: number;
    },
    context: CoordinatorCallContext,
  ): Promise<CoordinatorResult>;
}

export interface ManagedStagedOutputDestinationCapabilityV1 {
  schemaVersion: 1;
  destinationId: string;
  grantId: string;
  stagingHandleId: string;
  mode: "create-only";
  outputName: string;
  verifiedParentIdentity: string;
  expiresAt: string;
  overwriteConfirmationId?: string;
}

/**
 * The export authority owns the ephemeral staging registry. A successful call
 * returns a fresh capability that is already consumable by export_start.
 */
export interface ManagedStagedOutputAuthority {
  stageWriteDestination(
    projectId: string,
    input: {
      grantId: string;
      outputName: string;
    },
    context: CoordinatorCallContext,
  ): Promise<ManagedStagedOutputDestinationCapabilityV1>;
}

export interface ManagedProjectValidationIssue {
  code: string;
  path: string;
  message: string;
}

/**
 * Deep validation needs access to hydrated sources and coordinator-owned
 * persistence/CAS state that this projection layer intentionally cannot open.
 */
export interface ManagedProjectValidationAuthority {
  validateProject(
    projectId: string,
    input: {
      manifest: EditorManifestV4;
      scopes: readonly string[];
      deep: boolean;
      state: StateToken;
    },
    context: CoordinatorCallContext,
  ): Promise<{
    valid: boolean;
    issues: readonly ManagedProjectValidationIssue[];
    jobId?: string;
  }>;
}

export interface ManagedArtifactAccessAuthority {
  readRange(
    projectId: string,
    artifact: ArtifactRecord,
    offset: number,
    endExclusive: number,
    context: CoordinatorCallContext,
  ): Promise<{
    bytes: Uint8Array;
    start: number;
    endExclusive: number;
    totalBytes: number;
    digest: string;
  }>;
  canonicalLocalPath?(
    projectId: string,
    artifact: ArtifactRecord,
    context: CoordinatorCallContext,
  ): Promise<string>;
  signedRangeUrl?(
    projectId: string,
    artifact: ArtifactRecord,
    context: CoordinatorCallContext,
  ): Promise<{
    signedRangeUrl: string;
    expiresAt: string;
  }>;
}

export interface ManagedDiagnosticsAuthority {
  readDiagnostics(
    projectId: string,
    sections: readonly string[],
    context: CoordinatorCallContext,
  ): Promise<{
    diagnosticsRevision: number;
    currentBytes: number;
    peakBytes: number;
    reservedDecoderPixelBytes: number;
    leasedDecoderPixelBytes: number;
    decoderSessions: number;
    queueLengths: Readonly<Record<string, number>>;
    evictions: number;
    cancellations: number;
    lateResultDisposals: number;
    leakedResourceAssertions: readonly string[];
  }>;
}

export interface ManagedToolHandlerDependencies {
  coordinator: ManagedCoreCoordinator;
  delegated: ManagedDelegatedToolPort;
  editorRender: ManagedEditorRenderAuthority;
  stagedOutput?: ManagedStagedOutputAuthority;
  projectValidation?: ManagedProjectValidationAuthority;
  artifactAccess?: ManagedArtifactAccessAuthority;
  diagnostics?: ManagedDiagnosticsAuthority;
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
}

interface GraphReference {
  id: string;
  kind: string;
  trackId?: string;
  startFrame?: number;
  endFrame?: number;
  label?: string;
  sourceId?: string;
  sourceKind?: "video-source" | "audio-source" | "video-source-audio";
  sourceStartSeconds?: number;
  sourceEndSeconds?: number;
  sourceStartSample?: number;
  sourceEndSample?: number;
  timelineDurationSamples?: number;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
  visible?: boolean;
  gainDb?: number;
  audioLinkState?: "linked" | "detached";
  audioMuted?: boolean;
  audioGainDb?: number;
  text?: string;
  blockId?: string;
  clipId?: string;
  coreStartSample?: number;
  coreEndSample?: number;
  sourceWordIds?: string[];
  sourceWordCount?: number;
  transcriptRecordId?: string;
  anchorBlockId?: string;
  targetKind?: "video-clip" | "audio-clip" | "subtitle";
  targetTrackId?: string;
  targetId?: string;
  associationKind?: "overlap" | "transcript-bound";
  followPolicy?: "none" | "follow";
  relativeStartOutputSample?: number;
  relativeEndOutputSample?: number;
  revision?: number;
}

const MAX_PUBLIC_ARTIFACT_RANGE_BYTES = 1024 * 1024;

export function createManagedToolHandlers(
  dependencies: ManagedToolHandlerDependencies,
): CanonicalToolRouterDependencies["handlers"] {
  const { coordinator, delegated } = dependencies;
  const participantProjects = new Map<string, string>();

  return {
    waptions_session_list: (call, context) =>
      sessionList(coordinator, call, context),
    waptions_session_open: (call, context) =>
      sessionOpen(dependencies, call, context, participantProjects),
    waptions_session_manage: (call, context) =>
      sessionManage(coordinator, call, context, participantProjects),
    waptions_path_grant: (call, context) =>
      pathGrant(dependencies, call, context),
    waptions_project_get: (call, context) =>
      projectGet(coordinator, call, context),
    waptions_project_import: delegated.waptions_project_import,
    waptions_project_validate: (call, context) =>
      projectValidate(dependencies, call, context),
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
      artifactGet(dependencies, call, context),
    waptions_events_read: (call, context) =>
      eventsRead(coordinator, call, context),
    waptions_view_get: (call, context) =>
      viewGet(coordinator, call, context),
    waptions_view_update: (call, context) =>
      viewUpdate(coordinator, call, context),
    waptions_playback_control: (call, context) =>
      playbackControl(coordinator, call, context),
    waptions_diagnostics_get: (call, context) =>
      diagnosticsGet(dependencies, call, context),
    waptions_editor_render: (call, context) =>
      editorRender(dependencies, call, context, participantProjects),
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
  participantProjects: Map<string, string>,
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
  if (result.ok) {
    dependencies.coordinator.bindParticipant(
      connectionIdForContext(context),
      result.data.participantId,
    );
    participantProjects.set(result.data.participantId, projectId);
  }
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
  participantProjects: Map<string, string>,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const request = call.request;
  const action = requiredObject(request, "action");
  const kind = requiredString(action, "kind");
  const projectId = projectIdForCall(coordinator, call);
  if (kind === "detach") {
    const connectionId = connectionIdForContext(context);
    const result = await coordinator.mutateRegistry(
      projectId,
      managedRequest(call, { action: kind }),
      () => {
        const participantId = coordinator.participantForConnection(
          connectionId,
        );
        if (
          participantId === null
          || participantProjects.get(participantId) !== projectId
        ) {
          throw managedError(
            "SESSION_NOT_FOUND",
            "The caller is not attached to this managed project.",
          );
        }
        return {
          update: (current) => current,
          result: {
            action: "detach",
            status: "detached",
          },
          afterCommit: () => {
            coordinator.detachConnection(connectionId);
          },
        };
      },
    );
    return managedMutationResult(result, (data) => data);
  }
  if (kind === "rename") {
    const current = coordinator.getProject(projectId);
    if (
      current.envelope.archivedAt !== undefined
      || current.envelope.deletedAt !== undefined
    ) {
      return failure(
        "Only an active project may be renamed.",
        current.state,
      );
    }
    const translatedId = canonicalDigest({
      toolName: call.toolName,
      idempotencyKey: requiredString(request, "idempotencyKey"),
      requestHash: call.requestHash,
    }).slice(7, 39);
    const coreBatch: EditorCommandBatchRequest = {
      apiVersion: "2026-07-25",
      toolName: "waptions_edit_apply",
      sessionEpoch: requiredString(request, "sessionEpoch"),
      expected: expectedRevisions(request),
      idempotencyKey: `session-rename-${translatedId}`,
      operations: [{
        operationId: `session-rename-${translatedId}`,
        type: "project.set-name",
        payload: { name: requiredString(action, "name") },
      }],
      history: {
        label: "Rename project",
        category: "project.rename",
      },
    };
    const command: ManagedCoreCommand = {
      kind: "dispatch",
      request: coreBatch,
    };
    const publicRequest = managedRequest(call, command);
    const coreRequest: ManagedMutationEnvelope<ManagedCoreCommand> = {
      ...publicRequest,
      toolName: "waptions_edit_apply",
      idempotencyKey: coreBatch.idempotencyKey,
    };
    const result = await coordinator.renameProjectThroughCore(
      projectId,
      publicRequest,
      coreRequest,
      command,
    );
    return managedMutationResult(result, (data) => data);
  }
  const mutation = managedRequest(call, { action: kind });
  const result = await coordinator.mutateRegistry(
    projectId,
    mutation,
    (envelope) => {
      assertSessionManageTransition(envelope, kind);
      const now = new Date().toISOString();
      return {
        update: (current) => {
          switch (kind) {
            case "archive":
              return { ...current, archivedAt: now };
            case "restore":
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
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { coordinator } = dependencies;
  const request = call.request;
  const action = requiredObject(request, "action");
  const kind = requiredString(action, "kind");
  const projectId = projectIdForCall(coordinator, call);
  const mutation = managedRequest(call, { action: kind });

  if (kind === "add") {
    const publicKind = requiredString(action, "grantKind");
    const outputName = publicKind === "write-destination"
      ? requiredString(action, "outputName")
      : undefined;
    if (outputName !== undefined && dependencies.stagedOutput === undefined) {
      throw managedError(
        "COORDINATOR_UNAVAILABLE",
        "The managed export staging authority is unavailable.",
        true,
      );
    }
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
    const projected = managedMutationResult(result, (data) => data);
    if (!projected.ok || outputName === undefined) return projected;
    const grant = (projected.data.grants as unknown as Array<
      { grantId: string }
    >)[0];
    if (!grant) {
      throw managedError(
        "INTERNAL_ERROR",
        "The managed destination grant result is missing.",
      );
    }
    const destination = await dependencies.stagedOutput!.stageWriteDestination(
      projectId,
      {
        grantId: grant.grantId,
        outputName,
      },
      context,
    );
    validateStagedOutputCapability(destination, grant.grantId, outputName);
    return {
      ...projected,
      data: {
        ...projected.data,
        destination: structuredClone(destination) as unknown as JsonObject,
      },
    };
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
  const captured = coordinator.getProject(projectId);
  assertMutationMatchesCapturedProject(coordinator, call, captured);
  const requestedGrantId = optionalString(action, "grantId");
  const grants = (
    await coordinator.store.readNamespace<SessionPathGrantRecord>(
      projectId,
      "grants",
    )
  ).filter((grant) =>
    requestedGrantId === undefined || grant.grantId === requestedGrantId
  );
  const afterRead = coordinator.getProject(projectId);
  if (
    afterRead.envelope.grantRevision !== captured.envelope.grantRevision
    || afterRead.envelope.eventSequence !== captured.envelope.eventSequence
  ) {
    throw managedError(
      "REVISION_CONFLICT",
      "The managed path grants changed while they were being inspected.",
      true,
    );
  }
  return success({
    action: "inspect",
    grants: grants.map(projectPathGrant),
  }, captured.state);
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
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { coordinator } = dependencies;
  const { envelope, state } = projectForCall(coordinator, call);
  const scopes = optionalStringArray(call.request, "scopes")
    ?? ["structural"];
  const deep = call.request.deep === true;
  if (dependencies.projectValidation !== undefined) {
    const validation = await dependencies.projectValidation.validateProject(
      envelope.projectId,
      {
        manifest: structuredClone(envelope.editor.state.snapshot.manifest),
        scopes,
        deep,
        state: projectStateToken(state),
      },
      context,
    );
    assertCapturedProjectRead(coordinator, envelope, "project validation");
    const issues = validation.issues.slice(0, 500).map(validationIssue);
    return success({
      valid: validation.valid,
      issues,
      ...(validation.jobId === undefined
        ? {}
        : { jobId: boundedIdentity(validation.jobId, "validation job") }),
    }, state);
  }
  if (deep || scopes.some((scope) => scope !== "structural")) {
    return stableFailure(
      "COORDINATOR_UNAVAILABLE",
      "Authoritative deep project validation is unavailable.",
      state,
      true,
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
  assertCapturedAuxiliaryRead(
    coordinator,
    envelope,
    "artifactRevision",
    "artifacts",
  );
  const page = paginate(artifacts, call.request);
  return success({ items: page.items, page: page.page }, state);
}

async function artifactGet(
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { coordinator } = dependencies;
  const presentation = requiredString(call.request, "presentation");
  const { envelope, state } = projectForCall(coordinator, call);
  const artifact = await coordinator.artifacts.get(
    envelope.projectId,
    requiredString(call.request, "artifactId"),
  );
  const projected = projectArtifactRecord(artifact);
  if (presentation === "inline-range") {
    if (dependencies.artifactAccess === undefined) {
      return stableFailure(
        "COORDINATOR_UNAVAILABLE",
        "The managed artifact range authority is unavailable.",
        state,
        true,
      );
    }
    const offset = requiredSafeInteger(call.request, "offset");
    const maxBytes = requiredSafeInteger(call.request, "maxBytes");
    if (
      offset < 0
      || offset > artifact.byteLength
      || maxBytes <= 0
      || maxBytes > MAX_PUBLIC_ARTIFACT_RANGE_BYTES
    ) {
      return stableFailure(
        "INVALID_REQUEST",
        `Artifact ranges are limited to ${MAX_PUBLIC_ARTIFACT_RANGE_BYTES} bytes.`,
        state,
      );
    }
    const nextOffset = Math.min(artifact.byteLength, offset + maxBytes);
    const bytes = offset === nextOffset
      ? new Uint8Array()
      : validateArtifactRange(
        await dependencies.artifactAccess.readRange(
          envelope.projectId,
          artifact,
          offset,
          nextOffset,
          context,
        ),
        artifact,
        offset,
        nextOffset,
      );
    assertCapturedAuxiliaryRead(
      coordinator,
      envelope,
      "artifactRevision",
      "artifact",
    );
    const encoded = encodeArtifactRange(artifact.mediaType, bytes);
    return success({
      presentation: "inline-range",
      artifact: projected,
      mediaType: artifact.mediaType,
      encoding: encoded.encoding,
      data: encoded.data,
      nextOffset,
      done: nextOffset === artifact.byteLength,
      digest: artifact.digest,
    }, state);
  }
  if (presentation === "local-path") {
    if (dependencies.artifactAccess?.canonicalLocalPath === undefined) {
      return stableFailure(
        "COORDINATOR_UNAVAILABLE",
        "The managed artifact local-path authority is unavailable.",
        state,
        true,
      );
    }
    const canonicalLocalPath =
      await dependencies.artifactAccess.canonicalLocalPath(
        envelope.projectId,
        artifact,
        context,
      );
    assertCapturedAuxiliaryRead(
      coordinator,
      envelope,
      "artifactRevision",
      "artifact",
    );
    return success({
      presentation: "local-path",
      artifact: projected,
      canonicalLocalPath,
    }, state);
  }
  if (presentation === "signed-range-url") {
    if (dependencies.artifactAccess?.signedRangeUrl === undefined) {
      return stableFailure(
        "COORDINATOR_UNAVAILABLE",
        "The managed artifact signed-range authority is unavailable.",
        state,
        true,
      );
    }
    const signed = await dependencies.artifactAccess.signedRangeUrl(
      envelope.projectId,
      artifact,
      context,
    );
    if (
      !signed.signedRangeUrl.startsWith("http://localhost:59941/")
      || !isIsoTimestamp(signed.expiresAt)
    ) {
      throw managedError(
        "INTERNAL_ERROR",
        "The managed artifact authority returned an invalid signed range.",
      );
    }
    assertCapturedAuxiliaryRead(
      coordinator,
      envelope,
      "artifactRevision",
      "artifact",
    );
    return success({
      presentation: "signed-range-url",
      artifact: projected,
      signedRangeUrl: signed.signedRangeUrl,
      expiresAt: signed.expiresAt,
    }, state);
  }
  if (presentation !== "metadata") {
    return stableFailure(
      "INVALID_REQUEST",
      "The artifact presentation is invalid.",
      state,
    );
  }
  assertCapturedAuxiliaryRead(
    coordinator,
    envelope,
    "artifactRevision",
    "artifact",
  );
  return success({
    presentation: "metadata",
    artifact: projected,
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
  const boundedEvents = page.events.filter((event) =>
    event.sequence <= envelope.eventSequence
  );
  const nextCursor = boundedEvents.at(-1)?.cursor
    ?? optionalString(call.request, "afterCursor")
    ?? coordinator.events.cursor(envelope.projectId, envelope.sessionId, 0);
  const hasMore = boundedEvents.length === limit
    ? (
      await coordinator.events.read(
        envelope.projectId,
        envelope.sessionId,
        nextCursor,
        1,
      )
    ).events.some((event) => event.sequence <= envelope.eventSequence)
    : false;
  return success({
    events: boundedEvents.map(projectEventRecord),
    nextCursor,
    hasMore,
  }, state);
}

async function viewGet(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const viewId = requiredString(call.request, "viewId");
  const captured = await captureDurableView(
    coordinator,
    projectIdForCall(coordinator, call),
    viewId,
  );
  return success({
    view: projectDurableView(
      captured.view,
      renderProfile(captured.envelope),
      captured.presence,
    ),
  }, captured.state);
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
      if (!existing) {
        throw managedError(
          "NOT_FOUND",
          "The durable view does not exist. Attach it through editor_render first.",
        );
      }
      const presence = requireAttachedViewPresence(
        coordinator,
        projectId,
        viewId,
      );
      const current = existing;
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
      const projected = projectDurableView(
        next,
        renderProfile(envelope),
        coordinator.presence.list(projectId),
      );
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
        afterCommit: () => {
          coordinator.presence.update(presence.viewId, {
            selectedIds: next.selectedIds,
            playheadSample: next.playheadSample,
            viewport: {
              zoom: next.zoom,
              scrollLeft: next.scrollLeft,
            },
          });
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
  const captured = await captureDurableView(coordinator, projectId, viewId);
  const playback = captured.envelope.playback;
  const viewer = requireAttachedViewPresence(coordinator, projectId, viewId);
  if (actionKind === "follow" || actionKind === "unfollow") {
    if (playback.revision !== expectedPlaybackRevision) {
      return playbackRevisionConflict(
        captured.state,
        expectedPlaybackRevision,
        playback.revision,
      );
    }
    const followPresenter = actionKind === "follow";
    if (viewer.followPresenter !== followPresenter) {
      coordinator.presence.update(viewId, { followPresenter });
    }
    const current = coordinator.getProject(projectId);
    return success(
      {
        ...projectPlaybackData(
          current.envelope.playback,
          renderProfile(current.envelope),
          coordinator.presence.list(projectId).find((item) =>
            item.viewId === viewId
          ),
        ),
      },
      current.state,
    );
  }
  const ownershipFailure = playbackOwnershipFailure(
    coordinator,
    projectId,
    viewId,
    actionKind,
    playback.presenterViewId,
  );
  if (ownershipFailure !== undefined) {
    return failure(ownershipFailure, captured.state);
  }
  const update = playbackPatch(
    actionKind,
    action,
    viewId,
    renderProfile(captured.envelope),
    captured.envelope,
  );
  const result = await coordinator.updatePlayback(
    projectId,
    managedRequest(call, { viewId, action }),
    expectedPlaybackRevision,
    update,
  );
  return managedMutationResult(result, ({ playback: updated }) => ({
    ...projectPlaybackData(
      updated,
      renderProfile(coordinator.getProject(projectId).envelope),
      coordinator.presence.list(projectId).find((item) =>
        item.viewId === viewId
      ),
    ),
  }));
}

async function diagnosticsGet(
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
): Promise<CoordinatorResult> {
  context.signal.throwIfAborted();
  const { envelope, state } = projectForCall(dependencies.coordinator, call);
  if (dependencies.diagnostics === undefined) {
    return stableFailure(
      "COORDINATOR_UNAVAILABLE",
      "The authoritative managed diagnostics source is unavailable.",
      state,
      true,
    );
  }
  const diagnostics = await dependencies.diagnostics.readDiagnostics(
    envelope.projectId,
    optionalStringArray(call.request, "sections") ?? ["all"],
    context,
  );
  return success({
    diagnosticsRevision: publicCounter(
      diagnostics.diagnosticsRevision,
      "diagnostics revision",
    ),
    currentBytes: publicCounter(diagnostics.currentBytes, "current bytes"),
    peakBytes: publicCounter(diagnostics.peakBytes, "peak bytes"),
    reservedDecoderPixelBytes: publicCounter(
      diagnostics.reservedDecoderPixelBytes,
      "reserved decoder pixel bytes",
    ),
    leasedDecoderPixelBytes: publicCounter(
      diagnostics.leasedDecoderPixelBytes,
      "leased decoder pixel bytes",
    ),
    decoderSessions: publicCounter(
      diagnostics.decoderSessions,
      "decoder sessions",
    ),
    queueLengths: projectQueueLengths(diagnostics.queueLengths),
    evictions: publicCounter(diagnostics.evictions, "evictions"),
    cancellations: publicCounter(
      diagnostics.cancellations,
      "cancellations",
    ),
    lateResultDisposals: publicCounter(
      diagnostics.lateResultDisposals,
      "late result disposals",
    ),
    leakedResourceAssertions: diagnostics.leakedResourceAssertions.slice(
      0,
      128,
    ).map((assertion) => assertion.slice(0, 512)),
  }, state);
}

async function editorRender(
  dependencies: ManagedToolHandlerDependencies,
  call: CanonicalToolCall,
  context: CoordinatorCallContext,
  participantProjects: Map<string, string>,
): Promise<CoordinatorResult> {
  const projectId = projectIdForCall(dependencies.coordinator, call);
  const participantId = dependencies.coordinator.participantForConnection(
    connectionIdForContext(context),
  );
  if (
    participantId === null
    || participantProjects.get(participantId) !== projectId
  ) {
    return failure(
      "The caller is not attached to this managed project.",
      dependencies.coordinator.getProject(projectId).state,
    );
  }
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
      participantId,
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
  return stableFailure("INVALID_REQUEST", message, state);
}

function stableFailure(
  code: StableErrorCode,
  message: string,
  state?: StateToken,
  retryable = false,
): CoordinatorResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
    ...(state ? { state: projectStateToken(state) } : {}),
  };
}

function managedMutationResult<Result>(
  result: ManagedMutationResult<Result>,
  project: (data: Result) => Readonly<Record<string, unknown>>,
): CoordinatorResult {
  if (!result.ok) {
    const code = canonicalRuntimeErrorCode(result.error.code);
    return {
      ok: false,
      error: {
        code,
        message: result.error.message,
        retryable: canonicalRuntimeErrorRetryable(
          result.error.code,
          result.error.retryable,
        ),
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
  const code = canonicalRuntimeErrorCode(result.error.code);
  return {
    ok: false,
    error: {
      code,
      message: result.error.message,
      retryable: canonicalRuntimeErrorRetryable(
        result.error.code,
        result.error.retryable,
      ),
    },
    state: projectStateToken(state),
  };
}

function canonicalRuntimeErrorCode(code: string): StableErrorCode {
  if (code === "STALE_TRANSCRIPTION_PUBLICATION") {
    return "REVISION_CONFLICT";
  }
  return (STABLE_ERROR_CODES as readonly string[]).includes(code)
    ? code as StableErrorCode
    : "INTERNAL_ERROR";
}

function canonicalRuntimeErrorRetryable(
  code: string,
  retryable: boolean,
): boolean {
  if (code === "STALE_TRANSCRIPTION_PUBLICATION") return true;
  return (STABLE_ERROR_CODES as readonly string[]).includes(code)
    ? retryable
    : false;
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
        visible: track.visible,
        locked: track.locked,
      })),
      ...manifest.audioTracks.map((track) => ({
        id: track.id,
        kind: "audio-track",
        trackId: track.id,
        label: boundedLabel(track.name),
        muted: track.muted,
        solo: track.solo,
        locked: track.locked,
        gainDb: track.gainDb,
      })),
      ...manifest.subtitleTracks.map((track) => ({
        id: track.id,
        kind: "subtitle-track",
        trackId: track.id,
        label: boundedLabel(track.name),
        visible: track.isVisible,
        locked: track.isLocked,
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
        sourceId: clip.sourceId,
        sourceKind: "video-source" as const,
        sourceStartSeconds: clip.sourceStart,
        sourceEndSeconds: clip.sourceEnd,
        ...(clip.audio === null
          ? {}
          : {
              audioLinkState: clip.audio.linkState,
              audioMuted: clip.audio.muted,
              audioGainDb: clip.audio.gainDb,
            }),
      })),
      ...manifest.audioTracks.flatMap((track) =>
        track.clips.map((clip) => {
          const durationFrames = getAudioClipDurationFrames(
            clip,
            manifest.renderProfile.fps,
            manifest.videoSourceDescriptors,
            manifest.audioSourceDescriptors,
          );
          let sourceProjection: Pick<
            GraphReference,
            | "sourceId"
            | "sourceKind"
            | "sourceStartSample"
            | "sourceEndSample"
            | "timelineDurationSamples"
            | "sourceStartSeconds"
            | "sourceEndSeconds"
          >;
          if ("sourceStartSample" in clip) {
            const imported = clip;
            sourceProjection = {
              sourceId: imported.source.audioSourceId,
              sourceKind: "audio-source",
              sourceStartSample: imported.sourceStartSample,
              sourceEndSample: imported.sourceEndSample,
              ...(imported.timelineDurationSamples === undefined
                ? {}
                : {
                    timelineDurationSamples: imported.timelineDurationSamples,
                  }),
            };
          } else {
            const detached = clip;
            sourceProjection = {
              sourceId: detached.source.videoSourceId,
              sourceKind: "video-source-audio",
              sourceStartSeconds: detached.sourceStart,
              sourceEndSeconds: detached.sourceEnd,
            };
          }
          return {
            id: clip.id,
            kind: "audio-clip",
            trackId: track.id,
            startFrame: clip.timelineStartFrame,
            muted: clip.muted,
            gainDb: clip.gainDb,
            ...sourceProjection,
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
          text: subtitle.text.slice(0, 4_096),
        };
      })
    );
  }
  if (entityKind === "narrative-blocks") {
    const narrative = manifest.narrative;
    return narrative
      ? narrative.blockIds.flatMap((blockId) => {
          const block = narrative.blocks[blockId];
          const clip = block === undefined
            ? undefined
            : manifest.videoClips.find((candidate) =>
              candidate.id === block.clipId
            );
          return block
            ? [{
                id: block.id,
                kind: `narrative-${block.kind}`,
                trackId: block.trackId,
                startFrame: block.timelineStartFrame,
                ...(clip === undefined
                  ? {}
                  : {
                      endFrame: block.timelineStartFrame
                        + getVideoClipDurationFramesV4(
                          clip,
                          manifest.renderProfile,
                        ),
                    }),
                blockId: block.id,
                clipId: block.clipId,
                sourceId: block.sourceId,
                sourceKind: "video-source" as const,
                coreStartSample: block.coreStartSample,
                coreEndSample: block.coreEndSample,
                sourceStartFrame: block.materialization.sourceStartFrame,
                sourceEndFrame: block.materialization.sourceEndFrame,
                sourceWordIds: block.sourceWordIds.slice(0, 512),
                sourceWordCount: block.sourceWordIds.length,
                transcriptRecordId: block.transcriptRecordId,
                revision: block.revision,
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
                blockId: block.id,
                sourceId: block.sourceId,
                sourceKind: "video-source" as const,
                transcriptRecordId: block.transcriptRecordId,
              }))
            : [];
        })
      : [];
  }
  if (entityKind === "links") {
    return manifest.dependentLinks.map((link) => {
      const targetId = link.target.kind === "subtitle"
        ? link.target.subtitleId
        : link.target.clipId;
      const targetTrackId = link.target.kind === "video-clip"
        ? undefined
        : link.target.trackId;
      return {
        id: link.id,
        kind: `link:${link.target.kind}`,
        label: boundedLabel(link.followPolicy),
        anchorBlockId: link.anchorBlockId,
        targetKind: link.target.kind,
        ...(targetTrackId === undefined ? {} : { targetTrackId }),
        targetId,
        associationKind: link.association.kind,
        followPolicy: link.followPolicy,
        relativeStartOutputSample: link.relativeStartOutputSample,
        relativeEndOutputSample: link.relativeEndOutputSample,
        revision: link.revision,
      };
    });
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

async function captureDurableView(
  coordinator: ManagedCoreCoordinator,
  projectId: string,
  viewId: string,
): Promise<{
  envelope: ManagedProjectEnvelopeV1<ManagedCoreEditorState>;
  state: StateToken;
  view: DurableViewRecord;
  presence: ManagedViewPresence[];
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const captured = coordinator.getProject(projectId);
    const view = await findDurableView(coordinator, projectId, viewId);
    const afterRead = coordinator.getProject(projectId);
    if (
      captured.envelope.eventSequence !== afterRead.envelope.eventSequence
      || captured.envelope.editor.manifestDigest
        !== afterRead.envelope.editor.manifestDigest
    ) {
      continue;
    }
    if (!view) {
      throw managedError(
        "NOT_FOUND",
        "The durable view does not exist. Attach it through editor_render first.",
      );
    }
    const presence = coordinator.presence.list(projectId);
    if (
      !presence.some((item) =>
        item.viewId === viewId && item.participantId !== undefined
      )
    ) {
      throw managedError(
        "NOT_FOUND",
        "The durable view is not attached to this coordinator.",
      );
    }
    return {
      envelope: captured.envelope,
      state: captured.state,
      view,
      presence,
    };
  }
  throw managedError(
    "COORDINATOR_UNAVAILABLE",
    "The durable view changed while it was being read.",
    true,
  );
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
  presence: readonly ManagedViewPresence[],
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
      participantIds: Array.from(
        new Set(presence.flatMap((item) =>
          item.participantId === undefined ? [] : [item.participantId]
        )),
      ),
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

function requireAttachedViewPresence(
  coordinator: ManagedCoreCoordinator,
  projectId: string,
  viewId: string,
): ManagedViewPresence {
  const presence = coordinator.presence.list(projectId).find((item) =>
    item.viewId === viewId && item.participantId !== undefined
  );
  if (!presence) {
    throw managedError(
      "NOT_FOUND",
      "The durable view is not attached to this coordinator.",
    );
  }
  return presence;
}

function playbackOwnershipFailure(
  coordinator: ManagedCoreCoordinator,
  projectId: string,
  viewId: string,
  actionKind: string,
  presenterViewId: string | null,
): string | undefined {
  if (actionKind === "claim-presenter") {
    const presenterIsAttached = presenterViewId !== null
      && coordinator.presence.list(projectId).some((item) =>
        item.viewId === presenterViewId
      );
    if (
      presenterViewId !== null
      && presenterViewId !== viewId
      && presenterIsAttached
    ) {
      return "Another attached view owns presenter playback.";
    }
    return undefined;
  }
  if (actionKind === "release-presenter") {
    if (presenterViewId !== null && presenterViewId !== viewId) {
      return "Only the presenter view may release presenter playback.";
    }
    return undefined;
  }
  if (presenterViewId !== viewId) {
    return "Claim presenter ownership before controlling shared playback.";
  }
  return undefined;
}

function playbackRevisionConflict(
  state: StateToken,
  expectedRevision: number,
  actualRevision: number,
): CoordinatorResult {
  return {
    ok: false,
    error: {
      code: "REVISION_CONFLICT",
      message: "The durable playback revision changed.",
      retryable: false,
      details: {
        domain: "playback",
        expectedRevision,
        actualRevision,
      },
    },
    state: projectStateToken(state),
  };
}

function assertSessionManageTransition(
  envelope: ManagedProjectEnvelopeV1<ManagedCoreEditorState>,
  kind: string,
): void {
  if (envelope.deletedAt !== undefined) {
    throw managedError(
      "INVALID_REQUEST",
      "A tombstoned project cannot transition to another lifecycle state.",
    );
  }
  if (kind === "archive" && envelope.archivedAt !== undefined) {
    throw managedError("INVALID_REQUEST", "The project is already archived.");
  }
  if (kind === "restore" && envelope.archivedAt === undefined) {
    throw managedError("INVALID_REQUEST", "Only an archived project may be restored.");
  }
}

function assertMutationMatchesCapturedProject(
  coordinator: ManagedCoreCoordinator,
  call: CanonicalToolCall,
  captured: ReturnType<ManagedCoreCoordinator["getProject"]>,
): void {
  const expected = expectedRevisions(call.request);
  if (requiredString(call.request, "sessionEpoch") !== coordinator.epoch) {
    throw managedError(
      "SESSION_EPOCH_MISMATCH",
      "The managed coordinator restarted; refresh state before inspecting grants.",
      true,
    );
  }
  if (
    expected.sessionRevision !== captured.state.sessionRevision
    || expected.documentRevision !== captured.state.documentRevision
    || (
      expected.audioGraphRevision !== undefined
      && expected.audioGraphRevision !== captured.state.audioGraphRevision
    )
    || (
      expected.narrativeRevision !== undefined
      && expected.narrativeRevision !== captured.state.narrativeRevision
    )
  ) {
    throw managedError(
      "REVISION_CONFLICT",
      "The managed project changed before the grants were inspected.",
      true,
    );
  }
}

function assertCapturedAuxiliaryRead(
  coordinator: ManagedCoreCoordinator,
  captured: ManagedProjectEnvelopeV1<ManagedCoreEditorState>,
  revision: "artifactRevision" | "grantRevision",
  label: string,
): void {
  const current = coordinator.getProject(captured.projectId).envelope;
  if (
    current[revision] !== captured[revision]
    || current.eventSequence !== captured.eventSequence
  ) {
    throw managedError(
      "REVISION_CONFLICT",
      `The managed ${label} changed while it was being read.`,
      true,
    );
  }
}

function assertCapturedProjectRead(
  coordinator: ManagedCoreCoordinator,
  captured: ManagedProjectEnvelopeV1<ManagedCoreEditorState>,
  label: string,
): void {
  const current = coordinator.getProject(captured.projectId).envelope;
  const revisionKeys = [
    "sessionRevision",
    "grantRevision",
    "artifactRevision",
    "jobRevision",
    "sourceRegistryRevision",
    "eventSequence",
  ] as const;
  if (
    revisionKeys.some((key) => current[key] !== captured[key])
    || current.playback.revision !== captured.playback.revision
    || current.editor.documentRevision !== captured.editor.documentRevision
    || current.editor.audioGraphRevision !== captured.editor.audioGraphRevision
    || current.editor.narrativeRevision !== captured.editor.narrativeRevision
  ) {
    throw managedError(
      "REVISION_CONFLICT",
      `The managed ${label} changed while it was being read.`,
      true,
    );
  }
}

function validationIssue(
  issue: ManagedProjectValidationIssue,
): ManagedProjectValidationIssue {
  return {
    code: boundedRequiredText(issue.code, 128, "validation issue code"),
    path: boundedRequiredText(issue.path, 512, "validation issue path"),
    message: boundedRequiredText(
      issue.message,
      1_024,
      "validation issue message",
    ),
  };
}

function validateStagedOutputCapability(
  capability: ManagedStagedOutputDestinationCapabilityV1,
  grantId: string,
  outputName: string,
): void {
  if (
    capability.schemaVersion !== 1
    || capability.mode !== "create-only"
    || capability.grantId !== grantId
    || capability.outputName !== outputName
    || !isIsoTimestamp(capability.expiresAt)
    || Date.parse(capability.expiresAt) <= Date.now()
  ) {
    throw managedError(
      "INTERNAL_ERROR",
      "The export staging authority returned an invalid destination capability.",
    );
  }
  for (
    const [label, value] of [
      ["destination", capability.destinationId],
      ["staging handle", capability.stagingHandleId],
      ["verified parent identity", capability.verifiedParentIdentity],
    ] as const
  ) {
    boundedIdentity(value, label);
  }
}

function validateArtifactRange(
  range: Awaited<ReturnType<ManagedArtifactAccessAuthority["readRange"]>>,
  artifact: ArtifactRecord,
  start: number,
  endExclusive: number,
): Uint8Array {
  if (
    !(range.bytes instanceof Uint8Array)
    || range.start !== start
    || range.endExclusive !== endExclusive
    || range.totalBytes !== artifact.byteLength
    || range.digest !== artifact.digest
    || range.bytes.byteLength !== endExclusive - start
  ) {
    throw managedError(
      "INTERNAL_ERROR",
      "The managed artifact authority returned an invalid byte range.",
    );
  }
  return range.bytes;
}

function encodeArtifactRange(
  mediaType: string,
  bytes: Uint8Array,
): { encoding: "utf8" | "base64"; data: string } {
  const normalizedMediaType = mediaType.split(";", 1)[0].trim().toLowerCase();
  const mayUseUtf8 = normalizedMediaType.startsWith("text/")
    || normalizedMediaType === "application/json"
    || normalizedMediaType.endsWith("+json");
  if (mayUseUtf8) {
    try {
      return {
        encoding: "utf8",
        data: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      // A byte-bounded chunk can split a UTF-8 sequence; base64 preserves it exactly.
    }
  }
  return {
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64"),
  };
}

function boundedIdentity(value: string, label: string): string {
  return boundedRequiredText(value, 256, label);
}

function publicCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw managedError(
      "INTERNAL_ERROR",
      `The managed ${label} is invalid.`,
    );
  }
  return value;
}

function projectQueueLengths(
  queueLengths: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(queueLengths).map(([name, length]) => [
      boundedRequiredText(name, 64, "diagnostics queue name"),
      publicCounter(length, `diagnostics queue ${name}`),
    ]),
  );
}

function boundedRequiredText(
  value: string,
  maximumLength: number,
  label: string,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw managedError(
      "INTERNAL_ERROR",
      `The managed ${label} is invalid.`,
    );
  }
  return value;
}

function isIsoTimestamp(value: string): boolean {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function connectionIdForContext(context: CoordinatorCallContext): string {
  const connectionId = (
    context as CoordinatorCallContext & { connectionId?: unknown }
  ).connectionId;
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw managedError(
      "COORDINATOR_UNAVAILABLE",
      "The managed caller connection identity is unavailable.",
      true,
    );
  }
  return connectionId;
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

function requiredSafeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = requiredNumber(record, key);
  if (!Number.isSafeInteger(value)) {
    throw managedError("INVALID_REQUEST", `${key} must be a safe integer.`);
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
