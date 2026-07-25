import { describe, expect, it } from 'vitest';
import { parseEditMaxEditorialTranscript } from './edit-max-parser';
import { verifyCanonicalEditorialTranscriptRecord } from './transcript-body';
import deterministicE2eFixture from '../../../e2e/fixtures/editorial/edit-max-v1-32000.json';
import pointAnchorE2eFixture from '../../../e2e/fixtures/editorial/edit-max-v1-point-anchor.json';

const submitted = {
    sourceFingerprint: 'video-fingerprint',
    sampleCount: 16_000,
    language: 'es',
    speakerMode: 'none' as const,
};

function responseFixture() {
    return {
        model: 'qwen3-asr-1.7b',
        text: 'hola mundo',
        words: [
            { start: 0.18, end: 0.52, word: 'hola', probability: 0.91 },
            { start: 0.48, end: 0.82, word: 'mundo', probability: 0.89 },
        ],
        editing: {
            schema_version: 1,
            profile: 'edit-max-v1',
            requested_model: 'qwen-1.7b-edit-max',
            canonical_model: 'qwen3-asr-1.7b',
            timeline: {
                sample_rate_hz: 16_000,
                sample_count: 16_000,
                duration: 1,
                time_origin: 'decoded_audio_start',
            },
            speech_regions: [{
                id: 0,
                start_sample: 2_880,
                end_sample: 13_120,
                start: 0.18,
                end: 0.82,
                evidence: 'alignment_acoustic',
                word_start_index: 0,
                word_end_index: 2,
                vad_peak_probability: 0.96,
                vad_mean_probability: 0.9,
                start_energy_confirmed: true,
                end_energy_confirmed: true,
            }],
            edit_boundaries: [
                {
                    region_id: 0,
                    type: 'speech_start',
                    sample: 2_880,
                    time: 0.18,
                    evidence: 'alignment_acoustic',
                    energy_confirmed: true,
                },
                {
                    region_id: 0,
                    type: 'speech_end',
                    sample: 13_120,
                    time: 0.82,
                    evidence: 'alignment_acoustic',
                    energy_confirmed: true,
                },
            ],
        },
    };
}

function pointAnchorResponseFixture() {
    return structuredClone(pointAnchorE2eFixture);
}

describe('edit-max-v1 editorial parser', () => {
    it('accepts the committed deterministic browser fixture at its exact sample count', async () => {
        const parsed = await parseEditMaxEditorialTranscript(deterministicE2eFixture, {
            sourceFingerprint: 'deterministic-e2e-source',
            sampleCount: 32_006,
            language: null,
            speakerMode: 'none',
        });
        expect(parsed.body.sampleCount).toBe(32_006);
        expect(parsed.body.words.map((word) => word.text)).toEqual(['alpha', 'bravo', 'charlie']);
    });

    it('normalizes the real lazy-whisper edit-max shape into stable canonical content', async () => {
        const first = await parseEditMaxEditorialTranscript(responseFixture(), submitted);
        const second = await parseEditMaxEditorialTranscript(responseFixture(), submitted);

        expect(first.recordId).toBe(second.recordId);
        expect(first.body.contentNamespace).toBe(second.body.contentNamespace);
        expect(first.body.words.map(word => [word.alignedStartSample, word.alignedEndSample])).toEqual([
            [2_880, 8_320],
            [7_680, 13_120],
        ]);
        expect(first.body.words[0].editableEndSample).toBe(8_000);
        expect(first.body.words[1].editableStartSample).toBe(8_000);
        await expect(verifyCanonicalEditorialTranscriptRecord(first.body, first.recordId))
            .resolves.toEqual(first);
    });

    it('encodes one alignment-backed point-anchor structurally without claiming acoustic duration', async () => {
        const parse = () => parseEditMaxEditorialTranscript(pointAnchorResponseFixture(), {
            ...submitted,
            sampleCount: 32_000,
        });
        const first = await parse();
        const second = await parse();

        expect(first.body.words.map((word) => [
            word.alignedStartSample,
            word.alignedEndSample,
            word.editableStartSample,
            word.editableEndSample,
        ])).toEqual([
            [4_000, 12_000, 4_000, 12_000],
            [12_000, 12_001, 12_000, 12_001],
            [12_000, 24_000, 12_001, 24_000],
        ]);
        expect(first.body.speechRegions.map((region) => [
            region.startSample,
            region.endSample,
            region.evidence,
        ])).toEqual([[4_000, 24_000, 'alignment_acoustic']]);
        expect(first.body.editBoundaries.map((boundary) => boundary.sample)).toEqual([
            4_000,
            24_000,
        ]);
        expect(first.canonicalJson).toBe(second.canonicalJson);
        expect(first.recordId).toBe(second.recordId);
        await expect(verifyCanonicalEditorialTranscriptRecord(first.body, first.recordId))
            .resolves.toEqual(first);
    });

    it('supports a point-anchor at an owned speech-region start', async () => {
        const fixture = pointAnchorResponseFixture();
        fixture.text = 'anchor continuation';
        fixture.words = [{
            start: 0.25,
            end: 0.25,
            word: 'anchor',
            probability: null,
        }, {
            start: 0.25,
            end: 0.75,
            word: 'continuation',
            probability: 0.98,
        }];
        fixture.editing.speech_regions[0].word_end_index = 2;

        const parsed = await parseEditMaxEditorialTranscript(fixture, {
            ...submitted,
            sampleCount: 32_000,
        });

        expect(parsed.body.words.map((word) => [
            word.alignedStartSample,
            word.alignedEndSample,
            word.editableStartSample,
            word.editableEndSample,
        ])).toEqual([
            [4_000, 4_001, 4_000, 4_001],
            [4_000, 12_000, 4_001, 12_000],
        ]);
    });

    it.each([
        ['missing region ownership', 'one explicit speech-region owner',
            (fixture: ReturnType<typeof pointAnchorResponseFixture>) => {
            const region = fixture.editing.speech_regions[0] as unknown as {
                word_start_index: number | null;
                word_end_index: number | null;
            };
            region.word_start_index = null;
            region.word_end_index = null;
        }],
        ['ambiguous region ownership', 'one explicit speech-region owner',
            (fixture: ReturnType<typeof pointAnchorResponseFixture>) => {
            const original = fixture.editing.speech_regions[0];
            fixture.editing.speech_regions = [{
                ...original,
                end_sample: 12_000,
                end: 0.75,
                word_end_index: 3,
            }, {
                ...original,
                id: 1,
                start_sample: 12_000,
                start: 0.75,
                word_start_index: 0,
            }];
            fixture.editing.edit_boundaries = [{
                ...fixture.editing.edit_boundaries[0],
                sample: 4_000,
                time: 0.25,
            }, {
                ...fixture.editing.edit_boundaries[1],
                sample: 12_000,
                time: 0.75,
            }, {
                ...fixture.editing.edit_boundaries[0],
                region_id: 1,
                sample: 12_000,
                time: 0.75,
            }, {
                ...fixture.editing.edit_boundaries[1],
                region_id: 1,
                sample: 24_000,
                time: 1.5,
            }];
        }],
        ['acoustic-only region', 'alignment-backed speech-region evidence',
            (fixture: ReturnType<typeof pointAnchorResponseFixture>) => {
            fixture.editing.speech_regions[0].evidence = 'acoustic_only';
            fixture.editing.edit_boundaries.forEach((boundary) => {
                boundary.evidence = 'acoustic_only';
            });
        }],
        ['anchor at the region end', 'leave one sample inside its owning speech region',
            (fixture: ReturnType<typeof pointAnchorResponseFixture>) => {
            fixture.text = 'edge';
            fixture.words = [{
                start: 1.5,
                end: 1.5,
                word: 'edge',
                probability: null,
            }];
            fixture.editing.speech_regions[0].word_start_index = 0;
            fixture.editing.speech_regions[0].word_end_index = 1;
        }],
        ['consecutive point-anchors', 'adjacent point-anchors',
            (fixture: ReturnType<typeof pointAnchorResponseFixture>) => {
            fixture.words[2].start = 0.75;
            fixture.words[2].end = 0.75;
        }],
        ['one-sample following word', 'one editable sample per word',
            (fixture: ReturnType<typeof pointAnchorResponseFixture>) => {
            fixture.words[2].start = 0.75;
            fixture.words[2].end = 0.7500625;
        }],
        ['reversed interval', 'end must not precede its start',
            (fixture: ReturnType<typeof pointAnchorResponseFixture>) => {
            fixture.words[1].end = 0.74;
        }],
    ])('fails closed for a point-anchor with %s', async (_name, expectedError, mutate) => {
        const fixture = pointAnchorResponseFixture();
        mutate(fixture);
        await expect(parseEditMaxEditorialTranscript(fixture, {
            ...submitted,
            sampleCount: 32_000,
        })).rejects.toThrow(expectedError);
    });

    it('accepts and canonicalizes the real diarization catalog and segments', async () => {
        const fixture = responseFixture();
        fixture.words = fixture.words.map((word, index) => ({
            ...word,
            speaker: `SPEAKER_0${index}`,
        }));
        const diarized = {
            ...fixture,
            diarization: {
                model: 'pyannote/speaker-diarization-community-1',
                device: 'cpu',
                num_speakers: 2,
                speakers: ['SPEAKER_00', 'SPEAKER_01'],
                processing_seconds: 0.5,
                segments: [
                    { start: 0, end: 0.5, speaker: 'SPEAKER_00' },
                    { start: 0.5, end: 1, speaker: 'SPEAKER_01' },
                ],
                speaker_segments: [],
            },
        };

        const parsed = await parseEditMaxEditorialTranscript(diarized, {
            ...submitted,
            speakerMode: 'diarized',
        });
        expect(parsed.body.speakers.map(speaker => speaker.label)).toEqual([
            'SPEAKER_00',
            'SPEAKER_01',
        ]);
        expect(parsed.body.words.every(word => word.speakerId !== null)).toBe(true);
    });

    it('accepts an exact silent result without inventing words or speakers', async () => {
        const fixture = responseFixture();
        fixture.text = '';
        fixture.words = [];
        fixture.editing.speech_regions = [];
        fixture.editing.edit_boundaries = [];

        const parsed = await parseEditMaxEditorialTranscript(fixture, submitted);
        expect(parsed.body.words).toEqual([]);
        expect(parsed.body.speechRegions).toEqual([]);
    });

    it.each([
        ['profile', (fixture: ReturnType<typeof responseFixture>) => {
            fixture.editing.profile = 'verbose_json';
        }],
        ['model agreement', (fixture: ReturnType<typeof responseFixture>) => {
            fixture.editing.canonical_model = 'different-model';
        }],
        ['sample count', (fixture: ReturnType<typeof responseFixture>) => {
            fixture.editing.timeline.sample_count = 15_999;
        }],
        ['unknown evidence', (fixture: ReturnType<typeof responseFixture>) => {
            fixture.editing.speech_regions[0].evidence = 'unknown';
        }],
        ['boundary edge', (fixture: ReturnType<typeof responseFixture>) => {
            fixture.editing.edit_boundaries[0].sample = 2_000;
        }],
        ['boundary energy', (fixture: ReturnType<typeof responseFixture>) => {
            fixture.editing.edit_boundaries[0].energy_confirmed = false;
        }],
        ['non-finite timing', (fixture: ReturnType<typeof responseFixture>) => {
            fixture.words[0].start = Number.NaN;
        }],
    ])('fails closed on incompatible %s', async (_name, mutate) => {
        const fixture = responseFixture();
        mutate(fixture);
        await expect(parseEditMaxEditorialTranscript(fixture, submitted)).rejects.toThrow();
    });

    it('rejects non-empty text without aligned words and impossible word overlap', async () => {
        const missingWords = responseFixture();
        missingWords.words = [];
        await expect(parseEditMaxEditorialTranscript(missingWords, submitted))
            .rejects.toThrow('must contain aligned words');

        const impossible = responseFixture();
        impossible.words = [
            { start: 0, end: 1 / 16_000, word: 'a', probability: 1 },
            { start: 0, end: 1 / 16_000, word: 'b', probability: 1 },
        ];
        await expect(parseEditMaxEditorialTranscript(impossible, submitted))
            .rejects.toThrow('cannot leave at least one');
    });
});
