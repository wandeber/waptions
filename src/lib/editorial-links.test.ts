import { describe, expect, it } from 'vitest';
import {
    EDITORIAL_TEST_RECORD_ID,
    createEditorialTranscriptDescriptorFixture,
    createNarrativeSpeechBlockFixture,
    createSubtitleTrackV4Fixture,
    createVideoSourceAssetV4Fixture,
} from '@/types/editorial.test-fixtures';
import type {
    EditorialDependentLinkV1,
    EditorialDependentTargetV1,
    NarrativeBlockV1,
    NarrativeDocumentV1,
    TranscriptFragmentBindingV1,
} from '@/types/editorial';
import type {
    AudioClip,
    AudioSourceAsset,
    EditorDocumentV4,
    ImportedAudioClip,
    VideoClipV4,
} from '@/types/video';
import { frameToOutputSample } from './audio-timebase';
import { validateEditorDocumentV4 } from './editor-document-v4';
import {
    classifyEditorialTargets,
    discoverEditorialOverlapCandidates,
    getEditorialTargetInterval,
    planBindEditorialTarget,
    planCreateManualOverlapLink,
    planDiscoverEditorialOverlapLinks,
    planEditorialLinksForAnchorTransforms,
    planEditorialLinksForTargetTransforms,
    planIntegrateDiscoveredEditorialOverlapLinks,
    planReanchorEditorialLink,
    planSetEditorialLinkFollowPolicy,
    planUnbindEditorialTarget,
    planUnlinkEditorialTarget,
    validateEditorialLinkGraph,
    type EditorialLinkCommandGuard,
    type EditorialLinkIdFactory,
} from './editorial-links';
import {
    planReleaseNarrativeTracks,
    type NarrativeAnchorTransform,
} from './narrative/commands';

const VIDEO_TARGET = { kind: 'video-clip', clipId: 'dependent_video' } as const;
const AUDIO_TARGET = { kind: 'audio-clip', trackId: 'audio_track', clipId: 'dependent_audio' } as const;
const SUBTITLE_TARGET = {
    kind: 'subtitle', trackId: 'subtitle_track', subtitleId: 'dependent_subtitle',
} as const;
const TARGETS = [VIDEO_TARGET, AUDIO_TARGET, SUBTITLE_TARGET] as const;

function createAudioSource(): AudioSourceAsset {
    const file = {
        name: 'audio.wav',
        type: 'audio/wav',
        size: 96_000,
        lastModified: 1_700_000_000_000,
    } as File;
    return {
        id: 'audio_source',
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        fingerprint: 'audio-fingerprint',
        duration: 2,
        nativeSampleRate: 48_000,
        nativeSampleCount: 96_000,
        nativeChannelCount: 1,
        bitrate: 768_000,
        codec: 'pcm_s16le',
        file,
    };
}

function speechBlock(input: {
    id: string;
    clipId: string;
    timelineStartFrame: number;
    sourceStartFrame: number;
    sourceEndFrame: number;
    coreStartSample: number;
    coreEndSample: number;
    sourceIntervalId?: string;
    lineageRootId?: string;
}): NarrativeBlockV1 {
    return createNarrativeSpeechBlockFixture({
        id: input.id,
        clipId: input.clipId,
        instanceId: `instance_${input.id}`,
        lineageRootId: input.lineageRootId ?? 'lineage_anchor',
        sourceIntervalId: input.sourceIntervalId ?? `interval_${input.id}`,
        trackId: 'controlled_track',
        sourceId: 'video_source_editorial',
        timelineStartFrame: input.timelineStartFrame,
        coreStartSample: input.coreStartSample,
        coreEndSample: input.coreEndSample,
        sourceWordIds: ['editorial_word_1'],
        materialization: {
            sourceStartFrame: input.sourceStartFrame,
            sourceEndFrame: input.sourceEndFrame,
            preBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
            postBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
        },
    });
}

function ownedClip(block: NarrativeBlockV1): VideoClipV4 {
    return {
        id: block.clipId,
        sourceId: block.sourceId,
        trackId: block.trackId,
        timelineStartFrame: block.timelineStartFrame,
        sourceStart: block.materialization.sourceStartFrame / 30,
        sourceEnd: block.materialization.sourceEndFrame / 30,
        audio: {
            linkState: 'linked',
            muted: false,
            gainDb: 0,
            fadeInFrames: 0,
            fadeOutFrames: 0,
        },
    };
}

function createDocument(options: {
    twoAnchors?: boolean;
    mode?: 'ripple' | 'absolute';
    targetStartFrame?: number;
    targetDurationFrames?: number;
} = {}): EditorDocumentV4 {
    const first = speechBlock({
        id: 'anchor_a',
        clipId: 'owned_a',
        timelineStartFrame: 0,
        sourceStartFrame: 0,
        sourceEndFrame: 30,
        coreStartSample: 0,
        coreEndSample: 16_000,
    });
    const blocks: Record<string, NarrativeBlockV1> = { [first.id]: first };
    const blockIds = [first.id];
    const clips = [ownedClip(first)];
    if (options.twoAnchors) {
        const second = speechBlock({
            id: 'anchor_b',
            clipId: 'owned_b',
            timelineStartFrame: 30,
            sourceStartFrame: 30,
            sourceEndFrame: 60,
            coreStartSample: 16_000,
            coreEndSample: 32_000,
            sourceIntervalId: 'interval_anchor_b',
        });
        blocks[second.id] = second;
        blockIds.push(second.id);
        clips.push(ownedClip(second));
    }
    const narrative: NarrativeDocumentV1 = {
        version: 1,
        id: 'narrative',
        revision: 1,
        controlledTrackIds: ['controlled_track'],
        blockIds,
        blocks,
        sourceRecordIds: [EDITORIAL_TEST_RECORD_ID],
        settings: {
            globalPreMarginSamples: 0,
            globalPostMarginSamples: 0,
            boundaryRefinementEnabled: true,
            showSpeakers: false,
        },
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
    };
    const targetStartFrame = options.targetStartFrame ?? 5;
    const targetDurationFrames = options.targetDurationFrames ?? 15;
    return {
        version: 4,
        revision: 1,
        audioGraphRevision: 0,
        renderProfile: {
            fps: { numerator: 30, denominator: 1 },
            width: 1_920,
            height: 1_080,
            audioSampleRate: 48_000,
            isFrameRateLocked: true,
            isCanvasSizeLocked: true,
        },
        renderBackgroundColor: '#000000',
        subtitleTracks: [createSubtitleTrackV4Fixture({
            id: 'subtitle_track',
            subtitles: [{
                id: 'dependent_subtitle',
                startTime: targetStartFrame / 30,
                endTime: (targetStartFrame + targetDurationFrames) / 30,
                text: 'Dependent',
            }],
        })],
        videoSources: [createVideoSourceAssetV4Fixture({ duration: 10, fps: 30 })],
        videoClips: [...clips, {
            id: 'dependent_video',
            sourceId: 'video_source_editorial',
            trackId: 'dependent_video_track',
            timelineStartFrame: targetStartFrame,
            sourceStart: 2,
            sourceEnd: 2 + targetDurationFrames / 30,
            audio: {
                linkState: 'linked',
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        }],
        videoTracks: [{
            id: 'controlled_track', name: 'Controlled', visible: true, locked: false,
        }, {
            id: 'dependent_video_track', name: 'Dependent', visible: true, locked: false,
        }],
        audioSources: [createAudioSource()],
        audioTracks: [{
            id: 'audio_track',
            name: 'Audio',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [{
                id: 'dependent_audio',
                source: { kind: 'audio-source', audioSourceId: 'audio_source' },
                timelineStartFrame: targetStartFrame,
                sourceStartSample: 0,
                sourceEndSample: targetDurationFrames * 1_600,
                timelineDurationSamples: targetDurationFrames * 1_600,
                fadeInSamples: 0,
                fadeOutSamples: 0,
                muted: false,
                gainDb: 0,
            }],
        }],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
        globalEditingMode: options.mode ?? 'ripple',
        editorialTranscriptDescriptors: [createEditorialTranscriptDescriptorFixture()],
        narrative,
        dependentLinks: [],
    };
}

function guard(document: EditorDocumentV4): EditorialLinkCommandGuard {
    return {
        expectedDocumentRevision: document.revision,
        expectedMode: document.globalEditingMode,
        expectedNarrativeRevision: document.narrative?.revision,
    };
}

function idFactory(): EditorialLinkIdFactory {
    let ordinal = 0;
    return kind => `${kind}_${ordinal += 1}`;
}

function exactBinding(document: EditorDocumentV4, anchorBlockId = 'anchor_a'): TranscriptFragmentBindingV1 {
    const anchor = document.narrative!.blocks[anchorBlockId];
    return {
        version: 1,
        bindingId: `binding_${anchorBlockId}`,
        transcriptRecordId: anchor.transcriptRecordId,
        sourceIntervalId: anchor.sourceIntervalId,
        activeStartSample: anchor.coreStartSample + 1_000,
        activeEndSample: anchor.coreEndSample - 1_000,
        lineageRootId: anchor.lineageRootId,
        createdFromBlockId: anchor.id,
    };
}

function attachLink(input: {
    document: EditorDocumentV4;
    target: EditorialDependentTargetV1;
    anchorBlockId?: string;
    association?: EditorialDependentLinkV1['association'];
    followPolicy?: 'none' | 'follow';
    id?: string;
}): EditorialDependentLinkV1 {
    const anchorBlockId = input.anchorBlockId ?? 'anchor_a';
    const interval = getEditorialTargetInterval(input.document, input.target);
    if (interval.kind === 'error') throw new Error(interval.error.message);
    const anchor = input.document.narrative!.blocks[anchorBlockId];
    const anchorStart = frameToOutputSample(anchor.timelineStartFrame, input.document.renderProfile.fps);
    const link: EditorialDependentLinkV1 = {
        version: 1,
        id: input.id ?? `link_${input.target.kind}`,
        anchorBlockId,
        target: { ...input.target },
        association: input.association ?? { kind: 'overlap', origin: 'manual' },
        followPolicy: input.followPolicy ?? 'none',
        relativeStartOutputSample: interval.interval.start - anchorStart,
        relativeEndOutputSample: interval.interval.end - anchorStart,
        revision: input.document.revision,
    };
    input.document.dependentLinks.push(link);
    return link;
}

function cloneDocument(document: EditorDocumentV4): EditorDocumentV4 {
    return {
        ...document,
        videoClips: document.videoClips.map(clip => ({
            ...clip,
            audio: clip.audio ? { ...clip.audio } : null,
        })),
        videoTracks: document.videoTracks.map(track => ({ ...track })),
        audioTracks: document.audioTracks.map(track => ({
            ...track,
            clips: track.clips.map(cloneTestAudioClip),
        })),
        subtitleTracks: document.subtitleTracks.map(track => ({
            ...track,
            subtitles: track.subtitles.map(subtitle => ({ ...subtitle })),
        })),
        narrative: document.narrative
            ? JSON.parse(JSON.stringify(document.narrative)) as NarrativeDocumentV1
            : null,
        dependentLinks: JSON.parse(JSON.stringify(document.dependentLinks)) as EditorialDependentLinkV1[],
    };
}

function cloneTestAudioClip(clip: AudioClip): AudioClip {
    return { ...clip, source: { ...clip.source } } as AudioClip;
}

function isImportedAudioClip(clip: AudioClip): clip is ImportedAudioClip {
    return clip.source.kind === 'audio-source';
}

function translatedAnchorDocument(
    before: EditorDocumentV4,
    deltaFrames: number,
    blockId = 'anchor_a',
): { after: EditorDocumentV4; transform: NarrativeAnchorTransform } {
    const after = cloneDocument(before);
    after.revision += 1;
    after.narrative!.revision += 1;
    const block = after.narrative!.blocks[blockId];
    block.timelineStartFrame += deltaFrames;
    block.revision = after.narrative!.revision;
    after.videoClips = after.videoClips.map(clip => clip.id === block.clipId
        ? { ...clip, timelineStartFrame: block.timelineStartFrame }
        : clip);
    return {
        after,
        transform: { kind: 'translated', blockId, deltaFrames },
    };
}

function splitAnchorDocument(
    before: EditorDocumentV4,
    splitSample = 8_000,
): { after: EditorDocumentV4; transform: NarrativeAnchorTransform } {
    const after = cloneDocument(before);
    after.revision += 1;
    after.narrative!.revision += 1;
    const old = before.narrative!.blocks.anchor_a;
    const left: NarrativeBlockV1 = {
        ...old,
        instanceId: 'instance_left',
        parentInstanceIds: [old.instanceId],
        sourceIntervalId: 'interval_left',
        coreEndSample: splitSample,
        materialization: {
            ...old.materialization,
            sourceEndFrame: 15,
            postBoundary: { kind: 'partition-seam', seamId: 'seam_split' },
        },
        revision: after.narrative!.revision,
    };
    const right: NarrativeBlockV1 = {
        ...old,
        id: 'anchor_right',
        clipId: 'owned_right',
        instanceId: 'instance_right',
        parentInstanceIds: [old.instanceId],
        sourceIntervalId: 'interval_right',
        coreStartSample: splitSample,
        materialization: {
            ...old.materialization,
            sourceStartFrame: 15,
            preBoundary: { kind: 'partition-seam', seamId: 'seam_split' },
        },
        timelineStartFrame: 15,
        revision: after.narrative!.revision,
    };
    after.narrative!.blockIds = [left.id, right.id];
    after.narrative!.blocks = { [left.id]: left, [right.id]: right };
    after.videoClips = after.videoClips.flatMap(clip => clip.id === old.clipId
        ? [{ ...clip, sourceEnd: 0.5 }, {
            ...clip,
            id: right.clipId,
            timelineStartFrame: 15,
            sourceStart: 0.5,
            sourceEnd: 1,
        }]
        : [clip]);
    return {
        after,
        transform: {
            kind: 'split',
            oldBlockId: old.id,
            leftBlockId: left.id,
            rightBlockId: right.id,
            splitSample,
        },
    };
}

function deletedAnchorDocument(
    before: EditorDocumentV4,
): { after: EditorDocumentV4; transform: NarrativeAnchorTransform } {
    const after = cloneDocument(before);
    const block = after.narrative!.blocks.anchor_a;
    after.revision += 1;
    after.narrative!.revision += 1;
    after.narrative!.blockIds = after.narrative!.blockIds.filter(id => id !== block.id);
    delete after.narrative!.blocks[block.id];
    after.videoClips = after.videoClips.filter(clip => clip.id !== block.clipId);
    return { after, transform: { kind: 'deleted', blockId: block.id } };
}

function releasedNarrativeDocument(
    before: EditorDocumentV4,
): { after: EditorDocumentV4; transforms: NarrativeAnchorTransform[] } {
    const after = cloneDocument(before);
    const transforms: NarrativeAnchorTransform[] = before.narrative!.blockIds
        .map(blockId => ({ kind: 'deleted', blockId }));
    after.revision += 1;
    after.narrative = null;
    if (after.transientSelection.kind === 'narrative') {
        after.transientSelection = { kind: 'none' };
    }
    return { after, transforms };
}

function trimmedAnchorDocument(
    before: EditorDocumentV4,
    retained: { start: number; end: number },
): { after: EditorDocumentV4; transform: NarrativeAnchorTransform } {
    const after = cloneDocument(before);
    const block = after.narrative!.blocks.anchor_a;
    after.revision += 1;
    after.narrative!.revision += 1;
    block.coreStartSample = retained.start;
    block.coreEndSample = retained.end;
    block.sourceIntervalId = 'interval_trimmed';
    block.materialization.sourceStartFrame = retained.start / 16_000 * 30;
    block.materialization.sourceEndFrame = retained.end / 16_000 * 30;
    block.revision = after.narrative!.revision;
    after.videoClips = after.videoClips.map(clip => clip.id === block.clipId
        ? {
            ...clip,
            sourceStart: block.materialization.sourceStartFrame / 30,
            sourceEnd: block.materialization.sourceEndFrame / 30,
        }
        : clip);
    return {
        after,
        transform: {
            kind: 'trimmed',
            oldBlockId: block.id,
            newBlockIds: [block.id],
            retainedRanges: [retained],
        },
    };
}

function mergedAnchorDocument(
    before: EditorDocumentV4,
): { after: EditorDocumentV4; transform: NarrativeAnchorTransform } {
    const after = cloneDocument(before);
    const left = after.narrative!.blocks.anchor_a;
    const right = after.narrative!.blocks.anchor_b;
    after.revision += 1;
    after.narrative!.revision += 1;
    const merged: NarrativeBlockV1 = {
        ...left,
        instanceId: 'instance_merged',
        parentInstanceIds: [left.instanceId, right.instanceId],
        sourceIntervalId: 'interval_merged',
        coreEndSample: right.coreEndSample,
        materialization: {
            ...left.materialization,
            sourceEndFrame: right.materialization.sourceEndFrame,
            postBoundary: right.materialization.postBoundary,
        },
        revision: after.narrative!.revision,
    };
    after.narrative!.blockIds = [merged.id];
    after.narrative!.blocks = { [merged.id]: merged };
    after.videoClips = after.videoClips
        .filter(clip => clip.id !== right.clipId)
        .map(clip => clip.id === left.clipId ? { ...clip, sourceEnd: 2 } : clip);
    return {
        after,
        transform: {
            kind: 'merged',
            leftBlockId: left.id,
            rightBlockId: right.id,
            mergedBlockId: merged.id,
        },
    };
}

function movedTargetDocument(
    before: EditorDocumentV4,
    target: EditorialDependentTargetV1,
    deltaFrames: number,
): EditorDocumentV4 {
    const after = cloneDocument(before);
    after.revision += 1;
    if (target.kind === 'video-clip') {
        after.videoClips = after.videoClips.map(clip => clip.id === target.clipId
            ? { ...clip, timelineStartFrame: clip.timelineStartFrame + deltaFrames }
            : clip);
    } else if (target.kind === 'audio-clip') {
        after.audioTracks = after.audioTracks.map(track => track.id === target.trackId
            ? {
                ...track,
                clips: track.clips.map(clip => clip.id === target.clipId
                    ? { ...clip, timelineStartFrame: clip.timelineStartFrame + deltaFrames }
                    : clip),
            }
            : track);
    } else {
        const deltaSeconds = deltaFrames / 30;
        after.subtitleTracks = after.subtitleTracks.map(track => track.id === target.trackId
            ? {
                ...track,
                subtitles: track.subtitles.map(subtitle => subtitle.id === target.subtitleId
                    ? {
                        ...subtitle,
                        startTime: subtitle.startTime + deltaSeconds,
                        endTime: subtitle.endTime + deltaSeconds,
                    }
                    : subtitle),
            }
            : track);
    }
    return after;
}

function trimmedTargetDocument(
    before: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): EditorDocumentV4 {
    const after = cloneDocument(before);
    after.revision += 1;
    if (target.kind === 'video-clip') {
        after.videoClips = after.videoClips.map(clip => clip.id === target.clipId
            ? { ...clip, sourceEnd: clip.sourceStart + (clip.sourceEnd - clip.sourceStart) / 2 }
            : clip);
    } else if (target.kind === 'audio-clip') {
        after.audioTracks = after.audioTracks.map(track => track.id === target.trackId
            ? {
                ...track,
                clips: track.clips.map(clip => {
                    if (clip.id !== target.clipId || !isImportedAudioClip(clip)) return clip;
                    return {
                        ...clip,
                        sourceEndSample: clip.sourceStartSample
                            + Math.floor((clip.sourceEndSample - clip.sourceStartSample) / 2),
                        timelineDurationSamples: Math.floor((clip.timelineDurationSamples ?? 24_000) / 2),
                    };
                }),
            }
            : track);
    } else {
        after.subtitleTracks = after.subtitleTracks.map(track => track.id === target.trackId
            ? {
                ...track,
                subtitles: track.subtitles.map(subtitle => subtitle.id === target.subtitleId
                    ? { ...subtitle, endTime: (subtitle.startTime + subtitle.endTime) / 2 }
                    : subtitle),
            }
            : track);
    }
    return after;
}

function deletedTargetDocument(
    before: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): EditorDocumentV4 {
    const after = cloneDocument(before);
    after.revision += 1;
    if (target.kind === 'video-clip') {
        after.videoClips = after.videoClips.filter(clip => clip.id !== target.clipId);
    } else if (target.kind === 'audio-clip') {
        after.audioTracks = after.audioTracks.map(track => track.id === target.trackId
            ? { ...track, clips: track.clips.filter(clip => clip.id !== target.clipId) }
            : track);
    } else {
        after.subtitleTracks = after.subtitleTracks.map(track => track.id === target.trackId
            ? { ...track, subtitles: track.subtitles.filter(value => value.id !== target.subtitleId) }
            : track);
    }
    return after;
}

function splitTargetDocument(
    before: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): { after: EditorDocumentV4; children: EditorialDependentTargetV1[] } {
    const after = cloneDocument(before);
    after.revision += 1;
    if (target.kind === 'video-clip') {
        const clip = after.videoClips.find(value => value.id === target.clipId)!;
        const midpoint = (clip.sourceStart + clip.sourceEnd) / 2;
        const rightId = `${clip.id}_right`;
        after.videoClips = after.videoClips.flatMap(value => value.id === clip.id
            ? [{ ...clip, sourceEnd: midpoint }, {
                ...clip,
                id: rightId,
                timelineStartFrame: clip.timelineStartFrame + 15,
                sourceStart: midpoint,
            }]
            : [value]);
        return {
            after,
            children: [target, { kind: 'video-clip', clipId: rightId }],
        };
    }
    if (target.kind === 'audio-clip') {
        const track = after.audioTracks.find(value => value.id === target.trackId)!;
        const clip = track.clips.find(value => value.id === target.clipId)!;
        if (!isImportedAudioClip(clip)) throw new Error('Expected imported audio.');
        const midpoint = clip.sourceStartSample
            + Math.floor((clip.sourceEndSample - clip.sourceStartSample) / 2);
        const rightId = `${clip.id}_right`;
        track.clips = track.clips.flatMap(value => value.id === clip.id
            ? [{
                ...clip,
                sourceEndSample: midpoint,
                timelineDurationSamples: 24_000,
            }, {
                ...clip,
                id: rightId,
                timelineStartFrame: clip.timelineStartFrame + 15,
                sourceStartSample: midpoint,
                timelineDurationSamples: 24_000,
            }]
            : [value]);
        return {
            after,
            children: [target, { kind: 'audio-clip', trackId: target.trackId, clipId: rightId }],
        };
    }
    const track = after.subtitleTracks.find(value => value.id === target.trackId)!;
    const subtitle = track.subtitles.find(value => value.id === target.subtitleId)!;
    const midpoint = (subtitle.startTime + subtitle.endTime) / 2;
    const rightId = `${subtitle.id}_right`;
    track.subtitles = track.subtitles.flatMap(value => value.id === subtitle.id
        ? [{ ...subtitle, endTime: midpoint }, {
            ...subtitle,
            id: rightId,
            startTime: midpoint,
        }]
        : [value]);
    return {
        after,
        children: [target, { kind: 'subtitle', trackId: target.trackId, subtitleId: rightId }],
    };
}

describe('editorial target classification and overlap discovery', () => {
    it('classifies owned, exact-bound, overlap-linked, and unbound identities without inference', () => {
        const document = createDocument();
        attachLink({
            document,
            target: AUDIO_TARGET,
            association: { kind: 'transcript-bound', binding: exactBinding(document) },
            id: 'link_bound_audio',
        });
        attachLink({ document, target: SUBTITLE_TARGET, id: 'link_overlap_subtitle' });

        const result = classifyEditorialTargets(document);
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.classifications.map(value => [value.targetKey, value.kind])).toEqual([
            ['video:owned_a', 'owned'],
            ['video:dependent_video', 'unbound'],
            ['audio:audio_track:dependent_audio', 'transcript-bound'],
            ['subtitle:subtitle_track:dependent_subtitle', 'overlap-linked'],
        ]);
    });

    it('discovers unique-greatest positive overlap for every target kind and leaves equal ties visible', () => {
        const unique = createDocument({ twoAnchors: true });
        const discovered = discoverEditorialOverlapCandidates(unique);
        expect(discovered.kind).toBe('success');
        if (discovered.kind !== 'success') return;
        expect(discovered.entries).toHaveLength(3);
        expect(discovered.entries.every(entry => entry.outcome === 'linked'
            && entry.anchorBlockId === 'anchor_a')).toBe(true);

        const tied = createDocument({
            twoAnchors: true,
            targetStartFrame: 15,
            targetDurationFrames: 30,
        });
        const tie = discoverEditorialOverlapCandidates(tied);
        expect(tie.kind).toBe('success');
        if (tie.kind !== 'success') return;
        expect(tie.entries.every(entry => entry.outcome === 'ambiguous')).toBe(true);
        expect(tie.entries[0].tiedBlockIds).toEqual(['anchor_a', 'anchor_b']);

        const noOverlap = createDocument({ targetStartFrame: 60 });
        const none = discoverEditorialOverlapCandidates(noOverlap);
        expect(none.kind).toBe('success');
        if (none.kind !== 'success') return;
        expect(none.entries.every(entry => entry.outcome === 'no-overlap')).toBe(true);
    });

    it('creates only unbound unique overlaps and excludes an exact-bound target', () => {
        const document = createDocument({ twoAnchors: true });
        attachLink({
            document,
            target: AUDIO_TARGET,
            association: { kind: 'transcript-bound', binding: exactBinding(document) },
            id: 'existing_exact',
        });
        const result = planDiscoverEditorialOverlapLinks({
            document,
            guard: guard(document),
            idFactory: idFactory(),
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks).toHaveLength(3);
        expect(result.document.dependentLinks.find(link => link.id === 'existing_exact')?.association.kind)
            .toBe('transcript-bound');
        expect(result.linkMutations.filter(mutation => mutation.kind === 'created')).toHaveLength(2);
        expect(result.history).toEqual({ createEntry: true, label: 'Link dependent' });
    });

    it.each(TARGETS)('excludes an exact-bound $kind target from overlap discovery', (target) => {
        const document = createDocument({ twoAnchors: true });
        attachLink({
            document,
            target,
            association: { kind: 'transcript-bound', binding: exactBinding(document) },
            id: `exact_${target.kind}`,
        });
        const discovery = discoverEditorialOverlapCandidates(document);
        expect(discovery.kind).toBe('success');
        if (discovery.kind !== 'success') return;
        const targetKey = target.kind === 'video-clip'
            ? `video:${target.clipId}`
            : target.kind === 'audio-clip'
                ? `audio:${target.trackId}:${target.clipId}`
                : `subtitle:${target.trackId}:${target.subtitleId}`;
        expect(discovery.entries.some(entry => entry.targetKey === targetKey)).toBe(false);
    });

    it('integrates post-ownership discovery without a second revision or history entry', () => {
        const pendingActivation = createDocument({ twoAnchors: true });
        const result = planIntegrateDiscoveredEditorialOverlapLinks({
            document: pendingActivation,
            guard: guard(pendingActivation),
            idFactory: idFactory(),
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.revision).toBe(pendingActivation.revision);
        expect(result.document.dependentLinks).toHaveLength(3);
        expect(result.document.dependentLinks.every(link => link.revision === pendingActivation.revision))
            .toBe(true);
        expect(result.history.createEntry).toBe(false);
        expect(result.persistence.enqueue).toBe(false);
    });
});

describe('manual links and exact transcript bindings', () => {
    it.each(TARGETS)('creates and validates an exact binding for $kind', (target) => {
        const document = createDocument({ targetStartFrame: 60 });
        const result = planBindEditorialTarget({
            document,
            guard: guard(document),
            target,
            anchorBlockId: 'anchor_a',
            activeStartSample: 2_000,
            activeEndSample: 8_000,
            idFactory: idFactory(),
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        const link = result.document.dependentLinks[0];
        expect(link.association).toMatchObject({
            kind: 'transcript-bound',
            binding: {
                transcriptRecordId: EDITORIAL_TEST_RECORD_ID,
                sourceIntervalId: 'interval_anchor_a',
                lineageRootId: 'lineage_anchor',
                activeStartSample: 2_000,
                activeEndSample: 8_000,
            },
        });
        expect(validateEditorialLinkGraph(result.document).valid).toBe(true);
        expect(validateEditorDocumentV4(result.document).issues).toEqual([]);
    });

    it('rejects out-of-core bindings and persisted lineage/sample corruption', () => {
        const document = createDocument();
        expect(planBindEditorialTarget({
            document,
            guard: guard(document),
            target: AUDIO_TARGET,
            anchorBlockId: 'anchor_a',
            activeStartSample: 8_000,
            activeEndSample: 17_000,
            idFactory: idFactory(),
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-binding' } });

        const link = attachLink({
            document,
            target: AUDIO_TARGET,
            association: { kind: 'transcript-bound', binding: exactBinding(document) },
        });
        if (link.association.kind !== 'transcript-bound') throw new Error('Expected binding.');
        link.association.binding.lineageRootId = 'different_lineage';
        expect(validateEditorialLinkGraph(document)).toMatchObject({
            valid: false,
            issues: [{ code: 'lineage-mismatch' }],
        });
    });

    it('permits a manual non-overlap relationship but prevents a second link to the same target', () => {
        const document = createDocument({ targetStartFrame: 60 });
        const linked = planCreateManualOverlapLink({
            document,
            guard: guard(document),
            target: VIDEO_TARGET,
            anchorBlockId: 'anchor_a',
            idFactory: idFactory(),
        });
        expect(linked.kind).toBe('success');
        if (linked.kind !== 'success') return;
        expect(linked.document.dependentLinks[0].association).toEqual({ kind: 'overlap', origin: 'manual' });
        expect(planCreateManualOverlapLink({
            document: linked.document,
            guard: guard(linked.document),
            target: VIDEO_TARGET,
            anchorBlockId: 'anchor_a',
            idFactory: idFactory(),
        })).toMatchObject({ kind: 'error', error: { code: 'target-already-linked' } });
    });

    it('re-anchors only inside the same transcript lineage and unbinds without moving the target', () => {
        const document = createDocument({ twoAnchors: true });
        const bound = planBindEditorialTarget({
            document,
            guard: guard(document),
            target: SUBTITLE_TARGET,
            anchorBlockId: 'anchor_a',
            activeStartSample: 10_000,
            activeEndSample: 15_000,
            idFactory: idFactory(),
        });
        expect(bound.kind).toBe('success');
        if (bound.kind !== 'success') return;
        // The second block shares lineage but not the active fragment, so it cannot steal binding.
        expect(planReanchorEditorialLink({
            document: bound.document,
            guard: guard(bound.document),
            target: SUBTITLE_TARGET,
            anchorBlockId: 'anchor_b',
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-binding' } });

        const beforeInterval = getEditorialTargetInterval(bound.document, SUBTITLE_TARGET);
        const unbound = planUnbindEditorialTarget({
            document: bound.document,
            guard: guard(bound.document),
            target: SUBTITLE_TARGET,
        });
        expect(unbound.kind).toBe('success');
        if (unbound.kind !== 'success' || beforeInterval.kind !== 'success') return;
        expect(unbound.document.dependentLinks).toEqual([]);
        expect(getEditorialTargetInterval(unbound.document, SUBTITLE_TARGET)).toEqual(beforeInterval);
    });

    it('re-anchors a repeated exact fragment in the same lineage and explicitly unlinks overlap', () => {
        const document = createDocument({ twoAnchors: true });
        const repeated = document.narrative!.blocks.anchor_b;
        repeated.coreStartSample = 0;
        repeated.coreEndSample = 16_000;
        const bound = planBindEditorialTarget({
            document,
            guard: guard(document),
            target: AUDIO_TARGET,
            anchorBlockId: 'anchor_a',
            activeStartSample: 2_000,
            activeEndSample: 8_000,
            idFactory: idFactory(),
        });
        expect(bound.kind).toBe('success');
        if (bound.kind !== 'success') return;
        const reanchored = planReanchorEditorialLink({
            document: bound.document,
            guard: guard(bound.document),
            target: AUDIO_TARGET,
            anchorBlockId: 'anchor_b',
        });
        expect(reanchored.kind).toBe('success');
        if (reanchored.kind !== 'success') return;
        expect(reanchored.document.dependentLinks[0]).toMatchObject({
            anchorBlockId: 'anchor_b',
            association: {
                kind: 'transcript-bound',
                binding: { sourceIntervalId: 'interval_anchor_b', lineageRootId: 'lineage_anchor' },
            },
        });

        const overlap = createDocument();
        attachLink({ document: overlap, target: VIDEO_TARGET });
        const unlinked = planUnlinkEditorialTarget({
            document: overlap,
            guard: guard(overlap),
            target: VIDEO_TARGET,
        });
        expect(unlinked.kind).toBe('success');
        if (unlinked.kind !== 'success') return;
        expect(unlinked.document.dependentLinks).toEqual([]);
        expect(getEditorialTargetInterval(unlinked.document, VIDEO_TARGET).kind).toBe('success');
    });

    it('blocks enabling follow on a locked target but permits disabling and unlinking it', () => {
        const document = createDocument();
        attachLink({ document, target: VIDEO_TARGET, followPolicy: 'none' });
        document.videoTracks[1].locked = true;
        expect(planSetEditorialLinkFollowPolicy({
            document,
            guard: guard(document),
            target: VIDEO_TARGET,
            followPolicy: 'follow',
        })).toMatchObject({ kind: 'error', error: { code: 'locked-target' } });

        document.dependentLinks[0].followPolicy = 'follow';
        const disabled = planSetEditorialLinkFollowPolicy({
            document,
            guard: guard(document),
            target: VIDEO_TARGET,
            followPolicy: 'none',
        });
        expect(disabled.kind).toBe('success');
        const unlinked = planUnlinkEditorialTarget({
            document,
            guard: guard(document),
            target: VIDEO_TARGET,
        });
        expect(unlinked.kind).toBe('success');
    });

    it('rejects a stale target identity instead of treating unlink as an unchanged command', () => {
        const document = createDocument();
        expect(planUnlinkEditorialTarget({
            document,
            guard: guard(document),
            target: { kind: 'audio-clip', trackId: 'audio_track', clipId: 'missing_audio' },
        })).toMatchObject({ kind: 'error', error: { code: 'missing-target' } });
    });
});

describe('WP4 anchor transform integration', () => {
    const releaseMatrix = TARGETS.flatMap(target => (
        (['none', 'follow'] as const).map(followPolicy => ({ target, followPolicy }))
    ));

    it.each(releaseMatrix)(
        'releases the final narrative with a $followPolicy $target.kind target',
        ({ target, followPolicy }) => {
            const before = createDocument();
            attachLink({ document: before, target, followPolicy });
            const targetBefore = getEditorialTargetInterval(before, target);
            const release = planReleaseNarrativeTracks({
                document: before,
                guard: guard(before),
                trackIds: ['controlled_track'],
                nowIso: '2026-07-22T00:01:00.000Z',
            });
            expect(release.kind).toBe('success');
            if (release.kind !== 'success') return;
            const result = planEditorialLinksForAnchorTransforms({
                before,
                afterNarrativeCommand: release.document,
                guard: guard(before),
                anchorTransforms: release.anchorTransforms,
            });
            expect(result.kind).toBe('success');
            if (result.kind !== 'success') return;
            expect(result.document.narrative).toBeNull();
            expect(result.document.dependentLinks).toEqual([]);
            expect(result.linkMutations).toMatchObject([{ kind: 'deleted' }]);
            expect(result.history).toEqual({ createEntry: false, label: null });
            expect(result.persistence).toEqual({ enqueue: false });
            if (followPolicy === 'follow') {
                expect(getEditorialTargetInterval(result.document, target)).toMatchObject({
                    kind: 'error', error: { code: 'missing-target' },
                });
                expect(result.targetMutations).toMatchObject([{
                    kind: 'deleted', target,
                }]);
            } else {
                expect(getEditorialTargetInterval(result.document, target)).toEqual(targetBefore);
                expect(result.targetMutations).toEqual([]);
            }
            expect(validateEditorialLinkGraph(result.document).valid).toBe(true);
            expect(validateEditorDocumentV4(result.document).issues).toEqual([]);
        },
    );

    it('rejects a final release with only partial deleted-transform coverage', () => {
        const before = createDocument({ twoAnchors: true });
        attachLink({ document: before, target: AUDIO_TARGET });
        const release = releasedNarrativeDocument(before);
        expect(planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: release.after,
            guard: guard(before),
            anchorTransforms: release.transforms.slice(0, 1),
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-transform' } });
    });

    it('rejects null-narrative projections that are not an exact final-track release', () => {
        const invalidBefore = createDocument();
        invalidBefore.narrative!.controlledTrackIds = [];
        const invalidBeforeRelease = releasedNarrativeDocument(invalidBefore);
        expect(planEditorialLinksForAnchorTransforms({
            before: invalidBefore,
            afterNarrativeCommand: invalidBeforeRelease.after,
            guard: guard(invalidBefore),
            anchorTransforms: invalidBeforeRelease.transforms,
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-proposal' } });

        const wrongKind = createDocument();
        const wrongKindRelease = releasedNarrativeDocument(wrongKind);
        expect(planEditorialLinksForAnchorTransforms({
            before: wrongKind,
            afterNarrativeCommand: wrongKindRelease.after,
            guard: guard(wrongKind),
            anchorTransforms: [{ kind: 'translated', blockId: 'anchor_a', deltaFrames: 1 }],
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-transform' } });

        const nonexistent = createDocument({ twoAnchors: true });
        const nonexistentRelease = releasedNarrativeDocument(nonexistent);
        expect(planEditorialLinksForAnchorTransforms({
            before: nonexistent,
            afterNarrativeCommand: nonexistentRelease.after,
            guard: guard(nonexistent),
            anchorTransforms: [
                { kind: 'deleted', blockId: 'anchor_a' },
                { kind: 'deleted', blockId: 'missing_anchor' },
            ],
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-transform' } });

        const removedMedia = createDocument();
        const removedMediaRelease = releasedNarrativeDocument(removedMedia);
        removedMediaRelease.after.videoClips = removedMediaRelease.after.videoClips
            .filter(clip => clip.id !== 'owned_a');
        expect(planEditorialLinksForAnchorTransforms({
            before: removedMedia,
            afterNarrativeCommand: removedMediaRelease.after,
            guard: guard(removedMedia),
            anchorTransforms: removedMediaRelease.transforms,
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-transform' } });

        const directTarget = createDocument();
        const directTargetRelease = releasedNarrativeDocument(directTarget);
        expect(planEditorialLinksForTargetTransforms({
            before: directTarget,
            afterTargetCommand: directTargetRelease.after,
            guard: guard(directTarget),
            targetTransforms: [],
        })).toMatchObject({ kind: 'error', error: { code: 'missing-narrative' } });
    });

    it.each([
        { name: 'before', start: 1_000, end: 4_000, anchor: 'anchor_a', active: [1_000, 4_000] },
        { name: 'after', start: 10_000, end: 14_000, anchor: 'anchor_right', active: [10_000, 14_000] },
        { name: 'through tie', start: 4_000, end: 12_000, anchor: 'anchor_a', active: [4_000, 8_000] },
    ])('retargets an exact binding split $name the active fragment', ({ start, end, anchor, active }) => {
        const before = createDocument();
        const binding = { ...exactBinding(before), activeStartSample: start, activeEndSample: end };
        attachLink({
            document: before,
            target: AUDIO_TARGET,
            association: { kind: 'transcript-bound', binding },
        });
        const split = splitAnchorDocument(before);
        const result = planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: split.after,
            guard: guard(before),
            anchorTransforms: [split.transform],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        const link = result.document.dependentLinks[0];
        expect(link.anchorBlockId).toBe(anchor);
        expect(link.association).toMatchObject({
            kind: 'transcript-bound',
            binding: { activeStartSample: active[0], activeEndSample: active[1] },
        });
        expect(result.history.createEntry).toBe(false);
        expect(result.persistence.enqueue).toBe(false);
    });

    it('resolves an equal overlap split at the target midpoint to the earlier child', () => {
        const before = createDocument({ targetStartFrame: 5, targetDurationFrames: 20 });
        attachLink({ document: before, target: VIDEO_TARGET });
        const split = splitAnchorDocument(before);
        const result = planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: split.after,
            guard: guard(before),
            anchorTransforms: [split.transform],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].anchorBlockId).toBe('anchor_a');
    });

    it('retargets an overlap link to the unique greatest child after a partial deletion', () => {
        const before = createDocument({ targetStartFrame: 18, targetDurationFrames: 5 });
        attachLink({ document: before, target: VIDEO_TARGET });
        const after = cloneDocument(before);
        const old = before.narrative!.blocks.anchor_a;
        after.revision += 1;
        after.narrative!.revision += 1;
        const left: NarrativeBlockV1 = {
            ...old,
            instanceId: 'instance_trim_left',
            parentInstanceIds: [old.instanceId],
            sourceIntervalId: 'interval_trim_left',
            coreEndSample: 6_400,
            materialization: {
                ...old.materialization,
                sourceEndFrame: 12,
                postBoundary: { kind: 'partition-seam', seamId: 'seam_trim' },
            },
            revision: after.narrative!.revision,
        };
        const right: NarrativeBlockV1 = {
            ...old,
            id: 'anchor_trim_right',
            clipId: 'owned_trim_right',
            instanceId: 'instance_trim_right',
            parentInstanceIds: [old.instanceId],
            sourceIntervalId: 'interval_trim_right',
            coreStartSample: 9_600,
            materialization: {
                ...old.materialization,
                sourceStartFrame: 18,
                preBoundary: { kind: 'partition-seam', seamId: 'seam_trim' },
            },
            timelineStartFrame: 12,
            revision: after.narrative!.revision,
        };
        after.narrative!.blockIds = [left.id, right.id];
        after.narrative!.blocks = { [left.id]: left, [right.id]: right };
        after.videoClips = after.videoClips.flatMap(clip => clip.id === old.clipId
            ? [{ ...clip, sourceEnd: 0.4 }, {
                ...clip,
                id: right.clipId,
                timelineStartFrame: 12,
                sourceStart: 0.6,
                sourceEnd: 1,
            }]
            : [clip]);
        const transform: NarrativeAnchorTransform = {
            kind: 'trimmed',
            oldBlockId: old.id,
            newBlockIds: [left.id, right.id],
            retainedRanges: [{ start: 0, end: 6_400 }, { start: 9_600, end: 16_000 }],
        };
        const result = planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: after,
            guard: guard(before),
            anchorTransforms: [transform],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].anchorBlockId).toBe(right.id);
        expect(getEditorialTargetInterval(result.document, VIDEO_TARGET))
            .toEqual(getEditorialTargetInterval(before, VIDEO_TARGET));
    });

    it.each(TARGETS)('implements follow none/follow translation for $kind', (target) => {
        const noneBefore = createDocument();
        const noneLink = attachLink({ document: noneBefore, target, followPolicy: 'none' });
        const noneTargetBefore = getEditorialTargetInterval(noneBefore, target);
        const noneTranslation = translatedAnchorDocument(noneBefore, 30);
        const none = planEditorialLinksForAnchorTransforms({
            before: noneBefore,
            afterNarrativeCommand: noneTranslation.after,
            guard: guard(noneBefore),
            anchorTransforms: [noneTranslation.transform],
        });
        expect(none.kind).toBe('success');
        if (none.kind !== 'success' || noneTargetBefore.kind !== 'success') return;
        expect(getEditorialTargetInterval(none.document, target)).toEqual(noneTargetBefore);
        expect(none.document.dependentLinks[0].relativeStartOutputSample)
            .toBe(noneLink.relativeStartOutputSample - 48_000);

        const followBefore = createDocument();
        attachLink({ document: followBefore, target, followPolicy: 'follow' });
        const followTargetBefore = getEditorialTargetInterval(followBefore, target);
        const followTranslation = translatedAnchorDocument(followBefore, 30);
        const follow = planEditorialLinksForAnchorTransforms({
            before: followBefore,
            afterNarrativeCommand: followTranslation.after,
            guard: guard(followBefore),
            anchorTransforms: [followTranslation.transform],
        });
        expect(follow.kind).toBe('success');
        if (follow.kind !== 'success' || followTargetBefore.kind !== 'success') return;
        const afterInterval = getEditorialTargetInterval(follow.document, target);
        expect(afterInterval).toEqual({
            kind: 'success',
            interval: {
                start: followTargetBefore.interval.start + 48_000,
                end: followTargetBefore.interval.end + 48_000,
            },
        });
        expect(follow.document.dependentLinks[0].relativeStartOutputSample)
            .toBe(followBefore.dependentLinks[0].relativeStartOutputSample);
    });

    it.each(['ripple', 'absolute'] as const)(
        'translates an exact-bound follow subtitle atomically with its anchor in %s mode',
        (mode) => {
            const before = createDocument({ mode });
            const link = attachLink({
                document: before,
                target: SUBTITLE_TARGET,
                association: { kind: 'transcript-bound', binding: exactBinding(before) },
                followPolicy: 'follow',
            });
            const oldInterval = getEditorialTargetInterval(before, SUBTITLE_TARGET);
            const translated = translatedAnchorDocument(before, 30);

            const result = planEditorialLinksForAnchorTransforms({
                before,
                afterNarrativeCommand: translated.after,
                guard: guard(before),
                anchorTransforms: [translated.transform],
            });
            expect(result.kind).toBe('success');
            if (result.kind !== 'success' || oldInterval.kind !== 'success') return;
            expect(getEditorialTargetInterval(result.document, SUBTITLE_TARGET)).toEqual({
                kind: 'success',
                interval: {
                    start: oldInterval.interval.start + 48_000,
                    end: oldInterval.interval.end + 48_000,
                },
            });
            expect(result.document.dependentLinks[0]).toMatchObject({
                association: link.association,
                followPolicy: 'follow',
                relativeStartOutputSample: link.relativeStartOutputSample,
                relativeEndOutputSample: link.relativeEndOutputSample,
            });
            expect(result.targetMutations).toMatchObject([{
                kind: 'translated',
                target: SUBTITLE_TARGET,
            }]);
        },
    );

    it('rejects an anchor projection that already moved a linked target upstream', () => {
        const before = createDocument();
        attachLink({ document: before, target: AUDIO_TARGET, followPolicy: 'follow' });
        const translation = translatedAnchorDocument(before, 30);
        translation.after.audioTracks[0].clips[0] = {
            ...translation.after.audioTracks[0].clips[0],
            timelineStartFrame: 35,
        };
        expect(planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: translation.after,
            guard: guard(before),
            anchorTransforms: [translation.transform],
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-transform' } });
    });

    it.each(TARGETS)('rejects executing follow on a locked $kind target', (target) => {
        const before = createDocument();
        if (target.kind === 'video-clip') before.videoTracks[1].locked = true;
        else if (target.kind === 'audio-clip') before.audioTracks[0].locked = true;
        else before.subtitleTracks[0].isLocked = true;
        attachLink({ document: before, target, followPolicy: 'follow' });
        const translated = translatedAnchorDocument(before, 30);
        expect(planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: translated.after,
            guard: guard(before),
            anchorTransforms: [translated.transform],
        })).toMatchObject({ kind: 'error', error: { code: 'locked-target' } });
    });

    it.each([
        { target: VIDEO_TARGET, kind: 'video' },
        { target: AUDIO_TARGET, kind: 'audio' },
    ])('rejects a planned followed $kind same-track collision atomically', ({ target }) => {
        const before = createDocument();
        if (target.kind === 'video-clip') {
            before.videoClips.push({
                id: 'video_blocker',
                sourceId: 'video_source_editorial',
                trackId: 'dependent_video_track',
                timelineStartFrame: 35,
                sourceStart: 3,
                sourceEnd: 3.5,
                audio: null,
            });
        } else {
            before.audioTracks[0].clips.push({
                id: 'audio_blocker',
                source: { kind: 'audio-source', audioSourceId: 'audio_source' },
                timelineStartFrame: 35,
                sourceStartSample: 24_000,
                sourceEndSample: 48_000,
                timelineDurationSamples: 24_000,
                fadeInSamples: 0,
                fadeOutSamples: 0,
                muted: false,
                gainDb: 0,
            });
        }
        attachLink({ document: before, target, followPolicy: 'follow' });
        const translated = translatedAnchorDocument(before, 30);
        expect(planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: translated.after,
            guard: guard(before),
            anchorTransforms: [translated.transform],
        })).toMatchObject({ kind: 'error', error: { code: 'collision' } });
    });

    it('rejects a collision between two followers planned by the same anchor command', () => {
        const before = createDocument({ twoAnchors: true });
        before.videoClips.push({
            id: 'dependent_video_b',
            sourceId: 'video_source_editorial',
            trackId: 'dependent_video_track',
            timelineStartFrame: 65,
            sourceStart: 3,
            sourceEnd: 3.5,
            audio: null,
        });
        const secondTarget = { kind: 'video-clip', clipId: 'dependent_video_b' } as const;
        attachLink({
            document: before,
            target: VIDEO_TARGET,
            anchorBlockId: 'anchor_a',
            followPolicy: 'follow',
            id: 'follower_a',
        });
        attachLink({
            document: before,
            target: secondTarget,
            anchorBlockId: 'anchor_b',
            followPolicy: 'follow',
            id: 'follower_b',
        });

        const after = cloneDocument(before);
        after.revision += 1;
        after.narrative!.revision += 1;
        after.narrative!.blocks.anchor_a.timelineStartFrame = 30;
        after.narrative!.blocks.anchor_b.timelineStartFrame = 0;
        after.narrative!.blockIds = ['anchor_b', 'anchor_a'];
        after.videoClips = after.videoClips.map(clip => clip.id === 'owned_a'
            ? { ...clip, timelineStartFrame: 30 }
            : clip.id === 'owned_b'
                ? { ...clip, timelineStartFrame: 0 }
                : clip);
        expect(planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: after,
            guard: guard(before),
            anchorTransforms: [{ kind: 'translated', blockId: 'anchor_a', deltaFrames: 30 }, {
                kind: 'translated', blockId: 'anchor_b', deltaFrames: -30,
            }],
        })).toMatchObject({ kind: 'error', error: { code: 'collision' } });
    });

    it('rejects a followed translation before project zero', () => {
        const before = createDocument({ targetStartFrame: 0 });
        before.narrative!.blocks.anchor_a.timelineStartFrame = 30;
        before.videoClips.find(clip => clip.id === 'owned_a')!.timelineStartFrame = 30;
        attachLink({ document: before, target: AUDIO_TARGET, followPolicy: 'follow' });
        const translated = translatedAnchorDocument(before, -30);
        expect(planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: translated.after,
            guard: guard(before),
            anchorTransforms: [translated.transform],
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-bounds' } });
    });

    it.each(TARGETS)('deletes a followed $kind on anchor deletion and detaches none policy', (target) => {
        const followBefore = createDocument();
        attachLink({ document: followBefore, target, followPolicy: 'follow' });
        const followDeletion = deletedAnchorDocument(followBefore);
        const follow = planEditorialLinksForAnchorTransforms({
            before: followBefore,
            afterNarrativeCommand: followDeletion.after,
            guard: guard(followBefore),
            anchorTransforms: [followDeletion.transform],
        });
        expect(follow.kind).toBe('success');
        if (follow.kind !== 'success') return;
        expect(follow.document.dependentLinks).toEqual([]);
        expect(getEditorialTargetInterval(follow.document, target)).toMatchObject({
            kind: 'error', error: { code: 'missing-target' },
        });

        const noneBefore = createDocument();
        attachLink({ document: noneBefore, target, followPolicy: 'none' });
        const noneInterval = getEditorialTargetInterval(noneBefore, target);
        const noneDeletion = deletedAnchorDocument(noneBefore);
        const none = planEditorialLinksForAnchorTransforms({
            before: noneBefore,
            afterNarrativeCommand: noneDeletion.after,
            guard: guard(noneBefore),
            anchorTransforms: [noneDeletion.transform],
        });
        expect(none.kind).toBe('success');
        if (none.kind !== 'success') return;
        expect(none.document.dependentLinks).toEqual([]);
        expect(getEditorialTargetInterval(none.document, target)).toEqual(noneInterval);
    });

    it('intersects a trim binding and applies empty-fragment none/follow behavior', () => {
        const surviving = createDocument();
        attachLink({
            document: surviving,
            target: SUBTITLE_TARGET,
            association: {
                kind: 'transcript-bound',
                binding: { ...exactBinding(surviving), activeStartSample: 4_000, activeEndSample: 12_000 },
            },
        });
        const trim = trimmedAnchorDocument(surviving, { start: 0, end: 8_000 });
        const retained = planEditorialLinksForAnchorTransforms({
            before: surviving,
            afterNarrativeCommand: trim.after,
            guard: guard(surviving),
            anchorTransforms: [trim.transform],
        });
        expect(retained.kind).toBe('success');
        if (retained.kind !== 'success') return;
        expect(retained.document.dependentLinks[0].association).toMatchObject({
            kind: 'transcript-bound',
            binding: { activeStartSample: 4_000, activeEndSample: 8_000 },
        });

        const empty = createDocument();
        attachLink({
            document: empty,
            target: SUBTITLE_TARGET,
            followPolicy: 'none',
            association: {
                kind: 'transcript-bound',
                binding: { ...exactBinding(empty), activeStartSample: 10_000, activeEndSample: 14_000 },
            },
        });
        const emptyTrim = trimmedAnchorDocument(empty, { start: 0, end: 8_000 });
        const detached = planEditorialLinksForAnchorTransforms({
            before: empty,
            afterNarrativeCommand: emptyTrim.after,
            guard: guard(empty),
            anchorTransforms: [emptyTrim.transform],
        });
        expect(detached.kind).toBe('success');
        if (detached.kind !== 'success') return;
        expect(detached.document.dependentLinks).toEqual([]);
        expect(getEditorialTargetInterval(detached.document, SUBTITLE_TARGET).kind).toBe('success');

        const followed = createDocument();
        attachLink({
            document: followed,
            target: SUBTITLE_TARGET,
            followPolicy: 'follow',
            association: {
                kind: 'transcript-bound',
                binding: { ...exactBinding(followed), activeStartSample: 10_000, activeEndSample: 14_000 },
            },
        });
        const followedTrim = trimmedAnchorDocument(followed, { start: 0, end: 8_000 });
        const deleted = planEditorialLinksForAnchorTransforms({
            before: followed,
            afterNarrativeCommand: followedTrim.after,
            guard: guard(followed),
            anchorTransforms: [followedTrim.transform],
        });
        expect(deleted.kind).toBe('success');
        if (deleted.kind !== 'success') return;
        expect(deleted.document.dependentLinks).toEqual([]);
        expect(getEditorialTargetInterval(deleted.document, SUBTITLE_TARGET)).toMatchObject({
            kind: 'error', error: { code: 'missing-target' },
        });
    });

    it.each(TARGETS)('accepts a WP4 source extension and preserves the exact $kind binding', (target) => {
        const before = createDocument();
        attachLink({
            document: before,
            target,
            followPolicy: 'follow',
            association: { kind: 'transcript-bound', binding: exactBinding(before) },
        });
        const targetBefore = getEditorialTargetInterval(before, target);
        const extension = trimmedAnchorDocument(before, { start: 0, end: 24_000 });
        const result = planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: extension.after,
            guard: guard(before),
            anchorTransforms: [extension.transform],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].association).toMatchObject({
            kind: 'transcript-bound',
            binding: {
                sourceIntervalId: 'interval_trimmed',
                activeStartSample: 1_000,
                activeEndSample: 15_000,
            },
        });
        // Extending the anchor's end does not stretch a followed target or move its start.
        expect(getEditorialTargetInterval(result.document, target)).toEqual(targetBefore);
    });

    it.each(['overlap', 'transcript-bound'] as const)('retargets a %s association through merge', (kind) => {
        const before = createDocument({ twoAnchors: true });
        attachLink({
            document: before,
            target: AUDIO_TARGET,
            anchorBlockId: 'anchor_b',
            association: kind === 'overlap'
                ? { kind: 'overlap', origin: 'manual' }
                : { kind: 'transcript-bound', binding: exactBinding(before, 'anchor_b') },
        });
        const merged = mergedAnchorDocument(before);
        const result = planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: merged.after,
            guard: guard(before),
            anchorTransforms: [merged.transform],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].anchorBlockId).toBe('anchor_a');
        if (kind === 'transcript-bound') {
            expect(result.document.dependentLinks[0].association).toMatchObject({
                kind: 'transcript-bound',
                binding: {
                    sourceIntervalId: 'interval_merged',
                    activeStartSample: 17_000,
                    activeEndSample: 31_000,
                },
            });
        }
    });
});

describe('direct target edit integration', () => {
    const modeTargetMatrix = (['ripple', 'absolute'] as const).flatMap(mode => (
        TARGETS.map(target => ({ mode, target }))
    ));
    const modeAssociationMatrix = (['ripple', 'absolute'] as const).flatMap(mode => (
        (['overlap', 'transcript-bound'] as const).map(association => ({ mode, association }))
    ));

    it.each(modeTargetMatrix)('refreshes a moved $target.kind link in $mode mode', ({ mode, target }) => {
        const before = createDocument({ mode });
        attachLink({ document: before, target });
        const beforeInterval = getEditorialTargetInterval(before, target);
        const after = movedTargetDocument(before, target, 30);
        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success' || beforeInterval.kind !== 'success') return;
        expect(getEditorialTargetInterval(result.document, target)).toEqual({
            kind: 'success',
            interval: {
                start: beforeInterval.interval.start + 48_000,
                end: beforeInterval.interval.end + 48_000,
            },
        });
        expect(validateEditorialLinkGraph(result.document).valid).toBe(true);
        expect(result.history.createEntry).toBe(false);
    });

    it('rejects a video move that silently deletes an unlinked subtitle outside the transform ledger', () => {
        const before = createDocument({ mode: 'ripple' });
        attachLink({ document: before, target: VIDEO_TARGET });
        const after = movedTargetDocument(before, VIDEO_TARGET, 30);
        after.subtitleTracks[0].subtitles = [];

        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target: VIDEO_TARGET }],
        })).toMatchObject({
            kind: 'error',
            error: {
                code: 'invalid-transform',
                ids: ['subtitle:subtitle_track:dependent_subtitle'],
            },
        });
    });

    it('rejects an explicit subtitle deletion follower in the same video-move transaction', () => {
        const before = createDocument({ mode: 'ripple' });
        const after = movedTargetDocument(before, VIDEO_TARGET, 30);
        after.subtitleTracks[0].subtitles = [];

        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target: VIDEO_TARGET }, {
                kind: 'deleted', target: SUBTITLE_TARGET,
            }],
        })).toMatchObject({
            kind: 'error',
            error: {
                code: 'invalid-transform',
                ids: ['subtitle:subtitle_track:dependent_subtitle'],
            },
        });
    });

    it('accepts a same-frame video move to another track as a real target move', () => {
        const before = createDocument({ mode: 'absolute' });
        before.videoTracks.push({
            id: 'vertical_destination',
            name: 'Vertical destination',
            visible: true,
            locked: false,
        });
        attachLink({ document: before, target: VIDEO_TARGET });
        const after = cloneDocument(before);
        after.revision += 1;
        after.videoClips = after.videoClips.map(clip => clip.id === VIDEO_TARGET.clipId
            ? { ...clip, trackId: 'vertical_destination' }
            : clip);

        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target: VIDEO_TARGET }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.targetMutations).toMatchObject([{
            kind: 'moved',
            target: VIDEO_TARGET,
            afterTarget: VIDEO_TARGET,
        }]);
        expect(result.document.dependentLinks[0].target).toEqual(VIDEO_TARGET);
    });

    it('rejects a same-frame linked-video track move omitted from the transform ledger', () => {
        const before = createDocument({ mode: 'absolute' });
        before.videoTracks.push({
            id: 'vertical_destination',
            name: 'Vertical destination',
            visible: true,
            locked: false,
        });
        attachLink({ document: before, target: VIDEO_TARGET });
        const after = cloneDocument(before);
        after.revision += 1;
        after.videoClips = after.videoClips.map(clip => clip.id === VIDEO_TARGET.clipId
            ? { ...clip, trackId: 'vertical_destination' }
            : clip);

        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [],
        })).toMatchObject({
            kind: 'error',
            error: { code: 'invalid-transform', ids: ['video:dependent_video'] },
        });
    });

    it.each(modeAssociationMatrix)(
        'keeps a $association follow subtitle attached and visible during an ordinary video move in $mode mode',
        ({ mode, association }) => {
            const before = createDocument({ mode });
            before.subtitleTracks[0].unlinkedVideoEditResponse = 'follow-project-ripple';
            attachLink({
                document: before,
                target: SUBTITLE_TARGET,
                association: association === 'overlap'
                    ? { kind: 'overlap', origin: 'manual' }
                    : { kind: 'transcript-bound', binding: exactBinding(before) },
                followPolicy: 'follow',
            });
            const oldInterval = getEditorialTargetInterval(before, SUBTITLE_TARGET);
            const after = movedTargetDocument(before, VIDEO_TARGET, 30);

            const result = planEditorialLinksForTargetTransforms({
                before,
                afterTargetCommand: after,
                guard: guard(before),
                targetTransforms: [{ kind: 'moved', target: VIDEO_TARGET }],
            });
            expect(result.kind).toBe('success');
            if (result.kind !== 'success') return;
            expect(getEditorialTargetInterval(result.document, SUBTITLE_TARGET)).toEqual(oldInterval);
            expect(result.document.dependentLinks[0]).toMatchObject({
                target: SUBTITLE_TARGET,
                followPolicy: 'follow',
                association: before.dependentLinks[0].association,
            });
        },
    );

    it.each([
        { mode: 'ripple', policy: 'stay-absolute', subtitleDeltaFrames: 0 },
        { mode: 'absolute', policy: 'follow-project-ripple', subtitleDeltaFrames: 0 },
        { mode: 'ripple', policy: 'follow-project-ripple', subtitleDeltaFrames: 30 },
    ] as const)(
        'accepts the explicit $policy subtitle response to a video move in $mode mode',
        ({ mode, policy, subtitleDeltaFrames }) => {
            const before = createDocument({ mode });
            before.subtitleTracks[0].unlinkedVideoEditResponse = policy;
            let after = movedTargetDocument(before, VIDEO_TARGET, 30);
            const targetTransforms: Array<{
                kind: 'moved';
                target: EditorialDependentTargetV1;
            }> = [{ kind: 'moved', target: VIDEO_TARGET }];
            if (subtitleDeltaFrames !== 0) {
                after = movedTargetDocument(after, SUBTITLE_TARGET, subtitleDeltaFrames);
                after.revision = before.revision + 1;
                targetTransforms.push({ kind: 'moved', target: SUBTITLE_TARGET });
            }

            const result = planEditorialLinksForTargetTransforms({
                before,
                afterTargetCommand: after,
                guard: guard(before),
                targetTransforms,
            });
            expect(result.kind).toBe('success');
            if (result.kind !== 'success') return;
            expect(result.document.subtitleTracks[0].subtitles).toHaveLength(1);
            expect(getEditorialTargetInterval(result.document, SUBTITLE_TARGET)).toMatchObject({
                kind: 'success',
                interval: {
                    start: frameToOutputSample(5 + subtitleDeltaFrames, before.renderProfile.fps),
                    end: frameToOutputSample(20 + subtitleDeltaFrames, before.renderProfile.fps),
                },
            });
        },
    );

    it('rejects an unreported subtitle translation produced by a video move policy', () => {
        const before = createDocument({ mode: 'ripple' });
        before.subtitleTracks[0].unlinkedVideoEditResponse = 'follow-project-ripple';
        let after = movedTargetDocument(before, VIDEO_TARGET, 30);
        after = movedTargetDocument(after, SUBTITLE_TARGET, 30);
        after.revision = before.revision + 1;

        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target: VIDEO_TARGET }],
        })).toMatchObject({
            kind: 'error',
            error: {
                code: 'invalid-transform',
                ids: ['subtitle:subtitle_track:dependent_subtitle'],
            },
        });
    });

    it('rejects a video move that hides an existing subtitle track', () => {
        const before = createDocument({ mode: 'absolute' });
        const after = movedTargetDocument(before, VIDEO_TARGET, 30);
        after.subtitleTracks[0].isVisible = false;

        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target: VIDEO_TARGET }],
        })).toMatchObject({
            kind: 'error',
            error: { code: 'invalid-transform', ids: ['subtitle_track'] },
        });
    });

    it.each(TARGETS)('keeps an exact binding attached while directly trimming $kind', (target) => {
        const before = createDocument();
        attachLink({
            document: before,
            target,
            association: { kind: 'transcript-bound', binding: exactBinding(before) },
        });
        const after = trimmedTargetDocument(before, target);
        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'trimmed', target }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].association).toEqual(before.dependentLinks[0].association);
        expect(result.document.dependentLinks[0].relativeEndOutputSample)
            .toBeLessThan(before.dependentLinks[0].relativeEndOutputSample);
    });

    it.each(TARGETS)('rejects a moved $kind target mislabeled as a trim', (target) => {
        const before = createDocument();
        attachLink({ document: before, target });
        const after = movedTargetDocument(before, target, 30);
        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'trimmed', target }],
        })).toMatchObject({ kind: 'error', error: { code: 'invalid-transform' } });
    });

    it('preserves a link across a same-time audio cross-track move by updating persisted identity', () => {
        const before = createDocument();
        before.audioTracks.push({
            id: 'audio_track_b',
            name: 'Audio B',
            muted: false,
            solo: false,
            locked: false,
            gainDb: 0,
            clips: [],
        });
        attachLink({ document: before, target: AUDIO_TARGET });
        const after = cloneDocument(before);
        after.revision += 1;
        const movedClip = after.audioTracks[0].clips[0];
        after.audioTracks[0].clips = [];
        after.audioTracks[1].clips = [{ ...movedClip }];
        const afterTarget = {
            kind: 'audio-clip', trackId: 'audio_track_b', clipId: 'dependent_audio',
        } as const;
        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target: AUDIO_TARGET, afterTarget }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].target).toEqual(afterTarget);
        expect(getEditorialTargetInterval(result.document, AUDIO_TARGET)).toMatchObject({
            kind: 'error', error: { code: 'missing-target' },
        });
        expect(getEditorialTargetInterval(result.document, afterTarget).kind).toBe('success');
    });

    it('preserves a link across a same-time subtitle cross-track move', () => {
        const before = createDocument();
        before.subtitleTracks.push(createSubtitleTrackV4Fixture({
            id: 'subtitle_track_b',
            subtitles: [],
        }));
        attachLink({ document: before, target: SUBTITLE_TARGET });
        const after = cloneDocument(before);
        after.revision += 1;
        const movedSubtitle = after.subtitleTracks[0].subtitles[0];
        after.subtitleTracks[0].subtitles = [];
        after.subtitleTracks[1].subtitles = [{ ...movedSubtitle }];
        const afterTarget = {
            kind: 'subtitle', trackId: 'subtitle_track_b', subtitleId: 'dependent_subtitle',
        } as const;
        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target: SUBTITLE_TARGET, afterTarget }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].target).toEqual(afterTarget);
        expect(getEditorialTargetInterval(result.document, SUBTITLE_TARGET)).toMatchObject({
            kind: 'error', error: { code: 'missing-target' },
        });
        expect(getEditorialTargetInterval(result.document, afterTarget).kind).toBe('success');
    });

    it.each(TARGETS)('retains exactly the greatest old-anchor-overlap child when splitting $kind', (target) => {
        const before = createDocument({ targetStartFrame: 0, targetDurationFrames: 30 });
        // The old anchor covers [15, 45), so only the chronologically later split child overlaps.
        before.narrative!.blocks.anchor_a.timelineStartFrame = 15;
        before.videoClips.find(clip => clip.id === 'owned_a')!.timelineStartFrame = 15;
        attachLink({
            document: before,
            target,
            association: { kind: 'transcript-bound', binding: exactBinding(before) },
        });
        const split = splitTargetDocument(before, target);
        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: split.after,
            guard: guard(before),
            targetTransforms: [{ kind: 'split', target, childTargets: split.children }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].target).toEqual(split.children[1]);
        const classification = classifyEditorialTargets(result.document);
        expect(classification.kind).toBe('success');
        if (classification.kind !== 'success') return;
        const leftKey = target.kind === 'video-clip'
            ? `video:${target.clipId}`
            : target.kind === 'audio-clip'
                ? `audio:${target.trackId}:${target.clipId}`
                : `subtitle:${target.trackId}:${target.subtitleId}`;
        expect(classification.classifications.find(value => value.targetKey === leftKey)?.kind).toBe('unbound');
    });

    it.each(TARGETS)('uses the earlier child on an exact direct-split tie for $kind', (target) => {
        const before = createDocument({ targetStartFrame: 0, targetDurationFrames: 30 });
        attachLink({ document: before, target });
        const split = splitTargetDocument(before, target);
        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: split.after,
            guard: guard(before),
            targetTransforms: [{ kind: 'split', target, childTargets: split.children }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks[0].target).toEqual(split.children[0]);
    });

    it.each(TARGETS)('removes the durable link when directly deleting $kind', (target) => {
        const before = createDocument();
        attachLink({ document: before, target });
        const after = deletedTargetDocument(before, target);
        const result = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'deleted', target }],
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.document.dependentLinks).toEqual([]);
        expect(result.linkMutations).toMatchObject([{ kind: 'deleted' }]);
    });

    it.each(TARGETS)('rejects a direct edit on a locked $kind target', (target) => {
        const before = createDocument();
        if (target.kind === 'video-clip') before.videoTracks[1].locked = true;
        else if (target.kind === 'audio-clip') before.audioTracks[0].locked = true;
        else before.subtitleTracks[0].isLocked = true;
        attachLink({ document: before, target });
        const after = movedTargetDocument(before, target, 30);
        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target }],
        })).toMatchObject({ kind: 'error', error: { code: 'locked-target' } });
    });
});

describe('link graph guards, collisions, and timebase conversions', () => {
    it('returns complete proposals without mutating either caller-owned projection', () => {
        const before = createDocument();
        attachLink({ document: before, target: AUDIO_TARGET, followPolicy: 'follow' });
        const translated = translatedAnchorDocument(before, 30);
        const beforeSnapshot = JSON.stringify(before);
        const afterSnapshot = JSON.stringify(translated.after);
        const result = planEditorialLinksForAnchorTransforms({
            before,
            afterNarrativeCommand: translated.after,
            guard: guard(before),
            anchorTransforms: [translated.transform],
        });
        expect(result.kind).toBe('success');
        expect(JSON.stringify(before)).toBe(beforeSnapshot);
        expect(JSON.stringify(translated.after)).toBe(afterSnapshot);
    });

    it('rejects duplicate target identity, dangling targets, owned targets, and stale offsets', () => {
        const duplicate = createDocument();
        const first = attachLink({ document: duplicate, target: AUDIO_TARGET, id: 'link_first' });
        duplicate.dependentLinks.push({ ...first, id: 'link_second' });
        expect(validateEditorialLinkGraph(duplicate)).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate-target' })]),
        });

        const dangling = createDocument();
        attachLink({ document: dangling, target: AUDIO_TARGET });
        dangling.audioTracks[0].clips = [];
        expect(validateEditorialLinkGraph(dangling)).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([expect.objectContaining({ code: 'missing-target' })]),
        });

        const owned = createDocument();
        attachLink({
            document: owned,
            target: { kind: 'video-clip', clipId: 'owned_a' },
            id: 'owned_link',
        });
        expect(validateEditorialLinkGraph(owned)).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([expect.objectContaining({ code: 'owned-target' })]),
        });

        const stale = createDocument();
        attachLink({ document: stale, target: SUBTITLE_TARGET });
        stale.dependentLinks[0].relativeStartOutputSample += 1;
        expect(validateEditorialLinkGraph(stale)).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([expect.objectContaining({ code: 'stale-offset' })]),
        });

        const duplicateOwner = createDocument();
        duplicateOwner.narrative!.blocks.duplicate_owner = {
            ...duplicateOwner.narrative!.blocks.anchor_a,
            id: 'duplicate_owner',
            instanceId: 'duplicate_owner_instance',
            sourceIntervalId: 'duplicate_owner_interval',
        };
        duplicateOwner.narrative!.blockIds.push('duplicate_owner');
        expect(classifyEditorialTargets(duplicateOwner)).toMatchObject({
            kind: 'error', error: { code: 'duplicate-target' },
        });

        const missingOrderedBlock = createDocument();
        attachLink({ document: missingOrderedBlock, target: VIDEO_TARGET });
        delete missingOrderedBlock.narrative!.blocks.anchor_a;
        expect(validateEditorialLinkGraph(missingOrderedBlock)).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-proposal' })]),
        });
    });

    it('enforces stale revision/mode guards before standalone and integrated commands', () => {
        const document = createDocument();
        expect(planCreateManualOverlapLink({
            document,
            guard: { ...guard(document), expectedDocumentRevision: 0 },
            target: AUDIO_TARGET,
            anchorBlockId: 'anchor_a',
            idFactory: idFactory(),
        })).toMatchObject({ kind: 'error', error: { code: 'stale-document' } });
        expect(planCreateManualOverlapLink({
            document,
            guard: { ...guard(document), expectedMode: 'absolute' },
            target: AUDIO_TARGET,
            anchorBlockId: 'anchor_a',
            idFactory: idFactory(),
        })).toMatchObject({ kind: 'error', error: { code: 'stale-mode' } });

        attachLink({ document, target: AUDIO_TARGET });
        const after = movedTargetDocument(document, AUDIO_TARGET, 30);
        expect(planEditorialLinksForTargetTransforms({
            before: document,
            afterTargetCommand: after,
            guard: { ...guard(document), expectedNarrativeRevision: 0 },
            targetTransforms: [{ kind: 'moved', target: AUDIO_TARGET }],
        })).toMatchObject({ kind: 'error', error: { code: 'stale-narrative' } });
    });

    it.each([
        { target: VIDEO_TARGET, kind: 'video' },
        { target: AUDIO_TARGET, kind: 'audio' },
    ])('preflights a direct $kind same-track collision before link publication', ({ target }) => {
        const before = createDocument();
        attachLink({ document: before, target });
        const after = movedTargetDocument(before, target, 30);
        if (target.kind === 'video-clip') {
            after.videoClips.push({
                id: 'direct_video_blocker',
                sourceId: 'video_source_editorial',
                trackId: 'dependent_video_track',
                timelineStartFrame: 35,
                sourceStart: 3,
                sourceEnd: 3.5,
                audio: null,
            });
        } else {
            after.audioTracks[0].clips.push({
                id: 'direct_audio_blocker',
                source: { kind: 'audio-source', audioSourceId: 'audio_source' },
                timelineStartFrame: 35,
                sourceStartSample: 24_000,
                sourceEndSample: 48_000,
                timelineDurationSamples: 24_000,
                fadeInSamples: 0,
                fadeOutSamples: 0,
                muted: false,
                gainDb: 0,
            });
        }
        expect(planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: guard(before),
            targetTransforms: [{ kind: 'moved', target }],
        })).toMatchObject({ kind: 'error', error: { code: 'collision' } });
    });

    it('converts video frames, exact audio duration, and subtitle seconds in the 48 kHz domain', () => {
        const document = createDocument();
        document.renderProfile.fps = { numerator: 30_000, denominator: 1_001 };
        const audioClip = document.audioTracks[0].clips[0];
        if (!isImportedAudioClip(audioClip)) throw new Error('Expected imported audio.');
        audioClip.timelineDurationSamples = 12_345;
        const video = getEditorialTargetInterval(document, VIDEO_TARGET);
        const audio = getEditorialTargetInterval(document, AUDIO_TARGET);
        const subtitle = getEditorialTargetInterval(document, SUBTITLE_TARGET);
        expect(video).toEqual({
            kind: 'success',
            interval: {
                start: frameToOutputSample(5, document.renderProfile.fps),
                end: frameToOutputSample(20, document.renderProfile.fps),
            },
        });
        expect(audio).toEqual({
            kind: 'success',
            interval: {
                start: frameToOutputSample(5, document.renderProfile.fps),
                end: frameToOutputSample(5, document.renderProfile.fps) + 12_345,
            },
        });
        expect(subtitle).toEqual({
            kind: 'success',
            interval: { start: 8_000, end: 32_000 },
        });

        const detached = createDocument();
        detached.audioTracks[0].clips = [{
            id: 'dependent_audio',
            source: { kind: 'video-source-audio', videoSourceId: 'video_source_editorial' },
            timelineStartFrame: 5,
            sourceStart: 2,
            sourceEnd: 2.5,
            fadeInFrames: 0,
            fadeOutFrames: 0,
            muted: false,
            gainDb: 0,
        }];
        expect(getEditorialTargetInterval(detached, AUDIO_TARGET)).toEqual({
            kind: 'success',
            interval: { start: 8_000, end: 32_000 },
        });
    });
});
