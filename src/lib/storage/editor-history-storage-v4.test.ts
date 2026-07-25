import { describe, expect, it } from 'vitest';
import { migrateEditorDocumentV3ToV4 } from '@/lib/editor-document-v4-migration';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import {
    applySerializablePatches,
    createSerializablePatches,
} from '@/lib/serializable-patch';
import {
    TIMELINE_HISTORY_ROOTS,
} from '@/stores/timeline-history-projection';
import type {
    TimelineHistoryEntry,
    TimelineHistoryRuntimeState,
} from '@/stores/timeline-store-types';
import type { EditorDocumentV3 } from '@/types/video';
import { projectEditorDocumentHistory } from './editor-history-storage';
import {
    migrateTimelineHistoryV3ToV4,
} from './editor-history-storage-v4';

const createV3Document = (order: readonly ['clip_a', 'clip_b'] | readonly ['clip_b', 'clip_a']): EditorDocumentV3 => {
    const file = {
        name: 'history-video.webm',
        type: 'video/webm',
        size: 1_024,
        lastModified: 1_700_000_000_000,
    } as File;
    const clips = {
        clip_a: {
            id: 'clip_a',
            sourceId: 'source_history',
            sourceStart: 0,
            sourceEnd: 1,
            audio: {
                linkState: 'linked' as const,
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        },
        clip_b: {
            id: 'clip_b',
            sourceId: 'source_history',
            sourceStart: 1,
            sourceEnd: 2,
            audio: {
                linkState: 'linked' as const,
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            },
        },
    };
    return {
        version: 3,
        revision: order[0] === 'clip_a' ? 1 : 2,
        audioGraphRevision: order[0] === 'clip_a' ? 0 : 1,
        renderProfile: createDefaultRenderProfile({
            fps: { numerator: 30, denominator: 1 },
            isFrameRateLocked: true,
        }),
        subtitleTracks: [],
        videoSources: [{
            id: 'source_history',
            originalName: file.name,
            mimeType: file.type,
            size: file.size,
            lastModified: file.lastModified,
            fingerprint: 'history-source-fingerprint',
            duration: 2,
            fps: 30,
            width: 1_920,
            height: 1_080,
            bitrate: null,
            hasAudio: true,
            file,
        }],
        videoClips: order.map((id) => clips[id]),
        videoTracks: [{ id: 'video_track_history', name: 'History video', clipIds: [...order] }],
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
};

describe('V3 to V4 timeline-history migration', () => {
    it('replays V3 clip-order patches and re-diffs explicit V4 placements without losing command identity', () => {
        const before = createV3Document(['clip_a', 'clip_b']);
        const current = createV3Document(['clip_b', 'clip_a']);
        const beforeProjection = projectEditorDocumentHistory(before);
        const currentProjection = projectEditorDocumentHistory(current);
        const patches = createSerializablePatches(
            beforeProjection,
            currentProjection,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        const entry: TimelineHistoryEntry = {
            id: 'history-reorder-v3',
            sequence: 7,
            label: 'Reorder video clips',
            mergeKey: 'video-reorder',
            timestamp: 123_456,
            patches: patches.patches,
            inversePatches: patches.inversePatches,
            audioGraphMutationImpact: 'invalidate-transcription',
            recalculatesContentBoundary: true,
            byteSize: 1,
            oversized: false,
        };
        const runtime: TimelineHistoryRuntimeState = {
            history: [entry],
            redoStack: [],
            projection: currentProjection,
        };

        const migrated = migrateTimelineHistoryV3ToV4(
            current,
            migrateEditorDocumentV3ToV4(current),
            runtime,
        );

        expect(migrated.history).toHaveLength(1);
        expect(migrated.history[0]).toMatchObject({
            id: entry.id,
            sequence: entry.sequence,
            label: entry.label,
            mergeKey: entry.mergeKey,
            timestamp: entry.timestamp,
            audioGraphMutationImpact: entry.audioGraphMutationImpact,
            recalculatesContentBoundary: true,
        });
        expect(migrated.projection.videoClips.map((clip) => ({
            id: clip.id,
            trackId: clip.trackId,
            timelineStartFrame: clip.timelineStartFrame,
        }))).toEqual([
            { id: 'clip_b', trackId: 'video_track_history', timelineStartFrame: 0 },
            { id: 'clip_a', trackId: 'video_track_history', timelineStartFrame: 30 },
        ]);

        const undone = applySerializablePatches(
            migrated.projection,
            migrated.history[0].inversePatches,
            TIMELINE_HISTORY_ROOTS as ReadonlySet<string>,
        );
        expect(undone.videoClips.map((clip) => ({
            id: clip.id,
            trackId: clip.trackId,
            timelineStartFrame: clip.timelineStartFrame,
        }))).toEqual([
            { id: 'clip_a', trackId: 'video_track_history', timelineStartFrame: 0 },
            { id: 'clip_b', trackId: 'video_track_history', timelineStartFrame: 30 },
        ]);
    });
});
