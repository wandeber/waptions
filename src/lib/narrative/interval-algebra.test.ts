import { describe, expect, it } from 'vitest';
import {
    classifyActivationIntervals,
    intervalsOverlap,
    planOrdinaryTrackIntervals,
    subtractHalfOpenIntervals,
} from './interval-algebra';

describe('narrative interval algebra', () => {
    it('excludes every new member of pair and transitive overlap components', () => {
        const result = classifyActivationIntervals([
            { id: 'isolated', trackId: 'track_a', trackOrder: 0, start: 0, end: 10 },
            { id: 'chain_a', trackId: 'track_a', trackOrder: 0, start: 20, end: 40 },
            { id: 'chain_b', trackId: 'track_b', trackOrder: 1, start: 35, end: 55 },
            { id: 'chain_c', trackId: 'track_c', trackOrder: 2, start: 50, end: 70 },
            { id: 'against_existing', trackId: 'track_d', trackOrder: 3, start: 90, end: 110 },
        ], [{ id: 'controlled', start: 100, end: 120 }]);

        expect(result.accepted.map(candidate => candidate.id)).toEqual(['isolated']);
        expect(result.excluded.map(exclusion => exclusion.candidateId)).toEqual([
            'chain_a',
            'chain_b',
            'chain_c',
            'against_existing',
        ]);
        expect(result.excluded[0].conflictingIds).toEqual(['chain_b', 'chain_c']);
        expect(result.excluded.at(-1)?.conflictingIds).toEqual(['controlled']);
    });

    it('treats touching half-open candidates as isolated and sorts accepted output canonically', () => {
        const result = classifyActivationIntervals([
            { id: 'later', trackId: 'track_b', trackOrder: 1, start: 10, end: 20 },
            { id: 'earlier', trackId: 'track_a', trackOrder: 0, start: 0, end: 10 },
        ], []);
        expect(result.accepted.map(candidate => candidate.id)).toEqual(['earlier', 'later']);
        expect(intervalsOverlap(result.accepted[0], result.accepted[1])).toBe(false);
    });

    it('subtracts overlapping removal coverage without producing empty ranges', () => {
        expect(subtractHalfOpenIntervals({ start: 0, end: 100 }, [
            { start: 10, end: 20 },
            { start: 15, end: 40 },
            { start: 70, end: 90 },
        ])).toEqual([
            { start: 0, end: 10 },
            { start: 40, end: 70 },
            { start: 90, end: 100 },
        ]);
    });

    it('implements the ordinary ripple/absolute and cross-track mode matrix', () => {
        const items = [
            { id: 'a', trackId: 'video_1', start: 0, end: 10 },
            { id: 'b', trackId: 'video_1', start: 10, end: 20 },
            { id: 'c', trackId: 'video_2', start: 0, end: 10 },
        ];
        expect(planOrdinaryTrackIntervals({
            mode: 'ripple',
            items,
            action: { kind: 'delete', itemId: 'a' },
        })).toMatchObject({
            kind: 'success',
            after: [
                { id: 'b', trackId: 'video_1', start: 0, end: 10 },
                { id: 'c', trackId: 'video_2', start: 0, end: 10 },
            ],
        });
        expect(planOrdinaryTrackIntervals({
            mode: 'absolute',
            items,
            action: { kind: 'delete', itemId: 'a' },
        })).toMatchObject({
            kind: 'success',
            after: [
                { id: 'b', trackId: 'video_1', start: 10, end: 20 },
                { id: 'c', trackId: 'video_2', start: 0, end: 10 },
            ],
        });
        expect(planOrdinaryTrackIntervals({
            mode: 'ripple',
            items,
            action: { kind: 'move', itemId: 'a', targetTrackId: 'video_2', targetStart: 10 },
        })).toMatchObject({
            kind: 'success',
            after: [
                { id: 'b', trackId: 'video_1', start: 0, end: 10 },
                { id: 'c', trackId: 'video_2', start: 0, end: 10 },
                { id: 'a', trackId: 'video_2', start: 10, end: 20 },
            ],
        });
        expect(planOrdinaryTrackIntervals({
            mode: 'absolute',
            items,
            action: {
                kind: 'move',
                itemId: 'a',
                targetTrackId: 'video_2',
                targetStart: Number.MAX_SAFE_INTEGER - 5,
            },
        })).toEqual({ kind: 'error', code: 'invalid-interval', itemIds: ['a'] });
    });

    it('uses a fixed-seed matrix to prove every accepted activation interval is globally isolated', () => {
        let seed = 0x4e415252;
        const random = (): number => {
            seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
            return seed / 0x1_0000_0000;
        };
        for (let trial = 0; trial < 200; trial += 1) {
            const candidates = Array.from({ length: 20 }, (_, index) => {
                const start = Math.floor(random() * 300);
                return {
                    id: `candidate_${index}`,
                    trackId: `track_${index % 4}`,
                    trackOrder: index % 4,
                    start,
                    end: start + 1 + Math.floor(random() * 30),
                };
            });
            const existing = [{ id: 'controlled', start: 140, end: 160 }];
            const result = classifyActivationIntervals(candidates, existing);
            for (const accepted of result.accepted) {
                expect(existing.some(interval => intervalsOverlap(accepted, interval))).toBe(false);
                expect(candidates.some(candidate => candidate.id !== accepted.id
                    && intervalsOverlap(accepted, candidate))).toBe(false);
            }
            for (let index = 1; index < result.accepted.length; index += 1) {
                expect(result.accepted[index - 1].start).toBeLessThanOrEqual(result.accepted[index].start);
                expect(intervalsOverlap(result.accepted[index - 1], result.accepted[index])).toBe(false);
            }
        }
    });
});
