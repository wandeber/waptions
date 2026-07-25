import { randomUUID } from 'node:crypto';

import type {
    ProcessDecodedMemoryBudget,
} from '../../diagnostics/decoded-memory-budget';
import type { MediaDiagnosticsEvent } from '../../media/ports';
import type {
    DecodedMemoryBudgetPort,
} from '../../media/ports';
import {
    HeadlessRenderError,
    type HeadlessRenderResourceBudgetPort,
    type HeadlessRenderResourceKind,
    type HeadlessRenderResourceRequest,
} from '../../render/contracts';

const COUNT_LIMITS: Readonly<Record<
    Exclude<HeadlessRenderResourceKind, 'decoded-pixel-bytes' | 'audio-mix-bytes'>,
    number
>> = Object.freeze({
    'backend-processes': 2,
    'canvas-frames': 2,
    'export-jobs': 1,
    'video-decoder-sessions': 2,
});

/**
 * Adapts every media and render reservation to the coordinator's one
 * process-wide byte authority. Counted resources are enforced in this same
 * object, so render jobs cannot manufacture an independent concurrency pool.
 */
export class ProductionResourceBudget implements
    HeadlessRenderResourceBudgetPort,
    DecodedMemoryBudgetPort {
    readonly authority = 'process-wide-decoded-memory-v1' as const;

    private readonly current = emptyCounters();
    private readonly peak = emptyCounters();

    constructor(private readonly bytes: ProcessDecodedMemoryBudget) {}

    async reserve(
        request: {
            readonly operationId: string;
            readonly category: 'review-decode';
            readonly bytes: number;
        },
        signal?: AbortSignal,
    ) {
        throwIfAborted(signal);
        const lease = this.bytes.acquire(request.operationId, request.bytes);
        return {
            leaseId: lease.leaseId,
            reservedBytes: lease.bytes,
            release: async () => lease.release(),
        };
    }

    async acquire(
        ownerId: string,
        request: HeadlessRenderResourceRequest,
        signal?: AbortSignal,
    ) {
        throwIfAborted(signal);
        const granted = normalizeRequest(request);
        const byteCount = granted['decoded-pixel-bytes']
            + granted['audio-mix-bytes'];
        for (const [kind, limit] of Object.entries(COUNT_LIMITS) as Array<
            [keyof typeof COUNT_LIMITS, number]
        >) {
            if (this.current[kind] + granted[kind] > limit) {
                throw new HeadlessRenderError(
                    'RESOURCE_LIMIT',
                    `The process-wide ${kind} budget is exhausted.`,
                );
            }
        }
        const byteLease = byteCount > 0
            ? this.bytes.acquire(ownerId, byteCount)
            : undefined;
        for (const kind of resourceKinds()) {
            this.current[kind] += granted[kind];
            this.peak[kind] = Math.max(this.peak[kind], this.current[kind]);
        }
        let released = false;
        return {
            reservation: {
                authority: this.authority,
                reservationId: `render-reservation:${randomUUID()}`,
                granted: Object.freeze({ ...granted }),
            },
            release: () => {
                if (released) return;
                released = true;
                for (const kind of resourceKinds()) {
                    this.current[kind] = Math.max(
                        0,
                        this.current[kind] - granted[kind],
                    );
                }
                byteLease?.release();
            },
        };
    }

    snapshot() {
        const byteSnapshot = this.bytes.snapshot();
        return {
            limits: Object.freeze({
                'decoded-pixel-bytes': byteSnapshot.limitBytes,
                'audio-mix-bytes': byteSnapshot.limitBytes,
                ...COUNT_LIMITS,
            }),
            current: Object.freeze({ ...this.current }),
            peak: Object.freeze({ ...this.peak }),
        };
    }
}

/**
 * Live process counters shared by media, render and diagnostics. Zero is a
 * measured initial value in this authority, never a response-layer fallback.
 */
export class ProductionRuntimeMetrics {
    private evictions = 0;
    private cancellations = 0;
    private lateResultDisposals = 0;

    record(event: MediaDiagnosticsEvent): void {
        const count = Number.isSafeInteger(event.value) && (event.value ?? 0) > 0
            ? event.value!
            : 1;
        const name = event.name.toLowerCase();
        if (name.includes('evict')) this.evictions += count;
        if (name.includes('cancel') || name.includes('abort')) {
            this.cancellations += count;
        }
        if (name.includes('late') && name.includes('dispos')) {
            this.lateResultDisposals += count;
        }
    }

    snapshot() {
        return {
            evictions: this.evictions,
            cancellations: this.cancellations,
            lateResultDisposals: this.lateResultDisposals,
        };
    }
}

function normalizeRequest(
    request: HeadlessRenderResourceRequest,
): Record<HeadlessRenderResourceKind, number> {
    const normalized = emptyCounters();
    for (const kind of resourceKinds()) {
        const value = request[kind] ?? 0;
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The render resource request is invalid.',
            );
        }
        normalized[kind] = value;
    }
    return normalized;
}

function emptyCounters(): Record<HeadlessRenderResourceKind, number> {
    return {
        'audio-mix-bytes': 0,
        'backend-processes': 0,
        'canvas-frames': 0,
        'decoded-pixel-bytes': 0,
        'export-jobs': 0,
        'video-decoder-sessions': 0,
    };
}

function resourceKinds(): readonly HeadlessRenderResourceKind[] {
    return [
        'audio-mix-bytes',
        'backend-processes',
        'canvas-frames',
        'decoded-pixel-bytes',
        'export-jobs',
        'video-decoder-sessions',
    ];
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
}
