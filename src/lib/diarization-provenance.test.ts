import { describe, expect, it } from 'vitest';
import type { AnimationStyle } from '@/types/timeline';
import type { EditorDocumentV3, TrackTranscriptionProvenanceV3 } from '@/types/video';
import { createDefaultRenderProfile } from './render-profile';
import { getStableValueSignature } from './audio-graph-signature';
import {
    createDiarizationJobGuard,
    createDiarizationProvenanceV1,
    DiarizationProvenanceCompatibilityError,
    getDiarizationProvenanceV1,
    inspectDiarizationProvenance,
    isDiarizationJobGuardCurrent,
} from './diarization-provenance';

const track = (id: string) => ({
    id,
    name: id,
    style: {} as AnimationStyle,
    subtitles: [],
    isVisible: true,
    isLocked: false,
    timingDomain: 'video-ripple' as const,
});

const provenance = (
    extension?: unknown,
    additionalExtensions: Record<string, unknown> = {},
): TrackTranscriptionProvenanceV3 => ({
    raw: [],
    groups: {},
    containerIds: [],
    sourceDocumentRevision: 1,
    sourceAudioGraphRevision: 0,
    sourceAudioGraphSignature: 'fnv1a64:unused',
    stale: false,
    extensions: extension === undefined ? additionalExtensions : {
        ...additionalExtensions,
        'waptions.transcription.diarization': extension,
    },
});

const document = (): EditorDocumentV3 => ({
    version: 3,
    revision: 1,
    audioGraphRevision: 0,
    renderProfile: createDefaultRenderProfile(),
    subtitleTracks: [track('target'), track('sibling'), track('unrelated')],
    videoSources: [],
    videoClips: [],
    videoTracks: [{ id: 'video_track_1', name: 'Video 1', clipIds: [] }],
    audioSources: [],
    audioTracks: [],
    activeSubtitleTrackId: 'target',
    transientSelection: { kind: 'none' },
    transcriptionByTrackId: {},
});

describe('diarization provenance', () => {
    it('strictly recognizes anchored v1 metadata and keeps unsupported values distinguishable', () => {
        const extension = createDiarizationProvenanceV1({
            setId: 'set-a',
            targetTrackId: 'target',
            speakerOrdinal: 0,
            sourceSpeakerLabel: 'SPEAKER_00',
        });
        expect(getDiarizationProvenanceV1(provenance(extension))).toEqual(extension);
        expect(inspectDiarizationProvenance(provenance({ ...extension, version: 2 }))).toEqual({
            kind: 'unsupported',
        });
        expect(inspectDiarizationProvenance(provenance())).toEqual({ kind: 'absent' });
    });

    it('uses canonical object ordering for metadata signatures', () => {
        expect(getStableValueSignature({ outer: { b: 2, a: 1 }, z: true }))
            .toBe(getStableValueSignature({ z: true, outer: { a: 1, b: 2 } }));
        expect(getStableValueSignature({ values: ['a', 'b'] }))
            .not.toBe(getStableValueSignature({ values: ['b', 'a'] }));
    });

    it('allows unrelated revisions and tracks while rejecting every targeted-set change', () => {
        const initial = document();
        const targetExtension = createDiarizationProvenanceV1({
            setId: 'set-a', targetTrackId: 'target', speakerOrdinal: 0, sourceSpeakerLabel: 'A',
        });
        const siblingExtension = createDiarizationProvenanceV1({
            setId: 'set-a', targetTrackId: 'target', speakerOrdinal: 1, sourceSpeakerLabel: 'B',
        });
        initial.transcriptionByTrackId = {
            target: provenance(targetExtension, { retained: { nested: true } }),
            sibling: provenance(siblingExtension),
        };
        const guard = createDiarizationJobGuard(initial, 'target')!;
        expect(guard.memberTrackIdsByOrdinal).toEqual(['target', 'sibling']);

        const unrelated = structuredClone(initial);
        unrelated.revision += 3;
        unrelated.subtitleTracks[2].name = 'Unrelated edit';
        unrelated.subtitleTracks.push(track('new-unrelated'));
        expect(isDiarizationJobGuardCurrent(guard, unrelated)).toBe(true);

        const changedTrack = structuredClone(initial);
        changedTrack.subtitleTracks[1].name = 'Changed member';
        expect(isDiarizationJobGuardCurrent(guard, changedTrack)).toBe(false);

        const changedProvenance = structuredClone(initial);
        changedProvenance.transcriptionByTrackId.target.extensions!.retained = { nested: false };
        expect(isDiarizationJobGuardCurrent(guard, changedProvenance)).toBe(false);

        const reorderedMembers = structuredClone(initial);
        reorderedMembers.subtitleTracks = [
            reorderedMembers.subtitleTracks[1],
            reorderedMembers.subtitleTracks[0],
            reorderedMembers.subtitleTracks[2],
        ];
        expect(isDiarizationJobGuardCurrent(guard, reorderedMembers)).toBe(false);

        const addedMember = structuredClone(initial);
        addedMember.subtitleTracks.push(track('third-member'));
        addedMember.transcriptionByTrackId['third-member'] = provenance(createDiarizationProvenanceV1({
            setId: 'set-a', targetTrackId: 'target', speakerOrdinal: 2, sourceSpeakerLabel: 'C',
        }));
        expect(isDiarizationJobGuardCurrent(guard, addedMember)).toBe(false);

        const changedAudio = structuredClone(initial);
        changedAudio.audioGraphRevision += 1;
        expect(isDiarizationJobGuardCurrent(guard, changedAudio)).toBe(false);

        const changedActiveTarget = structuredClone(initial);
        changedActiveTarget.activeSubtitleTrackId = 'unrelated';
        expect(isDiarizationJobGuardCurrent(guard, changedActiveTarget)).toBe(false);
        expect(createDiarizationJobGuard(changedActiveTarget, 'target')).toBeNull();
    });

    it('refuses to capture a selected target with unknown future metadata', () => {
        const initial = document();
        initial.transcriptionByTrackId.target = provenance({ version: 99, opaque: true });
        expect(() => createDiarizationJobGuard(initial, 'target'))
            .toThrow(DiarizationProvenanceCompatibilityError);
    });
});
