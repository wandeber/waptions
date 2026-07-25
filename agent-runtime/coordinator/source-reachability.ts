import type { ManagedProjectEnvelopeV1 } from './types';
import type { DurableReceipt } from '../persistence/managed-filesystem-store';

export interface SourceRetention {
    sourceId: string;
    reasons: readonly string[];
}

export interface SourceReleasePlan {
    projectId: string;
    sessionRevision: number;
    releasableSourceIds: readonly string[];
    retained: readonly SourceRetention[];
}

export function evaluateSourceRelease<State>(
    envelope: ManagedProjectEnvelopeV1<State>,
    jobs: readonly { state: string; input?: unknown; checkpoint?: unknown }[],
    receipts: readonly DurableReceipt[],
    artifacts: readonly { sourceIds: readonly string[] }[] = [],
): SourceReleasePlan {
    const reasons = new Map<string, Set<string>>();
    const retain = (sourceId: string, reason: string) => {
        const current = reasons.get(sourceId) ?? new Set<string>();
        current.add(reason);
        reasons.set(sourceId, current);
    };
    for (const sourceId of envelope.editor.reachableSourceIds) retain(sourceId, 'document-or-history');
    for (const receipt of receipts) {
        for (const sourceId of receipt.retainedSourceIds) retain(sourceId, 'idempotency-receipt');
    }
    for (const artifact of artifacts) {
        for (const sourceId of artifact.sourceIds) retain(sourceId, 'retained-artifact');
    }
    for (const job of jobs) {
        if (!['queued', 'running', 'cancelling', 'interrupted'].includes(job.state)) continue;
        for (const sourceId of discoverSourceIds(job.input)) retain(sourceId, 'durable-job-input');
        for (const sourceId of discoverSourceIds(job.checkpoint)) retain(sourceId, 'durable-job-checkpoint');
    }
    const active = envelope.sourceRegistry.filter((source) => !source.releasedAt);
    return {
        projectId: envelope.projectId,
        sessionRevision: envelope.sessionRevision,
        releasableSourceIds: active
            .map((source) => source.sourceId)
            .filter((sourceId) => !reasons.has(sourceId)),
        retained: Array.from(reasons.entries())
            .map(([sourceId, sourceReasons]) => ({
                sourceId,
                reasons: Array.from(sourceReasons).sort(),
            }))
            .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    };
}

function discoverSourceIds(value: unknown): string[] {
    const found = new Set<string>();
    const visit = (candidate: unknown, key?: string) => {
        if (typeof candidate === 'string' && (key === 'sourceId' || key === 'sourceIds')) {
            found.add(candidate);
            return;
        }
        if (Array.isArray(candidate)) {
            for (const item of candidate) visit(item, key);
            return;
        }
        if (candidate && typeof candidate === 'object') {
            for (const [nestedKey, nestedValue] of Object.entries(candidate)) visit(nestedValue, nestedKey);
        }
    };
    visit(value);
    return Array.from(found);
}
