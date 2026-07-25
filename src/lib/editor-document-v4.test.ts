import { describe, expect, it } from 'vitest';
import {
    EDITORIAL_TEST_RECORD_ID,
    createEditorDocumentV4Fixture,
    createEditorManifestV4Fixture,
    createEditorialDependentLinkFixture,
    createEditorialTranscriptBodyFixture,
    createEditorialTranscriptDescriptorFixture,
    createNarrativeSilenceBlockFixture,
    createNarrativeSpeechBlockFixture,
    createSubtitleTrackV4Fixture,
} from '@/types/editorial.test-fixtures';
import type {
    ResolvedEditorialTranscriptMapV1,
    ResolvedEditorialTranscriptRecordBodyV1,
} from '@/types/editorial';
import type { EditorDocumentV4, VideoClipV4 } from '@/types/video';
import {
    validateEditorDocumentV4,
    validateEditorManifestV4,
    validateHydratedEditorDocumentV4,
} from './editor-document-v4';

const TEST_WORD_ID = `sha256:${'1'.repeat(64)}`;
const TEST_REGION_ID = `sha256:${'2'.repeat(64)}`;
const TEST_START_BOUNDARY_ID = `sha256:${'3'.repeat(64)}`;
const TEST_END_BOUNDARY_ID = `sha256:${'4'.repeat(64)}`;

const FIXTURE_ENTITY_IDS = new Map<string, string>([
    ['editorial_word_1', TEST_WORD_ID],
    ['editorial_region_1', TEST_REGION_ID],
    ['editorial_boundary_start_1', TEST_START_BOUNDARY_ID],
    ['editorial_boundary_end_1', TEST_END_BOUNDARY_ID],
]);

function replaceFixtureEntityId(id: string): string {
    return FIXTURE_ENTITY_IDS.get(id) ?? id;
}

/**
 * WP0 fixtures deliberately use readable placeholder references. Hydrated V4 validation tests
 * model the immutable CAS contract, whose body entity IDs are lowercase SHA-256 digests.
 */
function canonicalDocumentFixture(
    overrides: Partial<EditorDocumentV4> = {},
): EditorDocumentV4 {
    const document = structuredClone(createEditorDocumentV4Fixture(overrides));
    if (document.narrative) {
        Object.values(document.narrative.blocks).forEach((block) => {
            if (block.kind !== 'speech') return;
            block.sourceWordIds = block.sourceWordIds.map(replaceFixtureEntityId);
            block.wordTextOverrides = Object.fromEntries(Object.entries(block.wordTextOverrides)
                .map(([id, value]) => [replaceFixtureEntityId(id), value]));
            block.speakerOverrides = Object.fromEntries(Object.entries(block.speakerOverrides)
                .map(([id, value]) => [replaceFixtureEntityId(id), value]));
        });
    }
    if (document.transientSelection.kind === 'narrative') {
        document.transientSelection.sourceWordIds = document.transientSelection.sourceWordIds
            .map(replaceFixtureEntityId);
        if (document.transientSelection.boundary) {
            document.transientSelection.boundary.boundaryId = replaceFixtureEntityId(
                document.transientSelection.boundary.boundaryId,
            );
        }
    }
    return document;
}

function cloneDocument(document = canonicalDocumentFixture()): EditorDocumentV4 {
    return structuredClone(document);
}

function resolvedBody(
    body = createEditorialTranscriptBodyFixture(),
): ResolvedEditorialTranscriptRecordBodyV1 {
    const resolved = structuredClone(body);
    resolved.words.forEach((word) => {
        word.id = replaceFixtureEntityId(word.id);
        if (word.speakerId !== null) word.speakerId = replaceFixtureEntityId(word.speakerId);
    });
    resolved.speechRegions.forEach((region) => {
        region.id = replaceFixtureEntityId(region.id);
    });
    resolved.editBoundaries.forEach((boundary) => {
        boundary.id = replaceFixtureEntityId(boundary.id);
        boundary.regionId = replaceFixtureEntityId(boundary.regionId);
    });
    resolved.speakers.forEach((speaker) => {
        speaker.id = replaceFixtureEntityId(speaker.id);
    });
    return resolved as ResolvedEditorialTranscriptRecordBodyV1;
}

function resolvedMap(
    body = resolvedBody(),
): ResolvedEditorialTranscriptMapV1 {
    return { [EDITORIAL_TEST_RECORD_ID]: body } as ResolvedEditorialTranscriptMapV1;
}

function linkedSubtitleDocument(): EditorDocumentV4 {
    return canonicalDocumentFixture({
        subtitleTracks: [createSubtitleTrackV4Fixture({
            subtitles: [{ id: 'subtitle_1', startTime: 0, endTime: 1, text: 'Visible subtitle' }],
        })],
        dependentLinks: [createEditorialDependentLinkFixture()],
    });
}

function repeatedNarrativeDocument(): EditorDocumentV4 {
    const first = createNarrativeSpeechBlockFixture();
    const repeated = createNarrativeSpeechBlockFixture({
        id: 'narrative_block_repeated',
        instanceId: 'narrative_instance_repeated',
        lineageRootId: 'narrative_lineage_repeated',
        clipId: 'video_clip_repeated',
        sourceIntervalId: 'source_interval_repeated',
        timelineStartFrame: 30,
    });
    const repeatedClip: VideoClipV4 = {
        ...createEditorDocumentV4Fixture().videoClips[0],
        id: repeated.clipId,
        timelineStartFrame: repeated.timelineStartFrame,
    };
    return canonicalDocumentFixture({
        revision: 2,
        videoClips: [createEditorDocumentV4Fixture().videoClips[0], repeatedClip],
        narrative: {
            version: 1,
            id: 'narrative_repeated',
            revision: 2,
            controlledTrackIds: ['video_track_editorial'],
            blockIds: [first.id, repeated.id],
            blocks: { [first.id]: first, [repeated.id]: repeated },
            sourceRecordIds: [EDITORIAL_TEST_RECORD_ID],
            settings: {
                globalPreMarginSamples: 0,
                globalPostMarginSamples: 0,
                boundaryRefinementEnabled: true,
                showSpeakers: false,
            },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        },
    });
}

function sharedRecordDocument(): EditorDocumentV4 {
    const document = canonicalDocumentFixture();
    const sourceId = 'video_source_shared_copy';
    const clipId = 'video_clip_shared_copy';
    const block = createNarrativeSpeechBlockFixture({
        id: 'narrative_block_shared_copy',
        instanceId: 'narrative_instance_shared_copy',
        lineageRootId: 'narrative_lineage_shared_copy',
        clipId,
        sourceId,
        sourceIntervalId: 'source_interval_shared_copy',
        timelineStartFrame: 30,
        sourceWordIds: [TEST_WORD_ID],
    });
    document.revision = 2;
    document.videoSources.push({ ...document.videoSources[0], id: sourceId });
    document.videoClips.push({
        ...document.videoClips[0],
        id: clipId,
        sourceId,
        timelineStartFrame: 30,
    });
    document.editorialTranscriptDescriptors.push({
        ...document.editorialTranscriptDescriptors[0],
        sourceId,
    });
    document.narrative!.revision = 2;
    document.narrative!.blockIds.push(block.id);
    document.narrative!.blocks[block.id] = block;
    return document;
}

describe('V4 editor graph validation', () => {
    it('accepts descriptor-only runtime and manifest graphs plus repeated source occurrences', () => {
        const document = canonicalDocumentFixture();
        const manifest = createEditorManifestV4Fixture();
        const repeated = repeatedNarrativeDocument();

        expect(validateEditorDocumentV4(document)).toEqual({ valid: true, issues: [] });
        expect(validateEditorManifestV4(manifest)).toEqual({ valid: true, issues: [] });
        expect(validateEditorDocumentV4(repeated)).toEqual({ valid: true, issues: [] });
        expect(validateHydratedEditorDocumentV4(repeated, resolvedMap())).toEqual({ valid: true, issues: [] });
    });

    it('accepts a source-tail crop shorter than the ceil-rounded canonical PCM by less than one sample', () => {
        const document = cloneDocument();
        document.videoSources[0].duration = 0.99998;
        document.videoClips[0].sourceEnd = 0.99998;
        document.editorialTranscriptDescriptors[0].sampleCount = 16_000;

        expect(validateEditorDocumentV4(document)).toEqual({ valid: true, issues: [] });
    });

    it('rejects transcript bodies or body-like fields embedded in descriptor-only roots', () => {
        const withRootBody = cloneDocument() as unknown as Record<string, unknown>;
        withRootBody.editorialTranscriptRecordBodies = [createEditorialTranscriptBodyFixture()];
        expect(validateEditorDocumentV4(withRootBody).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-descriptor',
            path: 'editorialTranscriptRecordBodies',
        }));

        const withDescriptorWords = cloneDocument();
        Object.assign(withDescriptorWords.editorialTranscriptDescriptors[0], {
            words: createEditorialTranscriptBodyFixture().words,
        });
        expect(validateEditorDocumentV4(withDescriptorWords).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-descriptor',
            path: 'editorialTranscriptDescriptors[0].words',
        }));

        const withPerTrackSequence = cloneDocument();
        Object.assign(withPerTrackSequence.narrative!, {
            blockIdsByTrackId: { video_track_editorial: ['narrative_block_1'] },
        });
        Object.assign(withPerTrackSequence.narrative!.blocks.narrative_block_1, {
            words: createEditorialTranscriptBodyFixture().words,
        });
        expect(validateEditorDocumentV4(withPerTrackSequence).issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'invalid-narrative', path: 'narrative.blockIdsByTrackId' }),
            expect.objectContaining({
                code: 'invalid-narrative',
                path: 'narrative.blocks.narrative_block_1.words',
            }),
        ]));
    });

    it('preserves V3 graph checks while adding explicit track, start, mode, and subtitle policy checks', () => {
        const invalid = cloneDocument();
        invalid.globalEditingMode = 'ripple';
        Object.assign(invalid, { globalEditingMode: 'per-view-hidden-mode' });
        invalid.videoTracks[0].visible = true;
        Object.assign(invalid.videoTracks[0], { locked: 'no' });
        invalid.videoClips.push({
            ...invalid.videoClips[0],
            id: 'overlapping_clip',
            timelineStartFrame: 15,
        });
        invalid.videoClips[0].timelineStartFrame = -1;
        Object.assign(invalid.subtitleTracks, [createSubtitleTrackV4Fixture()]);
        Object.assign(invalid.subtitleTracks[0], {
            timingDomain: 'video-ripple',
            unlinkedVideoEditResponse: 'hidden',
        });

        const result = validateEditorDocumentV4(invalid);
        expect(result.valid).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'invalid-global-mode', path: 'globalEditingMode' }),
            expect.objectContaining({ code: 'missing-track', path: 'videoTracks[0].locked' }),
            expect.objectContaining({ code: 'invalid-clip-bounds', path: 'videoClips[0].timelineStartFrame' }),
            expect.objectContaining({ code: 'invalid-subtitle-policy', path: 'subtitleTracks[0].timingDomain' }),
            expect.objectContaining({
                code: 'invalid-subtitle-policy',
                path: 'subtitleTracks[0].unlinkedVideoEditResponse',
            }),
        ]));
    });

    it('rejects same-track video overlap but allows cross-track visual overlap', () => {
        const sameTrack = cloneDocument();
        sameTrack.videoClips.push({
            ...sameTrack.videoClips[0],
            id: 'same_track_overlap',
            timelineStartFrame: 10,
        });
        expect(validateEditorDocumentV4(sameTrack).issues).toContainEqual(expect.objectContaining({
            code: 'overlapping-clips',
            path: 'videoClips[1]',
        }));

        const crossTrack = cloneDocument();
        crossTrack.videoTracks.push({ id: 'video_track_lower', name: 'Lower', visible: true, locked: false });
        crossTrack.videoClips.push({
            ...crossTrack.videoClips[0],
            id: 'cross_track_overlap',
            trackId: 'video_track_lower',
        });
        expect(validateEditorDocumentV4(crossTrack)).toEqual({ valid: true, issues: [] });
    });

    it('validates descriptor hashes, source mapping uniqueness, body identity, and acquisition contract', () => {
        const invalid = cloneDocument();
        invalid.editorialTranscriptDescriptors.push(createEditorialTranscriptDescriptorFixture({
            sourceFingerprint: 'wrong-fingerprint',
            acquisition: 'local-no-audio',
        }));
        Object.assign(invalid.editorialTranscriptDescriptors[0], {
            requestKey: 'sha256:UPPERCASE',
        });

        const result = validateEditorDocumentV4(invalid);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'invalid-descriptor', path: 'editorialTranscriptDescriptors[0]' }),
            expect.objectContaining({
                code: 'conflicting-descriptor',
                path: 'editorialTranscriptDescriptors[1].recordId',
            }),
            expect.objectContaining({
                code: 'duplicate-descriptor',
                path: 'editorialTranscriptDescriptors[1].sourceId',
            }),
            expect.objectContaining({
                code: 'invalid-descriptor',
                path: 'editorialTranscriptDescriptors[1].sourceFingerprint',
            }),
            expect.objectContaining({
                code: 'invalid-descriptor',
                path: 'editorialTranscriptDescriptors[1].acquisition',
            }),
        ]));
    });

    it('allows one immutable record to map to two exact source IDs and back both narrative occurrences', () => {
        const document = sharedRecordDocument();

        expect(document.editorialTranscriptDescriptors[0].recordId)
            .toBe(document.editorialTranscriptDescriptors[1].recordId);
        expect(document.editorialTranscriptDescriptors[0].sourceId)
            .not.toBe(document.editorialTranscriptDescriptors[1].sourceId);
        expect(validateEditorDocumentV4(document)).toEqual({ valid: true, issues: [] });
        expect(validateHydratedEditorDocumentV4(document, resolvedMap())).toEqual({ valid: true, issues: [] });

        const missingExactSourceMapping = sharedRecordDocument();
        missingExactSourceMapping.editorialTranscriptDescriptors.pop();
        expect(validateEditorDocumentV4(missingExactSourceMapping).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-narrative',
            path: 'narrative.blocks.narrative_block_shared_copy.sourceId',
        }));
    });

    it('rejects conflicting body contracts and duplicate source mappings for a shared record', () => {
        const sampleConflict = sharedRecordDocument();
        sampleConflict.editorialTranscriptDescriptors[1].sampleCount += 1;
        expect(validateEditorDocumentV4(sampleConflict).issues).toContainEqual(expect.objectContaining({
            code: 'conflicting-descriptor',
            path: 'editorialTranscriptDescriptors[1].recordId',
        }));

        const fingerprintConflict = sharedRecordDocument();
        fingerprintConflict.videoSources[1].fingerprint = 'different-compatible-source-fingerprint';
        fingerprintConflict.editorialTranscriptDescriptors[1].sourceFingerprint
            = fingerprintConflict.videoSources[1].fingerprint;
        expect(validateEditorDocumentV4(fingerprintConflict).issues).toContainEqual(expect.objectContaining({
            code: 'conflicting-descriptor',
            path: 'editorialTranscriptDescriptors[1].recordId',
        }));

        const duplicateMapping = canonicalDocumentFixture();
        duplicateMapping.editorialTranscriptDescriptors.push({
            ...duplicateMapping.editorialTranscriptDescriptors[0],
            requestKey: `sha256:${'8'.repeat(64)}`,
            endpointIdentityDigest: `sha256:${'7'.repeat(64)}`,
        });
        expect(validateEditorDocumentV4(duplicateMapping).issues).toContainEqual(expect.objectContaining({
            code: 'duplicate-descriptor',
            path: 'editorialTranscriptDescriptors[1].sourceId',
        }));

        const requestConflict = sharedRecordDocument();
        requestConflict.editorialTranscriptDescriptors[1].recordId = `sha256:${'9'.repeat(64)}`;
        expect(validateEditorDocumentV4(requestConflict).issues).toContainEqual(expect.objectContaining({
            code: 'conflicting-descriptor',
            path: 'editorialTranscriptDescriptors[1].requestKey',
        }));
    });

    it('treats every immutable-body descriptor field as part of shared-record compatibility', () => {
        const conflicts: Array<[string, Record<string, unknown>]> = [
            ['source fingerprint', { sourceFingerprint: 'different-fingerprint' }],
            ['PCM algorithm', { pcmAlgorithmVersion: 2 }],
            ['record body version', { recordBodyVersion: 2 }],
            ['canonical JSON version', { canonicalJsonVersion: 2 }],
            ['response profile', { responseSchema: 'different-profile' }],
            ['requested model', { requestedModel: 'different-requested-model' }],
            ['canonical model', { canonicalModel: 'different-canonical-model' }],
            ['sample rate', { sampleRateHz: 8_000 }],
            ['sample count', { sampleCount: 159_999 }],
            ['language', { language: 'es' }],
            ['speaker mode', { speakerMode: 'diarized' }],
            ['acquisition', { acquisition: 'local-no-audio' }],
        ];

        conflicts.forEach(([label, mutation]) => {
            const document = sharedRecordDocument();
            Object.assign(document.editorialTranscriptDescriptors[1], mutation);
            expect(validateEditorDocumentV4(document).issues, label).toContainEqual(expect.objectContaining({
                code: 'conflicting-descriptor',
                path: 'editorialTranscriptDescriptors[1].recordId',
            }));
        });
    });

    it('allows different request provenance to deduplicate to the same compatible body', () => {
        const document = sharedRecordDocument();
        document.editorialTranscriptDescriptors[1].requestKey = `sha256:${'8'.repeat(64)}`;
        document.editorialTranscriptDescriptors[1].endpointIdentityDigest = `sha256:${'7'.repeat(64)}`;

        expect(validateEditorDocumentV4(document)).toEqual({ valid: true, issues: [] });
    });

    it('checks one hydrated shared body against every source descriptor mapping', () => {
        const document = sharedRecordDocument();
        document.editorialTranscriptDescriptors.forEach((descriptor) => {
            descriptor.canonicalModel = 'different-runtime-model';
        });

        expect(validateEditorDocumentV4(document)).toEqual({ valid: true, issues: [] });
        const mismatches = validateHydratedEditorDocumentV4(document, resolvedMap()).issues
            .filter((issue) => issue.code === 'transcript-body-mismatch');
        expect(mismatches).toEqual([
            expect.objectContaining({ path: expect.stringContaining('descriptorMappings[0]') }),
            expect.objectContaining({ path: expect.stringContaining('descriptorMappings[1]') }),
        ]);
    });

    it('rejects orphan blocks, mismatched ownership, speech without words, and global controlled overlap', () => {
        const document = cloneDocument();
        const first = document.narrative!.blocks.narrative_block_1;
        if (first.kind !== 'speech') throw new Error('Expected speech fixture.');
        first.sourceWordIds = [];
        first.timelineStartFrame = 1;
        document.narrative!.blocks.orphan_block = createNarrativeSilenceBlockFixture({ id: 'orphan_block' });

        document.videoTracks.push({ id: 'video_track_second', name: 'Second', visible: true, locked: false });
        const overlapping = createNarrativeSilenceBlockFixture({
            trackId: 'video_track_second',
            timelineStartFrame: 15,
        });
        document.videoClips.push({
            ...document.videoClips[0],
            id: overlapping.clipId,
            trackId: overlapping.trackId,
            timelineStartFrame: overlapping.timelineStartFrame,
            sourceStart: 1,
            sourceEnd: 2,
        });
        document.narrative!.controlledTrackIds.push(overlapping.trackId);
        document.narrative!.blockIds.push(overlapping.id);
        document.narrative!.blocks[overlapping.id] = overlapping;

        const result = validateEditorDocumentV4(document);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'invalid-narrative', path: 'narrative.blocks.orphan_block' }),
            expect.objectContaining({ code: 'invalid-narrative', path: 'narrative.blocks.narrative_block_1' }),
            expect.objectContaining({
                code: 'invalid-narrative',
                path: 'narrative.blocks.narrative_block_1.sourceWordIds',
            }),
            expect.objectContaining({ code: 'invalid-narrative', path: 'narrative.blockIds[1]' }),
        ]));
    });

    it('accepts paired split seams and rejects an over-subscribed seam identity', () => {
        const document = cloneDocument();
        const first = document.narrative!.blocks.narrative_block_1;
        first.materialization.postBoundary = { kind: 'partition-seam', seamId: 'partition_seam_1' };
        const second = createNarrativeSilenceBlockFixture({
            lineageRootId: first.lineageRootId,
            materialization: {
                ...createNarrativeSilenceBlockFixture().materialization,
                preBoundary: { kind: 'partition-seam', seamId: 'partition_seam_1' },
            },
        });
        document.videoClips.push({
            ...document.videoClips[0],
            id: second.clipId,
            timelineStartFrame: 30,
            sourceStart: 1,
            sourceEnd: 2,
        });
        document.narrative!.blockIds.push(second.id);
        document.narrative!.blocks[second.id] = second;

        expect(validateEditorDocumentV4(document)).toEqual({ valid: true, issues: [] });

        // A 4,000-sample semantic boundary at 29.97 fps falls inside native frame 7. The paired
        // seam must keep that exact frame for both children even though the left core extends a
        // fraction beyond its materialized end; outward containment applies only to margins.
        document.videoSources[0].fps = 29.97;
        first.coreEndSample = 4_000;
        first.materialization.sourceEndFrame = 7;
        document.videoClips[0].sourceEnd = 7 / 29.97;
        second.coreStartSample = 4_000;
        second.materialization.sourceStartFrame = 7;
        second.materialization.sourceEndFrame = 60;
        second.timelineStartFrame = 7;
        document.videoClips[1].timelineStartFrame = 7;
        document.videoClips[1].sourceStart = 7 / 29.97;
        document.videoClips[1].sourceEnd = 60 / 29.97;
        expect(validateEditorDocumentV4(document)).toEqual({ valid: true, issues: [] });

        document.narrative!.blocks[second.id].lineageRootId = 'different_lineage';
        expect(validateEditorDocumentV4(document).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-materialization',
            path: 'narrative.blocks',
        }));
        document.narrative!.blocks[second.id].lineageRootId = first.lineageRootId;

        first.materialization.preBoundary = { kind: 'partition-seam', seamId: 'partition_seam_1' };
        expect(validateEditorDocumentV4(document).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-materialization',
            path: 'narrative.blocks',
        }));
    });

    it('validates generalized targets, exact fragment identity, ownership, and current offsets', () => {
        expect(validateEditorDocumentV4(linkedSubtitleDocument())).toEqual({ valid: true, issues: [] });

        const stale = linkedSubtitleDocument();
        stale.dependentLinks[0].relativeEndOutputSample = 47_999;
        expect(validateEditorDocumentV4(stale).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-dependent-link',
            path: 'dependentLinks[0]',
        }));

        const ownedTarget = cloneDocument();
        ownedTarget.dependentLinks = [createEditorialDependentLinkFixture({
            target: { kind: 'video-clip', clipId: 'video_clip_editorial' },
            association: { kind: 'overlap', origin: 'manual' },
            relativeStartOutputSample: 0,
            relativeEndOutputSample: 48_000,
        })];
        expect(validateEditorDocumentV4(ownedTarget).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-dependent-link',
            path: 'dependentLinks[0].target.clipId',
        }));

        const invalidBinding = linkedSubtitleDocument();
        if (invalidBinding.dependentLinks[0].association.kind !== 'transcript-bound') {
            throw new Error('Expected exact binding fixture.');
        }
        invalidBinding.dependentLinks[0].association.binding.lineageRootId = 'another_occurrence';
        expect(validateEditorDocumentV4(invalidBinding).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-dependent-link',
            path: 'dependentLinks[0].association.binding',
        }));
    });

    it('deep-validates descriptor/body identity and required body availability', () => {
        const document = canonicalDocumentFixture();
        expect(validateHydratedEditorDocumentV4(document, resolvedMap())).toEqual({ valid: true, issues: [] });

        expect(validateHydratedEditorDocumentV4(document, {})).toEqual({
            valid: false,
            issues: [expect.objectContaining({ code: 'missing-transcript-record' })],
        });

        const mismatched = createEditorialTranscriptBodyFixture({
            canonicalModel: 'different-runtime-model',
            sampleCount: 159_999,
        });
        expect(validateHydratedEditorDocumentV4(document, resolvedMap(resolvedBody(mismatched))).issues)
            .toContainEqual(expect.objectContaining({
                code: 'transcript-body-mismatch',
                path: `resolvedBodies.${EDITORIAL_TEST_RECORD_ID}.descriptorMappings[0]`,
            }));
    });

    it('requires SHA-256 entity identities once descriptor-only references are hydrated', () => {
        const placeholderDocument = createEditorDocumentV4Fixture();
        const placeholderBody = createEditorialTranscriptBodyFixture() as ResolvedEditorialTranscriptRecordBodyV1;

        expect(validateEditorDocumentV4(placeholderDocument)).toEqual({ valid: true, issues: [] });
        expect(validateHydratedEditorDocumentV4(
            placeholderDocument,
            { [EDITORIAL_TEST_RECORD_ID]: placeholderBody } as ResolvedEditorialTranscriptMapV1,
        ).issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'invalid-transcript-body',
                path: `resolvedBodies.${EDITORIAL_TEST_RECORD_ID}.words[0].id`,
            }),
            expect.objectContaining({
                code: 'invalid-transcript-body',
                path: `resolvedBodies.${EDITORIAL_TEST_RECORD_ID}.speechRegions[0]`,
            }),
            expect.objectContaining({
                code: 'invalid-transcript-body',
                path: `resolvedBodies.${EDITORIAL_TEST_RECORD_ID}.editBoundaries[0]`,
            }),
        ]));
    });

    it('accepts a local no-audio body only with source-backed no-audio silence evidence', () => {
        const document = cloneDocument();
        document.videoSources[0].hasAudio = false;
        document.videoClips[0].audio = null;
        document.editorialTranscriptDescriptors[0].acquisition = 'local-no-audio';
        const silence = createNarrativeSilenceBlockFixture({
            id: 'narrative_block_1',
            clipId: 'video_clip_editorial',
            coreStartSample: 0,
            coreEndSample: 16_000,
            materialization: {
                sourceStartFrame: 0,
                sourceEndFrame: 30,
                preBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
                postBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
            },
            timelineStartFrame: 0,
            evidence: 'no-audio',
        });
        document.narrative!.blocks = { [silence.id]: silence };
        const body = createEditorialTranscriptBodyFixture({
            noAudioStream: true,
            words: [],
            speechRegions: [],
            editBoundaries: [],
            speakers: [],
        });

        expect(validateHydratedEditorDocumentV4(document, resolvedMap(resolvedBody(body))))
            .toEqual({ valid: true, issues: [] });

        silence.evidence = 'quiet';
        expect(validateHydratedEditorDocumentV4(document, resolvedMap(resolvedBody(body))).issues)
            .toContainEqual(expect.objectContaining({
                code: 'invalid-transcript-reference',
                path: 'narrative.blocks.narrative_block_1.evidence',
            }));
    });

    it('accepts a partially cropped word as untranscribed coverage but rejects a retained word', () => {
        const document = cloneDocument();
        const silence = createNarrativeSilenceBlockFixture({
            id: 'narrative_block_1',
            clipId: 'video_clip_editorial',
            coreStartSample: 0,
            coreEndSample: 16_000,
            materialization: {
                sourceStartFrame: 0,
                sourceEndFrame: 30,
                preBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
                postBoundary: { kind: 'margin', mode: 'inherit-global', requestedSamples: null },
            },
            timelineStartFrame: 0,
            evidence: 'unknown',
        });
        document.narrative!.blocks = { [silence.id]: silence };

        const bodyWithWord = (startSample: number, endSample: number) => {
            const fixture = createEditorialTranscriptBodyFixture();
            return resolvedBody(createEditorialTranscriptBodyFixture({
                words: [{
                    ...fixture.words[0],
                    alignedStartSample: startSample,
                    alignedEndSample: endSample,
                    editableStartSample: startSample,
                    editableEndSample: endSample,
                }],
                speechRegions: [{
                    ...fixture.speechRegions[0],
                    startSample,
                    endSample,
                }],
                editBoundaries: [{
                    ...fixture.editBoundaries[0],
                    sample: startSample,
                }, {
                    ...fixture.editBoundaries[1],
                    sample: endSample,
                }],
            }));
        };

        expect(validateHydratedEditorDocumentV4(
            document,
            resolvedMap(bodyWithWord(15_000, 17_000)),
        )).toEqual({ valid: true, issues: [] });
        expect(validateHydratedEditorDocumentV4(
            document,
            resolvedMap(bodyWithWord(8_000, 12_000)),
        ).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-transcript-reference',
            path: 'narrative.blocks.narrative_block_1',
        }));
    });

    it('deep-validates body ranges, region boundaries, speakers, and block word order', () => {
        const document = canonicalDocumentFixture();
        const invalidBody = createEditorialTranscriptBodyFixture({
            speakerMode: 'diarized',
            words: [{
                ...createEditorialTranscriptBodyFixture().words[0],
                editableEndSample: 200_000,
                speakerId: 'missing_speaker',
            }],
            speechRegions: [{
                ...createEditorialTranscriptBodyFixture().speechRegions[0],
                endSample: 20_000,
            }],
        });
        const issues = validateHydratedEditorDocumentV4(
            document,
            resolvedMap(resolvedBody(invalidBody)),
        ).issues;
        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'invalid-transcript-body', path: expect.stringContaining('.words[0]') }),
            expect.objectContaining({
                code: 'invalid-transcript-body',
                path: expect.stringContaining('.words[0].speakerId'),
            }),
            expect.objectContaining({
                code: 'invalid-transcript-body',
                path: expect.stringContaining('.editBoundaries'),
            }),
        ]));

        const missingWord = cloneDocument();
        const speech = missingWord.narrative!.blocks.narrative_block_1;
        if (speech.kind !== 'speech') throw new Error('Expected speech fixture.');
        speech.sourceWordIds = ['missing_word'];
        expect(validateHydratedEditorDocumentV4(missingWord, resolvedMap()).issues).toContainEqual(
            expect.objectContaining({
                code: 'invalid-transcript-reference',
                path: 'narrative.blocks.narrative_block_1.sourceWordIds[0]',
            }),
        );
    });

    it('keeps provider word probability finite while enforcing normalized editable bounds', () => {
        const document = canonicalDocumentFixture();
        const finiteProviderValue = resolvedBody(createEditorialTranscriptBodyFixture({
            words: [{ ...createEditorialTranscriptBodyFixture().words[0], probability: 2 }],
        }));
        expect(validateHydratedEditorDocumentV4(document, resolvedMap(finiteProviderValue)))
            .toEqual({ valid: true, issues: [] });

        const invalidEditableBounds = resolvedBody(createEditorialTranscriptBodyFixture({
            words: [{
                ...createEditorialTranscriptBodyFixture().words[0],
                alignedStartSample: 1,
                editableStartSample: 0,
            }],
        }));
        expect(validateHydratedEditorDocumentV4(document, resolvedMap(invalidEditableBounds)).issues)
            .toContainEqual(expect.objectContaining({
                code: 'invalid-transcript-body',
                path: `resolvedBodies.${EDITORIAL_TEST_RECORD_ID}.words[0]`,
            }));
    });

    it('fails safely with precise paths for malformed untrusted root shapes and File mismatch', () => {
        expect(validateEditorManifestV4({ version: 4 }).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-graph-shape',
            path: 'subtitleTracks',
        }));

        const wrongVersion = createEditorManifestV4Fixture() as unknown as Record<string, unknown>;
        wrongVersion.version = 3;
        expect(validateEditorManifestV4(wrongVersion).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-version',
            path: 'version',
        }));

        const runtimeFieldsInManifest = createEditorManifestV4Fixture() as unknown as Record<string, unknown>;
        runtimeFieldsInManifest.transientSelection = { kind: 'none' };
        const descriptors = runtimeFieldsInManifest.videoSourceDescriptors as Array<Record<string, unknown>>;
        descriptors[0].file = { name: 'forbidden.webm' };
        expect(validateEditorManifestV4(runtimeFieldsInManifest).issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'invalid-graph-shape', path: 'transientSelection' }),
            expect.objectContaining({ code: 'file-mismatch', path: 'videoSourceDescriptors[0].file' }),
        ]));

        const mismatchedFile = cloneDocument();
        mismatchedFile.videoSources[0].file = {
            ...mismatchedFile.videoSources[0].file,
            name: 'different.webm',
        } as File;
        expect(validateEditorDocumentV4(mismatchedFile).issues).toContainEqual(expect.objectContaining({
            code: 'file-mismatch',
            path: 'videoSources[0].file',
        }));

        const invalidProvenance = cloneDocument();
        invalidProvenance.subtitleTracks = [createSubtitleTrackV4Fixture()];
        invalidProvenance.transcriptionByTrackId.subtitle_track_editorial = {
            raw: [],
            groups: {},
            containerIds: [],
            sourceDocumentRevision: 0,
            sourceAudioGraphRevision: 0,
            sourceAudioGraphSignature: 'fnv1a64:0000000000000000',
            stale: 'not-a-boolean' as unknown as boolean,
        };
        expect(validateEditorDocumentV4(invalidProvenance).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-transcription-provenance',
            path: 'transcriptionByTrackId.subtitle_track_editorial.stale',
        }));

        const malformedSeam = cloneDocument();
        Object.assign(malformedSeam.narrative!.blocks.narrative_block_1.materialization, {
            preBoundary: null,
        });
        expect(() => validateEditorDocumentV4(malformedSeam)).not.toThrow();
        expect(validateEditorDocumentV4(malformedSeam).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-materialization',
            path: 'narrative.blocks.narrative_block_1.materialization.preBoundary',
        }));

        const malformedBody = {
            ...resolvedBody(),
            words: [null],
        } as unknown as ResolvedEditorialTranscriptRecordBodyV1;
        expect(() => validateHydratedEditorDocumentV4(
            canonicalDocumentFixture(),
            resolvedMap(malformedBody),
        )).not.toThrow();
        expect(validateHydratedEditorDocumentV4(
            canonicalDocumentFixture(),
            resolvedMap(malformedBody),
        ).issues).toContainEqual(expect.objectContaining({
            code: 'invalid-transcript-body',
            path: `resolvedBodies.${EDITORIAL_TEST_RECORD_ID}.words[0]`,
        }));
    });
});
