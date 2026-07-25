import { randomUUID } from 'node:crypto';
import { managedError } from '../coordinator/errors';

export interface DecodedMemoryLease {
    leaseId: string;
    owner: string;
    bytes: number;
    release(): void;
}

export interface DecodedMemoryBudgetSnapshot {
    limitBytes: number;
    currentBytes: number;
    peakBytes: number;
    leaseCount: number;
}

/**
 * One process-wide decoded-memory budget shared by every coordinator project and worker adapter.
 * Consumers receive this injected object; they must not create per-project replacement budgets.
 */
export class ProcessDecodedMemoryBudget {
    private readonly leases = new Map<string, { owner: string; bytes: number }>();
    private currentBytes = 0;
    private peakBytes = 0;

    constructor(readonly limitBytes: number) {
        if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
            throw new Error('Decoded memory budget must be a positive safe integer.');
        }
    }

    acquire(owner: string, bytes: number): DecodedMemoryLease {
        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
            throw managedError('INVALID_REQUEST', 'Decoded memory leases require positive bytes.');
        }
        if (this.currentBytes + bytes > this.limitBytes) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The process-wide decoded-memory budget is exhausted.',
                true,
                {
                    limitBytes: this.limitBytes,
                    currentBytes: this.currentBytes,
                    requestedBytes: bytes,
                },
            );
        }
        const leaseId = randomUUID();
        this.leases.set(leaseId, { owner: owner.slice(0, 128), bytes });
        this.currentBytes += bytes;
        this.peakBytes = Math.max(this.peakBytes, this.currentBytes);
        let released = false;
        return {
            leaseId,
            owner,
            bytes,
            release: () => {
                if (released) return;
                released = true;
                const lease = this.leases.get(leaseId);
                if (!lease) return;
                this.leases.delete(leaseId);
                this.currentBytes -= lease.bytes;
            },
        };
    }

    snapshot(): DecodedMemoryBudgetSnapshot {
        return {
            limitBytes: this.limitBytes,
            currentBytes: this.currentBytes,
            peakBytes: this.peakBytes,
            leaseCount: this.leases.size,
        };
    }

    assertReleased(): void {
        if (this.leases.size > 0 || this.currentBytes !== 0) {
            throw new Error('Decoded memory leases remain active.');
        }
    }
}

const PROCESS_BUDGET_KEY = Symbol.for('waptions.managed.decoded-memory-budget');
type BudgetGlobal = typeof globalThis & { [PROCESS_BUDGET_KEY]?: ProcessDecodedMemoryBudget };

export function getProcessDecodedMemoryBudget(
    limitBytes = 384 * 1024 * 1024,
): ProcessDecodedMemoryBudget {
    const shared = globalThis as BudgetGlobal;
    if (!shared[PROCESS_BUDGET_KEY]) {
        shared[PROCESS_BUDGET_KEY] = new ProcessDecodedMemoryBudget(limitBytes);
    } else if (shared[PROCESS_BUDGET_KEY].limitBytes !== limitBytes) {
        throw new Error('The process-wide decoded-memory budget was already configured differently.');
    }
    return shared[PROCESS_BUDGET_KEY];
}
