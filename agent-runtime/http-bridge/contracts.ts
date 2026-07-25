export type BridgeResourceKind = "media" | "artifact";
export type BridgeReadMethod = "GET" | "HEAD";

export interface BridgeResourceScope {
  kind: BridgeResourceKind;
  resourceId: string;
}

export interface BridgeCapabilityScope {
  sessionId: string;
  projectId: string;
  viewId: string;
  sessionEpoch: string;
  origin: string;
  methods: BridgeReadMethod[];
  resources: BridgeResourceScope[];
  expiresAt: string;
}

export interface PairingExchangeResult {
  scope: BridgeCapabilityScope;
  /**
   * The coordinator may shorten the requested lifetime. The bridge enforces a
   * hard upper bound and signs the final capability with the coordinator-owned
   * bridge secret.
   */
  maxTtlSeconds: number;
}

export interface BridgeByteRange {
  start: number;
  endExclusive: number;
}

export interface BridgeResourceHandle {
  size: number;
  etag: string;
  contentType: string;
  fileName?: string;
  read(
    range: BridgeByteRange,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

export interface BridgeCoordinatorAdapter {
  /**
   * Atomically consume a one-time pairing capability. Reuse, wrong origin,
   * expiry, archived projects, detached views, and epoch mismatch must fail
   * closed. The raw pairing capability must never be logged or persisted in a
   * URL.
   */
  consumePairingCapability(
    request: {
      pairingCapability: string;
      origin: string;
    },
    context: { signal: AbortSignal },
  ): Promise<PairingExchangeResult>;

  /**
   * Revalidate the live session/view/epoch before every byte request so a
   * signed token is immediately invalidated by detach, archive, or recovery.
   */
  authorizeBridgeView(
    scope: BridgeCapabilityScope,
    context: { signal: AbortSignal },
  ): Promise<void>;

  /**
   * Resolve an opaque resource ID through coordinator registries and path-grant
   * enforcement. The bridge never accepts or resolves caller-provided paths.
   */
  openBridgeResource(
    request: {
      scope: BridgeCapabilityScope;
      resource: BridgeResourceScope;
    },
    context: { signal: AbortSignal },
  ): Promise<BridgeResourceHandle>;
}

export class BridgeAuthorizationError extends Error {
  constructor(
    readonly code:
      | "CAPABILITY_EXPIRED"
      | "CAPABILITY_INVALID"
      | "CAPABILITY_SCOPE_MISMATCH"
      | "PATH_NOT_GRANTED"
      | "ARTIFACT_EXPIRED"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}
