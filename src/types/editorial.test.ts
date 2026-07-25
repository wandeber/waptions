import { describe, expect, it } from 'vitest';
import {
    isSha256Digest,
    type EditorialTranscriptDescriptorV1,
    type EditorialTranscriptRecordBodyV1,
    type MaterializedBoundaryPolicyV1,
} from './editorial';
import {
    EDITORIAL_TEST_RECORD_ID,
    createEditorDocumentV4Fixture,
    createEditorManifestV4Fixture,
    createEditorialDependentLinkFixture,
    createEditorialTranscriptBodyFixture,
    createEditorialTranscriptDescriptorFixture,
    createNarrativeSilenceBlockFixture,
    createSubtitleTrackV4Fixture,
} from './editorial.test-fixtures';
import type { SubtitleTrackV4 } from './timeline';
import type { EditorDocumentV4, EditorManifestV4, SubtitleTrackV3 } from './video';

describe('V4 editorial contracts', () => {
    it('keeps content-addressed bodies outside descriptor-only document and manifest roots', () => {
        const document = createEditorDocumentV4Fixture();
        const manifest = createEditorManifestV4Fixture();

        const documentHasBodyField:
            'editorialTranscriptRecordBodies' extends keyof EditorDocumentV4 ? true : false = false;
        const manifestHasBodyField:
            'editorialTranscriptRecordBodies' extends keyof EditorManifestV4 ? true : false = false;
        const descriptorHasWords:
            'words' extends keyof EditorialTranscriptDescriptorV1 ? true : false = false;
        const bodyHasRecordId:
            'recordId' extends keyof EditorialTranscriptRecordBodyV1 ? true : false = false;
        const descriptorHasApiKey:
            'apiKey' extends keyof EditorialTranscriptDescriptorV1 ? true : false = false;
        const descriptorHasEndpoint:
            'endpoint' extends keyof EditorialTranscriptDescriptorV1 ? true : false = false;
        const manifestHasAuthorization:
            'authorization' extends keyof EditorManifestV4 ? true : false = false;

        expect({
            documentHasBodyField,
            manifestHasBodyField,
            descriptorHasWords,
            bodyHasRecordId,
            descriptorHasApiKey,
            descriptorHasEndpoint,
            manifestHasAuthorization,
        })
            .toEqual({
                documentHasBodyField: false,
                manifestHasBodyField: false,
                descriptorHasWords: false,
                bodyHasRecordId: false,
                descriptorHasApiKey: false,
                descriptorHasEndpoint: false,
                manifestHasAuthorization: false,
            });
        expect(JSON.stringify(document)).not.toContain('"words"');
        expect(JSON.stringify(manifest)).not.toContain('"words"');
        expect(JSON.stringify(manifest)).not.toContain('Hello');
    });

    it('keeps request identity distinct from immutable body content identity', () => {
        const descriptor = createEditorialTranscriptDescriptorFixture();
        const body = createEditorialTranscriptBodyFixture();

        expect(descriptor.recordId).toBe(EDITORIAL_TEST_RECORD_ID);
        expect(descriptor.requestKey).not.toBe(descriptor.recordId);
        expect(descriptor).not.toHaveProperty('words');
        expect(body).not.toHaveProperty('recordId');
        expect(body).not.toHaveProperty('requestKey');
        expect(body).not.toHaveProperty('createdAt');
        expect(body.words[0].text).toBe('Hello');
    });

    it('accepts only fully shaped lowercase SHA-256 identifiers at runtime', () => {
        expect(isSha256Digest(EDITORIAL_TEST_RECORD_ID)).toBe(true);
        expect(isSha256Digest(`sha256:${'A'.repeat(64)}`)).toBe(false);
        expect(isSha256Digest(`sha256:${'a'.repeat(63)}`)).toBe(false);
        expect(isSha256Digest('editorial_record')).toBe(false);
        expect(isSha256Digest(null)).toBe(false);
    });

    it('models explicit placements, one global narrative order, and typed partition seams', () => {
        const document = createEditorDocumentV4Fixture();
        const seam = {
            kind: 'partition-seam',
            seamId: 'seam_1',
        } satisfies MaterializedBoundaryPolicyV1;
        const silence = createNarrativeSilenceBlockFixture({
            materialization: {
                sourceStartFrame: 30,
                sourceEndFrame: 60,
                preBoundary: seam,
                postBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 800 },
            },
        });

        expect(document.videoClips[0]).toMatchObject({
            trackId: 'video_track_editorial',
            timelineStartFrame: 0,
        });
        expect(document.narrative?.blockIds).toEqual(['narrative_block_1']);
        expect(document.narrative).not.toHaveProperty('sequences');
        expect(silence).toMatchObject({
            kind: 'silence',
            sourceWordIds: [],
            materialization: { preBoundary: seam },
        });
    });

    it('shares one generalized exact-binding shape across dependent target kinds', () => {
        const link = createEditorialDependentLinkFixture();

        expect(link.target).toEqual({
            kind: 'subtitle',
            trackId: 'subtitle_track_editorial',
            subtitleId: 'subtitle_1',
        });
        expect(link.association).toMatchObject({
            kind: 'transcript-bound',
            binding: {
                transcriptRecordId: EDITORIAL_TEST_RECORD_ID,
                activeStartSample: 0,
                activeEndSample: 16_000,
                lineageRootId: 'narrative_lineage_1',
            },
        });
        expect([link.relativeStartOutputSample, link.relativeEndOutputSample]).toEqual([0, 48_000]);
    });

    it('replaces the hidden V3 subtitle timing domain with a visible V4 response policy', () => {
        const v3HasTimingDomain: 'timingDomain' extends keyof SubtitleTrackV3 ? true : false = true;
        const v4HasTimingDomain: 'timingDomain' extends keyof SubtitleTrackV4 ? true : false = false;
        const track = createSubtitleTrackV4Fixture({
            unlinkedVideoEditResponse: 'follow-project-ripple',
        });

        expect({ v3HasTimingDomain, v4HasTimingDomain }).toEqual({
            v3HasTimingDomain: true,
            v4HasTimingDomain: false,
        });
        expect(track.unlinkedVideoEditResponse).toBe('follow-project-ripple');
    });
});
