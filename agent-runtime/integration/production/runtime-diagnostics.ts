import type { ManagedDiagnosticsAuthority } from '../managed-tool-handlers.js';
import type {
    ProductionCacheMetricsSnapshot,
    ProductionRuntimeDiagnosticsPorts,
} from './contracts.js';

const MAX_QUEUE_NAMES = 64;
const MAX_QUEUE_NAME_LENGTH = 64;
const MAX_LEAK_ASSERTIONS = 128;
const MAX_LEAK_ASSERTION_LENGTH = 512;
const SAFE_LEAK_NAME = /^[a-z][a-z0-9-]{0,127}$/;

/**
 * Combines live process metrics through required production ports. No section receives a default
 * zero: every returned number was read from a budget, cache, scheduler, decoder, or assertion.
 */
export function createProductionRuntimeDiagnosticsAuthority(
    ports: ProductionRuntimeDiagnosticsPorts,
): ManagedDiagnosticsAuthority {
    assertDiagnosticsPorts(ports);
    let revision = 0;

    return {
        readDiagnostics: async (projectId) => {
            const resourceBudget = ports.resourceBudget.snapshot();
            const decodedMemory = ports.decodedMemory.snapshot();
            const decoderLeases = ports.decoderLeases.snapshot();
            const decoderSessions = ports.decoderSessions.snapshot();
            const queueLengths = ports.jobQueues.snapshot(projectId);
            const cacheMetrics = ports.cacheMetrics.snapshot();

            const leakAssertions = await collectLeakAssertions({
                ports,
                resourceBudget,
                decodedMemory,
                decoderLeases,
                decoderSessions,
                cacheMetrics,
            });

            return Object.freeze({
                diagnosticsRevision: nextRevision(revision),
                currentBytes: counter(resourceBudget.currentBytes, 'resource budget current bytes'),
                peakBytes: counter(resourceBudget.peakBytes, 'resource budget peak bytes'),
                reservedDecoderPixelBytes: counter(
                    decoderLeases.reservedPixelBytes,
                    'decoder reserved pixel bytes',
                ),
                leasedDecoderPixelBytes: counter(
                    decoderLeases.leasedPixelBytes,
                    'decoder leased pixel bytes',
                ),
                decoderSessions: counter(decoderSessions.activeSessions, 'decoder sessions'),
                queueLengths: canonicalQueues(queueLengths),
                evictions: counter(cacheMetrics.evictions, 'cache evictions'),
                cancellations: counter(cacheMetrics.cancellations, 'cancellations'),
                lateResultDisposals: counter(
                    cacheMetrics.lateResultDisposals,
                    'late result disposals',
                ),
                leakedResourceAssertions: Object.freeze(leakAssertions),
            });
        },
    };

    function nextRevision(previous: number): number {
        if (previous >= Number.MAX_SAFE_INTEGER) {
            throw new Error('Production diagnostics revision is exhausted.');
        }
        revision = previous + 1;
        return revision;
    }
}

function assertDiagnosticsPorts(ports: ProductionRuntimeDiagnosticsPorts): void {
    if (!ports || typeof ports !== 'object') {
        throw new TypeError('Production diagnostics ports are required.');
    }
    const required: Readonly<Record<string, unknown>> = {
        resourceBudget: ports.resourceBudget,
        decodedMemory: ports.decodedMemory,
        decoderLeases: ports.decoderLeases,
        decoderSessions: ports.decoderSessions,
        jobQueues: ports.jobQueues,
        cacheMetrics: ports.cacheMetrics,
    };
    for (const [name, port] of Object.entries(required)) {
        if (!port || typeof (port as { snapshot?: unknown }).snapshot !== 'function') {
            throw new TypeError(`Production diagnostics port "${name}" is required.`);
        }
    }
}

async function collectLeakAssertions(input: {
    ports: ProductionRuntimeDiagnosticsPorts;
    resourceBudget: { readonly currentBytes: number };
    decodedMemory: { readonly currentBytes: number; readonly leaseCount: number };
    decoderLeases: { readonly leaseCount: number };
    decoderSessions: { readonly activeSessions: number };
    cacheMetrics: ProductionCacheMetricsSnapshot;
}): Promise<string[]> {
    const assertions = new Set<string>();
    if (counter(input.resourceBudget.currentBytes, 'resource budget current bytes') > 0) {
        assertions.add('resource-budget-bytes-active');
    }
    if (counter(input.decodedMemory.currentBytes, 'decoded memory current bytes') > 0) {
        assertions.add('decoded-memory-bytes-active');
    }
    if (counter(input.decodedMemory.leaseCount, 'decoded memory lease count') > 0) {
        assertions.add('decoded-memory-leases-active');
    }
    if (counter(input.decoderLeases.leaseCount, 'decoder lease count') > 0) {
        assertions.add('decoder-leases-active');
    }
    if (counter(input.decoderSessions.activeSessions, 'decoder sessions') > 0) {
        assertions.add('decoder-sessions-active');
    }

    await Promise.all([
        assertReleased(input.ports.resourceBudget, 'resource-budget', assertions),
        assertReleased(input.ports.decodedMemory, 'decoded-memory', assertions),
        assertReleased(input.ports.decoderLeases, 'decoder-leases', assertions),
        assertReleased(input.ports.decoderSessions, 'decoder-sessions', assertions),
        assertReleased(input.ports.cacheMetrics, 'cache-metrics', assertions),
    ]);

    return [...assertions]
        .filter((assertion) => SAFE_LEAK_NAME.test(assertion))
        .sort()
        .slice(0, MAX_LEAK_ASSERTIONS)
        .map((assertion) => assertion.slice(0, MAX_LEAK_ASSERTION_LENGTH));
}

async function assertReleased(
    port: { assertReleased?: () => void | Promise<void> },
    name: string,
    assertions: Set<string>,
): Promise<void> {
    if (port.assertReleased === undefined) return;
    try {
        await port.assertReleased();
    } catch {
        assertions.add(`${name}-leak-assertion-failed`);
    }
}

function canonicalQueues(
    queueLengths: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
    const validEntries = Object.entries(queueLengths)
        .filter(([name]) => isQueueName(name))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_QUEUE_NAMES)
        .map(([name, length]) => [name, counter(length, `queue ${name}`)] as const);
    if (validEntries.length !== Object.keys(queueLengths).length) {
        throw new Error('Production job queue metrics contain an invalid queue name.');
    }
    return Object.freeze(Object.fromEntries(validEntries));
}

function isQueueName(value: string): boolean {
    return value.length > 0
        && value.length <= MAX_QUEUE_NAME_LENGTH
        && !value.includes('/')
        && !value.includes('\\')
        && !value.includes('\0');
}

function counter(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Production diagnostics ${label} must be a non-negative safe integer.`);
    }
    return value;
}
