import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  BridgeAuthorizationError,
  type BridgeCapabilityScope,
  type BridgeCoordinatorAdapter,
  type BridgeReadMethod,
  type BridgeResourceHandle,
  type BridgeResourceScope,
} from "./contracts.js";
import { BridgeCapabilitySigner } from "./capability.js";
import {
  InvalidByteRangeError,
  parseSingleByteRange,
} from "./range.js";

const DEFAULT_PORT = 59941;
const MAX_PAIR_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_STAGING_BYTES = 4 * 1024 * 1024;
const RESOURCE_PATH = /^\/v1\/(media|artifacts)\/([A-Za-z0-9._~-]{1,256})$/;
const PAIR_PATH = "/v1/pair/exchange";
const FORWARDED_HOST_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-original-host",
] as const;
const PUBLIC_AUTHORIZATION_MESSAGES = {
  CAPABILITY_EXPIRED: "The bridge capability has expired.",
  CAPABILITY_INVALID: "The bridge capability is invalid.",
  CAPABILITY_SCOPE_MISMATCH:
    "The bridge capability does not authorize this request.",
  PATH_NOT_GRANTED: "The requested resource is not authorized.",
  ARTIFACT_EXPIRED: "The requested artifact has expired.",
  NOT_FOUND: "The requested resource was not found.",
} as const;

interface ErrorPayload {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable = false,
): void {
  const payload: ErrorPayload = {
    ok: false,
    error: { code, message, retryable },
  };
  sendJson(response, status, payload);
}

function normalizeEtag(etag: string): string {
  if (/^"[^"\r\n]+"$/.test(etag)) {
    return etag;
  }
  if (!/^[A-Za-z0-9:._~-]{1,256}$/.test(etag)) {
    throw new Error("Bridge resource ETag is invalid.");
  }
  return `"${etag}"`;
}

function extractBearerCapability(request: IncomingMessage, url: URL): string {
  const authorization = request.headers.authorization;
  const queryCapability = url.searchParams.get("capability");
  if (url.searchParams.size > (queryCapability ? 1 : 0)) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Unexpected query parameters.",
    );
  }
  if (authorization && queryCapability) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Use exactly one capability transport.",
    );
  }
  if (authorization) {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Authorization header is invalid.",
      );
    }
    return match[1];
  }
  if (queryCapability) {
    return queryCapability;
  }
  throw new BridgeAuthorizationError(
    "CAPABILITY_INVALID",
    "A bridge capability is required.",
  );
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    throw new Error("Pairing exchange requires application/json.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_PAIR_BODY_BYTES) {
      throw new RangeError("Pairing request is too large.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function closeHandle(handle: BridgeResourceHandle | undefined) {
  if (handle) {
    await handle.close();
  }
}

export interface LocalHttpBridgeOptions {
  coordinator: BridgeCoordinatorAdapter;
  capabilitySecret: Uint8Array;
  allowedOrigins: readonly string[];
  port?: number;
  /**
   * A non-default port is accepted only when the packaged MCP App CSP has been
   * regenerated and verified for this exact origin.
   */
  approvedAppBridgeOrigin?: string;
  maxConcurrentStreams?: number;
  now?: () => number;
}

export class LocalHttpBridge {
  readonly port: number;
  readonly origin: string;

  private readonly expectedHost: string;
  private readonly allowedOrigins: Set<string>;
  private readonly signer: BridgeCapabilitySigner;
  private readonly maxConcurrentStreams: number;
  private readonly servers: Server[];
  private readonly activeRequests = new Set<AbortController>();
  private readonly requestTasks = new Set<Promise<void>>();
  private activeStreams = 0;
  private started = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: LocalHttpBridgeOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    if (
      !Number.isInteger(this.port) ||
      this.port < 1 ||
      this.port > 65_535
    ) {
      throw new Error("HTTP bridge port is invalid.");
    }
    this.origin = `http://localhost:${this.port}`;
    if (
      this.port !== DEFAULT_PORT &&
      options.approvedAppBridgeOrigin !== this.origin
    ) {
      throw new Error(
        "A non-default bridge port requires the exact CSP-approved bridge origin.",
      );
    }
    this.expectedHost = `localhost:${this.port}`;
    this.maxConcurrentStreams = options.maxConcurrentStreams ?? 8;
    if (
      !Number.isInteger(this.maxConcurrentStreams) ||
      this.maxConcurrentStreams < 1 ||
      this.maxConcurrentStreams > 64
    ) {
      throw new Error("HTTP bridge stream concurrency limit is invalid.");
    }
    this.allowedOrigins = new Set(options.allowedOrigins);
    if (
      this.allowedOrigins.size === 0 ||
      Array.from(this.allowedOrigins).some(
        (origin) => new URL(origin).origin !== origin,
      )
    ) {
      throw new Error("HTTP bridge origins must be exact URL origins.");
    }
    this.signer = new BridgeCapabilitySigner({
      secret: options.capabilitySecret,
      now: options.now,
    });
    this.servers = [
      this.createHttpServer(),
      this.createHttpServer(),
    ];
  }

  private createHttpServer(): Server {
    return createServer((request, response) => {
      const task = this.handleRequest(request, response);
      this.requestTasks.add(task);
      void task.then(
        () => this.requestTasks.delete(task),
        () => this.requestTasks.delete(task),
      );
    });
  }

  private validateOrigin(request: IncomingMessage): string {
    const origin = request.headers.origin;
    if (
      typeof origin !== "string" ||
      !this.allowedOrigins.has(origin)
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Origin is not authorized.",
      );
    }
    return origin;
  }

  private applyCors(response: ServerResponse, origin: string): void {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  private async handleOptions(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
    pathname: string,
  ): Promise<void> {
    const requestedMethod = request.headers["access-control-request-method"];
    const allowed =
      (pathname === PAIR_PATH && requestedMethod === "POST") ||
      (RESOURCE_PATH.test(pathname) &&
        (requestedMethod === "GET" || requestedMethod === "HEAD"));
    if (!allowed) {
      sendError(response, 405, "METHOD_NOT_ALLOWED", "Method is not allowed.");
      return;
    }
    this.applyCors(response, origin);
    response.writeHead(204, {
      "Access-Control-Allow-Methods":
        pathname === PAIR_PATH ? "POST" : "GET, HEAD",
      "Access-Control-Allow-Headers":
        pathname === PAIR_PATH
          ? "Content-Type"
          : "Authorization, Range, If-Range",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    });
    response.end();
  }

  private async handlePairExchange(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
    controller: AbortController,
  ): Promise<void> {
    if (request.method !== "POST") {
      sendError(response, 405, "METHOD_NOT_ALLOWED", "Method is not allowed.");
      return;
    }
    if (request.url?.includes("?")) {
      sendError(
        response,
        400,
        "INVALID_REQUEST",
        "Pairing capabilities must be sent in the request body, never in a URL.",
      );
      return;
    }
    const body = await readBoundedJson(request);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>).pairingCapability !== "string"
    ) {
      sendError(
        response,
        400,
        "INVALID_REQUEST",
        "Pairing request must contain only pairingCapability.",
      );
      return;
    }
    const exchange = await this.options.coordinator.consumePairingCapability(
      {
        pairingCapability: (body as { pairingCapability: string })
          .pairingCapability,
        origin,
      },
      { signal: controller.signal },
    );
    if (exchange.scope.origin !== origin) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Pairing capability origin does not match.",
      );
    }
    const unsignedScope = {
      sessionId: exchange.scope.sessionId,
      projectId: exchange.scope.projectId,
      viewId: exchange.scope.viewId,
      sessionEpoch: exchange.scope.sessionEpoch,
      origin: exchange.scope.origin,
      methods: exchange.scope.methods,
      resources: exchange.scope.resources,
    };
    const issued = this.signer.issue(unsignedScope, exchange.maxTtlSeconds);
    this.applyCors(response, origin);
    sendJson(response, 200, {
      ok: true,
      data: {
        sessionId: issued.scope.sessionId,
        projectId: issued.scope.projectId,
        viewId: issued.scope.viewId,
        sessionEpoch: issued.scope.sessionEpoch,
        expiresAt: issued.scope.expiresAt,
        capabilityToken: issued.token,
      },
    });
  }

  private async writeResourceBody(
    response: ServerResponse,
    handle: BridgeResourceHandle,
    range: { start: number; endExclusive: number },
    signal: AbortSignal,
  ): Promise<void> {
    const expectedBytes = range.endExclusive - range.start;
    let writtenBytes = 0;
    for await (const sourceChunk of handle.read(range, signal)) {
      if (signal.aborted) {
        break;
      }
      if (writtenBytes + sourceChunk.byteLength > expectedBytes) {
        throw new Error("Bridge resource yielded more bytes than authorized.");
      }
      for (
        let offset = 0;
        offset < sourceChunk.byteLength;
        offset += MAX_RESPONSE_STAGING_BYTES
      ) {
        const chunk = sourceChunk.subarray(
          offset,
          Math.min(
            sourceChunk.byteLength,
            offset + MAX_RESPONSE_STAGING_BYTES,
          ),
        );
        if (!response.write(chunk)) {
          const drained = await new Promise<boolean>((resolve) => {
            if (signal.aborted) {
              resolve(false);
              return;
            }
            const finish = (value: boolean) => {
              response.off("drain", onDrain);
              response.off("close", onClose);
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            };
            const onDrain = () => finish(true);
            const onClose = () => finish(false);
            const onAbort = () => finish(false);
            response.once("drain", onDrain);
            response.once("close", onClose);
            signal.addEventListener("abort", onAbort, { once: true });
          });
          if (!drained || response.destroyed || signal.aborted) {
            return;
          }
        }
        writtenBytes += chunk.byteLength;
      }
    }
    if (!signal.aborted && writtenBytes !== expectedBytes) {
      throw new Error("Bridge resource yielded fewer bytes than authorized.");
    }
    response.end();
  }

  private async handleResource(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
    pathname: string,
    url: URL,
    controller: AbortController,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(response, 405, "METHOD_NOT_ALLOWED", "Method is not allowed.");
      return;
    }
    const match = RESOURCE_PATH.exec(pathname);
    if (!match) {
      sendError(response, 404, "NOT_FOUND", "Resource was not found.");
      return;
    }
    const resource: BridgeResourceScope = {
      kind: match[1] === "media" ? "media" : "artifact",
      resourceId: match[2],
    };
    const method = request.method as BridgeReadMethod;
    const capability = extractBearerCapability(request, url);
    const scope = this.signer.verify(capability, {
      origin,
      method,
      resource,
    });
    await this.options.coordinator.authorizeBridgeView(scope, {
      signal: controller.signal,
    });
    const streamSlot = method === "GET";
    if (streamSlot && this.activeStreams >= this.maxConcurrentStreams) {
      sendError(
        response,
        429,
        "RESOURCE_LIMIT_EXCEEDED",
        "The local bridge stream limit is reached.",
        true,
      );
      return;
    }
    if (streamSlot) {
      this.activeStreams += 1;
    }

    let handle: BridgeResourceHandle | undefined;
    try {
      handle = await this.options.coordinator.openBridgeResource(
        { scope, resource },
        { signal: controller.signal },
      );
      const etag = normalizeEtag(handle.etag);
      const requestedRange =
        request.headers["if-range"] &&
        request.headers["if-range"] !== etag
          ? undefined
          : parseSingleByteRange(request.headers.range, handle.size);
      const range = requestedRange ?? {
        start: 0,
        endExclusive: handle.size,
      };
      const partial = requestedRange !== undefined;
      const contentLength = range.endExclusive - range.start;
      this.applyCors(response, origin);
      response.statusCode = partial ? 206 : 200;
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Type", handle.contentType);
      response.setHeader("Content-Length", contentLength);
      response.setHeader("ETag", etag);
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (partial) {
        response.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.endExclusive - 1}/${handle.size}`,
        );
      }
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      await this.writeResourceBody(
        response,
        handle,
        range,
        controller.signal,
      );
    } catch (error) {
      if (error instanceof InvalidByteRangeError && handle) {
        response.setHeader("Content-Range", `bytes */${handle.size}`);
        sendError(
          response,
          416,
          "INVALID_RANGE",
          "Requested byte range is not satisfiable.",
        );
        return;
      }
      throw error;
    } finally {
      try {
        await closeHandle(handle);
      } finally {
        if (streamSlot) {
          this.activeStreams -= 1;
        }
      }
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableFinished) {
        controller.abort();
      }
    });

    try {
      const hostHeaderCount = request.rawHeaders.reduce(
        (count, value, index) =>
          index % 2 === 0 && value.toLowerCase() === "host"
            ? count + 1
            : count,
        0,
      );
      if (
        hostHeaderCount !== 1 ||
        request.headers.host !== this.expectedHost ||
        FORWARDED_HOST_HEADERS.some(
          (header) => request.headers[header] !== undefined,
        )
      ) {
        sendError(response, 400, "INVALID_HOST", "Host header is not allowed.");
        return;
      }
      const origin = this.validateOrigin(request);
      this.applyCors(response, origin);
      const url = new URL(request.url ?? "/", this.origin);
      const pathname = url.pathname;

      if (request.method === "OPTIONS") {
        await this.handleOptions(request, response, origin, pathname);
      } else if (pathname === PAIR_PATH) {
        await this.handlePairExchange(
          request,
          response,
          origin,
          controller,
        );
      } else {
        await this.handleResource(
          request,
          response,
          origin,
          pathname,
          url,
          controller,
        );
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof BridgeAuthorizationError) {
        const status =
          error.code === "CAPABILITY_EXPIRED"
            ? 401
            : error.code === "ARTIFACT_EXPIRED"
              ? 410
            : error.code === "NOT_FOUND"
              ? 404
              : error.code === "PATH_NOT_GRANTED"
                ? 403
                : 401;
        sendError(
          response,
          status,
          error.code,
          PUBLIC_AUTHORIZATION_MESSAGES[error.code],
        );
      } else if (error instanceof RangeError) {
        sendError(
          response,
          413,
          "PAYLOAD_TOO_LARGE",
          "The pairing request exceeds the local bridge limit.",
        );
      } else if (error instanceof SyntaxError) {
        sendError(response, 400, "INVALID_REQUEST", "Request JSON is invalid.");
      } else {
        sendError(
          response,
          500,
          "INTERNAL_ERROR",
          "The local bridge could not complete the request.",
          false,
        );
      }
    } finally {
      this.activeRequests.delete(controller);
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.closePromise) {
      throw new Error("HTTP bridge is closing.");
    }
    const listen = (
      server: Server,
      host: "::1" | "127.0.0.1",
      ipv6Only: boolean,
    ) =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
          port: this.port,
          host,
          ...(host === "::1" ? { ipv6Only } : {}),
        });
      });
    try {
      // Both loopback families are reserved so no second process can claim the
      // same logical localhost origin through the other address family.
      await listen(this.servers[0], "::1", true);
      await listen(this.servers[1], "127.0.0.1", false);
    } catch (error) {
      await Promise.allSettled(
        this.servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close(() => resolve());
            }),
        ),
      );
      throw error;
    }
    this.started = true;
  }

  issueResourceCapability(
    scope: Omit<BridgeCapabilityScope, "expiresAt">,
    ttlSeconds: number,
  ): { token: string; scope: BridgeCapabilityScope } {
    return this.signer.issue(scope, ttlSeconds);
  }

  createSignedResourceUrl(
    resource: BridgeResourceScope,
    capabilityToken: string,
  ): string {
    const collection = resource.kind === "media" ? "media" : "artifacts";
    const url = new URL(
      `/v1/${collection}/${encodeURIComponent(resource.resourceId)}`,
      this.origin,
    );
    url.searchParams.set("capability", capabilityToken);
    return url.toString();
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    for (const controller of Array.from(this.activeRequests)) {
      controller.abort();
    }
    if (this.started) {
      await Promise.all(
        this.servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
              server.closeAllConnections();
            }),
        ),
      );
    }
    await Promise.allSettled(Array.from(this.requestTasks));
    this.started = false;
  }
}

export const LOCAL_HTTP_BRIDGE_DEFAULT_PORT = DEFAULT_PORT;

export async function startLocalHttpBridge(
  options: LocalHttpBridgeOptions,
): Promise<LocalHttpBridge> {
  const bridge = new LocalHttpBridge(options);
  await bridge.start();
  return bridge;
}
