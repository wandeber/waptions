import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpAppResource,
  MCP_APPS_EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from "../mcp/app-resource.js";
import {
  FakeCoordinatorAdapter,
  TEST_SEMANTIC_SCHEMAS,
} from "./test-fixtures/fakes.js";
import { WaptionsMcpServer } from "./mcp-server.js";

async function connectClient(options: {
  withApps: boolean;
  appResource?: ReturnType<typeof createMcpAppResource>;
}) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const coordinator = new FakeCoordinatorAdapter();
  const appResource =
    options.appResource ??
    createMcpAppResource("<!doctype html><p>protocol editor</p>");
  const runtime = new WaptionsMcpServer({
    coordinator,
    semanticSchemas: TEST_SEMANTIC_SCHEMAS,
    appResource,
  });
  const capabilities = options.withApps
    ? {
        extensions: {
          [MCP_APPS_EXTENSION_ID]: {
            mimeTypes: [RESOURCE_MIME_TYPE],
          },
        },
      }
    : {};
  const client = new Client(
    { name: "waptions-test-client", version: "1.0.0" },
    { capabilities },
  );
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  return { appResource, client, coordinator, runtime };
}

describe("MCP protocol server", () => {
  it("lists all tools and attaches nested UI metadata only to editor_render", async () => {
    const connected = await connectClient({ withApps: true });
    try {
      const listed = await connected.client.listTools();
      expect(listed.tools).toHaveLength(29);
      const toolsWithUi = listed.tools.filter(
        (tool) =>
          typeof tool._meta?.ui === "object" &&
          tool._meta.ui !== null,
      );
      expect(toolsWithUi).toHaveLength(1);
      expect(toolsWithUi[0].name).toBe("waptions_editor_render");
      expect(toolsWithUi[0]._meta).toEqual({
        ui: {
          resourceUri: connected.appResource.uri,
          visibility: ["model", "app"],
        },
      });
      expect(listed.tools.every((tool) => tool.outputSchema)).toBe(true);
    } finally {
      await connected.client.close();
      await connected.runtime.close();
    }
  });

  it("degrades to text/structured tools when MCP Apps is not negotiated", async () => {
    const connected = await connectClient({ withApps: false });
    try {
      const listed = await connected.client.listTools();
      expect(listed.tools.every((tool) => tool._meta === undefined)).toBe(true);
      const result = await connected.client.callTool({
        name: "waptions_project_get",
        arguments: {
          apiVersion: "2026-07-25",
          sessionId: "session-1",
        },
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("waptions_project_get succeeded"),
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        state: {
          narrativeRevision: 2,
        },
      });
    } finally {
      await connected.client.close();
      await connected.runtime.close();
    }
  });

  it("lists and verifies the immutable MCP App resource and event subscription anchor", async () => {
    const connected = await connectClient({ withApps: true });
    try {
      const resources = await connected.client.listResources();
      expect(resources.resources).toEqual([
        expect.objectContaining({
          uri: connected.appResource.uri,
          mimeType: RESOURCE_MIME_TYPE,
        }),
      ]);
      const read = await connected.client.readResource({
        uri: connected.appResource.uri,
      });
      expect(read.contents).toEqual([
        expect.objectContaining({
          uri: connected.appResource.uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: connected.appResource.html,
        }),
      ]);

      const uri = "waptions://sessions/session-1/events";
      await connected.client.subscribeResource({ uri });
      expect(connected.coordinator.eventCallback).toBeTypeOf("function");
      connected.coordinator.eventCallback?.();
      await connected.client.unsubscribeResource({ uri });
      expect(connected.coordinator.eventCallback).toBeUndefined();
    } finally {
      await connected.client.close();
      await connected.runtime.close();
    }
  });

  it("contains resource notification rejection during transport shutdown", async () => {
    const connected = await connectClient({ withApps: true });
    try {
      const uri = "waptions://sessions/session-1/events";
      await connected.client.subscribeResource({ uri });
      const notification = vi
        .spyOn(connected.runtime.server, "sendResourceUpdated")
        .mockRejectedValue(new Error("Not connected"));
      connected.coordinator.eventCallback?.();
      await Promise.resolve();
      expect(notification).toHaveBeenCalledWith({ uri });
    } finally {
      await connected.client.close();
      await connected.runtime.close();
    }
  });
});
