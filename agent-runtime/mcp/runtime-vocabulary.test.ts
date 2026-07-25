import { describe, expect, it } from "vitest";

import {
  mapRuntimeEventType,
  mapRuntimeJobState,
  normalizeCoordinatorVocabulary,
  PUBLIC_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  RUNTIME_JOB_STATES,
} from "./runtime-vocabulary.js";
import { TEST_STATE } from "../server/test-fixtures/fakes.js";

describe("runtime to public MCP vocabulary", () => {
  it("maps every declared runtime event including recovery, grants, source invalidation, and job completion", () => {
    const expected = {
      "session.recovered": "session.recovered",
      "project.snapshot": "project.snapshot",
      "project.changed": "project.mutated",
      "project.mutated": "project.mutated",
      "history.changed": "history.changed",
      "job.changed": "job.changed",
      "job.completed": "job.changed",
      "job.succeeded": "job.changed",
      "artifact.created": "artifact.created",
      "diagnostics.changed": "diagnostics.changed",
      "presence.changed": "presence.changed",
      "view.changed": "view.changed",
      "source.changed": "source.invalidated",
      "source.invalidated": "source.invalidated",
      "grant.changed": "project.snapshot",
    } as const;

    expect(Object.keys(expected)).toEqual([...RUNTIME_EVENT_TYPES]);
    for (const runtimeType of RUNTIME_EVENT_TYPES) {
      const publicType = mapRuntimeEventType(runtimeType);
      expect(publicType).toBe(expected[runtimeType]);
      expect(PUBLIC_EVENT_TYPES).toContain(publicType);
    }
  });

  it("maps every runtime job terminal spelling to the frozen public state", () => {
    const expected = {
      pending: "queued",
      queued: "queued",
      active: "running",
      running: "running",
      completed: "succeeded",
      succeeded: "succeeded",
      error: "failed",
      failed: "failed",
      canceled: "cancelled",
      cancelled: "cancelled",
      stale: "stale",
      interrupted: "interrupted",
    } as const;

    expect(Object.keys(expected)).toEqual([...RUNTIME_JOB_STATES]);
    for (const state of RUNTIME_JOB_STATES) {
      expect(mapRuntimeJobState(state)).toBe(expected[state]);
    }
  });

  it("normalizes nested event and job descriptors and rejects unknown vocabulary", () => {
    expect(
      normalizeCoordinatorVocabulary({
        ok: true,
        data: {
          events: [
            {
              cursor: "cursor-1",
              type: "session.recovered",
            },
            {
              cursor: "cursor-2",
              type: "source.changed",
            },
            {
              cursor: "cursor-3",
              type: "grant.changed",
            },
          ],
          jobs: [
            { jobId: "job-1", state: "completed" },
            { jobId: "job-2", state: "succeeded" },
          ],
        },
        state: TEST_STATE,
      }),
    ).toMatchObject({
      data: {
        events: [
          { type: "session.recovered" },
          { type: "source.invalidated" },
          { type: "project.snapshot" },
        ],
        jobs: [
          { state: "succeeded" },
          { state: "succeeded" },
        ],
      },
    });

    expect(() =>
      normalizeCoordinatorVocabulary({
        ok: true,
        data: {
          events: [{ cursor: "cursor", type: "project.secretly-changed" }],
        },
        state: TEST_STATE,
      }),
    ).toThrow("Unknown runtime event type");
  });
});
