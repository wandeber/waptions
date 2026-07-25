import {
  createServer,
  request as httpRequest,
} from "node:http";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  BridgeAuthorizationError,
  type BridgeCapabilityScope,
  type BridgeCoordinatorAdapter,
  type BridgeResourceHandle,
} from "./contracts.js";
import { LocalHttpBridge } from "./server.js";

const ORIGIN = "https://codex.example";
const RESOURCE_BYTES = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

class FakeBridgeCoordinator implements BridgeCoordinatorAdapter {
  pairingAvailable = true;
  active = true;
  closeCount = 0;
  authorizeCount = 0;
  readRanges: Array<{ start: number; endExclusive: number }> = [];
  resourceBytes = RESOURCE_BYTES;
  readGate?: Promise<void>;
  onReadStart?: () => void;
  closeGate?: Promise<void>;
  onCloseStart?: () => void;
  closeError?: Error;
  openError?: BridgeAuthorizationError;
  outputMode: "exact" | "short" | "long" = "exact";
  lastReadSignal?: AbortSignal;
  openedRequests: Array<{
    scope: BridgeCapabilityScope;
    resource: { kind: "media" | "artifact"; resourceId: string };
  }> = [];

  async consumePairingCapability(request: {
    pairingCapability: string;
    origin: string;
  }) {
    if (
      !this.pairingAvailable ||
      request.pairingCapability !== "pair-once" ||
      request.origin !== ORIGIN
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Pairing capability is invalid.",
      );
    }
    this.pairingAvailable = false;
    return {
      scope: {
        sessionId: "session-1",
        projectId: "project-1",
        viewId: "view-1",
        sessionEpoch: "epoch-1",
        origin: ORIGIN,
        methods: ["GET", "HEAD"] as Array<"GET" | "HEAD">,
        resources: [
          { kind: "media" as const, resourceId: "media-1" },
          { kind: "artifact" as const, resourceId: "artifact-1" },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      maxTtlSeconds: 60,
    };
  }

  async authorizeBridgeView(scope: BridgeCapabilityScope) {
    this.authorizeCount += 1;
    if (
      !this.active ||
      scope.sessionId !== "session-1" ||
      scope.projectId !== "project-1" ||
      scope.viewId !== "view-1" ||
      scope.sessionEpoch !== "epoch-1"
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_SCOPE_MISMATCH",
        "View is no longer authorized.",
      );
    }
  }

  async openBridgeResource(request: {
    scope: BridgeCapabilityScope;
    resource: { kind: "media" | "artifact"; resourceId: string };
  }): Promise<BridgeResourceHandle> {
    this.openedRequests.push(request);
    if (this.openError) {
      throw this.openError;
    }
    const resourceBytes = this.resourceBytes;
    const recordRange = (range: { start: number; endExclusive: number }) => {
      this.readRanges.push(range);
    };
    const recordClose = () => {
      this.closeCount += 1;
    };
    const readGate = this.readGate;
    const onReadStart = this.onReadStart;
    const closeGate = this.closeGate;
    const onCloseStart = this.onCloseStart;
    const closeError = this.closeError;
    const outputMode = this.outputMode;
    const recordSignal = (signal: AbortSignal) => {
      this.lastReadSignal = signal;
    };
    return {
      size: resourceBytes.byteLength,
      etag: "sha256:test-resource",
      contentType: "application/octet-stream",
      async *read(range, signal) {
        recordRange(range);
        recordSignal(signal);
        onReadStart?.();
        await readGate;
        const selected = resourceBytes.subarray(
          range.start,
          range.endExclusive,
        );
        if (outputMode === "short") {
          yield selected.subarray(0, Math.max(0, selected.byteLength - 1));
        } else if (outputMode === "long") {
          yield Buffer.concat([selected, Buffer.from("x")]);
        } else {
          yield Buffer.concat([selected]).subarray(0, selected.byteLength);
        }
      },
      async close() {
        onCloseStart?.();
        await closeGate;
        recordClose();
        if (closeError) {
          throw closeError;
        }
      },
    };
  }
}

interface BridgeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function callBridge(options: {
  method: string;
  path: string;
  origin?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "localhost",
        port: 59941,
        agent: false,
        method: options.method,
        path: options.path,
        headers: {
          Host: options.host ?? "localhost:59941",
          Origin: options.origin ?? ORIGIN,
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.once("aborted", () => {
          reject(new Error("Bridge response was aborted."));
        });
        response.once("error", reject);
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function expectAddressInUse(host: "::1" | "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const candidate = createServer();
    candidate.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve();
      } else {
        reject(error);
      }
    });
    candidate.once("listening", () => {
      candidate.close(() => {
        reject(new Error(`${host} was not reserved by the HTTP bridge.`));
      });
    });
    candidate.listen(59941, host);
  });
}

async function pair(): Promise<string> {
  const body = JSON.stringify({ pairingCapability: "pair-once" });
  const response = await callBridge({
    method: "POST",
    path: "/v1/pair/exchange",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  });
  expect(response.status).toBe(200);
  const parsed = JSON.parse(response.body.toString("utf8"));
  return parsed.data.capabilityToken as string;
}

describe.sequential("localhost HTTP bridge", () => {
  let now = Date.now();
  let coordinator: FakeBridgeCoordinator;
  let bridge: LocalHttpBridge;

  beforeEach(async () => {
    now = Date.now();
    coordinator = new FakeBridgeCoordinator();
    bridge = new LocalHttpBridge({
      coordinator,
      capabilitySecret: Buffer.alloc(32, 7),
      allowedOrigins: [ORIGIN, "http://localhost:59940"],
      now: () => now,
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.close();
  });

  it("exchanges a one-time body capability without URL/history caching", async () => {
    const token = await pair();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const secondBody = JSON.stringify({ pairingCapability: "pair-once" });
    const second = await callBridge({
      method: "POST",
      path: "/v1/pair/exchange",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(secondBody)),
      },
      body: secondBody,
    });
    expect(second.status).toBe(401);

    const queryAttempt = await callBridge({
      method: "POST",
      path: "/v1/pair/exchange?pairingCapability=pair-once",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(queryAttempt.status).toBe(400);
    expect(queryAttempt.body.toString("utf8")).not.toContain("pair-once");
  });

  it("reserves both IPv6 and IPv4 localhost listeners", async () => {
    await Promise.all([
      expectAddressInUse("::1"),
      expectAddressInUse("127.0.0.1"),
    ]);
  });

  it("serves signed single ranges with ETag, If-Range, HEAD, and close-once", async () => {
    const token = await pair();
    const partial = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: {
        Authorization: `Bearer ${token}`,
        Range: "bytes=2-5",
      },
    });
    expect(partial.status).toBe(206);
    expect(partial.body.toString("utf8")).toBe("2345");
    expect(partial.headers["content-range"]).toBe(
      `bytes 2-5/${RESOURCE_BYTES.byteLength}`,
    );
    expect(partial.headers.etag).toBe('"sha256:test-resource"');

    const ifRangeMiss = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: {
        Authorization: `Bearer ${token}`,
        Range: "bytes=2-5",
        "If-Range": '"different"',
      },
    });
    expect(ifRangeMiss.status).toBe(200);
    expect(ifRangeMiss.body).toEqual(RESOURCE_BYTES);

    const head = await callBridge({
      method: "HEAD",
      path: "/v1/artifacts/artifact-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
    expect(coordinator.closeCount).toBe(3);
    expect(coordinator.authorizeCount).toBe(3);
  });

  it("supports signed URLs while rejecting traversal, multiple ranges, and extra query input", async () => {
    const issued = bridge.issueResourceCapability(
      {
        sessionId: "session-1",
        projectId: "project-1",
        viewId: "view-1",
        sessionEpoch: "epoch-1",
        origin: ORIGIN,
        methods: ["GET"],
        resources: [{ kind: "media", resourceId: "media-1" }],
      },
      30,
    );
    const signedUrl = new URL(
      bridge.createSignedResourceUrl(
        { kind: "media", resourceId: "media-1" },
        issued.token,
      ),
    );
    const success = await callBridge({
      method: "GET",
      path: `${signedUrl.pathname}${signedUrl.search}`,
    });
    expect(success.status).toBe(200);
    expect(coordinator.openedRequests[0]).toMatchObject({
      scope: {
        sessionId: "session-1",
        projectId: "project-1",
        viewId: "view-1",
        sessionEpoch: "epoch-1",
      },
      resource: { kind: "media", resourceId: "media-1" },
    });

    const multiple = await callBridge({
      method: "GET",
      path: `${signedUrl.pathname}${signedUrl.search}`,
      headers: { Range: "bytes=0-1,4-5" },
    });
    expect(multiple.status).toBe(416);

    const extraQuery = await callBridge({
      method: "GET",
      path: `${signedUrl.pathname}${signedUrl.search}&path=/etc/passwd`,
    });
    expect(extraQuery.status).toBe(401);
    expect(extraQuery.body.toString("utf8")).not.toContain("/etc/passwd");

    const traversal = await callBridge({
      method: "GET",
      path: `/v1/media/%2e%2e?capability=${issued.token}`,
    });
    expect(traversal.status).toBe(404);
  });

  it("streams source chunks larger than the four MiB staging bound with backpressure", async () => {
    coordinator.resourceBytes = Buffer.alloc(5 * 1024 * 1024 + 17, 0x5a);
    const token = await pair();
    const response = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.body.byteLength).toBe(coordinator.resourceBytes.byteLength);
    expect(response.body[0]).toBe(0x5a);
    expect(response.body.at(-1)).toBe(0x5a);
    expect(coordinator.closeCount).toBe(1);
  });

  it("enforces the configured concurrent stream bound", async () => {
    await bridge.close();
    bridge = new LocalHttpBridge({
      coordinator,
      capabilitySecret: Buffer.alloc(32, 7),
      allowedOrigins: [ORIGIN],
      maxConcurrentStreams: 1,
      now: () => now,
    });
    await bridge.start();
    const token = await pair();
    let releaseRead: (() => void) | undefined;
    coordinator.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    coordinator.onReadStart = notifyReadStarted;

    const first = callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    await readStarted;
    const limited = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(limited.status).toBe(429);
    expect(limited.body.toString("utf8")).toContain(
      "RESOURCE_LIMIT_EXCEEDED",
    );

    releaseRead?.();
    expect((await first).status).toBe(200);
  });

  it("waits for request handle cleanup before bridge close resolves", async () => {
    const token = await pair();
    let releaseClose: (() => void) | undefined;
    coordinator.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let notifyCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      notifyCloseStarted = resolve;
    });
    coordinator.onCloseStart = notifyCloseStarted;
    const request = callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
    await closeStarted;

    let resolved = false;
    const closing = bridge.close().then(() => {
      resolved = true;
    });
    let secondResolved = false;
    const secondClosing = bridge.close().then(() => {
      secondResolved = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);
    expect(secondResolved).toBe(false);
    releaseClose?.();
    await Promise.all([closing, secondClosing]);
    await request;
    expect(coordinator.closeCount).toBe(1);
  });

  it("releases a stream slot even when resource cleanup fails", async () => {
    await bridge.close();
    bridge = new LocalHttpBridge({
      coordinator,
      capabilitySecret: Buffer.alloc(32, 7),
      allowedOrigins: [ORIGIN],
      maxConcurrentStreams: 1,
      now: () => now,
    });
    await bridge.start();
    const token = await pair();
    coordinator.closeError = new Error("synthetic close failure");
    await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);

    coordinator.closeError = undefined;
    const second = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(200);
  });

  it("rejects wrong Host, Origin, method, token scope, expiry, and detached views", async () => {
    const token = await pair();
    const wrongHost = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      host: "127.0.0.1:59941",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(wrongHost.status).toBe(400);

    const wrongOrigin = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      origin: "https://attacker.example",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(wrongOrigin.status).toBe(401);

    const forwardedHost = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: {
        Authorization: `Bearer ${token}`,
        Forwarded: "host=localhost:59941",
      },
    });
    expect(forwardedHost.status).toBe(400);

    const wrongMethod = await callBridge({
      method: "POST",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(wrongMethod.status).toBe(405);

    const wrongResource = await callBridge({
      method: "GET",
      path: "/v1/media/media-2",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(wrongResource.status).toBe(401);

    now += 61_000;
    const expired = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(expired.status).toBe(401);
    expect(expired.body.toString("utf8")).toContain("CAPABILITY_EXPIRED");

    const fresh = bridge.issueResourceCapability(
      {
        sessionId: "session-1",
        projectId: "project-1",
        viewId: "view-1",
        sessionEpoch: "epoch-1",
        origin: ORIGIN,
        methods: ["GET"],
        resources: [{ kind: "media", resourceId: "media-1" }],
      },
      30,
    );
    coordinator.active = false;
    const detached = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${fresh.token}` },
    });
    expect(detached.status).toBe(401);
  });

  it("rejects cross-session and stale-epoch scopes at live view authorization", async () => {
    for (const scopePatch of [
      { sessionId: "session-2" },
      { sessionEpoch: "epoch-stale" },
    ]) {
      const issued = bridge.issueResourceCapability(
        {
          sessionId: "session-1",
          projectId: "project-1",
          viewId: "view-1",
          sessionEpoch: "epoch-1",
          origin: ORIGIN,
          methods: ["GET"],
          resources: [{ kind: "media", resourceId: "media-1" }],
          ...scopePatch,
        },
        30,
      );
      const response = await callBridge({
        method: "GET",
        path: "/v1/media/media-1",
        headers: { Authorization: `Bearer ${issued.token}` },
      });
      expect(response.status).toBe(401);
      expect(response.body.toString("utf8")).toContain(
        "CAPABILITY_SCOPE_MISMATCH",
      );
    }
  });

  it("maps adapter authorization errors to fixed public messages", async () => {
    const token = await pair();
    coordinator.openError = new BridgeAuthorizationError(
      "PATH_NOT_GRANTED",
      "/private/secret/source.mov was outside an internal grant",
    );
    const denied = await callBridge({
      method: "GET",
      path: "/v1/media/media-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.toString("utf8")).toContain("PATH_NOT_GRANTED");
    expect(denied.body.toString("utf8")).not.toContain("/private/secret");

    coordinator.openError = new BridgeAuthorizationError(
      "ARTIFACT_EXPIRED",
      "artifact registry row and local path details",
    );
    const expired = await callBridge({
      method: "GET",
      path: "/v1/artifacts/artifact-1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(expired.status).toBe(410);
    expect(expired.body.toString("utf8")).toContain("ARTIFACT_EXPIRED");
    expect(expired.body.toString("utf8")).not.toContain("registry row");
  });

  it("terminates responses when an authorized handle yields the wrong byte count", async () => {
    const token = await pair();
    coordinator.outputMode = "short";
    await expect(
      callBridge({
        method: "GET",
        path: "/v1/media/media-1",
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toThrow();
    coordinator.outputMode = "long";
    expect(
      (
        await callBridge({
          method: "GET",
          path: "/v1/media/media-1",
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(500);
    coordinator.outputMode = "exact";
    expect(
      (
        await callBridge({
          method: "GET",
          path: "/v1/media/media-1",
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  });

  it("propagates client abort while a backpressured read is active", async () => {
    coordinator.resourceBytes = Buffer.alloc(8 * 1024 * 1024, 0x42);
    const token = await pair();
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "localhost",
          port: 59941,
          agent: false,
          method: "GET",
          path: "/v1/media/media-1",
          headers: {
            Host: "localhost:59941",
            Origin: ORIGIN,
            Authorization: `Bearer ${token}`,
          },
        },
        (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        },
      );
      request.once("error", reject);
      request.end();
    });
    await vi.waitFor(() => {
      expect(coordinator.lastReadSignal?.aborted).toBe(true);
      expect(coordinator.closeCount).toBe(1);
    });
  });

  it("requires explicit CSP approval for a non-default port", () => {
    expect(
      () =>
        new LocalHttpBridge({
          coordinator,
          capabilitySecret: Buffer.alloc(32, 7),
          allowedOrigins: [ORIGIN],
          port: 59942,
        }),
    ).toThrow("CSP-approved");
  });

  it("rejects invalid capability lifetimes before signing", () => {
    expect(() =>
      bridge.issueResourceCapability(
        {
          sessionId: "session-1",
          projectId: "project-1",
          viewId: "view-1",
          sessionEpoch: "epoch-1",
          origin: ORIGIN,
          methods: ["GET"],
          resources: [{ kind: "media", resourceId: "media-1" }],
        },
        Number.NaN,
      ),
    ).toThrow("lifetime");
  });
});
