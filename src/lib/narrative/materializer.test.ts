import { describe, expect, it } from 'vitest';
import type {
    NarrativeSpeechBlockV1,
    ResolvedEditorialTranscriptRecordBodyV1,
} from '@/types/editorial';
import {
    createEditorialTranscriptBodyFixture,
    createNarrativeSilenceBlockFixture,
    createNarrativeSpeechBlockFixture,
} from '@/types/editorial.test-fixtures';
import type { VideoClipV4 } from '@/types/video';
import {
    materializeActivationRange,
    mergeNarrativeOccurrences,
    sourceFrameSpanToProjectFrames,
    sourceFrameRangeToTranscriptSamples,
    sourceSampleToVideoFrame,
    splitNarrativeOccurrence,
} from './materializer';

function bodyFixture(): ResolvedEditorialTranscriptRecordBodyV1 {
    return createEditorialTranscriptBodyFixture({
        sampleCount: 64_000,
        words: [{
            id: 'word_left',
            text: 'Left',
            alignedStartSample: 16_000,
            alignedEndSample: 24_000,
            editableStartSample: 16_000,
            editableEndSample: 24_000,
            probability: 1,
            speakerId: null,
        }, {
            id: 'word_right',
            text: 'Right',
            alignedStartSample: 32_000,
            alignedEndSample: 40_000,
            editableStartSample: 32_000,
            editableEndSample: 40_000,
            probability: 1,
            speakerId: null,
        }],
        speechRegions: [],
        editBoundaries: [],
    }) as ResolvedEditorialTranscriptRecordBodyV1;
}

function splitFixture(): {
    block: NarrativeSpeechBlockV1;
    clip: VideoClipV4;
} {
    const block = createNarrativeSpeechBlockFixture({
        id: 'block_original',
        clipId: 'clip_original',
        instanceId: 'instance_original',
        lineageRootId: 'lineage_original',
        sourceIntervalId: 'interval_original',
        coreStartSample: 16_000,
        coreEndSample: 40_000,
        sourceWordIds: ['word_left', 'word_right'],
        wordTextOverrides: { word_left: 'Corrected left' },
        speakerOverrides: { word_right: 'speaker_override' },
        materialization: {
            sourceStartFrame: 15,
            sourceEndFrame: 105,
            preBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 8_000 },
            postBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 4_000 },
        },
        timelineStartFrame: 10,
    });
    return {
        block,
        clip: {
            id: block.clipId,
            sourceId: block.sourceId,
            trackId: block.trackId,
            timelineStartFrame: block.timelineStartFrame,
            sourceStart: 0.5,
            sourceEnd: 3.5,
            audio: {
                linkState: 'linked',
                muted: false,
                gainDb: 0,
                fadeInFrames: 5,
                fadeOutFrames: 7,
            },
        },
    };
}

describe('narrative materialization', () => {
    it('uses guarded canonical sample/frame rounding at exact and fractional boundaries', () => {
        expect(sourceSampleToVideoFrame(16_000, 30, 'floor')).toBe(30);
        expect(sourceSampleToVideoFrame(16_000, 30, 'ceil')).toBe(30);
        expect(sourceSampleToVideoFrame(8_000, 29.97, 'nearest')).toBe(15);
        const crop = sourceFrameRangeToTranscriptSamples(1, 31, 30, 160_000);
        expect(crop).toEqual({ start: 534, end: 16_533 });
        expect(sourceSampleToVideoFrame(crop.start, 30, 'floor')).toBe(1);
        expect(sourceSampleToVideoFrame(crop.end, 30, 'ceil')).toBe(31);
        expect(sourceFrameSpanToProjectFrames(
            0,
            48,
            24,
            { numerator: 30_000, denominator: 1_001 },
        )).toBe(60);
    });

    it('preserves exact source and project coverage with differing source/project FPS', () => {
        let seam = 0;
        const result = materializeActivationRange({
            body: bodyFixture(),
            coreRange: { start: 0, end: 64_000 },
            sourceStartFrame: 0,
            sourceEndFrame: 96,
            timelineStartFrame: 7,
            sourceFps: 24,
            sourceDuration: 4,
            projectFps: { numerator: 30_000, denominator: 1_001 },
            createSeamId: () => `seam_${seam += 1}`,
        });
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') return;
        expect(result.value[0].sourceStartFrame).toBe(0);
        expect(result.value.at(-1)?.sourceEndFrame).toBe(96);
        expect(result.value[0].timelineStartFrame).toBe(7);
        expect(result.value.at(-1)?.timelineEndFrame).toBe(127);
        for (let index = 1; index < result.value.length; index += 1) {
            expect(result.value[index - 1].sourceEndFrame).toBe(result.value[index].sourceStartFrame);
            expect(result.value[index - 1].timelineEndFrame).toBe(result.value[index].timelineStartFrame);
            expect(result.value[index].timelineEndFrame).toBeGreaterThan(result.value[index].timelineStartFrame);
        }
        const durationSum = result.value.reduce(
            (sum, fragment) => sum + fragment.timelineEndFrame - fragment.timelineStartFrame,
            0,
        );
        expect(durationSum).toBe(120);
    });

    it('splits nonzero margins through one paired seam and merges siblings without frame loss', () => {
        const fixture = splitFixture();
        const split = splitNarrativeOccurrence({
            ...fixture,
            body: bodyFixture(),
            source: { duration: 4, fps: 30 },
            projectFps: { numerator: 24, denominator: 1 },
            splitSample: 32_000,
            revision: 2,
            ids: {
                seamId: 'seam_split',
                leftInstanceId: 'instance_left',
                rightInstanceId: 'instance_right',
                leftSourceIntervalId: 'interval_left',
                rightSourceIntervalId: 'interval_right',
                rightBlockId: 'block_right',
                rightClipId: 'clip_right',
            },
        });
        expect(split.kind).toBe('success');
        if (split.kind !== 'success') return;
        expect(split.value.leftBlock.materialization.preBoundary).toEqual(
            fixture.block.materialization.preBoundary,
        );
        expect(split.value.leftBlock.materialization.postBoundary).toEqual({
            kind: 'partition-seam',
            seamId: 'seam_split',
        });
        expect(split.value.rightBlock.materialization.preBoundary).toEqual(
            split.value.leftBlock.materialization.postBoundary,
        );
        expect(split.value.rightBlock.materialization.postBoundary).toEqual(
            fixture.block.materialization.postBoundary,
        );
        expect(split.value.leftBlock.timelineStartFrame).toBe(10);
        expect(split.value.rightBlock.timelineStartFrame).toBe(46);
        expect(split.value.rightBlock.timelineStartFrame + 36).toBe(82);
        expect(split.value.leftBlock.wordTextOverrides).toEqual({ word_left: 'Corrected left' });
        expect(split.value.rightBlock.speakerOverrides).toEqual({ word_right: 'speaker_override' });
        expect(split.value.leftClip.audio).toMatchObject({ fadeInFrames: 5, fadeOutFrames: 0 });
        expect(split.value.rightClip.audio).toMatchObject({ fadeInFrames: 0, fadeOutFrames: 7 });

        const merged = mergeNarrativeOccurrences({
            leftBlock: split.value.leftBlock,
            rightBlock: split.value.rightBlock,
            leftClip: split.value.leftClip,
            rightClip: split.value.rightClip,
            source: { duration: 4, fps: 30 },
            projectFps: { numerator: 24, denominator: 1 },
            revision: 3,
            mergedInstanceId: 'instance_merged',
            mergedSourceIntervalId: 'interval_merged',
        });
        expect(merged.kind).toBe('success');
        if (merged.kind !== 'success') return;
        expect(merged.value.block.coreStartSample).toBe(fixture.block.coreStartSample);
        expect(merged.value.block.coreEndSample).toBe(fixture.block.coreEndSample);
        expect(merged.value.block.sourceWordIds).toEqual(['word_left', 'word_right']);
        expect(merged.value.block.materialization).toEqual(fixture.block.materialization);
        expect(merged.value.clip.sourceStart).toBe(fixture.clip.sourceStart);
        expect(merged.value.clip.sourceEnd).toBe(fixture.clip.sourceEnd);
        expect(merged.value.clip.audio).toEqual(fixture.clip.audio);
    });

    it('rejects a merge that would deduplicate an intentional repeated word occurrence', () => {
        const fixture = splitFixture();
        const left = {
            ...fixture.block,
            coreStartSample: 0,
            coreEndSample: 16_000,
            sourceWordIds: ['word_left'],
            materialization: {
                sourceStartFrame: 0,
                sourceEndFrame: 30,
                preBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 } as const,
                postBoundary: { kind: 'partition-seam', seamId: 'repeat_seam' } as const,
            },
            timelineStartFrame: 0,
        };
        const right = {
            ...fixture.block,
            id: 'block_repeat',
            clipId: 'clip_repeat',
            instanceId: 'instance_repeat',
            sourceIntervalId: 'interval_repeat',
            coreStartSample: 16_000,
            coreEndSample: 32_000,
            sourceWordIds: ['word_left'],
            materialization: {
                sourceStartFrame: 30,
                sourceEndFrame: 60,
                preBoundary: { kind: 'partition-seam', seamId: 'repeat_seam' } as const,
                postBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 } as const,
            },
            timelineStartFrame: 30,
        };
        const result = mergeNarrativeOccurrences({
            leftBlock: left,
            rightBlock: right,
            leftClip: { ...fixture.clip, sourceStart: 0, sourceEnd: 1, timelineStartFrame: 0 },
            rightClip: {
                ...fixture.clip,
                id: 'clip_repeat',
                sourceStart: 1,
                sourceEnd: 2,
                timelineStartFrame: 30,
            },
            source: { duration: 4, fps: 30 },
            projectFps: { numerator: 30, denominator: 1 },
            revision: 2,
            mergedInstanceId: 'instance_forbidden',
            mergedSourceIntervalId: 'interval_forbidden',
        });
        expect(result).toMatchObject({ kind: 'error', code: 'incompatible-merge' });
    });

    it('uses a fixed seed to prove every accepted fractional-FPS split has exact coverage', () => {
        let seed = 0x53504c54;
        const random = (): number => {
            seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
            return seed / 0x1_0000_0000;
        };
        const sourceRates = [23.976, 24, 25, 29.97, 30];
        const projectRates = [
            { numerator: 24, denominator: 1 },
            { numerator: 25, denominator: 1 },
            { numerator: 30_000, denominator: 1_001 },
            { numerator: 30, denominator: 1 },
        ];
        const body = createEditorialTranscriptBodyFixture({
            sampleCount: 160_000,
            words: [],
            speechRegions: [],
            editBoundaries: [],
        }) as ResolvedEditorialTranscriptRecordBodyV1;
        let accepted = 0;
        for (let trial = 0; trial < 300; trial += 1) {
            const sourceFps = sourceRates[Math.floor(random() * sourceRates.length)];
            const projectFps = projectRates[Math.floor(random() * projectRates.length)];
            const endFrame = 40 + Math.floor(random() * 120);
            const coreEndSample = Math.min(160_000, Math.floor(endFrame / sourceFps * 16_000));
            const splitSample = 1 + Math.floor(random() * (coreEndSample - 2));
            const block = createNarrativeSilenceBlockFixture({
                id: `block_${trial}`,
                clipId: `clip_${trial}`,
                instanceId: `instance_${trial}`,
                lineageRootId: `lineage_${trial}`,
                sourceIntervalId: `interval_${trial}`,
                coreStartSample: 0,
                coreEndSample,
                materialization: {
                    sourceStartFrame: 0,
                    sourceEndFrame: endFrame,
                    preBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
                    postBoundary: { kind: 'margin', mode: 'explicit', requestedSamples: 0 },
                },
                timelineStartFrame: 11,
            });
            const clip: VideoClipV4 = {
                id: block.clipId,
                sourceId: block.sourceId,
                trackId: block.trackId,
                timelineStartFrame: block.timelineStartFrame,
                sourceStart: 0,
                sourceEnd: endFrame / sourceFps,
                audio: null,
            };
            const result = splitNarrativeOccurrence({
                block,
                clip,
                body,
                source: { duration: 10, fps: sourceFps },
                projectFps,
                splitSample,
                revision: 2,
                ids: {
                    seamId: `seam_${trial}`,
                    leftInstanceId: `left_instance_${trial}`,
                    rightInstanceId: `right_instance_${trial}`,
                    leftSourceIntervalId: `left_interval_${trial}`,
                    rightSourceIntervalId: `right_interval_${trial}`,
                    rightBlockId: `right_block_${trial}`,
                    rightClipId: `right_clip_${trial}`,
                },
            });
            if (result.kind === 'error') {
                expect(['minimum-duration', 'source-bounds']).toContain(result.code);
                continue;
            }
            accepted += 1;
            const oldDuration = sourceFrameSpanToProjectFrames(0, endFrame, sourceFps, projectFps);
            const leftDuration = sourceFrameSpanToProjectFrames(
                result.value.leftBlock.materialization.sourceStartFrame,
                result.value.leftBlock.materialization.sourceEndFrame,
                sourceFps,
                projectFps,
            );
            const rightDuration = sourceFrameSpanToProjectFrames(
                result.value.rightBlock.materialization.sourceStartFrame,
                result.value.rightBlock.materialization.sourceEndFrame,
                sourceFps,
                projectFps,
            );
            expect(leftDuration + rightDuration).toBe(oldDuration);
            expect(result.value.leftBlock.materialization.sourceStartFrame).toBe(0);
            expect(result.value.leftBlock.materialization.sourceEndFrame)
                .toBe(result.value.rightBlock.materialization.sourceStartFrame);
            expect(result.value.rightBlock.materialization.sourceEndFrame).toBe(endFrame);
            expect(result.value.leftBlock.timelineStartFrame + leftDuration)
                .toBe(result.value.rightBlock.timelineStartFrame);
        }
        expect(accepted).toBeGreaterThan(100);
    });
});
