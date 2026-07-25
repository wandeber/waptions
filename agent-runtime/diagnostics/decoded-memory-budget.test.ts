import { describe, expect, it } from 'vitest';
import { ProcessDecodedMemoryBudget } from './decoded-memory-budget';

describe('ProcessDecodedMemoryBudget', () => {
    it('enforces one shared cap and detects leaked leases', () => {
        const budget = new ProcessDecodedMemoryBudget(100);
        const first = budget.acquire('decoder-a', 60);
        expect(() => budget.acquire('decoder-b', 41)).toThrow();
        const second = budget.acquire('decoder-b', 40);
        expect(budget.snapshot()).toMatchObject({
            currentBytes: 100,
            peakBytes: 100,
            leaseCount: 2,
        });
        expect(() => budget.assertReleased()).toThrow();
        first.release();
        second.release();
        expect(() => budget.assertReleased()).not.toThrow();
    });
});
