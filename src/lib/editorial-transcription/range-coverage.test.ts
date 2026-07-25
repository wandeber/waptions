import { describe, expect, it } from 'vitest';
import type { HalfOpenSampleRange, Sha256Digest } from '@/types/editorial';
import {
    coverageFromCompatibleRecords,
    createRangeTranscriptionRequestKey,
    createTranscriptionCoverageRecordV2,
    normalizeSampleRanges,
    planIncrementalTranscriptionCoverage,
    subtractSampleRanges,
    verifyTranscriptionCoverageRecordV2,
} from './range-coverage';

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}`;

const profile = (coreCoverage: HalfOpenSampleRange[]) => ({
    sourceFingerprint: 'source-fingerprint',
    sourceSampleRate: 16_000,
    sourceSampleCount: 160_000,
    coreCoverage,
    contextSamples: 32_000,
    language: 'es',
    speakerMode: 'diarized' as const,
    endpointIdentityDigest: digest('a'),
    requestedModel: 'qwen-1.7b-edit-max',
    responseSchema: 'edit-max-v1',
    pcmAlgorithmVersion: 1,
    providerProfileVersion: 1,
});

describe('range transcription coverage', () => {
    it('normalizes unordered overlaps and adjacency into a sorted disjoint union', () => {
        expect(normalizeSampleRanges([
            { startSample: 40, endSample: 50 },
            { startSample: 10, endSample: 20 },
            { startSample: 18, endSample: 30 },
            { startSample: 30, endSample: 40 },
        ], 100)).toEqual([{ startSample: 10, endSample: 50 }]);
    });

    it('subtracts only compatible covered intervals and keeps half-open gap boundaries exact', () => {
        expect(subtractSampleRanges(
            [{ startSample: 10, endSample: 90 }],
            [
                { startSample: 0, endSample: 20 },
                { startSample: 30, endSample: 40 },
                { startSample: 60, endSample: 100 },
            ],
            100,
        )).toEqual([
            { startSample: 20, endSample: 30 },
            { startSample: 40, endSample: 60 },
        ]);
    });

    it('plans only uncovered core and clamps two-second context to source bounds', async () => {
        const plan = await planIncrementalTranscriptionCoverage({
            profile: profile([
                { startSample: 1_000, endSample: 20_000 },
                { startSample: 100_000, endSample: 140_000 },
            ]),
            compatibleCoverage: [{ startSample: 0, endSample: 10_000 }],
        });

        expect(plan.missingCoreCoverage).toEqual([
            { startSample: 10_000, endSample: 20_000 },
            { startSample: 100_000, endSample: 140_000 },
        ]);
        expect(plan.acquisitionWindows.map(window => ({
            core: window.core,
            decoded: window.decoded,
        }))).toEqual([
            {
                core: { startSample: 10_000, endSample: 20_000 },
                decoded: { startSample: 0, endSample: 52_000 },
            },
            {
                core: { startSample: 100_000, endSample: 140_000 },
                decoded: { startSample: 68_000, endSample: 160_000 },
            },
        ]);
    });

    it('splits long cores into bounded windows without granting ownership to context gaps', async () => {
        const planned = await planIncrementalTranscriptionCoverage({
            profile: {
                ...profile([
                    { startSample: 0, endSample: 600_000 },
                    { startSample: 610_000, endSample: 620_000 },
                ]),
                sourceSampleCount: 700_000,
            },
        });
        expect(planned.acquisitionWindows.every(window => (
            window.decoded.endSample - window.decoded.startSample <= 30 * 16_000
        ))).toBe(true);
        expect(planned.acquisitionWindows.some(window => (
            window.core.startSample < 600_000 && window.core.endSample > 610_000
        ))).toBe(false);
    });

    it('treats compatible V1 as full-source coverage without rewriting it', () => {
        expect(coverageFromCompatibleRecords({
            sourceSampleCount: 50,
            hasCompatibleV1FullSource: true,
            compatibleV2Records: [],
        })).toEqual([{ startSample: 0, endSample: 50 }]);
    });

    it('makes exact core/context/profile fields part of request identity', async () => {
        const baseline = profile([{ startSample: 1, endSample: 20 }]);
        const identities = await Promise.all([
            createRangeTranscriptionRequestKey(baseline),
            createRangeTranscriptionRequestKey({
                ...baseline,
                coreCoverage: [{ startSample: 1, endSample: 21 }],
            }),
            createRangeTranscriptionRequestKey({ ...baseline, contextSamples: 1 }),
            createRangeTranscriptionRequestKey({ ...baseline, language: 'en' }),
            createRangeTranscriptionRequestKey({ ...baseline, speakerMode: 'none' }),
        ]);

        expect(new Set(identities).size).toBe(identities.length);
    });

    it('content-addresses canonical coverage and rejects tampering', async () => {
        const plan = await planIncrementalTranscriptionCoverage({
            profile: profile([{ startSample: 5, endSample: 30 }]),
        });
        const acquisitionProfile = profile([{ startSample: 5, endSample: 30 }]);
        const coverage = await createTranscriptionCoverageRecordV2({
            sourceFingerprint: 'source-fingerprint',
            sourceSampleRate: 16_000,
            sourceSampleCount: 160_000,
            acquisitionProfileDigest: plan.acquisitionProfileDigest,
            endpointIdentityDigest: acquisitionProfile.endpointIdentityDigest,
            contextSamples: acquisitionProfile.contextSamples,
            requestedModel: acquisitionProfile.requestedModel,
            responseSchema: acquisitionProfile.responseSchema,
            pcmAlgorithmVersion: acquisitionProfile.pcmAlgorithmVersion,
            providerProfileVersion: acquisitionProfile.providerProfileVersion,
            language: 'es',
            speakerMode: 'diarized',
            coreCoverage: plan.normalizedCoreCoverage,
            acquisitionWindows: plan.acquisitionWindows.map(window => ({
                ...window,
                chunkRecordIds: [digest('b')],
            })),
            mergedTranscriptRecordId: digest('c'),
        });

        await expect(verifyTranscriptionCoverageRecordV2(coverage)).resolves.toBeUndefined();
        await expect(createTranscriptionCoverageRecordV2({
            sourceFingerprint: coverage.sourceFingerprint,
            sourceSampleRate: coverage.sourceSampleRate,
            sourceSampleCount: coverage.sourceSampleCount,
            acquisitionProfileDigest: coverage.acquisitionProfileDigest,
            endpointIdentityDigest: coverage.endpointIdentityDigest,
            contextSamples: coverage.contextSamples,
            requestedModel: coverage.requestedModel,
            responseSchema: coverage.responseSchema,
            pcmAlgorithmVersion: coverage.pcmAlgorithmVersion,
            providerProfileVersion: coverage.providerProfileVersion,
            language: coverage.language,
            speakerMode: coverage.speakerMode,
            coreCoverage: coverage.coreCoverage,
            acquisitionWindows: coverage.acquisitionWindows,
            mergedTranscriptRecordId: coverage.mergedTranscriptRecordId,
        })).resolves.toEqual(coverage);
        await expect(verifyTranscriptionCoverageRecordV2({
            ...coverage,
            coreCoverage: [{ startSample: 6, endSample: 30 }],
        })).rejects.toThrow('hash');
    });

    it('preserves normalization/subtraction invariants across deterministic adversarial inputs', () => {
        let state = 0x6d2b79f5;
        const random = () => {
            state = Math.imul(state ^ state >>> 15, 1 | state);
            state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
            return ((state ^ state >>> 14) >>> 0) / 4_294_967_296;
        };
        for (let iteration = 0; iteration < 250; iteration += 1) {
            const requested = Array.from({ length: 20 }, () => {
                const startSample = Math.floor(random() * 99);
                return {
                    startSample,
                    endSample: startSample + 1 + Math.floor(random() * (100 - startSample)),
                };
            });
            const covered = Array.from({ length: 20 }, () => {
                const startSample = Math.floor(random() * 99);
                return {
                    startSample,
                    endSample: startSample + 1 + Math.floor(random() * (100 - startSample)),
                };
            });
            const normalized = normalizeSampleRanges(requested, 100);
            const missing = subtractSampleRanges(requested, covered, 100);
            normalized.forEach((range, index) => {
                if (index > 0) expect(normalized[index - 1].endSample).toBeLessThan(range.startSample);
            });
            missing.forEach((range) => {
                expect(range.startSample).toBeLessThan(range.endSample);
                expect(covered.some(item => (
                    item.startSample < range.endSample && item.endSample > range.startSample
                ))).toBe(false);
            });
        }
    });

    it('rejects invalid and over-ten-second contexts before acquisition', async () => {
        await expect(planIncrementalTranscriptionCoverage({
            profile: { ...profile([{ startSample: 0, endSample: 1 }]), contextSamples: 160_001 },
        })).rejects.toThrow('ten-second');
        expect(() => normalizeSampleRanges([
            { startSample: -1, endSample: 1 },
        ], 10)).toThrow('half-open');
    });
});
