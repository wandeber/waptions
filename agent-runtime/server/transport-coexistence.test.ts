import { request as httpRequest } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { BridgeCoordinatorAdapter } from "../http-bridge/contracts.js";
import { LocalHttpBridge } from "../http-bridge/server.js";
import { assertPrivateControlEndpoint } from "./control-endpoint.js";

const unavailableBridgeAdapter: BridgeCoordinatorAdapter = {
  async consumePairingCapability() {
    throw new Error("not used");
  },
  async authorizeBridgeView() {
    throw new Error("not used");
  },
  async openBridgeResource() {
    throw new Error("not used");
  },
};

describe("coordinator transport ownership", () => {
  it.skipIf(process.platform === "win32")(
    "serves private control IPC and the coordinator-owned HTTP bridge simultaneously without a port collision",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "waptions-control-"));
      const socketPath = resolve(directory, "coordinator.sock");
      const endpoint = { kind: "unix-socket" as const, path: socketPath };
      assertPrivateControlEndpoint(endpoint);

      const controlServer = createNetServer((socket) => {
        socket.once("data", (data) => {
          if (data.toString("utf8") === "ping") {
            socket.end("pong");
          } else {
            socket.destroy();
          }
        });
      });
      const bridge = new LocalHttpBridge({
        coordinator: unavailableBridgeAdapter,
        capabilitySecret: Buffer.alloc(32, 9),
        allowedOrigins: ["https://codex.example"],
      });

      try {
        await new Promise<void>((resolveListen, reject) => {
          controlServer.once("error", reject);
          controlServer.listen(socketPath, resolveListen);
        });
        await bridge.start();

        const controlReply = await new Promise<string>((resolveReply, reject) => {
          const socket = createConnection(socketPath);
          const chunks: Buffer[] = [];
          socket.once("connect", () => socket.write("ping"));
          socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          socket.once("end", () =>
            resolveReply(Buffer.concat(chunks).toString("utf8")),
          );
          socket.once("error", reject);
        });
        expect(controlReply).toBe("pong");

        const httpStatus = await new Promise<number>((resolveStatus, reject) => {
          const request = httpRequest(
            {
              hostname: "localhost",
              port: 59941,
              path: "/v1/media/media-1",
              method: "GET",
              headers: {
                Host: "localhost:59941",
                Origin: "https://codex.example",
              },
            },
            (response) => {
              response.resume();
              response.once("end", () =>
                resolveStatus(response.statusCode ?? 0),
              );
            },
          );
          request.once("error", reject);
          request.end();
        });
        expect(httpStatus).toBe(401);
      } finally {
        await bridge.close();
        await new Promise<void>((resolveClose, reject) =>
          controlServer.close((error) =>
            error ? reject(error) : resolveClose(),
          ),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects TCP-like control endpoints so port 59941 remains HTTP-only", () => {
    expect(() =>
      assertPrivateControlEndpoint({
        kind: "unix-socket",
        path: "http://localhost:59941",
      }),
    ).toThrow("Unix socket");
  });
});
