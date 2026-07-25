import { describe, expect, it } from 'vitest';
import { frameSpanToOutputSamples, frameToOutputSample } from '../audio-timebase';
import {
    createHeadlessRenderSnapshotFixture,
} from '../headless-render/headless-render.test-fixtures';
import {
    createResolvedRenderPlan,
    resolveRenderPlanVideoFrame,
} from './render-plan';

describe('resolved V4 render plan', () => {
    it('freezes one descriptor-only snapshot and remains detached from later mutations', () => {
        const snapshot = createHeadlessRenderSnapshotFixture();
        const plan = createResolvedRenderPlan(snapshot);

        snapshot.manifest.revision = 99;
        snapshot.manifest.videoClips[0].timelineStartFrame = 100;
        snapshot.manifest.subtitleTracks[0].subtitles[0].text = 'Changed';
        snapshot.sourceIdentities[0].fingerprint = 'sha256:changed';

        expect(plan).toMatchObject({
            version: 1,
            documentRevision: 7,
            audioGraphRevision: 3,
            backgroundColor: '#000000',
            output: {
                container: 'mp4',
                videoCodec: 'h264',
                audioCodec: 'aac',
            },
        });
        expect(plan.videoSegments[0].outputStartFrame).toBe(0);
        expect(plan.subtitleTracks[0].subtitles[0].text).toBe('Visible');
        expect(plan.sources[0].fingerprint).toBe('sha256:red');
        expect(Object.isFrozen(plan)).toBe(true);
        expect(Object.isFrozen(plan.audioMixPlan.contributors)).toBe(true);
    });

    it('matches the shared V4 winning-frame plan across overlap, gaps, and black tails', () => {
        const snapshot = createHeadlessRenderSnapshotFixture();
        const plan = createResolvedRenderPlan(snapshot);

        expect(plan.contentEndFrame).toBe(120);
        expect(plan.videoSegments).toMatchObject([
            {
                kind: 'video',
                outputStartFrame: 0,
                outputEndFrame: 10,
                clipId: 'red-lower',
                trackId: 'lower',
            },
            {
                kind: 'video',
                outputStartFrame: 10,
                outputEndFrame: 25,
                clipId: 'red-top',
                trackId: 'top',
            },
            {
                kind: 'video',
                outputStartFrame: 25,
                outputEndFrame: 30,
                clipId: 'red-lower',
                trackId: 'lower',
            },
            { kind: 'background', outputStartFrame: 30, outputEndFrame: 45 },
            {
                kind: 'video',
                outputStartFrame: 45,
                outputEndFrame: 75,
                clipId: 'blue-lower',
                trackId: 'lower',
            },
            { kind: 'background', outputStartFrame: 75, outputEndFrame: 120 },
        ]);
        for (let frame = 0; frame < plan.contentEndFrame; frame += 1) {
            const actual = resolveRenderPlanVideoFrame(plan, frame);
            const expectedClipId = frame < 10 ? 'red-lower'
                : frame < 25 ? 'red-top'
                    : frame < 30 ? 'red-lower'
                        : frame < 45 ? null
                            : frame < 75 ? 'blue-lower'
                                : null;
            expect(actual?.clipId ?? null).toBe(expectedClipId);
        }
        expect(resolveRenderPlanVideoFrame(plan, 0)?.sourceTimeSeconds).toBe(0);
        expect(resolveRenderPlanVideoFrame(plan, 10)?.sourceTimeSeconds).toBe(1);
        expect(resolveRenderPlanVideoFrame(plan, 29)?.sourceTimeSeconds).toBeCloseTo(29 / 30, 12);
        expect(resolveRenderPlanVideoFrame(plan, 45)?.sourceTimeSeconds).toBe(0);
        expect(resolveRenderPlanVideoFrame(plan, 120)).toBeNull();
    });

    it('reuses canonical compositor geometry, visible subtitle order, and audio mix semantics', () => {
        const snapshot = createHeadlessRenderSnapshotFixture();
        const plan = createResolvedRenderPlan(snapshot);
        expect(plan.subtitleTracks.map((track) => track.id)).toEqual(['visible-subtitles']);
        expect(plan.requiredFontFamilies).toEqual(['Arial']);
        expect(plan.videoSegments.find((segment) => (
            segment.kind === 'video' && segment.sourceId === 'video-blue'
        ))).toMatchObject({
            contain: { x: 109.375, y: 0, width: 101.25, height: 180 },
        });
        expect(plan.audioMixPlan.contributors.map((item) => item.id)).toEqual([
            'embedded-video:red-lower',
            'embedded-video:red-top',
            'independent-audio:audio-main:imported-tail',
        ]);
        expect(plan.audioMixPlan.contributors[0]).toMatchObject({
            outputStartSample: 0,
            outputEndSample: 48_000,
            fadeInSamples: 3_200,
            fadeOutSamples: 3_200,
        });
        expect(plan.audioMixPlan.contributors[0].gainLinear)
            .toBeCloseTo(10 ** (-2 / 20), 12);
        expect(plan.audioMixPlan.contributors.at(-1)).toMatchObject({
            outputStartSample: 128_000,
            outputEndSample: 176_000,
            fadeInSamples: 3_000,
            fadeOutSamples: 6_000,
            sourceRange: {
                domain: 'native-samples',
                startSample: 0,
                endSample: 16_000,
                sampleRate: 16_000,
            },
        });
        expect(plan.audioMixPlan.contributors.at(-1)?.gainLinear)
            .toBeCloseTo(10 ** (-4 / 20), 12);
        expect(plan.audioMixPlan.totalSampleCount).toBe(176_000);
        expect(plan.outputEndSample).toBe(192_000);
    });

    it('fails closed when a source identity is missing, duplicated, or changed', () => {
        const missing = createHeadlessRenderSnapshotFixture();
        missing.sourceIdentities.pop();
        expect(() => createResolvedRenderPlan(missing)).toThrow(/exactly match|missing audio identity/i);

        const duplicate = createHeadlessRenderSnapshotFixture();
        duplicate.sourceIdentities.push({ ...duplicate.sourceIdentities[0] });
        expect(() => createResolvedRenderPlan(duplicate)).toThrow(/duplicate/i);

        const changed = createHeadlessRenderSnapshotFixture();
        changed.sourceIdentities[0].size += 1;
        expect(() => createResolvedRenderPlan(changed)).toThrow(/source identity changed/i);
    });

    it('preserves mute, solo, linked, and detached decisions in the resolved audio plan', () => {
        const snapshot = createHeadlessRenderSnapshotFixture();
        snapshot.manifest.videoClips[0].audio!.linkState = 'detached';
        snapshot.manifest.audioTracks.push({
            id: 'detached-track',
            name: 'Detached',
            muted: false,
            solo: true,
            locked: false,
            gainDb: 0,
            clips: [{
                id: 'detached-red',
                source: { kind: 'video-source-audio', videoSourceId: 'video-red' },
                timelineStartFrame: 0,
                sourceStart: 0,
                sourceEnd: 1,
                muted: false,
                gainDb: -6,
                fadeInFrames: 1,
                fadeOutFrames: 1,
            }],
        });

        const plan = createResolvedRenderPlan(snapshot);

        expect(plan.audioMixPlan.contributors).toHaveLength(1);
        expect(plan.audioMixPlan.contributors[0]).toMatchObject({
            id: 'independent-audio:detached-track:detached-red',
            kind: 'independent-audio',
            trackId: 'detached-track',
        });
        expect(plan.audioMixPlan.contributors[0].gainLinear).toBeCloseTo(10 ** (-6 / 20), 12);
    });

    it('uses the durable V4 render background and preserves black for legacy manifests', () => {
        const legacy = createResolvedRenderPlan(createHeadlessRenderSnapshotFixture());
        const configuredSnapshot = createHeadlessRenderSnapshotFixture();
        Object.assign(configuredSnapshot.manifest, { renderBackgroundColor: '#12abef' });
        const configured = createResolvedRenderPlan(configuredSnapshot);

        expect(legacy.backgroundColor).toBe('#000000');
        expect(configured.backgroundColor).toBe('#12abef');
        for (const invalidColor of ['#12ABef', 'not-a-color', undefined]) {
            const invalid = createHeadlessRenderSnapshotFixture();
            Object.assign(invalid.manifest, { renderBackgroundColor: invalidColor });
            expect(() => createResolvedRenderPlan(invalid)).toThrow(/renderBackgroundColor/i);
        }

        const parallelField = createHeadlessRenderSnapshotFixture();
        Object.assign(parallelField.manifest, {
            renderBackground: { color: '#123456' },
        });
        expect(() => createResolvedRenderPlan(parallelField)).toThrow(/unsupported root field/i);
    });

    it('keeps rational frame-rate audio boundaries exact and excludes no-audio sources', () => {
        const snapshot = createHeadlessRenderSnapshotFixture();
        const fps = { numerator: 30_000, denominator: 1_001 };
        snapshot.manifest.renderProfile.fps = fps;
        snapshot.manifest.audioTracks = [];

        const plan = createResolvedRenderPlan(snapshot);
        const lower = plan.audioMixPlan.contributors.find((contributor) => (
            contributor.id === 'embedded-video:red-lower'
        ));

        expect(plan.audioMixPlan.contributors.map((contributor) => contributor.id)).toEqual([
            'embedded-video:red-lower',
            'embedded-video:red-top',
        ]);
        expect(lower).toMatchObject({
            outputStartSample: frameToOutputSample(0, fps),
            outputEndSample: frameToOutputSample(30, fps),
            fadeInSamples: frameSpanToOutputSamples(0, 2, fps),
            fadeOutSamples: frameSpanToOutputSamples(28, 30, fps),
        });
        expect(plan.audioMixPlan.contributors.some((contributor) => (
            contributor.source.kind === 'video-source-audio'
            && contributor.source.videoSourceId === 'video-blue'
        ))).toBe(false);
    });
});
