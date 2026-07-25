import {
    buildAudioMixPlan,
    type AudioMixDocument,
    type AudioMixPlan,
} from './audio-mix-plan';
import type { TimelineAudioEngineSnapshot } from '@/types/timeline-audio-engine';
import type {
    AudioSourceAsset,
    AudioTrack,
    RenderProfile,
    VideoClipV3,
    VideoClipV4,
    VideoSourceAssetV3,
    VideoTrack,
    VideoTrackV4,
} from '@/types/video';

export interface TimelineAudioRuntimeDocumentInput {
    renderProfile: RenderProfile;
    videoSources: VideoSourceAssetV3[];
    videoClips: VideoClipV3[] | VideoClipV4[];
    videoTracks: VideoTrack[] | VideoTrackV4[];
    audioSources: AudioSourceAsset[];
    audioTracks: AudioTrack[];
}

interface AudioRuntimeSourceIdentity {
    kind: 'audio-source' | 'video-source-audio';
    id: string;
    fingerprint: string;
}

/**
 * Projects the large editor document into the three semantic domains consumed by playback.
 *
 * Revision counters are intentionally absent. They also cover selection, subtitle text, track
 * names, and other editor metadata that cannot alter a decoded audio sample. Full canonical
 * strings are used instead of lossy hashes: audio cache invalidation must never depend on a hash
 * collision, and these projections remain tiny compared with the media they describe.
 */
export function buildTimelineAudioRuntimeSnapshot(
    document: TimelineAudioRuntimeDocumentInput,
    contentEndSample: number,
): TimelineAudioEngineSnapshot {
    if (!Number.isSafeInteger(contentEndSample) || contentEndSample < 0) {
        throw new RangeError('Audio content end must be a non-negative safe integer.');
    }
    // The store transition is incremental, so this adapter exposes correlated V3/V4 arrays as
    // unions. buildAudioMixPlan performs the explicit-clip shape check and fails closed if a
    // caller ever supplies a mixed graph rather than one complete document version.
    const mixPlan = buildAudioMixPlan(document as AudioMixDocument);
    const sourceIdentities = collectSourceIdentities(document);
    const fingerprintsByIdentity = new Map(sourceIdentities.map((source) => [
        `${source.kind}:${source.id}`,
        source.fingerprint,
    ]));

    return {
        document,
        mixPlan,
        sourceCatalogKey: JSON.stringify(sourceIdentities),
        audibleMixKey: JSON.stringify({
            plan: mixPlan,
            // A fingerprint is not part of AudioMixPlan geometry, but replacing the bytes behind
            // an audible source must still invalidate rendered blocks and the worklet queue.
            sourceFingerprints: collectReferencedSourceFingerprints(
                mixPlan,
                fingerprintsByIdentity,
            ),
        }),
        contentEndSample,
    };
}

/** Returns a stable cache key for a transient plan while keeping the durable source identity. */
export function buildTimelineAudioMixSemanticKey(
    plan: AudioMixPlan,
    durableAudibleMixKey: string,
): string {
    return JSON.stringify({ durableAudibleMixKey, transientPlan: plan });
}

function collectSourceIdentities(
    document: TimelineAudioRuntimeDocumentInput,
): AudioRuntimeSourceIdentity[] {
    const identities: AudioRuntimeSourceIdentity[] = [
        ...document.videoSources.map((source): AudioRuntimeSourceIdentity => ({
            kind: 'video-source-audio',
            id: source.id,
            // `hasAudio` participates because it changes whether this typed source can own a
            // decoder session even when an importer happens to reuse the same file fingerprint.
            fingerprint: `${source.fingerprint}:${source.hasAudio ? 'audio' : 'silent'}`,
        })),
        ...document.audioSources.map((source): AudioRuntimeSourceIdentity => ({
            kind: 'audio-source',
            id: source.id,
            fingerprint: source.fingerprint,
        })),
    ];
    identities.sort((left, right) => (
        left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
    ));
    return identities;
}

function collectReferencedSourceFingerprints(
    plan: AudioMixPlan,
    fingerprintsByIdentity: ReadonlyMap<string, string>,
): string[] {
    return plan.contributors.map((contributor) => {
        const source = contributor.source;
        const identity = source.kind === 'audio-source'
            ? `audio-source:${source.audioSourceId}`
            : `video-source-audio:${source.videoSourceId}`;
        return `${identity}:${fingerprintsByIdentity.get(identity) ?? 'missing'}`;
    });
}
