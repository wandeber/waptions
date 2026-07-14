import { describe, expect, it } from 'vitest';
import {
    applySerializablePatches,
    createSerializablePatches,
    estimateSerializableBytes,
    validateSerializablePatches,
    type SerializablePatch,
} from './serializable-patch';

const ROOTS = new Set(['tracks', 'selection']);

describe('serializable patch engine', () => {
    it('round-trips keyed arrays and preserves untouched branches by reference', () => {
        const before = {
            tracks: [
                { id: 'a', name: 'A', subtitles: [{ id: 's1', text: 'Before' }] },
                { id: 'b', name: 'B', subtitles: [] },
            ],
            selection: { id: 's1' },
        };
        const after = {
            ...before,
            tracks: [
                { ...before.tracks[0], subtitles: [{ id: 's1', text: 'After' }] },
                before.tracks[1],
            ],
        };
        const pair = createSerializablePatches(before, after, ROOTS);
        const applied = applySerializablePatches(before, pair.patches, ROOTS);
        const restored = applySerializablePatches(applied, pair.inversePatches, ROOTS);

        expect(pair.patches[0].path).toEqual([
            'tracks',
            { id: 'a' },
            'subtitles',
            { id: 's1' },
            'text',
        ]);
        expect(applied).toEqual(after);
        expect(applied.tracks[1]).toBe(before.tracks[1]);
        expect(applied.selection).toBe(before.selection);
        expect(restored).toEqual(before);
    });

    it('uses a reversible middle splice for structural array edits', () => {
        const before = { tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], selection: null };
        const after = { tracks: [{ id: 'a' }, { id: 'x' }, { id: 'y' }, { id: 'c' }], selection: null };
        const pair = createSerializablePatches(before, after, ROOTS);

        expect(pair.patches).toContainEqual({
            op: 'splice',
            path: ['tracks'],
            index: 1,
            deleteCount: 1,
            items: [{ id: 'x' }, { id: 'y' }],
        });
        expect(applySerializablePatches(before, pair.patches, ROOTS)).toEqual(after);
        expect(applySerializablePatches(after, pair.inversePatches, ROOTS)).toEqual(before);
    });

    it('represents a same-length keyed reorder with one compact splice', () => {
        const before = { tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], selection: null };
        const after = { tracks: [{ id: 'c' }, { id: 'a' }, { id: 'b' }], selection: null };
        const pair = createSerializablePatches(before, after, ROOTS);

        expect(pair.patches).toEqual([{
            op: 'splice',
            path: ['tracks'],
            index: 0,
            deleteCount: 3,
            items: after.tracks,
        }]);
        expect(applySerializablePatches(before, pair.patches, ROOTS)).toEqual(after);
        expect(applySerializablePatches(after, pair.inversePatches, ROOTS)).toEqual(before);
    });

    it('rejects roots outside the projection and prototype-pollution paths', () => {
        const hostile = { op: 'set', path: ['tracks', '__proto__', 'polluted'], value: true } as SerializablePatch;
        expect(() => validateSerializablePatches([hostile], ROOTS)).toThrow('Unsafe history path');
        expect(() => validateSerializablePatches([
            { op: 'remove', path: ['videoSources'] },
        ], ROOTS)).toThrow('is not allowed');
        expect(() => validateSerializablePatches([
            { op: 'set', path: ['selection'], value: () => undefined },
        ], ROOTS)).toThrow('structured-cloneable');
        expect(() => validateSerializablePatches([
            { op: 'set', path: ['tracks', 'length'], value: 0 },
        ], ROOTS)).toThrow('Unsafe history path');
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });

    it('round-trips deterministic randomized editor-shaped mutations under stress', () => {
        let seed = 0x5f3759df;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 0x1_0000_0000;
        };
        let current = {
            tracks: Array.from({ length: 20 }, (_unused, trackIndex) => ({
                id: `track-${trackIndex}`,
                name: `Track ${trackIndex}`,
                subtitles: Array.from({ length: 40 }, (_entry, subtitleIndex) => ({
                    id: `subtitle-${trackIndex}-${subtitleIndex}`,
                    text: `Text ${subtitleIndex}`,
                    startTime: subtitleIndex,
                    endTime: subtitleIndex + 0.8,
                })),
            })),
            selection: { id: null as string | null },
        };

        for (let iteration = 0; iteration < 250; iteration += 1) {
            const trackIndex = Math.floor(random() * current.tracks.length);
            const subtitleIndex = Math.floor(random() * current.tracks[trackIndex].subtitles.length);
            const track = current.tracks[trackIndex];
            const subtitle = track.subtitles[subtitleIndex];
            const next = {
                tracks: current.tracks.map((candidate, candidateTrackIndex) => (
                    candidateTrackIndex === trackIndex
                        ? {
                            ...candidate,
                            subtitles: candidate.subtitles.map((entry, candidateSubtitleIndex) => (
                                candidateSubtitleIndex === subtitleIndex
                                    ? { ...entry, text: `${entry.text}.${iteration}` }
                                    : entry
                            )),
                        }
                        : candidate
                )),
                selection: { id: subtitle.id },
            };
            const pair = createSerializablePatches(current, next, ROOTS);
            const applied = applySerializablePatches(current, pair.patches, ROOTS);
            expect(applied).toEqual(next);
            expect(applySerializablePatches(applied, pair.inversePatches, ROOTS)).toEqual(current);
            expect(estimateSerializableBytes(pair)).toBeGreaterThan(0);
            current = next;
        }
    });
});
