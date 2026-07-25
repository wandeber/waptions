import { describe, expect, it } from "vitest";

import type { ArtifactRecord } from "../artifacts/artifact-registry.js";
import type {
  ManagedPlaybackState,
  StateToken,
} from "../coordinator/types.js";
import type { ManagedViewPresence } from "../coordinator/view-presence-store.js";
import type { ManagedEvent } from "../events/event-log.js";
import type { DurableJobRecord } from "../jobs/durable-job-scheduler.js";
import {
  loadCommittedCoreSemanticSchemaBundle,
} from "../mcp/core-schema-loader.js";
import type { WaptionsToolName } from "../mcp/constants.js";
import { ToolSchemaValidator } from "../mcp/schema-validator.js";
import type { RenderProfile } from "../../src/types/video";
import {
  CanonicalProjectionError,
  outputSampleToTimelineFrame,
  projectArtifactRecord,
  projectEventRecord,
  projectJobRecord,
  projectPlaybackData,
  projectStateToken,
  projectViewSnapshot,
  timelineFrameToOutputSample,
} from "./canonical-projections.js";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const SECOND_DIGEST = `sha256:${"b".repeat(64)}` as const;

const state: StateToken = {
  sessionId: "session-1",
  projectId: "project-1",
  sessionEpoch: "epoch-1",
  sessionRevision: 7,
  documentRevision: 5,
  audioGraphRevision: 3,
  narrativeRevision: 2,
  eventCursor: "cursor-9",
};

const renderProfile: RenderProfile = {
  fps: {
    numerator: 30_000,
    denominator: 1_001,
  },
  width: 1_920,
  height: 1_080,
  audioSampleRate: 48_000,
  isFrameRateLocked: true,
  isCanvasSizeLocked: true,
};

const bundle = loadCommittedCoreSemanticSchemaBundle();
const validator = new ToolSchemaValidator();

function expectCanonicalOutput(
  toolName: WaptionsToolName,
  data: unknown,
): void {
  expect(validator.validateOutput(
    bundle.toolSchemas[toolName].outputSchema,
    {
      ok: true,
      data,
      state: projectStateToken(state),
      warnings: [],
      replayed: false,
    },
  )).toBe(true);
}

describe("canonical runtime projections", () => {
  it("closes state tokens without forwarding internal properties", () => {
    const projected = projectStateToken({
      ...state,
      canonicalPath: "/private/project",
      capabilitySecret: "sk-secret",
    } as StateToken & {
      canonicalPath: string;
      capabilitySecret: string;
    });

    expect(projected).toEqual(state);
    expect(Object.keys(projected)).toEqual([
      "sessionId",
      "projectId",
      "sessionEpoch",
      "sessionRevision",
      "documentRevision",
      "audioGraphRevision",
      "narrativeRevision",
      "eventCursor",
    ]);
  });

  it("projects durable jobs to JobRecordV1 without input, checkpoint, result, or secrets", () => {
    const record: DurableJobRecord = {
      schemaVersion: 1,
      jobId: "job-1",
      projectId: state.projectId,
      kind: "contact-sheet",
      input: {
        canonicalPath: "/private/source.mov",
        apiKey: "sk-secret",
      },
      inputDigest: DIGEST,
      capturedState: state,
      sequence: 4,
      state: "cancelling",
      stage: "rendering",
      fraction: 0.5,
      message: "Rendering contact sheet.",
      checkpoint: {
        temporaryPath: "/private/checkpoint",
        token: "checkpoint-secret",
      },
      result: {
        signedUrl: "https://secret.invalid/result",
      },
      resultArtifactIds: ["artifact-1"],
      cancellable: true,
      resumable: true,
      cancellationRequestedAt: "2026-07-25T09:00:02.000Z",
      createdAt: "2026-07-25T09:00:00.000Z",
      startedAt: "2026-07-25T09:00:01.000Z",
      updatedAt: "2026-07-25T09:00:02.000Z",
      error: {
        code: "INVALID_OPERATION",
        message: "The operation failed safely.",
        retryable: false,
        details: {
          jobId: "job-1",
          canonicalPath: "/private/source.mov",
          secret: "sk-secret",
        },
      },
    };

    const projected = projectJobRecord(record);

    expect(projected).toMatchObject({
      schemaVersion: 1,
      jobId: "job-1",
      kind: "contact-sheet",
      jobSequence: 4,
      state: "running",
      cancellationRequested: true,
      error: {
        details: {
          jobId: "job-1",
        },
      },
    });
    expect(projected).not.toHaveProperty("input");
    expect(projected).not.toHaveProperty("checkpoint");
    expect(projected).not.toHaveProperty("result");
    expect(projected).not.toHaveProperty("cancellable");
    expect(projected).not.toHaveProperty("resumable");
    expect(JSON.stringify(projected)).not.toContain("/private");
    expect(JSON.stringify(projected)).not.toContain("secret");
    expectCanonicalOutput("waptions_job_get", { job: projected });

    expect(() => projectJobRecord({
      ...record,
      kind: "private-maintenance-job",
    })).toThrow(CanonicalProjectionError);
  });

  it("projects artifact metadata with an opaque path-free storage reference", () => {
    const artifact: ArtifactRecord = {
      schemaVersion: 1,
      artifactId: "artifact-1",
      projectId: state.projectId,
      kind: "review-proxy",
      mediaType: "video/mp4",
      byteLength: 1_024,
      digest: SECOND_DIGEST,
      relativeBlobPath: "blobs/private-source-name.blob",
      createdAt: "2026-07-25T09:00:00.000Z",
      expiresAt: "2026-07-26T09:00:00.000Z",
      sourceIds: ["private-source-id"],
    };

    const projected = projectArtifactRecord(artifact);

    expect(projected).toEqual({
      schemaVersion: 1,
      artifactId: "artifact-1",
      projectId: state.projectId,
      kind: "review-proxy",
      contentDigest: SECOND_DIGEST,
      byteLength: 1_024,
      createdAt: "2026-07-25T09:00:00.000Z",
      expiresAt: "2026-07-26T09:00:00.000Z",
      storageRef: "artifact-1",
    });
    expect(JSON.stringify(projected)).not.toContain("private-source");
    expectCanonicalOutput("waptions_artifact_get", {
      presentation: "metadata",
      artifact: projected,
    });

    expect(() => projectArtifactRecord({
      ...artifact,
      kind: "private-debug-dump",
    })).toThrow(CanonicalProjectionError);
  });

  it("projects every canonical event kind with closed schema-owned data", () => {
    const cases: Array<{
      type: ManagedEvent["type"];
      data: Record<string, unknown>;
    }> = [
      {
        type: "session.recovered",
        data: {
          previousEpoch: "epoch-0",
          newEpoch: "epoch-1",
          outcome: "clean",
          interruptedJobIds: ["job-1"],
        },
      },
      {
        type: "project.snapshot",
        data: {
          manifestDigest: DIGEST,
          reason: "recovered",
        },
      },
      {
        type: "project.mutated",
        data: {
          commandId: "command-1",
          planId: "plan-1",
          historyEntryId: "history-1",
          operationIds: ["operation-1"],
          affectedIds: ["clip-1"],
        },
      },
      {
        type: "history.changed",
        data: {
          currentIndex: 2,
          undoCount: 3,
          redoCount: 1,
          headEntryId: "history-1",
        },
      },
      {
        type: "job.changed",
        data: {
          jobId: "job-1",
          kind: "contact-sheet",
          state: "running",
          jobSequence: 2,
          stage: "rendering",
          fraction: 0.25,
          message: "Rendering.",
        },
      },
      {
        type: "artifact.created",
        data: {
          artifactId: "artifact-1",
          jobId: "job-1",
          kind: "contact-sheet",
          contentDigest: DIGEST,
          byteLength: 1_024,
        },
      },
      {
        type: "diagnostics.changed",
        data: {
          diagnosticsRevision: 4,
          reason: "budget-pressure",
        },
      },
      {
        type: "presence.changed",
        data: {
          presenceRevision: 3,
          participantIds: ["participant-1"],
        },
      },
      {
        type: "view.changed",
        data: {
          viewId: "view-1",
          viewRevision: 5,
          changedFields: ["selection", "playhead"],
        },
      },
      {
        type: "source.invalidated",
        data: {
          sourceId: "source-1",
          reason: "identity-changed",
          observedIdentityDigest: SECOND_DIGEST,
        },
      },
    ];

    const projected = cases.map((candidate, index) =>
      projectEventRecord({
        schemaVersion: 1,
        cursor: `cursor-${index + 1}`,
        type: candidate.type,
        occurredAt: "2026-07-25T09:00:00.000Z",
        state,
        sequence: index + 1,
        data: {
          ...candidate.data,
          canonicalPath: "/private/source.mov",
          apiKey: "sk-secret",
        },
      } as ManagedEvent)
    );

    expect(projected.map((event) => event.type)).toEqual(
      cases.map((candidate) => candidate.type),
    );
    projected.forEach((event) => {
      expect(event.data).not.toHaveProperty("canonicalPath");
      expect(event.data).not.toHaveProperty("apiKey");
    });
    expectCanonicalOutput("waptions_events_read", {
      events: projected,
      nextCursor: projected.at(-1)!.cursor,
      hasMore: false,
    });

    expect(() => projectEventRecord({
      schemaVersion: 1,
      cursor: "cursor-legacy",
      type: "project.changed",
      occurredAt: "2026-07-25T09:00:00.000Z",
      state,
      sequence: 11,
      data: {},
    })).toThrow(CanonicalProjectionError);
  });

  it("projects view presence and playback on the render-profile frame grid", () => {
    const presence: ManagedViewPresence = {
      viewId: "view-1",
      projectId: state.projectId,
      viewRevision: 4,
      connectedAt: "2026-07-25T09:00:00.000Z",
      heartbeatAt: "2026-07-25T09:00:01.000Z",
      followPresenter: true,
      selectedIds: ["clip-1", "clip-2"],
      playheadSample: 1_602,
      viewport: {
        zoom: 2.5,
        scrollLeft: 120,
        privatePath: 999,
      },
    };
    const playback: ManagedPlaybackState = {
      revision: 6,
      presenterViewId: "view-presenter",
      playing: true,
      outputSample: 1_602,
      rate: 1.25,
      masterVolume: 0.75,
      masterMuted: false,
    };

    const view = projectViewSnapshot(presence, renderProfile, {
      participantIds: ["participant-1", "participant-2"],
      selectionKind: "clips",
      focusedPanel: "timeline",
      presentation: "fullscreen",
    });
    const projectedPlayback = projectPlaybackData(
      playback,
      renderProfile,
      presence,
    );

    expect(view).toEqual({
      viewId: "view-1",
      viewRevision: 4,
      selection: {
        kind: "clips",
        ids: ["clip-1", "clip-2"],
      },
      playheadFrame: 1,
      zoom: 2.5,
      scrollLeft: 120,
      focusedPanel: "timeline",
      presentation: "fullscreen",
      participantIds: ["participant-1", "participant-2"],
    });
    expect(projectedPlayback).toEqual({
      playbackRevision: 6,
      playing: true,
      playheadFrame: 1,
      rate: 1.25,
      masterVolume: 0.75,
      masterMuted: false,
      presenterViewId: "view-presenter",
      followingPresenter: true,
    });
    expectCanonicalOutput("waptions_view_get", { view });
    expectCanonicalOutput("waptions_playback_control", projectedPlayback);

    const frame = 1_001;
    const sample = timelineFrameToOutputSample(frame, renderProfile);
    expect(outputSampleToTimelineFrame(sample, renderProfile)).toBe(frame);
    expect(() => projectViewSnapshot(presence, renderProfile, {
      participantIds: ["participant-1"],
    })).toThrow(CanonicalProjectionError);
  });
});
