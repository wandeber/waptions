import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeCoreSemanticSchemaSha256,
} from "../mcp/semantic-schema-adapter.js";
import {
  TEST_OPERATION_SCHEMA,
} from "./test-fixtures/fakes.js";
import {
  TEST_CORE_OPERATION_TYPES,
} from "./test-fixtures/core-operation-names.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function createRuntimeModule(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "waptions-stdio-"));
  temporaryDirectories.push(directory);
  const modulePath = resolve(directory, "runtime.mjs");
  const semanticSchemas = {
    apiVersion: "2026-07-25",
    editOperationSchema: TEST_OPERATION_SCHEMA,
    operationTypes: TEST_CORE_OPERATION_TYPES,
    schemaSha256: computeCoreSemanticSchemaSha256(TEST_OPERATION_SCHEMA),
  };
  const state = {
    sessionId: "session-1",
    projectId: "project-1",
    sessionEpoch: "epoch-1",
    sessionRevision: 1,
    documentRevision: 1,
    audioGraphRevision: 1,
    narrativeRevision: 0,
    eventCursor: "event-1",
  };
  const source = `
const state = ${JSON.stringify(state)};
const success = { ok: true, data: {}, state, warnings: [] };
export async function attachWaptionsRuntime() {
  return {
    controlEndpoint: { kind: "unix-socket", path: ${JSON.stringify(
      resolve(directory, "coordinator.sock"),
    )} },
    semanticSchemas: ${JSON.stringify(semanticSchemas)},
    coordinator: {
      async executeRead() { return success; },
      async resolveReceiptScope(call) {
        return {
          ok: true,
          scope: {
            projectId: state.projectId,
            toolName: call.toolName,
            idempotencyKey: call.identity.idempotencyKey,
          },
        };
      },
      async executeMutation() { return { ...success, replayed: false }; },
      async executeSessionOpen() { return { ...success, replayed: false }; },
      async close() {},
    },
  };
}
`;
  await writeFile(modulePath, source, "utf8");
  return modulePath;
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("stdio server did not exit after stdin closed."));
    }, 5000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit({ code, stderr });
    });
  });
}

describe("stdio lifecycle", () => {
  it("handles initialize/list/read/call, survives malformed input, keeps stdout protocol-only, and exits on EOF", async () => {
    const modulePath = await createRuntimeModule();
    const entrypoint = resolve(
      import.meta.dirname,
      "../dist/server/stdio.js",
    );
    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        WAPTIONS_ALLOW_PARTIAL_RUNTIME: "1",
        WAPTIONS_RUNTIME_ADAPTER_MODULE: modulePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages = new Map<number, unknown>();
    const nonProtocolLines: string[] = [];
    const waiters = new Map<number, (value: unknown) => void>();
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") {
          messages.set(message.id, message);
          waiters.get(message.id)?.(message);
        }
      } catch {
        nonProtocolLines.push(line);
      }
    });
    const waitForMessage = (id: number) =>
      messages.get(id) ??
      new Promise((resolveMessage) => waiters.set(id, resolveMessage));
    const send = (message: unknown) => {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
    };

    child.stdin!.write("this is malformed json\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    });
    expect(await waitForMessage(1)).toMatchObject({
      id: 1,
      result: {
        serverInfo: { name: "waptions" },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(await waitForMessage(2)).toMatchObject({
      id: 2,
      result: { tools: expect.arrayContaining([expect.objectContaining({
        name: "waptions_editor_render",
      })]) },
    });
    send({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
    expect(await waitForMessage(3)).toMatchObject({
      id: 3,
      result: {
        resources: [
          expect.objectContaining({
            mimeType: "text/html;profile=mcp-app",
          }),
        ],
      },
    });
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "waptions_project_get",
        arguments: {
          apiVersion: "2026-07-25",
          sessionId: "session-1",
        },
      },
    });
    expect(await waitForMessage(4)).toMatchObject({
      id: 4,
      result: {
        structuredContent: {
          ok: true,
          state: { narrativeRevision: 0 },
        },
      },
    });

    child.stdin!.end();
    const exited = await waitForExit(child);
    expect(exited.code).toBe(0);
    expect(nonProtocolLines).toEqual([]);
    expect(exited.stderr).not.toContain("stdio");
  });
});
