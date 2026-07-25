import { describe, expect, it, vi } from "vitest";

import type {
  CanonicalToolCall,
  CoordinatorResult,
} from "../mcp/contracts.js";
import {
  TOOL_NAMES,
  type WaptionsToolName,
} from "../mcp/constants.js";
import toolRegistry from "../schemas/2026-07-25/tool-registry.json" with {
  type: "json",
};
import {
  CanonicalToolRouter,
  type CanonicalToolHandler,
  type CanonicalToolRouterDependencies,
} from "./canonical-tool-router.js";

function createHandlers(
  result: CoordinatorResult,
): CanonicalToolRouterDependencies["handlers"] {
  return Object.fromEntries(
    TOOL_NAMES.map((toolName) => [
      toolName,
      vi.fn<CanonicalToolHandler>().mockResolvedValue(result),
    ]),
  ) as unknown as CanonicalToolRouterDependencies["handlers"];
}

function canonicalCall(
  toolName: WaptionsToolName,
  requestHash: `sha256:${string}`,
): CanonicalToolCall {
  return {
    toolName,
    request: {
      apiVersion: "2026-07-25",
    },
    canonicalRequest: '{"apiVersion":"2026-07-25"}',
    requestHash,
  };
}

describe("CanonicalToolRouter", () => {
  it("routes exactly the 29 tools committed in the canonical registry", async () => {
    const registryNames = toolRegistry.tools.map((tool) => tool.name);
    expect(registryNames).toHaveLength(29);
    expect(registryNames).toEqual([...TOOL_NAMES]);

    const envelope: CoordinatorResult = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Expected test envelope.",
        retryable: false,
      },
    };
    const handlers = createHandlers(envelope);
    const router = new CanonicalToolRouter({ handlers });
    const context = { signal: new AbortController().signal };

    for (const toolName of TOOL_NAMES) {
      const call = canonicalCall(toolName, `sha256:${toolName}`);
      await expect(router.route(call, context)).resolves.toBe(envelope);
      expect(handlers[toolName]).toHaveBeenCalledOnce();
      expect(handlers[toolName]).toHaveBeenCalledWith(call, context);
    }
  });

  it("preserves the canonical request hash when invoking a handler", async () => {
    const envelope: CoordinatorResult = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Expected test envelope.",
        retryable: false,
      },
    };
    const handlers = createHandlers(envelope);
    const router = new CanonicalToolRouter({ handlers });
    const context = { signal: new AbortController().signal };
    const requestHash =
      `sha256:${"a".repeat(64)}` as `sha256:${string}`;
    const call = canonicalCall("waptions_edit_apply", requestHash);

    await router.route(call, context);

    const forwardedCall =
      vi.mocked(handlers.waptions_edit_apply).mock.calls[0]?.[0];
    expect(forwardedCall).toBe(call);
    expect(forwardedCall?.requestHash).toBe(requestHash);
  });
});
