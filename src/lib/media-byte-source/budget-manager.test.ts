import { describe, expect, it } from 'vitest';
import { MediaBudgetExceededError, MediaBudgetManager } from './budget-manager';
import { getAdaptiveDecodedPixelBudgetBytes } from './budgets';

describe('MediaBudgetManager', () => {
    it('tracks reserved and leased bytes without exceeding the hard cap', async () => {
        const budget = new MediaBudgetManager('test', 10);
        const reservation = await budget.reserve(10, { label: 'frame' });
        expect(budget.snapshot()).toMatchObject({
            currentBytes: 10,
            reservedBytes: 10,
            leasedBytes: 0,
            peakBytes: 10,
        });

        const lease = reservation.commit(7);
        expect(budget.snapshot()).toMatchObject({
            currentBytes: 7,
            reservedBytes: 0,
            leasedBytes: 7,
            activeLeases: 1,
        });
        lease.release();
        lease.release();
        expect(budget.snapshot()).toMatchObject({
            currentBytes: 0,
            activeLeases: 0,
            releases: 1,
        });
        budget.assertDrained();
    });

    it('uses strict FIFO backpressure and removes aborted waiters', async () => {
        const budget = new MediaBudgetManager('test', 10);
        const first = (await budget.reserve(6)).commit();
        const order: string[] = [];
        const blockedLarge = budget.reserve(5).then((reservation) => {
            order.push('large');
            return reservation;
        });
        const blockedSmall = budget.reserve(4).then((reservation) => {
            order.push('small');
            return reservation;
        });
        await Promise.resolve();
        expect(order).toEqual([]);

        first.release();
        const [large, small] = await Promise.all([blockedLarge, blockedSmall]);
        expect(order).toEqual(['large', 'small']);
        large.release();
        small.release();

        const held = (await budget.reserve(10)).commit();
        const controller = new AbortController();
        const cancelled = budget.reserve(1, { signal: controller.signal });
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        held.release();
        expect(budget.snapshot()).toMatchObject({ cancellations: 1, queuedReservations: 0 });
        budget.assertDrained();
    });

    it('rejects impossible reservations before allocation', async () => {
        const budget = new MediaBudgetManager('test', 4);
        await expect(budget.reserve(5)).rejects.toBeInstanceOf(MediaBudgetExceededError);
        expect(budget.snapshot()).toMatchObject({
            currentBytes: 0,
            rejectedOversized: 1,
        });
    });

    it('remains leak-free through repeated open/close style cycles', async () => {
        const budget = new MediaBudgetManager('test', 128);
        for (let index = 0; index < 50; index++) {
            const reservation = await budget.reserve(64);
            const lease = reservation.commit();
            lease.release();
        }
        expect(budget.snapshot()).toMatchObject({
            reservations: 50,
            releases: 50,
            currentBytes: 0,
            peakBytes: 64,
        });
        budget.assertDrained();
    });

    it('uses the decoded-pixel tiers from the runtime plan', () => {
        expect(getAdaptiveDecodedPixelBudgetBytes(2)).toBe(96 * 1024 * 1024);
        expect(getAdaptiveDecodedPixelBudgetBytes(4)).toBe(192 * 1024 * 1024);
        expect(getAdaptiveDecodedPixelBudgetBytes(undefined)).toBe(192 * 1024 * 1024);
        expect(getAdaptiveDecodedPixelBudgetBytes(8)).toBe(384 * 1024 * 1024);
    });
});
