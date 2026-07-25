import { describe, expect, it } from 'vitest';
import {
    EDITORIAL_TEST_RECORD_ID,
    createEditorialDependentLinkFixture,
    createEditorialTranscriptBodyFixture,
    createEditorDocumentV4Fixture,
    createNarrativeDocumentFixture,
    createNarrativeSilenceBlockFixture,
    createNarrativeSpeechBlockFixture,
} from '@/types/editorial.test-fixtures';
import {
    NARRATIVE_BLOCK_ROW_HEIGHT,
    NARRATIVE_GAP_ROW_HEIGHT,
    buildNarrativeListProjection,
    chooseDefaultEditorialTrackIds,
    getNarrativeSilenceLabel,
    getSelectedWordBounds,
    getTargetStatusLabel,
    getTimelineNarrativeSplitSample,
    getVisibleNarrativeRows,
    summarizeSilenceDeletion,
} from './text-editor-model';

describe('text editor presentation model', () => {
    it('chooses the first unlocked track with audible linked video', () => {
        expect(chooseDefaultEditorialTrackIds([
            { id: 'locked', locked: true },
            { id: 'silent', locked: false },
            { id: 'audible', locked: false },
        ], [{
            trackId: 'silent',
            audio: null,
        }, {
            trackId: 'audible',
            audio: {
                linkState: 'linked',
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        }])).toEqual(['audible']);
    });

    it('projects one unified sequence with a derived timeline gap and hydrated words', () => {
        const speech = createNarrativeSpeechBlockFixture({
            wordTextOverrides: { editorial_word_1: 'Welcome' },
        });
        const silence = createNarrativeSilenceBlockFixture({
            timelineStartFrame: 60,
            evidence: 'acoustic-only',
        });
        const narrative = createNarrativeDocumentFixture({
            blockIds: [speech.id, silence.id],
            blocks: { [speech.id]: speech, [silence.id]: silence },
        });
        const document = createEditorDocumentV4Fixture({
            narrative,
            videoClips: [
                createEditorDocumentV4Fixture().videoClips[0],
                {
                    ...createEditorDocumentV4Fixture().videoClips[0],
                    id: silence.clipId,
                    timelineStartFrame: silence.timelineStartFrame,
                    sourceStart: 1,
                    sourceEnd: 2,
                },
            ],
            dependentLinks: [createEditorialDependentLinkFixture({ anchorBlockId: speech.id })],
        });
        const projection = buildNarrativeListProjection({
            narrative,
            bodies: { [EDITORIAL_TEST_RECORD_ID]: createEditorialTranscriptBodyFixture() },
            videoClips: document.videoClips,
            videoTracks: document.videoTracks,
            dependentLinks: document.dependentLinks,
            renderProfile: document.renderProfile,
        });

        expect(projection.rows.map((row) => row.kind)).toEqual(['block', 'gap', 'block']);
        expect(projection.totalHeight).toBe(
            NARRATIVE_BLOCK_ROW_HEIGHT * 2 + NARRATIVE_GAP_ROW_HEIGHT,
        );
        const speechRow = projection.blockRowById.get(speech.id)!;
        expect(speechRow.words[0]).toMatchObject({
            immutableText: 'Hello',
            displayText: 'Welcome',
            corrected: true,
        });
        expect(speechRow.linkCounts.subtitle).toBe(1);
        expect(projection.blockRowById.get(silence.id)?.silenceLabel).toBe('Untranscribed audio');
    });

    it('windows rows with overscan while retaining stable row identities', () => {
        const speech = createNarrativeSpeechBlockFixture();
        const narrative = createNarrativeDocumentFixture({
            blockIds: [speech.id],
            blocks: { [speech.id]: speech },
        });
        const document = createEditorDocumentV4Fixture({ narrative });
        const projection = buildNarrativeListProjection({
            narrative,
            bodies: { [EDITORIAL_TEST_RECORD_ID]: createEditorialTranscriptBodyFixture() },
            videoClips: document.videoClips,
            videoTracks: document.videoTracks,
            dependentLinks: [],
            renderProfile: document.renderProfile,
        });
        expect(getVisibleNarrativeRows(projection, 0, 50, 0).map((row) => row.id))
            .toEqual([speech.id]);
    });

    it('summarizes only source-backed silence in the requested track scope', () => {
        const speech = createNarrativeSpeechBlockFixture();
        const firstSilence = createNarrativeSilenceBlockFixture();
        const secondSilence = createNarrativeSilenceBlockFixture({
            id: 'silence_other_track',
            clipId: 'clip_other_track',
            trackId: 'video_track_other',
            timelineStartFrame: 60,
        });
        const narrative = createNarrativeDocumentFixture({
            controlledTrackIds: ['video_track_editorial', 'video_track_other'],
            blockIds: [speech.id, firstSilence.id, secondSilence.id],
            blocks: {
                [speech.id]: speech,
                [firstSilence.id]: firstSilence,
                [secondSilence.id]: secondSilence,
            },
        });
        const base = createEditorDocumentV4Fixture();
        const videoClips = [
            base.videoClips[0],
            { ...base.videoClips[0], id: firstSilence.clipId, timelineStartFrame: 30 },
            {
                ...base.videoClips[0],
                id: secondSilence.clipId,
                trackId: secondSilence.trackId,
                timelineStartFrame: 60,
            },
        ];
        expect(summarizeSilenceDeletion({
            narrative,
            videoClips,
            renderProfile: base.renderProfile,
            trackId: 'video_track_editorial',
        })).toEqual({ count: 1, durationFrames: 30 });
    });

    it('keeps quiet, no-audio, and untranscribed evidence visibly distinct', () => {
        expect(getNarrativeSilenceLabel(createNarrativeSilenceBlockFixture({ evidence: 'quiet' })))
            .toBe('Silence');
        expect(getNarrativeSilenceLabel(createNarrativeSilenceBlockFixture({ evidence: 'no-audio' })))
            .toBe('No audio');
        expect(getNarrativeSilenceLabel(createNarrativeSilenceBlockFixture({ evidence: 'unknown' })))
            .toBe('Untranscribed audio');
    });

    it('derives selected word bounds in immutable narrative order', () => {
        const speech = createNarrativeSpeechBlockFixture();
        const narrative = createNarrativeDocumentFixture({
            blockIds: [speech.id],
            blocks: { [speech.id]: speech },
        });
        const document = createEditorDocumentV4Fixture({ narrative });
        const row = buildNarrativeListProjection({
            narrative,
            bodies: { [EDITORIAL_TEST_RECORD_ID]: createEditorialTranscriptBodyFixture() },
            videoClips: document.videoClips,
            videoTracks: document.videoTracks,
            dependentLinks: [],
            renderProfile: document.renderProfile,
        }).blockRowById.get(speech.id)!;
        expect(getSelectedWordBounds(row, ['editorial_word_1'])).toEqual({
            firstWordId: 'editorial_word_1',
            lastWordId: 'editorial_word_1',
            startSample: 0,
            endSample: 16_000,
        });
    });

    it('uses exact target identity for controlled, bound, and overlap badges', () => {
        const bound = createEditorialDependentLinkFixture();
        const targetKey = 'subtitle:subtitle_track_editorial:subtitle_1';
        expect(getTargetStatusLabel(targetKey, [bound], new Set())).toBe('Exact bound');
        expect(getTargetStatusLabel(targetKey, [], new Set([targetKey]))).toBe('Controlled');
        expect(getTargetStatusLabel(targetKey, [{
            ...bound,
            association: { kind: 'overlap', origin: 'auto' },
        }], new Set())).toBe('Overlap linked');
        expect(getTargetStatusLabel(targetKey, [], new Set())).toBe('Unlinked');
    });

    it('snaps a Timeline split gesture to the nearest retained source-word boundary', () => {
        const speech = createNarrativeSpeechBlockFixture({
            coreEndSample: 16_000,
            sourceWordIds: ['editorial_word_1', 'editorial_word_2'],
        });
        const body = createEditorialTranscriptBodyFixture({
            words: [{
                id: 'editorial_word_1',
                text: 'Hello',
                alignedStartSample: 0,
                alignedEndSample: 8_000,
                editableStartSample: 0,
                editableEndSample: 8_000,
                probability: 0.99,
                speakerId: null,
            }, {
                id: 'editorial_word_2',
                text: 'world',
                alignedStartSample: 8_000,
                alignedEndSample: 16_000,
                editableStartSample: 8_000,
                editableEndSample: 16_000,
                probability: 0.99,
                speakerId: null,
            }],
        });
        const narrative = createNarrativeDocumentFixture({
            blockIds: [speech.id],
            blocks: { [speech.id]: speech },
        });
        const document = createEditorDocumentV4Fixture({ narrative });
        const row = buildNarrativeListProjection({
            narrative,
            bodies: { [EDITORIAL_TEST_RECORD_ID]: body },
            videoClips: document.videoClips,
            videoTracks: document.videoTracks,
            dependentLinks: [],
            renderProfile: document.renderProfile,
        }).blockRowById.get(speech.id)!;

        expect(getTimelineNarrativeSplitSample({
            row,
            body,
            sourceFps: 30,
            playheadFrame: 16,
            renderProfile: document.renderProfile,
        })).toBe(8_000);
    });
});
