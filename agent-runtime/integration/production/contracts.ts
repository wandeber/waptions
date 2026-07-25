import type { EditorManifestV4 } from '../../../src/types/video.js';
import type { StateToken } from '../../mcp/contracts.js';
import type { CoordinatorCallContext } from '../../server/coordinator-adapter.js';
import type {
    ManagedDiagnosticsAuthority,
    ManagedProjectValidationAuthority,
} from '../managed-tool-handlers.js';

export const PRODUCTION_VALIDATION_SCOPES = [
    'structural',
    'hydrated',
    'sources',
    'history-wal',
    'transcript-pins',
    'renderability',
] as const;

export type ProductionValidationScope = (typeof PRODUCTION_VALIDATION_SCOPES)[number];

export interface ProductionValidationFinding {
    /** A stable, path-free failure code owned by the production adapter. */
    readonly code: string;
    /** Optional opaque source, transcript, artifact, or output identifier. */
    readonly subjectId?: string;
}

export interface ProductionDeepValidationRequest {
    readonly projectId: string;
    readonly manifest: EditorManifestV4;
    readonly state: StateToken;
    readonly context: CoordinatorCallContext;
    readonly scope: Exclude<ProductionValidationScope, 'structural'>;
}

/**
 * Each expensive validation owns its own private storage and handles. It returns only opaque
 * identities so this boundary cannot accidentally publish host paths through MCP issues.
 */
export interface ProductionDeepValidationPort {
    validate(
        request: ProductionDeepValidationRequest,
    ): Promise<readonly ProductionValidationFinding[]>;
}

export interface ProductionDeepValidationPorts {
    readonly hydration: ProductionDeepValidationPort;
    readonly sources: ProductionDeepValidationPort;
    readonly historyWal: ProductionDeepValidationPort;
    readonly transcriptPins: ProductionDeepValidationPort;
    readonly renderability: ProductionDeepValidationPort;
}

export interface ProductionResourceBudgetSnapshot {
    readonly currentBytes: number;
    readonly peakBytes: number;
}

/**
 * Process-wide budget supplied by the production composition. The diagnostics authority only
 * observes it; it must never allocate a competing per-request resource manager.
 */
export interface ProductionResourceBudget {
    snapshot(): ProductionResourceBudgetSnapshot;
    assertReleased?(): void | Promise<void>;
}

export interface ProductionDecodedMemorySnapshot {
    readonly currentBytes: number;
    readonly peakBytes: number;
    readonly leaseCount: number;
}

export interface ProductionDecodedMemoryPort {
    snapshot(): ProductionDecodedMemorySnapshot;
    assertReleased?(): void | Promise<void>;
}

export interface ProductionDecoderLeaseSnapshot {
    readonly reservedPixelBytes: number;
    readonly leasedPixelBytes: number;
    readonly leaseCount: number;
}

export interface ProductionDecoderLeasePort {
    snapshot(): ProductionDecoderLeaseSnapshot;
    assertReleased?(): void | Promise<void>;
}

export interface ProductionDecoderSessionSnapshot {
    readonly activeSessions: number;
}

export interface ProductionDecoderSessionPort {
    snapshot(): ProductionDecoderSessionSnapshot;
    assertReleased?(): void | Promise<void>;
}

export interface ProductionJobQueuePort {
    snapshot(projectId: string): Readonly<Record<string, number>>;
}

export interface ProductionCacheMetricsSnapshot {
    readonly evictions: number;
    readonly cancellations: number;
    readonly lateResultDisposals: number;
}

export interface ProductionCacheMetricsPort {
    snapshot(): ProductionCacheMetricsSnapshot;
    assertReleased?(): void | Promise<void>;
}

export interface ProductionRuntimeDiagnosticsPorts {
    readonly resourceBudget: ProductionResourceBudget;
    readonly decodedMemory: ProductionDecodedMemoryPort;
    readonly decoderLeases: ProductionDecoderLeasePort;
    readonly decoderSessions: ProductionDecoderSessionPort;
    readonly jobQueues: ProductionJobQueuePort;
    readonly cacheMetrics: ProductionCacheMetricsPort;
}

/**
 * The result is intentionally shaped as the two seams consumed by managed-tool-handlers. A
 * composition can instantiate this before coordinator recovery without importing either handler.
 */
export interface ProductionRuntimeAuthorities {
    readonly projectValidation: ManagedProjectValidationAuthority;
    readonly diagnostics: ManagedDiagnosticsAuthority;
}

export interface ProductionRuntimeAuthorityPorts {
    readonly validation: ProductionDeepValidationPorts;
    readonly diagnostics: ProductionRuntimeDiagnosticsPorts;
}
