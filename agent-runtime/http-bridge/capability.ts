import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  BridgeCapabilityScope,
  BridgeReadMethod,
  BridgeResourceScope,
} from "./contracts.js";
import { BridgeAuthorizationError } from "./contracts.js";

interface SignedCapabilityPayload {
  v: 1;
  sessionId: string;
  projectId: string;
  viewId: string;
  sessionEpoch: string;
  origin: string;
  methods: BridgeReadMethod[];
  resources: BridgeResourceScope[];
  exp: number;
  nonce: string;
}

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_CAPABILITY_TTL_SECONDS = 5 * 60;

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.includes("/")
  ) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      `Capability ${field} is invalid.`,
    );
  }
}

function parsePayload(value: unknown): SignedCapabilityPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Capability payload is invalid.",
    );
  }
  const payload = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "v",
    "sessionId",
    "projectId",
    "viewId",
    "sessionEpoch",
    "origin",
    "methods",
    "resources",
    "exp",
    "nonce",
  ]);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Capability payload has unknown fields.",
    );
  }
  if (payload.v !== 1) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Capability version is invalid.",
    );
  }
  assertIdentifier(payload.sessionId, "sessionId");
  assertIdentifier(payload.projectId, "projectId");
  assertIdentifier(payload.viewId, "viewId");
  assertIdentifier(payload.sessionEpoch, "sessionEpoch");
  if (
    typeof payload.origin !== "string" ||
    !payload.origin.startsWith("http") ||
    payload.origin.length > 2048
  ) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Capability origin is invalid.",
    );
  }
  if (
    !Array.isArray(payload.methods) ||
    payload.methods.length < 1 ||
    payload.methods.some((method) => method !== "GET" && method !== "HEAD")
  ) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Capability methods are invalid.",
    );
  }
  if (
    !Array.isArray(payload.resources) ||
    payload.resources.length < 1 ||
    payload.resources.length > 500
  ) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Capability resources are invalid.",
    );
  }
  const resources = payload.resources.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability resource is invalid.",
      );
    }
    const resource = entry as Record<string, unknown>;
    if (
      Object.keys(resource).some(
        (key) => key !== "kind" && key !== "resourceId",
      ) ||
      (resource.kind !== "media" && resource.kind !== "artifact")
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability resource kind is invalid.",
      );
    }
    assertIdentifier(resource.resourceId, "resourceId");
    return {
      kind: resource.kind as "media" | "artifact",
      resourceId: resource.resourceId,
    };
  });
  if (
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp) ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 16 ||
    payload.nonce.length > 128
  ) {
    throw new BridgeAuthorizationError(
      "CAPABILITY_INVALID",
      "Capability expiry or nonce is invalid.",
    );
  }

  return {
    v: 1,
    sessionId: payload.sessionId,
    projectId: payload.projectId,
    viewId: payload.viewId,
    sessionEpoch: payload.sessionEpoch,
    origin: payload.origin,
    methods: Array.from(new Set(payload.methods)),
    resources,
    exp: payload.exp,
    nonce: payload.nonce,
  };
}

export interface BridgeCapabilitySignerOptions {
  secret: Uint8Array;
  now?: () => number;
  maxTtlSeconds?: number;
}

export class BridgeCapabilitySigner {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly maxTtlSeconds: number;

  constructor(options: BridgeCapabilitySignerOptions) {
    if (options.secret.byteLength < 32) {
      throw new Error("Bridge capability secret must contain at least 32 bytes.");
    }
    this.secret = Buffer.from(options.secret);
    this.now = options.now ?? Date.now;
    this.maxTtlSeconds = Math.min(
      options.maxTtlSeconds ?? MAX_CAPABILITY_TTL_SECONDS,
      MAX_CAPABILITY_TTL_SECONDS,
    );
  }

  issue(
    scope: Omit<BridgeCapabilityScope, "expiresAt">,
    requestedTtlSeconds: number,
  ): { token: string; scope: BridgeCapabilityScope } {
    if (
      !Number.isFinite(requestedTtlSeconds) ||
      requestedTtlSeconds <= 0
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability lifetime is invalid.",
      );
    }
    const ttlSeconds = Math.max(
      1,
      Math.min(Math.floor(requestedTtlSeconds), this.maxTtlSeconds),
    );
    const exp = Math.floor(this.now() / 1000) + ttlSeconds;
    const payload: SignedCapabilityPayload = {
      v: 1,
      sessionId: scope.sessionId,
      projectId: scope.projectId,
      viewId: scope.viewId,
      sessionEpoch: scope.sessionEpoch,
      origin: scope.origin,
      methods: Array.from(new Set(scope.methods)),
      resources: scope.resources.map((resource) => ({ ...resource })),
      exp,
      nonce: randomBytes(16).toString("base64url"),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.secret)
      .update(encoded, "ascii")
      .digest("base64url");
    return {
      token: `${encoded}.${signature}`,
      scope: {
        ...scope,
        methods: payload.methods,
        resources: payload.resources,
        expiresAt: new Date(exp * 1000).toISOString(),
      },
    };
  }

  verify(
    token: string,
    request: {
      origin: string;
      method: BridgeReadMethod;
      resource: BridgeResourceScope;
    },
  ): BridgeCapabilityScope {
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability is too large.",
      );
    }
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability format is invalid.",
      );
    }
    const expected = createHmac("sha256", this.secret)
      .update(encoded, "ascii")
      .digest();
    let observed: Buffer;
    try {
      observed = Buffer.from(signature, "base64url");
    } catch {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability signature is invalid.",
      );
    }
    if (
      observed.byteLength !== expected.byteLength ||
      !timingSafeEqual(observed, expected)
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability signature is invalid.",
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new BridgeAuthorizationError(
        "CAPABILITY_INVALID",
        "Capability payload is invalid.",
      );
    }
    const payload = parsePayload(decoded);
    if (payload.exp <= Math.floor(this.now() / 1000)) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_EXPIRED",
        "Capability has expired.",
      );
    }
    if (
      payload.origin !== request.origin ||
      !payload.methods.includes(request.method) ||
      !payload.resources.some(
        (resource) =>
          resource.kind === request.resource.kind &&
          resource.resourceId === request.resource.resourceId,
      )
    ) {
      throw new BridgeAuthorizationError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Capability does not authorize this origin, method, or resource.",
      );
    }

    return {
      sessionId: payload.sessionId,
      projectId: payload.projectId,
      viewId: payload.viewId,
      sessionEpoch: payload.sessionEpoch,
      origin: payload.origin,
      methods: payload.methods,
      resources: payload.resources,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }
}
