import { describe, expect, it, vi } from 'vitest';
import type {
    ProductionRuntimeDiagnosticsPorts,
} from './contracts.js';
import { createProductionRuntimeDiagnosticsAuthority } from './runtime-diagnostics.js';

describe('createProductionRuntimeDiagnosticsAuthority', () => {
    it('projects observed budget, decoder, queue, cache, cancellation, and disposal metrics', async () => {
        const ports = diagnosticsPorts({
            resourceBudget: { currentBytes: 1_024, peakBytes: 2_048 },
            decodedMemory: { currentBytes: 256, peakBytes: 512, leaseCount: 1 },
            decoderLeases: { reservedPixelBytes: 768, leasedPixelBytes: 512, leaseCount: 2 },
            decoderSessions: { activeSessions: 3 },
            queues: { export: 1, transcription: 4 },
            cache: { evictions: 5, cancellations: 6, lateResultDisposals: 7 },
        });
        const authority = createProductionRuntimeDiagnosticsAuthority(ports);

        const result = await authority.readDiagnostics('project-production', ['all'], context());

        expect(result).toEqual(expect.objectContaining({
            diagnosticsRevision: 1,
            currentBytes: 1_024,
            peakBytes: 2_048,
            reservedDecoderPixelBytes: 768,
            leasedDecoderPixelBytes: 512,
            decoderSessions: 3,
            queueLengths: { export: 1, transcription: 4 },
            evictions: 5,
            cancellations: 6,
            lateResultDisposals: 7,
        }));
        expect(result.leakedResourceAssertions).toEqual([
            'decoded-memory-bytes-active',
            'decoded-memory-leases-active',
            'decoder-leases-active',
            'decoder-sessions-active',
            'resource-budget-bytes-active',
        ]);
        expect(ports.resourceBudget.snapshot).toHaveBeenCalledOnce();
        expect(ports.jobQueues.snapshot).toHaveBeenCalledWith('project-production');
    });

    it('keeps its own strictly monotonic revision while snapshots change', async () => {
        let currentBytes = 10;
        const ports = diagnosticsPorts({ resourceBudget: { currentBytes, peakBytes: 10 } });
        ports.resourceBudget.snapshot.mockImplementation(() => ({ currentBytes, peakBytes: 20 }));
        const authority = createProductionRuntimeDiagnosticsAuthority(ports);

        const first = await authority.readDiagnostics('project-production', ['memory'], context());
        currentBytes = 12;
        const second = await authority.readDiagnostics('project-production', ['memory'], context());

        expect(first).toMatchObject({ diagnosticsRevision: 1, currentBytes: 10, peakBytes: 20 });
        expect(second).toMatchObject({ diagnosticsRevision: 2, currentBytes: 12, peakBytes: 20 });
    });

    it('reports only real leak assertion failures and never forwards private error text', async () => {
        const ports = diagnosticsPorts();
        ports.decoderLeases.assertReleased = vi.fn(() => {
            throw new Error('/private/runtime/decoder leaked');
        });
        const authority = createProductionRuntimeDiagnosticsAuthority(ports);

        const result = await authority.readDiagnostics('project-production', ['leaks'], context());

        expect(result.leakedResourceAssertions).toContain('decoder-leases-leak-assertion-failed');
        expect(result.leakedResourceAssertions.join(' ')).not.toContain('/private');
    });

    it('fails closed when a required counter or queue name is invalid instead of replacing it with zero', async () => {
        const badCounter = diagnosticsPorts({ cache: { evictions: -1, cancellations: 0, lateResultDisposals: 0 } });
        const badQueue = diagnosticsPorts({ queues: { '/private/queue': 1 } });

        await expect(
            createProductionRuntimeDiagnosticsAuthority(badCounter)
                .readDiagnostics('project-production', ['caches'], context()),
        ).rejects.toThrow('cache evictions');
        await expect(
            createProductionRuntimeDiagnosticsAuthority(badQueue)
                .readDiagnostics('project-production', ['queues'], context()),
        ).rejects.toThrow('invalid queue name');
    });
});

function diagnosticsPorts(overrides: {
    resourceBudget?: { currentBytes: number; peakBytes: number };
    decodedMemory?: { currentBytes: number; peakBytes: number; leaseCount: number };
    decoderLeases?: { reservedPixelBytes: number; leasedPixelBytes: number; leaseCount: number };
    decoderSessions?: { activeSessions: number };
    queues?: Record<string, number>;
    cache?: { evictions: number; cancellations: number; lateResultDisposals: number };
} = {}): ProductionRuntimeDiagnosticsPorts & {
    resourceBudget: { snapshot: ReturnType<typeof vi.fn>; assertReleased?: ReturnType<typeof vi.fn> };
    decodedMemory: { snapshot: ReturnType<typeof vi.fn>; assertReleased?: ReturnType<typeof vi.fn> };
    decoderLeases: { snapshot: ReturnType<typeof vi.fn>; assertReleased?: ReturnType<typeof vi.fn> };
    decoderSessions: { snapshot: ReturnType<typeof vi.fn>; assertReleased?: ReturnType<typeof vi.fn> };
    jobQueues: { snapshot: ReturnType<typeof vi.fn> };
    cacheMetrics: { snapshot: ReturnType<typeof vi.fn>; assertReleased?: ReturnType<typeof vi.fn> };
} {
    return {
        resourceBudget: { snapshot: vi.fn(() => overrides.resourceBudget ?? { currentBytes: 0, peakBytes: 0 }) },
        decodedMemory: { snapshot: vi.fn(() => overrides.decodedMemory ?? {
            currentBytes: 0,
            peakBytes: 0,
            leaseCount: 0,
        }) },
        decoderLeases: { snapshot: vi.fn(() => overrides.decoderLeases ?? {
            reservedPixelBytes: 0,
            leasedPixelBytes: 0,
            leaseCount: 0,
        }) },
        decoderSessions: { snapshot: vi.fn(() => overrides.decoderSessions ?? { activeSessions: 0 }) },
        jobQueues: { snapshot: vi.fn(() => overrides.queues ?? {}) },
        cacheMetrics: { snapshot: vi.fn(() => overrides.cache ?? {
            evictions: 0,
            cancellations: 0,
            lateResultDisposals: 0,
        }) },
    } as never;
}

function context() {
    return { signal: new AbortController().signal };
}
