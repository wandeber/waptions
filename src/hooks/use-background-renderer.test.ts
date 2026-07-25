import { describe, expect, it, vi } from 'vitest';
import type { ClipPlacement, VideoSourceAssetV3 } from '@/types/video';
import { FrameCache } from '@/lib/frame-cache';
import { createDefaultRenderProfile } from '@/lib/render-profile';
import { buildClipPlacements } from '@/lib/video-timeline';
import { buildPreviewWarmupFramePlan } from '@/lib/video-frame-plan';
import { buildTimelineVideoFrameRuntimePlanV4 } from '@/stores/timeline-v4-compat';
import { buildPreviewWarmupRequest } from './use-background-renderer';

const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
const source = (id: string, fps: number, duration = 10): VideoSourceAssetV3 => ({
    id,
    originalName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 5,
    lastModified: 1,
    fingerprint: id,
    duration,
    fps,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio: true,
    file,
});

const commonOptions = (
    placements: readonly ClipPlacement[],
    sources: readonly VideoSourceAssetV3[],
) => ({
    isPlaying: true,
    currentProjectFrameIndex: 0,
    projectFrameRate: { numerator: 30, denominator: 1 },
    placements,
    sources,
    rangeForward: 5,
    rangeBackward: 2,
    sparseFps: 10,
    playbackLookaheadFrames: 4,
    hasFrame: () => false,
});

describe('buildPreviewWarmupFramePlan', () => {
    it('projects an empty transitional Timeline graph as an explicit V4 runtime plan', () => {
        const plan = buildTimelineVideoFrameRuntimePlanV4({
            renderProfile: createDefaultRenderProfile(),
            videoClips: [],
            videoTracks: [{
                id: 'video_track_1',
                name: 'Video 1',
                visible: true,
                locked: false,
                clipIds: [],
            }],
        });

        expect(plan).toMatchObject({
            version: 4,
            tracks: [{
                track: { id: 'video_track_1', visible: true, locked: false },
                placements: [],
            }],
        });
    });

    it('uses the measured preview resolution on the first warmup request', () => {
        const candidate = source('a', 30);
        const planned = {
            projectFrameIndex: 1,
            sourceId: candidate.id,
            sourceFrameIndex: 1,
            sourceTime: 1 / 30,
        };
        const controller = new AbortController();

        const request = buildPreviewWarmupRequest(
            candidate,
            planned,
            { width: 640, height: 360 },
            controller.signal,
            { generation: 7, order: 2 },
        );

        expect(request.targetResolution).toEqual({ width: 640, height: 360 });
        expect(request.signal).toBe(controller.signal);
        expect(request.warmupPlan).toEqual({ generation: 7, order: 2 });
    });

    it('keeps a full project-frame runway ahead of playback', () => {
        const sources = [source('a', 30)];
        const placements = buildClipPlacements([
            { id: 'clip', sourceId: 'a', sourceStart: 0, sourceEnd: 5 },
        ], { numerator: 30, denominator: 1 });

        const plan = buildPreviewWarmupFramePlan({
            ...commonOptions(placements, sources),
            currentProjectFrameIndex: 100,
        });

        expect(plan.map((frame) => frame.projectFrameIndex)).toEqual([101, 102, 103, 104]);
        expect(plan.map((frame) => frame.sourceFrameIndex)).toEqual([101, 102, 103, 104]);
    });

    it('crosses a clip boundary and switches source identity', () => {
        const sources = [source('a', 30), source('b', 24)];
        const placements = buildClipPlacements([
            { id: 'first', sourceId: 'a', sourceStart: 1, sourceEnd: 2 },
            { id: 'second', sourceId: 'b', sourceStart: 3, sourceEnd: 4 },
        ], { numerator: 30, denominator: 1 });

        const plan = buildPreviewWarmupFramePlan({
            ...commonOptions(placements, sources),
            currentProjectFrameIndex: 28,
        });

        expect(plan.map(({ projectFrameIndex, sourceId, sourceFrameIndex }) => ({
            projectFrameIndex,
            sourceId,
            sourceFrameIndex,
        }))).toEqual([
            { projectFrameIndex: 29, sourceId: 'a', sourceFrameIndex: 59 },
            { projectFrameIndex: 30, sourceId: 'b', sourceFrameIndex: 72 },
            { projectFrameIndex: 32, sourceId: 'b', sourceFrameIndex: 73 },
        ]);
    });

    it('uses exact 30000/1001 project boundaries across a reused clip', () => {
        const rate = { numerator: 30_000, denominator: 1_001 };
        const sources = [source('a', 30, 20)];
        const placements = buildClipPlacements([
            { id: 'first', sourceId: 'a', sourceStart: 0, sourceEnd: 1.001 },
            { id: 'reused', sourceId: 'a', sourceStart: 10, sourceEnd: 11.001 },
        ], rate);

        const plan = buildPreviewWarmupFramePlan({
            ...commonOptions(placements, sources),
            currentProjectFrameIndex: 28,
            projectFrameRate: rate,
        });

        expect(plan.map((frame) => [frame.projectFrameIndex, frame.sourceFrameIndex])).toEqual([
            [29, 29],
            [30, 300],
            [31, 301],
            [32, 302],
        ]);
    });

    it('requests the nearest paused runway before farther and backward frames', () => {
        const sources = [source('a', 4, 20)];
        const placements = buildClipPlacements([
            { id: 'clip', sourceId: 'a', sourceStart: 0, sourceEnd: 20 },
        ], { numerator: 4, denominator: 1 });

        const plan = buildPreviewWarmupFramePlan({
            ...commonOptions(placements, sources),
            isPlaying: false,
            currentProjectFrameIndex: 10,
            projectFrameRate: { numerator: 4, denominator: 1 },
            rangeForward: 3,
            rangeBackward: 1,
            sparseFps: 2,
        });

        expect(plan.map((frame) => frame.projectFrameIndex)).toEqual([
            11, 12, 13, 14, 15, 16, 17, 18,
            20, 22, 8, 6,
        ]);
    });

    it('leaves the nearest forward runway resident after a low-budget paused warmup', () => {
        const sources = [source('a', 4, 20)];
        const placements = buildClipPlacements([
            { id: 'clip', sourceId: 'a', sourceStart: 0, sourceEnd: 20 },
        ], { numerator: 4, denominator: 1 });
        const plan = buildPreviewWarmupFramePlan({
            ...commonOptions(placements, sources),
            isPlaying: false,
            currentProjectFrameIndex: 10,
            projectFrameRate: { numerator: 4, denominator: 1 },
            rangeForward: 3,
            rangeBackward: 1,
            sparseFps: 2,
        });
        // Each 256x256 RGBA bitmap consumes exactly 0.25 MiB, so this cache retains only three
        // frames. Warmup admission receives a decreasing priority in decode order: later distant
        // frames are rejected instead of evicting the already-decoded nearest runway.
        const cache = new FrameCache(0.75);
        plan.forEach((planned, index) => {
            cache.addFrameAtIndex('source', planned.sourceFrameIndex, {
                width: 256,
                height: 256,
                close: vi.fn(),
            } as unknown as ImageBitmap, 4, {
                retentionPriority: 1 / (index + 1),
            });
        });

        expect([11, 12, 13].map((index) => cache.hasFrameAtIndex('source', index)))
            .toEqual([true, true, true]);
        expect([6, 8, 20, 22].map((index) => cache.hasFrameAtIndex('source', index)))
            .toEqual([false, false, false, false]);
        expect(cache.getStats()).toMatchObject({
            frameCount: 3,
            memoryBytes: 3 * 256 * 256 * 4,
        });
        cache.clear();
    });

    it('skips already cached source frames and source-frame duplicates', () => {
        const sources = [source('a', 24)];
        const placements = buildClipPlacements([
            { id: 'clip', sourceId: 'a', sourceStart: 0, sourceEnd: 5 },
        ], { numerator: 30, denominator: 1 });

        const plan = buildPreviewWarmupFramePlan({
            ...commonOptions(placements, sources),
            hasFrame: (_sourceId, frameIndex) => frameIndex === 2,
        });

        expect(plan.map((frame) => frame.sourceFrameIndex)).toEqual([0, 1, 3]);
    });
});
