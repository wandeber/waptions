import { describe, expect, it } from "vitest";

import {
  createBoundedUiModelContext,
  toUiToolResult,
} from "./ui-result-adapter.js";
import { TEST_STATE } from "../server/test-fixtures/fakes.js";

describe("MCP UI result adapter", () => {
  it("preserves the authoritative envelope and narrative revision", () => {
    const result = toUiToolResult({
      ok: true,
      data: { project: "descriptor" },
      state: TEST_STATE,
      warnings: [],
    });
    expect(result).toEqual({
      ok: true,
      data: { project: "descriptor" },
      state: TEST_STATE,
      warnings: [],
    });
    expect(result.ok && result.state.narrativeRevision).toBe(2);
  });

  it("publishes only bounded allowlisted model context", () => {
    const context = createBoundedUiModelContext({
      projectName: "Project",
      selection: [{ id: "clip-1", type: "video-clip" }],
      timecode: "00:00:01:00",
      state: TEST_STATE,
      activeJobs: [{ jobId: "job-1", kind: "export", state: "running" }],
      recentSemanticAction: "Moved clip",
    });
    const serialized = JSON.stringify(context);
    expect(context).toMatchObject({
      revisions: {
        narrativeRevision: 2,
      },
    });
    expect(serialized).not.toMatch(
      /path|url|token|transcript|credential|api.?key/i,
    );
  });
});
