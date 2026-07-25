import { describe, expect, it } from 'vitest';
import type { Sha256Digest } from '@/types/editorial';
import { mergeRangeTranscriptChunks, type RangeTranscriptChunk } from './range-merge';

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}`;

const chunk = (
    window: string,
    record: string,
    decoded: { startSample: number; endSample: number },
    words: RangeTranscriptChunk['words'],
): RangeTranscriptChunk => ({
    windowId: digest(window),
    recordId: digest(record),
    decoded,
    words,
});

describe('range transcript overlap merge', () => {
    it('selects duplicate evidence farthest from an edge, then confidence and window ID', () => {
        const result = mergeRangeTranscriptChunks([
            chunk('a', 'c', { startSample: 0, endSample: 100 }, [{
                text: 'Hello',
                startSample: 40,
                endSample: 50,
                probability: 0.4,
                speaker: null,
            }]),
            chunk('b', 'd', { startSample: 35, endSample: 70 }, [{
                text: ' hello ',
                startSample: 40,
                endSample: 50,
                probability: 0.99,
                speaker: null,
            }]),
        ]);

        expect(result.words).toHaveLength(1);
        expect(result.words[0]).toMatchObject({
            text: 'Hello',
            windowId: digest('a'),
            probability: 0.4,
        });
        expect(result.words[0]).not.toHaveProperty('decodedWindow');
    });

    it('retains real repeated tokens while de-duplicating quantized overlap evidence', () => {
        const result = mergeRangeTranscriptChunks([
            chunk('a', 'c', { startSample: 0, endSample: 100 }, [
                { text: 'go', startSample: 10, endSample: 20, probability: 1, speaker: null },
                { text: 'go', startSample: 30, endSample: 40, probability: 1, speaker: null },
            ]),
            chunk('b', 'd', { startSample: 15, endSample: 60 }, [
                { text: 'go', startSample: 31, endSample: 41, probability: 0.5, speaker: null },
            ]),
        ]);

        expect(result.words.map(word => [word.text, word.startSample, word.endSample]))
            .toEqual([['go', 10, 20], ['go', 30, 40]]);
    });

    it('preserves stable speaker provenance and fails closed on contradictions', () => {
        const sameSpeaker = { providerSpeakerId: 'SPEAKER_00', evidenceKey: 'window-a:voice' };
        const compatible = mergeRangeTranscriptChunks([
            chunk('a', 'c', { startSample: 0, endSample: 100 }, [{
                text: 'word',
                startSample: 20,
                endSample: 30,
                probability: 0.8,
                speaker: sameSpeaker,
            }]),
            chunk('b', 'd', { startSample: 10, endSample: 60 }, [{
                text: 'word',
                startSample: 20,
                endSample: 30,
                probability: 0.7,
                speaker: { providerSpeakerId: 'local-7', evidenceKey: 'window-b:voice' },
            }]),
        ]);
        expect(compatible.words[0].speakerProvenance).toMatchObject({
            evidenceKey: 'window-a:voice',
            chunkRecordId: digest('c'),
        });
        expect(compatible.words[0].speaker?.evidenceKey).toBe('window-a:voice');

        expect(() => mergeRangeTranscriptChunks([
            chunk('a', 'c', { startSample: 0, endSample: 100 }, [{
                text: 'word',
                startSample: 20,
                endSample: 30,
                probability: 0.8,
                speaker: sameSpeaker,
            }]),
            chunk('a', 'd', { startSample: 10, endSample: 60 }, [{
                text: 'word',
                startSample: 20,
                endSample: 30,
                probability: 0.7,
                speaker: { providerSpeakerId: 'SPEAKER_01', evidenceKey: 'window-a:other' },
            }]),
        ])).toThrow('irreconcilable speaker');
    });

    it('rejects non-monotonic provider timing instead of publishing partial output', () => {
        expect(() => mergeRangeTranscriptChunks([
            chunk('a', 'c', { startSample: 0, endSample: 100 }, [
                { text: 'late', startSample: 20, endSample: 30, probability: null, speaker: null },
                { text: 'early', startSample: 10, endSample: 15, probability: null, speaker: null },
            ]),
        ])).toThrow('non-monotonic');
    });

    it('is independent of chunk arrival order', () => {
        const chunks = [
            chunk('a', 'c', { startSample: 0, endSample: 50 }, [{
                text: 'one',
                startSample: 5,
                endSample: 10,
                probability: 0.7,
                speaker: null,
            }]),
            chunk('b', 'd', { startSample: 30, endSample: 80 }, [{
                text: 'two',
                startSample: 40,
                endSample: 50,
                probability: 0.7,
                speaker: null,
            }]),
        ];
        expect(mergeRangeTranscriptChunks(chunks))
            .toEqual(mergeRangeTranscriptChunks([...chunks].reverse()));
    });
});
