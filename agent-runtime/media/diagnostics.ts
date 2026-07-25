import type { MediaRuntimeBudgets } from '../../src/lib/media-byte-source/budgets';
import type { MediaBudgetSnapshot } from '../../src/lib/media-byte-source/budget-manager';
import type { ImmutableSourceRegistryDiagnostics } from '../source-registry/immutable-source-registry';
import type { ReviewDiagnostics } from '../review/contracts';
import type { ProbeImportDiagnostics } from './probe-import-service';

export interface ManagedMediaRuntimeSnapshot {
    readonly budgets: {
        readonly decodedPixels: MediaBudgetSnapshot;
        readonly compressedBytes: MediaBudgetSnapshot;
        readonly pcmBytes: MediaBudgetSnapshot;
        readonly mediabunnyCacheAdmissions: MediaBudgetSnapshot;
    };
    readonly sources: ImmutableSourceRegistryDiagnostics;
    readonly probeImport: ProbeImportDiagnostics;
    readonly review: ReviewDiagnostics;
}

export function captureManagedMediaRuntimeSnapshot(input: {
    budgets: MediaRuntimeBudgets;
    sourceRegistry: { diagnostics(): ImmutableSourceRegistryDiagnostics };
    probeImport: { diagnostics(): ProbeImportDiagnostics };
    review: { diagnostics(): ReviewDiagnostics };
}): ManagedMediaRuntimeSnapshot {
    return Object.freeze({
        budgets: Object.freeze({
            decodedPixels: input.budgets.decodedPixels.snapshot(),
            compressedBytes: input.budgets.compressedBytes.snapshot(),
            pcmBytes: input.budgets.pcmBytes.snapshot(),
            mediabunnyCacheAdmissions: input.budgets.mediabunnyCacheAdmissions.snapshot(),
        }),
        sources: input.sourceRegistry.diagnostics(),
        probeImport: input.probeImport.diagnostics(),
        review: input.review.diagnostics(),
    });
}

export function assertManagedMediaBudgetsDrained(budgets: MediaRuntimeBudgets): void {
    budgets.decodedPixels.assertDrained();
    budgets.compressedBytes.assertDrained();
    budgets.pcmBytes.assertDrained();
    budgets.mediabunnyCacheAdmissions.assertDrained();
}

export function assertManagedMediaRuntimeDrained(input: {
    budgets: MediaRuntimeBudgets;
    sourceRegistry: { assertDrained(): void };
    probeImport: { assertDrained(): void };
}): void {
    assertManagedMediaBudgetsDrained(input.budgets);
    input.sourceRegistry.assertDrained();
    input.probeImport.assertDrained();
}
