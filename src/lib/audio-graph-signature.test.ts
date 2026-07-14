import { describe, expect, it } from 'vitest';
import type { EditorDocumentV3, TrackTranscriptionProvenanceV3 } from '@/types/video';
import {
    createTranscriptionJobGuard,
    finalizeAudioGraphMutation,
    isTranscriptionJobGuardCurrent,
} from './audio-graph-signature';
import { createDefaultRenderProfile } from './render-profile';
import type { AnimationStyle } from '@/types/timeline';

const track = {
    id: 'captions',
    name: 'Captions',
    style: {} as AnimationStyle,
    subtitles: [],
    isVisible: true,
    isLocked: false,
    timingDomain: 'video-ripple' as const,
};

const provenance = (): TrackTranscriptionProvenanceV3 => ({
    raw: [],
    groups: {},
    containerIds: [],
    sourceDocumentRevision: 1,
    sourceAudioGraphRevision: 2,
    sourceAudioGraphSignature: 'old',
    stale: false,
});

const document = (): EditorDocumentV3 => ({
    version: 3,
    revision: 1,
    audioGraphRevision: 2,
    renderProfile: createDefaultRenderProfile(),
    subtitleTracks: [track],
    videoSources: [],
    videoClips: [],
    audioSources: [],
    audioTracks: [],
    activeSubtitleTrackId: track.id,
    transientSelection: { kind: 'none' },
    transcriptionByTrackId: { [track.id]: provenance() },
});

describe('audio graph mutation finalization', () => {
    it('does not let an invalidate hint advance an unchanged canonical graph', () => {
        const previous = document();
        const next = { ...previous, revision: 2 };
        const result = finalizeAudioGraphMutation(previous, next, 'invalidate-transcription');
        expect(result.audioGraphRevision).toBe(2);
        expect(result.transcriptionByTrackId.captions.stale).toBe(false);
    });

    it('does not let a preserve hint suppress a changed canonical graph', () => {
        const previous = document();
        const next = {
            ...previous,
            renderProfile: {
                ...previous.renderProfile,
                fps: { numerator: 24, denominator: 1 },
            },
        };
        const result = finalizeAudioGraphMutation(previous, next, 'preserve-transcription');
        expect(result.audioGraphRevision).toBe(3);
        expect(result.transcriptionByTrackId.captions.stale).toBe(true);
    });

    it('allows unrelated durable revisions while guarding the audio graph and target lane', () => {
        const current = document();
        const guard = createTranscriptionJobGuard(current, current.subtitleTracks[0]);
        expect(isTranscriptionJobGuardCurrent(guard, current, current.subtitleTracks[0])).toBe(true);
        expect(isTranscriptionJobGuardCurrent(guard, {
            ...current,
            revision: current.revision + 1,
        }, current.subtitleTracks[0])).toBe(true);
        expect(isTranscriptionJobGuardCurrent(guard, current, {
            ...current.subtitleTracks[0],
            name: 'Changed',
        })).toBe(false);
        expect(isTranscriptionJobGuardCurrent(guard, {
            ...current,
            renderProfile: {
                ...current.renderProfile,
                fps: { numerator: 24, denominator: 1 },
            },
        }, current.subtitleTracks[0])).toBe(false);
    });
});
