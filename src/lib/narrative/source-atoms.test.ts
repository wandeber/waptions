import { describe, expect, it } from 'vitest';
import type {
    EditorialTranscriptRecordBodyV1,
    ResolvedEditorialTranscriptRecordBodyV1,
} from '@/types/editorial';
import { createEditorialTranscriptBodyFixture } from '@/types/editorial.test-fixtures';
import {
    classifyNoWordEvidence,
    deriveSourceAtoms,
    getOrderedWordSelectionRange,
    lookupHydratedSourceRange,
} from './source-atoms';

function bodyFixture(
    overrides: Partial<EditorialTranscriptRecordBodyV1> = {},
): ResolvedEditorialTranscriptRecordBodyV1 {
    return createEditorialTranscriptBodyFixture({
        sampleCount: 48_000,
        words: [{
            id: 'word_a',
            text: 'Alpha',
            alignedStartSample: 4_000,
            alignedEndSample: 8_000,
            editableStartSample: 4_000,
            editableEndSample: 8_000,
            probability: 1,
            speakerId: null,
        }, {
            id: 'word_b',
            text: 'Beta',
            alignedStartSample: 8_000,
            alignedEndSample: 12_000,
            editableStartSample: 8_000,
            editableEndSample: 12_000,
            probability: 1,
            speakerId: null,
        }, {
            id: 'word_c',
            text: 'Gamma',
            alignedStartSample: 20_000,
            alignedEndSample: 24_000,
            editableStartSample: 20_000,
            editableEndSample: 24_000,
            probability: 1,
            speakerId: null,
        }],
        speechRegions: [{
            id: 'region_acoustic',
            providerRegionId: 1,
            startSample: 3_000,
            endSample: 16_000,
            evidence: 'alignment_acoustic',
            wordStartIndex: 0,
            wordEndIndex: 2,
            vadPeakProbability: 1,
            vadMeanProbability: 1,
            startEnergyConfirmed: true,
            endEnergyConfirmed: true,
        }, {
            id: 'region_alignment',
            providerRegionId: 2,
            startSample: 18_000,
            endSample: 26_000,
            evidence: 'alignment_only',
            wordStartIndex: 2,
            wordEndIndex: 3,
            vadPeakProbability: null,
            vadMeanProbability: null,
            startEnergyConfirmed: false,
            endEnergyConfirmed: false,
        }],
        editBoundaries: [],
        ...overrides,
    }) as ResolvedEditorialTranscriptRecordBodyV1;
}

describe('hydrated narrative source atoms', () => {
    it('partitions complete coverage into readable speech and evidence-backed complements', () => {
        const atoms = deriveSourceAtoms(bodyFixture(), { start: 0, end: 32_000 });

        expect(atoms).toEqual([
            { kind: 'silence', start: 0, end: 4_000, evidence: 'acoustic-only' },
            {
                kind: 'speech',
                start: 4_000,
                end: 12_000,
                sourceWordIds: ['word_a', 'word_b'],
                speakerId: null,
            },
            { kind: 'silence', start: 12_000, end: 20_000, evidence: 'acoustic-only' },
            {
                kind: 'speech',
                start: 20_000,
                end: 24_000,
                sourceWordIds: ['word_c'],
                speakerId: null,
            },
            { kind: 'silence', start: 24_000, end: 32_000, evidence: 'unknown' },
        ]);
        expect(atoms[0].start).toBe(0);
        expect(atoms.at(-1)?.end).toBe(32_000);
        for (let index = 1; index < atoms.length; index += 1) {
            expect(atoms[index - 1].end).toBe(atoms[index].start);
        }
    });

    it('keeps partially cropped words as untranscribed coverage instead of dangling word IDs', () => {
        const atoms = deriveSourceAtoms(bodyFixture(), { start: 6_000, end: 10_000 });
        expect(atoms).toEqual([{
            kind: 'silence',
            start: 6_000,
            end: 10_000,
            evidence: 'acoustic-only',
        }]);
        expect(deriveSourceAtoms(
            bodyFixture({ speechRegions: [] }),
            { start: 6_000, end: 10_000 },
        )).toEqual([{
            kind: 'silence',
            start: 6_000,
            end: 10_000,
            evidence: 'unknown',
        }]);
    });

    it('derives explicit no-audio atoms and never mistakes arbitrary quiet source for no audio', () => {
        const noAudio = bodyFixture({ noAudioStream: true, words: [], speechRegions: [] });
        expect(deriveSourceAtoms(noAudio, { start: 1, end: 100 })).toEqual([{
            kind: 'silence',
            start: 1,
            end: 100,
            evidence: 'no-audio',
        }]);
        expect(classifyNoWordEvidence(bodyFixture(), { start: 30_000, end: 32_000 })).toBe('quiet');
    });

    it('returns body-order range lookups without deduplicating entity identity', () => {
        const body = bodyFixture();
        const lookup = lookupHydratedSourceRange(body, { start: 7_000, end: 21_000 });
        expect(lookup.words.map(word => word.id)).toEqual(['word_a', 'word_b', 'word_c']);
        expect(getOrderedWordSelectionRange(body, 'word_a', 'word_c')).toEqual({
            start: 4_000,
            end: 24_000,
        });
        // A second lookup is a second source occurrence request; equal IDs remain present rather
        // than being consumed by or deduplicated against the first lookup.
        expect(lookupHydratedSourceRange(body, { start: 7_000, end: 21_000 }).words.map(word => word.id))
            .toEqual(['word_a', 'word_b', 'word_c']);
    });
});
