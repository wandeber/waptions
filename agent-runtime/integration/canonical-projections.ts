import type { ArtifactRecord } from "../artifacts/artifact-registry.js";
import type {
  ManagedPlaybackState,
  StateToken as ManagedStateToken,
} from "../coordinator/types.js";
import type { ManagedViewPresence } from "../coordinator/view-presence-store.js";
import type { ManagedEvent } from "../events/event-log.js";
import type {
  DurableJobRecord,
  DurableJobState,
} from "../jobs/durable-job-scheduler.js";
import {
  outputFramesToSamples,
  samplesToOutputFrames,
} from "../../src/lib/render-profile";
import type { RenderProfile } from "../../src/types/video";
import {
  WAPTIONS_EVENT_TYPES,
  WAPTIONS_JOB_KINDS,
  type StateToken,
  type WaptionsEventRecordV1,
  type WaptionsStableErrorCode,
} from "../../src/types/waptions-agent-protocol";

const ARTIFACT_KINDS = [
  "contact-sheet",
  "thumbnail-strip",
  "waveform",
  "audio-map",
  "silence-speech-map",
  "scene-cuts",
  "review-proxy",
  "transcript",
  "project-bundle",
  "reference-snapshot",
  "proof-record",
  "video-export",
  "validation-report",
] as const;

const SELECTION_KINDS = [
  "tracks",
  "clips",
  "subtitles",
  "narrative",
] as const;

const PRESENTATIONS = [
  "inline",
  "fullscreen",
  "picture-in-picture",
] as const;

type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
type SelectionKind = (typeof SELECTION_KINDS)[number];
type Presentation = (typeof PRESENTATIONS)[number];
type EventType = (typeof WAPTIONS_EVENT_TYPES)[number];
type JobKind = (typeof WAPTIONS_JOB_KINDS)[number];
type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale"
  | "interrupted";

export type CanonicalStateToken = StateToken;

export interface CanonicalErrorDetails {
  operationId?: string;
  resourceKind?: string;
  domain?: "session" | "document" | "audio" | "narrative" | "view" | "playback";
  expectedRevision?: number;
  actualRevision?: number;
  limitBytes?: number;
  grantId?: string;
  jobId?: string;
  cursor?: string;
}

export interface JobRecordV1 {
  schemaVersion: 1;
  jobId: string;
  projectId: string;
  kind: JobKind;
  inputDigest: `sha256:${string}`;
  capturedState: StateToken;
  jobSequence: number;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  stage: string;
  fraction?: number;
  message?: string;
  cancellationRequested: boolean;
  cancellationRequestedAt?: string;
  checkpointRef?: string;
  resultArtifactIds: string[];
  error?: {
    code: WaptionsStableErrorCode;
    message: string;
    retryable: boolean;
    details?: CanonicalErrorDetails;
  };
}

export interface ArtifactRecordV1 {
  schemaVersion: 1;
  artifactId: string;
  projectId: string;
  jobId?: string;
  kind: ArtifactKind;
  contentDigest: `sha256:${string}`;
  byteLength: number;
  createdAt: string;
  expiresAt?: string;
  storageRef: string;
}

export type ViewSelection =
  | { kind: "none" }
  | {
      kind: SelectionKind;
      ids: string[];
    };

export interface ViewSnapshot {
  viewId: string;
  viewRevision: number;
  selection: ViewSelection;
  playheadFrame: number;
  zoom: number;
  scrollLeft: number;
  focusedPanel?: string;
  presentation: Presentation;
  participantIds: string[];
}

export interface PlaybackData {
  playbackRevision: number;
  playing: boolean;
  playheadFrame: number;
  rate: number;
  masterVolume: number;
  masterMuted: boolean;
  presenterViewId?: string;
  followingPresenter: boolean;
}

interface EventDataByType {
  "session.recovered": {
    previousEpoch?: string;
    newEpoch: string;
    outcome: "clean" | "wal-replayed" | "wal-rolled-back" | "degraded";
    interruptedJobIds: string[];
  };
  "project.snapshot": {
    manifestDigest: `sha256:${string}`;
    reason: "opened" | "recovered" | "refreshed";
  };
  "project.mutated": {
    commandId: string;
    planId?: string;
    historyEntryId?: string;
    operationIds: string[];
    affectedIds: string[];
  };
  "history.changed": {
    currentIndex: number;
    undoCount: number;
    redoCount: number;
    headEntryId?: string;
  };
  "job.changed": {
    jobId: string;
    kind: JobKind;
    state: JobState;
    jobSequence: number;
    stage: string;
    fraction?: number;
    message?: string;
  };
  "artifact.created": {
    artifactId: string;
    jobId?: string;
    kind: string;
    contentDigest: `sha256:${string}`;
    byteLength: number;
  };
  "diagnostics.changed": {
    diagnosticsRevision: number;
    reason:
      | "threshold-crossed"
      | "leak-assertion"
      | "budget-pressure"
      | "job-queue";
  };
  "presence.changed": {
    presenceRevision: number;
    participantIds: string[];
  };
  "view.changed": {
    viewId: string;
    viewRevision: number;
    changedFields: Array<
      | "selection"
      | "playhead"
      | "zoom"
      | "scroll"
      | "rowHeights"
      | "layout"
      | "focus"
      | "presentation"
    >;
  };
  "source.invalidated": {
    sourceId: string;
    reason: "identity-changed" | "grant-revoked" | "unreadable" | "removed";
    observedIdentityDigest?: `sha256:${string}`;
  };
}

type EventRecordBase = Omit<WaptionsEventRecordV1, "type" | "data">;

export type EventRecordV1 = {
  [Type in EventType]: EventRecordBase & {
    type: Type;
    data: EventDataByType[Type];
  };
}[EventType];

export interface ViewProjectionOptions {
  participantIds: readonly string[];
  selectionKind?: SelectionKind;
  focusedPanel?: string;
  presentation?: Presentation;
}

export class CanonicalProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalProjectionError";
  }
}

export function projectStateToken(
  token: ManagedStateToken,
): CanonicalStateToken {
  return {
    sessionId: opaqueId(token.sessionId, "state.sessionId"),
    projectId: opaqueId(token.projectId, "state.projectId"),
    sessionEpoch: opaqueId(token.sessionEpoch, "state.sessionEpoch"),
    sessionRevision: safeInteger(
      token.sessionRevision,
      "state.sessionRevision",
    ),
    documentRevision: safeInteger(
      token.documentRevision,
      "state.documentRevision",
    ),
    audioGraphRevision: safeInteger(
      token.audioGraphRevision,
      "state.audioGraphRevision",
    ),
    ...(token.narrativeRevision === undefined
      ? {}
      : {
          narrativeRevision: safeInteger(
            token.narrativeRevision,
            "state.narrativeRevision",
          ),
        }),
    eventCursor: opaqueId(token.eventCursor, "state.eventCursor"),
  };
}

export function projectJobRecord(
  record: DurableJobRecord,
): JobRecordV1 {
  const state = projectJobState(record.state);
  const error = record.error === undefined
    ? undefined
    : {
        code: record.error.code as WaptionsStableErrorCode,
        message: boundedString(record.error.message, 2_048, "job.error.message"),
        retryable: record.error.retryable,
        ...projectErrorDetails(record.error.details),
      };
  return {
    schemaVersion: 1,
    jobId: opaqueId(record.jobId, "job.jobId"),
    projectId: opaqueId(record.projectId, "job.projectId"),
    kind: jobKind(record.kind),
    inputDigest: sha256(record.inputDigest, "job.inputDigest"),
    capturedState: projectStateToken(record.capturedState),
    jobSequence: safeInteger(record.sequence, "job.sequence"),
    state,
    createdAt: isoTimestamp(record.createdAt, "job.createdAt"),
    updatedAt: isoTimestamp(record.updatedAt, "job.updatedAt"),
    ...(record.startedAt === undefined
      ? {}
      : { startedAt: isoTimestamp(record.startedAt, "job.startedAt") }),
    ...(record.finishedAt === undefined
      ? {}
      : { finishedAt: isoTimestamp(record.finishedAt, "job.finishedAt") }),
    stage: nonEmptyBoundedString(record.stage, 128, "job.stage"),
    ...(record.fraction === undefined
      ? {}
      : { fraction: finiteRange(record.fraction, 0, 1, "job.fraction") }),
    ...(record.message === undefined
      ? {}
      : { message: boundedString(record.message, 1_024, "job.message") }),
    cancellationRequested:
      record.state === "cancelling"
      || record.cancellationRequestedAt !== undefined,
    ...(record.cancellationRequestedAt === undefined
      ? {}
      : {
          cancellationRequestedAt: isoTimestamp(
            record.cancellationRequestedAt,
            "job.cancellationRequestedAt",
          ),
        }),
    resultArtifactIds: uniqueOpaqueIds(
      record.resultArtifactIds,
      256,
      "job.resultArtifactIds",
    ),
    ...(error === undefined ? {} : { error }),
  };
}

export function projectArtifactRecord(
  record: ArtifactRecord,
): ArtifactRecordV1 {
  const artifactId = opaqueId(record.artifactId, "artifact.artifactId");
  return {
    schemaVersion: 1,
    artifactId,
    projectId: opaqueId(record.projectId, "artifact.projectId"),
    kind: artifactKind(record.kind),
    contentDigest: sha256(record.digest, "artifact.digest"),
    byteLength: safeInteger(record.byteLength, "artifact.byteLength"),
    createdAt: isoTimestamp(record.createdAt, "artifact.createdAt"),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: isoTimestamp(record.expiresAt, "artifact.expiresAt") }),
    // The artifact id is already the public lookup authority; filesystem locations stay private.
    storageRef: artifactId,
  };
}

export function projectEventRecord(
  event: ManagedEvent,
): EventRecordV1 {
  const base: EventRecordBase = {
    schemaVersion: 1,
    cursor: opaqueId(event.cursor, "event.cursor"),
    occurredAt: isoTimestamp(event.occurredAt, "event.occurredAt"),
    state: projectStateToken(event.state),
    sequence: safeInteger(event.sequence, "event.sequence"),
  };
  const data = event.data;
  switch (event.type) {
    case "session.recovered":
      return {
        ...base,
        type: event.type,
        data: {
          ...optionalOpaqueId(data, "previousEpoch", "event.previousEpoch"),
          newEpoch: requiredOpaqueId(data, "newEpoch", "event.newEpoch"),
          outcome: requiredEnum(
            data,
            "outcome",
            ["clean", "wal-replayed", "wal-rolled-back", "degraded"] as const,
            "event.outcome",
          ),
          interruptedJobIds: requiredOpaqueIds(
            data,
            "interruptedJobIds",
            256,
            "event.interruptedJobIds",
          ),
        },
      };
    case "project.snapshot":
      return {
        ...base,
        type: event.type,
        data: {
          manifestDigest: requiredSha256(
            data,
            "manifestDigest",
            "event.manifestDigest",
          ),
          reason: requiredEnum(
            data,
            "reason",
            ["opened", "recovered", "refreshed"] as const,
            "event.reason",
          ),
        },
      };
    case "project.mutated":
      return {
        ...base,
        type: event.type,
        data: {
          commandId: requiredOpaqueId(data, "commandId", "event.commandId"),
          ...optionalOpaqueId(data, "planId", "event.planId"),
          ...optionalOpaqueId(
            data,
            "historyEntryId",
            "event.historyEntryId",
          ),
          operationIds: requiredOpaqueIds(
            data,
            "operationIds",
            256,
            "event.operationIds",
          ),
          affectedIds: requiredOpaqueIds(
            data,
            "affectedIds",
            1_024,
            "event.affectedIds",
          ),
        },
      };
    case "history.changed":
      return {
        ...base,
        type: event.type,
        data: {
          currentIndex: requiredIntegerRange(
            data,
            "currentIndex",
            -1,
            Number.MAX_SAFE_INTEGER,
            "event.currentIndex",
          ),
          undoCount: requiredSafeInteger(data, "undoCount", "event.undoCount"),
          redoCount: requiredSafeInteger(data, "redoCount", "event.redoCount"),
          ...optionalOpaqueId(data, "headEntryId", "event.headEntryId"),
        },
      };
    case "job.changed":
      return {
        ...base,
        type: event.type,
        data: {
          jobId: requiredOpaqueId(data, "jobId", "event.jobId"),
          kind: jobKind(requiredString(data, "kind", "event.kind")),
          state: publicJobState(
            requiredString(data, "state", "event.state"),
            "event.state",
          ),
          jobSequence: requiredSafeInteger(
            data,
            "jobSequence",
            "event.jobSequence",
          ),
          stage: requiredNonEmptyBoundedString(
            data,
            "stage",
            128,
            "event.stage",
          ),
          ...optionalFiniteRange(
            data,
            "fraction",
            0,
            1,
            "event.fraction",
          ),
          ...optionalBoundedString(data, "message", 1_024, "event.message"),
        },
      };
    case "artifact.created":
      return {
        ...base,
        type: event.type,
        data: {
          artifactId: requiredOpaqueId(
            data,
            "artifactId",
            "event.artifactId",
          ),
          ...optionalOpaqueId(data, "jobId", "event.jobId"),
          kind: requiredNonEmptyBoundedString(
            data,
            "kind",
            64,
            "event.kind",
          ),
          contentDigest: requiredSha256(
            data,
            "contentDigest",
            "event.contentDigest",
          ),
          byteLength: requiredSafeInteger(
            data,
            "byteLength",
            "event.byteLength",
          ),
        },
      };
    case "diagnostics.changed":
      return {
        ...base,
        type: event.type,
        data: {
          diagnosticsRevision: requiredSafeInteger(
            data,
            "diagnosticsRevision",
            "event.diagnosticsRevision",
          ),
          reason: requiredEnum(
            data,
            "reason",
            [
              "threshold-crossed",
              "leak-assertion",
              "budget-pressure",
              "job-queue",
            ] as const,
            "event.reason",
          ),
        },
      };
    case "presence.changed":
      return {
        ...base,
        type: event.type,
        data: {
          presenceRevision: requiredSafeInteger(
            data,
            "presenceRevision",
            "event.presenceRevision",
          ),
          participantIds: requiredOpaqueIds(
            data,
            "participantIds",
            128,
            "event.participantIds",
          ),
        },
      };
    case "view.changed":
      return {
        ...base,
        type: event.type,
        data: {
          viewId: requiredOpaqueId(data, "viewId", "event.viewId"),
          viewRevision: requiredSafeInteger(
            data,
            "viewRevision",
            "event.viewRevision",
          ),
          changedFields: requiredEnums(
            data,
            "changedFields",
            [
              "selection",
              "playhead",
              "zoom",
              "scroll",
              "rowHeights",
              "layout",
              "focus",
              "presentation",
            ] as const,
            32,
            "event.changedFields",
          ),
        },
      };
    case "source.invalidated":
      return {
        ...base,
        type: event.type,
        data: {
          sourceId: requiredOpaqueId(data, "sourceId", "event.sourceId"),
          reason: requiredEnum(
            data,
            "reason",
            [
              "identity-changed",
              "grant-revoked",
              "unreadable",
              "removed",
            ] as const,
            "event.reason",
          ),
          ...optionalSha256(
            data,
            "observedIdentityDigest",
            "event.observedIdentityDigest",
          ),
        },
      };
    default:
      throw new CanonicalProjectionError(
        `Managed event type is not canonical: ${event.type}`,
      );
  }
}

export function projectViewSnapshot(
  presence: ManagedViewPresence,
  renderProfile: RenderProfile,
  options: ViewProjectionOptions,
): ViewSnapshot {
  const selectedIds = uniqueOpaqueIds(
    presence.selectedIds,
    256,
    "view.selection.ids",
  );
  if (selectedIds.length > 0 && options.selectionKind === undefined) {
    throw new CanonicalProjectionError(
      "A non-empty managed selection requires an explicit canonical selection kind.",
    );
  }
  const selection: ViewSelection = selectedIds.length === 0
    ? { kind: "none" }
    : {
        kind: requiredMember(
          options.selectionKind,
          SELECTION_KINDS,
          "view.selection.kind",
        ),
        ids: selectedIds,
      };
  const zoom = viewportNumber(presence.viewport, "zoom", 1);
  const scrollLeft = viewportNumber(presence.viewport, "scrollLeft", 0);
  return {
    viewId: opaqueId(presence.viewId, "view.viewId"),
    viewRevision: safeInteger(presence.viewRevision, "view.viewRevision"),
    selection,
    playheadFrame: outputSampleToTimelineFrame(
      presence.playheadSample ?? 0,
      renderProfile,
    ),
    zoom: finiteRange(zoom, 0, Number.MAX_VALUE, "view.zoom"),
    scrollLeft: finiteRange(
      scrollLeft,
      0,
      Number.MAX_VALUE,
      "view.scrollLeft",
    ),
    ...(options.focusedPanel === undefined
      ? {}
      : {
          focusedPanel: boundedString(
            options.focusedPanel,
            128,
            "view.focusedPanel",
          ),
        }),
    presentation: requiredMember(
      options.presentation ?? "inline",
      PRESENTATIONS,
      "view.presentation",
    ),
    participantIds: uniqueOpaqueIds(
      options.participantIds,
      128,
      "view.participantIds",
    ),
  };
}

export function projectPlaybackData(
  playback: ManagedPlaybackState,
  renderProfile: RenderProfile,
  viewer?: Pick<ManagedViewPresence, "followPresenter">,
): PlaybackData {
  return {
    playbackRevision: safeInteger(
      playback.revision,
      "playback.playbackRevision",
    ),
    playing: playback.playing,
    playheadFrame: outputSampleToTimelineFrame(
      playback.outputSample,
      renderProfile,
    ),
    rate: finiteRange(playback.rate, Number.MIN_VALUE, 16, "playback.rate"),
    masterVolume: finiteRange(
      playback.masterVolume,
      0,
      1,
      "playback.masterVolume",
    ),
    masterMuted: playback.masterMuted,
    ...(playback.presenterViewId === null
      ? {}
      : {
          presenterViewId: opaqueId(
            playback.presenterViewId,
            "playback.presenterViewId",
          ),
        }),
    followingPresenter:
      viewer?.followPresenter === true
      && playback.presenterViewId !== null,
  };
}

export function outputSampleToTimelineFrame(
  outputSample: number,
  renderProfile: RenderProfile,
): number {
  assertRenderProfileTimebase(renderProfile);
  return samplesToOutputFrames(outputSample, renderProfile.fps, "nearest");
}

export function timelineFrameToOutputSample(
  frame: number,
  renderProfile: RenderProfile,
): number {
  assertRenderProfileTimebase(renderProfile);
  return outputFramesToSamples(frame, renderProfile.fps, "nearest");
}

function projectJobState(state: DurableJobState): JobState {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
    case "cancelling":
      return "running";
    case "cancelled":
      return "cancelled";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stale":
      return "stale";
    case "interrupted":
      return "interrupted";
  }
}

function publicJobState(
  state: string,
  field: string,
): JobState {
  return requiredMember(
    state,
    [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "stale",
      "interrupted",
    ] as const,
    field,
  );
}

function projectErrorDetails(
  details: Readonly<Record<string, string | number | boolean | null>> | undefined,
): { details?: CanonicalErrorDetails } {
  if (details === undefined) return {};
  const projected: CanonicalErrorDetails = {};
  if (typeof details.operationId === "string") {
    projected.operationId = opaqueId(
      details.operationId,
      "job.error.details.operationId",
    );
  }
  if (typeof details.resourceKind === "string") {
    projected.resourceKind = nonEmptyBoundedString(
      details.resourceKind,
      64,
      "job.error.details.resourceKind",
    );
  }
  if (
    details.domain === "session"
    || details.domain === "document"
    || details.domain === "audio"
    || details.domain === "narrative"
    || details.domain === "view"
    || details.domain === "playback"
  ) {
    projected.domain = details.domain;
  }
  for (const key of [
    "expectedRevision",
    "actualRevision",
    "limitBytes",
  ] as const) {
    if (typeof details[key] === "number") {
      projected[key] = safeInteger(
        details[key],
        `job.error.details.${key}`,
      );
    }
  }
  for (const key of ["grantId", "jobId", "cursor"] as const) {
    if (typeof details[key] === "string") {
      projected[key] = opaqueId(
        details[key],
        `job.error.details.${key}`,
      );
    }
  }
  return Object.keys(projected).length === 0 ? {} : { details: projected };
}

function assertRenderProfileTimebase(profile: RenderProfile): void {
  if (profile.audioSampleRate !== 48_000) {
    throw new CanonicalProjectionError(
      "Canonical playback projection requires a 48 kHz render profile.",
    );
  }
  safePositiveInteger(profile.fps.numerator, "renderProfile.fps.numerator");
  safePositiveInteger(profile.fps.denominator, "renderProfile.fps.denominator");
}

function viewportNumber(
  viewport: Readonly<Record<string, number>> | undefined,
  key: string,
  fallback: number,
): number {
  return viewport?.[key] ?? fallback;
}

function artifactKind(value: string): ArtifactKind {
  return requiredMember(value, ARTIFACT_KINDS, "artifact.kind");
}

function jobKind(value: string): JobKind {
  return requiredMember(value, WAPTIONS_JOB_KINDS, "job.kind");
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new CanonicalProjectionError(`${field} must be a string.`);
  }
  return value;
}

function requiredOpaqueId(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): string {
  return opaqueId(requiredString(record, key, field), field);
}

function optionalOpaqueId(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): Record<string, string> {
  if (record[key] === undefined) return {};
  return { [key]: requiredOpaqueId(record, key, field) };
}

function requiredSha256(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): `sha256:${string}` {
  return sha256(requiredString(record, key, field), field);
}

function optionalSha256(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): Record<string, `sha256:${string}`> {
  if (record[key] === undefined) return {};
  return { [key]: requiredSha256(record, key, field) };
}

function requiredSafeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): number {
  return safeInteger(record[key], field);
}

function requiredIntegerRange(
  record: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const value = record[key];
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new CanonicalProjectionError(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function requiredNonEmptyBoundedString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
  field: string,
): string {
  return nonEmptyBoundedString(
    requiredString(record, key, field),
    maximumLength,
    field,
  );
}

function optionalBoundedString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
  field: string,
): Record<string, string> {
  if (record[key] === undefined) return {};
  return {
    [key]: boundedString(
      requiredString(record, key, field),
      maximumLength,
      field,
    ),
  };
}

function optionalFiniteRange(
  record: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
  field: string,
): Record<string, number> {
  if (record[key] === undefined) return {};
  return {
    [key]: finiteRange(record[key], minimum, maximum, field),
  };
}

function requiredOpaqueIds(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximumItems: number,
  field: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new CanonicalProjectionError(`${field} must be an array.`);
  }
  return uniqueOpaqueIds(value, maximumItems, field);
}

function requiredEnums<const Values extends readonly string[]>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  allowed: Values,
  maximumItems: number,
  field: string,
): Values[number][] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new CanonicalProjectionError(`${field} must be an array.`);
  }
  if (value.length > maximumItems) {
    throw new CanonicalProjectionError(
      `${field} exceeds ${maximumItems} items.`,
    );
  }
  const projected = value.map((item) => requiredMember(item, allowed, field));
  if (new Set(projected).size !== projected.length) {
    throw new CanonicalProjectionError(`${field} must contain unique values.`);
  }
  return projected;
}

function requiredEnum<const Values extends readonly string[]>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  allowed: Values,
  field: string,
): Values[number] {
  return requiredMember(record[key], allowed, field);
}

function requiredMember<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string,
): Values[number] {
  if (
    typeof value !== "string"
    || !(allowed as readonly string[]).includes(value)
  ) {
    throw new CanonicalProjectionError(
      `${field} is outside the canonical vocabulary.`,
    );
  }
  return value as Values[number];
}

function uniqueOpaqueIds(
  values: readonly unknown[],
  maximumItems: number,
  field: string,
): string[] {
  if (values.length > maximumItems) {
    throw new CanonicalProjectionError(
      `${field} exceeds ${maximumItems} items.`,
    );
  }
  const projected = values.map((value, index) =>
    opaqueId(value, `${field}[${index}]`)
  );
  if (new Set(projected).size !== projected.length) {
    throw new CanonicalProjectionError(`${field} must contain unique values.`);
  }
  return projected;
}

function sha256(value: unknown, field: string): `sha256:${string}` {
  if (
    typeof value !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(value)
  ) {
    throw new CanonicalProjectionError(
      `${field} must be a lowercase SHA-256 digest.`,
    );
  }
  return value as `sha256:${string}`;
}

function opaqueId(value: unknown, field: string): string {
  return nonEmptyBoundedString(value, 256, field);
}

function safePositiveInteger(value: unknown, field: string): number {
  const projected = safeInteger(value, field);
  if (projected === 0) {
    throw new CanonicalProjectionError(`${field} must be positive.`);
  }
  return projected;
}

function safeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new CanonicalProjectionError(
      `${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function finiteRange(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new CanonicalProjectionError(
      `${field} must be finite and between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function nonEmptyBoundedString(
  value: unknown,
  maximumLength: number,
  field: string,
): string {
  const projected = boundedString(value, maximumLength, field);
  if (projected.length === 0) {
    throw new CanonicalProjectionError(`${field} cannot be empty.`);
  }
  return projected;
}

function boundedString(
  value: unknown,
  maximumLength: number,
  field: string,
): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new CanonicalProjectionError(
      `${field} must be a string no longer than ${maximumLength} characters.`,
    );
  }
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const projected = nonEmptyBoundedString(value, 64, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(projected)
    || !Number.isFinite(Date.parse(projected))
  ) {
    throw new CanonicalProjectionError(
      `${field} must be an ISO-8601 UTC timestamp.`,
    );
  }
  return projected;
}
