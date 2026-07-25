import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from '../../../src/lib/editorial-transcription/canonical-json';
import {
    createTranscriptionCoverageRecordV2,
} from '../../../src/lib/editorial-transcription/range-coverage';
import type {
    Sha256Digest,
    TranscriptionCoverageRecordV2,
} from '../../../src/types/editorial';
import type {
    ManagedChunkRecordV1,
    ManagedCoverageHeadReaderPort,
} from './contracts';
import { FilesystemManagedTranscriptionCas } from './filesystem-cas';

const roots: string[] = [];
const sourceFingerprint = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const profileDigest = `sha256:${'b'.repeat(64)}` as Sha256Digest;

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('filesystem managed transcription CAS', () => {
    it('externally merges overlap evidence and preserves diarized provenance', async () => {
        const { cas } = await createCas();
        const first = await chunk({
            windowId: `sha256:${'1'.repeat(64)}`,
            decoded: { startSample: 0, endSample: 100 },
            words: [{
                text: 'hola',
                startSample: 40,
                endSample: 60,
                probability: 0.8,
                speaker: {
                    providerSpeakerId: 'A',
                    evidenceKey: 'window-a:A',
                },
            }, {
                text: 'fin',
                startSample: 80,
                endSample: 90,
                probability: 0.9,
                speaker: {
                    providerSpeakerId: 'A',
                    evidenceKey: 'window-a:A',
                },
            }],
        });
        const second = await chunk({
            windowId: `sha256:${'2'.repeat(64)}`,
            decoded: { startSample: 50, endSample: 150 },
            words: [{
                text: 'hola',
                startSample: 50,
                endSample: 61,
                probability: 0.99,
                speaker: {
                    providerSpeakerId: 'B',
                    evidenceKey: 'window-b:B',
                },
            }, {
                text: 'luego',
                startSample: 100,
                endSample: 110,
                probability: 0.9,
                speaker: {
                    providerSpeakerId: 'B',
                    evidenceKey: 'window-b:B',
                },
            }],
        });
        await cas.stageChunk(first, new AbortController().signal);
        await cas.stageChunk(second, new AbortController().signal);

        const manifest = await cas.stageMergedTranscript({
            sourceFingerprint,
            acquisitionProfileDigest: profileDigest,
            sourceSampleCount: 150,
            language: 'es',
            speakerMode: 'diarized',
            canonicalModel: 'qwen3-asr-1.7b',
            coreCoverage: [{ startSample: 0, endSample: 150 }],
            chunks: [first, second].map(value => ({
                recordId: value.recordId,
                windowId: value.windowId,
                decoded: value.decoded,
            })),
            signal: new AbortController().signal,
        });
        const words = [];
        for await (const word of cas.iterateMergedWords(manifest.mergedWordsRecordId)) {
            words.push(word);
        }

        expect(words).toHaveLength(3);
        expect(words[0]).toMatchObject({
            text: 'hola',
            startSample: 40,
            endSample: 60,
            speaker: {
                providerSpeakerId: 'A',
                evidenceKey: 'window-a:A',
            },
        });
        expect(words.map(word => word.speaker?.evidenceKey))
            .toEqual(['window-a:A', 'window-a:A', 'window-a:A']);
        await expect(cas.verifyRecord(first.recordId)).resolves.toBe(true);
        await expect(cas.verifyRecord(manifest.recordId)).resolves.toBe(true);
        await expect(cas.verifyRecord(manifest.mergedWordsRecordId)).resolves.toBe(true);
    });

    it('revalidates checkpoint/CAS digests and rejects a corrupted immutable chunk', async () => {
        const { cas, root } = await createCas();
        const value = await chunk({
            windowId: `sha256:${'3'.repeat(64)}`,
            decoded: { startSample: 0, endSample: 100 },
            words: [{
                text: 'safe',
                startSample: 10,
                endSample: 20,
                probability: null,
                speaker: null,
            }],
        });
        await cas.stageChunk(value, new AbortController().signal);
        await writeFile(
            join(root, 'chunks', `${value.recordId.slice(7)}.json`),
            '{"schemaVersion":1,"words":[{"text":"corrupt"}]}\n',
        );

        await expect(cas.verifyRecord(value.recordId)).resolves.toBe(false);
        await expect(cas.getChunk(value.recordId)).rejects.toMatchObject({
            transcriptionCode: 'CAS_CORRUPT',
        });
        await cas.stageChunk(value, new AbortController().signal);
        await expect(cas.getChunk(value.recordId)).resolves.toEqual(value);
    });

    it('prepares an ID-only exact coverage CAS and reports conflicts without writes', async () => {
        const state: { records: TranscriptionCoverageRecordV2[] } = { records: [] };
        const { cas } = await createCas({
            readCoverageFamily: async () => state.records,
        });
        const value = await chunk({
            windowId: `sha256:${'4'.repeat(64)}`,
            decoded: { startSample: 0, endSample: 100 },
            words: [{
                text: 'safe',
                startSample: 10,
                endSample: 20,
                probability: null,
                speaker: null,
            }],
        });
        await cas.stageChunk(value, new AbortController().signal);
        const manifest = await cas.stageMergedTranscript({
            sourceFingerprint,
            acquisitionProfileDigest: profileDigest,
            sourceSampleCount: 100,
            language: 'es',
            speakerMode: 'none',
            canonicalModel: 'qwen3-asr-1.7b',
            coreCoverage: [{ startSample: 0, endSample: 100 }],
            chunks: [{
                recordId: value.recordId,
                windowId: value.windowId,
                decoded: value.decoded,
            }],
            signal: new AbortController().signal,
        });
        const coverage = await coverageRecord(value, manifest.recordId);
        const update = await cas.prepareCoverageUpdate({
            projectId: 'project-1',
            sourceFingerprint,
            acquisitionProfileDigest: profileDigest,
            expectedCoverageRecordIds: [],
            record: coverage,
            pinRecordIds: [
                value.recordId,
                manifest.recordId,
                manifest.mergedWordsRecordId,
            ],
            signal: new AbortController().signal,
        });

        expect(update).not.toBeNull();
        const durable = JSON.stringify(update?.durableWrites());
        expect(durable).not.toContain('safe');
        expect(durable).not.toContain('http://');
        state.records = [coverage];
        await expect(cas.prepareCoverageUpdate({
            projectId: 'project-1',
            sourceFingerprint,
            acquisitionProfileDigest: profileDigest,
            expectedCoverageRecordIds: [],
            record: coverage,
            pinRecordIds: [value.recordId],
            signal: new AbortController().signal,
        })).resolves.toBeNull();
    });

    it('rejects recovered chunks whose provenance or speakers contradict the merge', async () => {
        const { cas } = await createCas();
        const value = await chunk({
            windowId: `sha256:${'5'.repeat(64)}`,
            decoded: { startSample: 0, endSample: 100 },
            words: [{
                text: 'safe',
                startSample: 10,
                endSample: 20,
                probability: null,
                speaker: null,
            }],
        });
        await cas.stageChunk(value, new AbortController().signal);
        const base = {
            sourceFingerprint,
            acquisitionProfileDigest: profileDigest,
            sourceSampleCount: 100,
            language: 'es',
            canonicalModel: 'qwen3-asr-1.7b',
            coreCoverage: [{ startSample: 0, endSample: 100 }],
            chunks: [{
                recordId: value.recordId,
                windowId: value.windowId,
                decoded: value.decoded,
            }],
            signal: new AbortController().signal,
        };

        await expect(cas.stageMergedTranscript({
            ...base,
            acquisitionProfileDigest: `sha256:${'c'.repeat(64)}`,
            speakerMode: 'none',
        })).rejects.toMatchObject({ transcriptionCode: 'CAS_CORRUPT' });
        await expect(cas.stageMergedTranscript({
            ...base,
            speakerMode: 'diarized',
        })).rejects.toMatchObject({ transcriptionCode: 'CAS_CORRUPT' });
    });
});

async function createCas(
    coverageHeads: ManagedCoverageHeadReaderPort = {
        readCoverageFamily: async () => [],
    },
) {
    const root = await mkdtemp(join(tmpdir(), 'waptions-transcription-cas-'));
    roots.push(root);
    const cas = new FilesystemManagedTranscriptionCas({ root, coverageHeads });
    await cas.initialize();
    return { cas, root };
}

async function chunk(input: {
    windowId: Sha256Digest;
    decoded: { startSample: number; endSample: number };
    words: ManagedChunkRecordV1['words'];
}): Promise<ManagedChunkRecordV1> {
    const body = {
        schemaVersion: 1 as const,
        sourceFingerprint,
        acquisitionProfileDigest: profileDigest,
        windowId: input.windowId,
        decoded: input.decoded,
        canonicalModel: 'qwen3-asr-1.7b',
        words: input.words,
    };
    return { ...body, recordId: await sha256CanonicalJson(body) };
}

async function coverageRecord(
    value: ManagedChunkRecordV1,
    mergedTranscriptRecordId: Sha256Digest,
): Promise<TranscriptionCoverageRecordV2> {
    return createTranscriptionCoverageRecordV2({
        sourceFingerprint,
        sourceSampleRate: 16_000,
        sourceSampleCount: 100,
        acquisitionProfileDigest: profileDigest,
        endpointIdentityDigest: `sha256:${'c'.repeat(64)}`,
        contextSamples: 0,
        requestedModel: 'qwen-1.7b-edit-max',
        responseSchema: 'edit-max-v1',
        pcmAlgorithmVersion: 1,
        providerProfileVersion: 1,
        language: 'es',
        speakerMode: 'none',
        coreCoverage: [{ startSample: 0, endSample: 100 }],
        acquisitionWindows: [{
            windowId: value.windowId,
            core: { startSample: 0, endSample: 100 },
            decoded: { startSample: 0, endSample: 100 },
            chunkRecordIds: [value.recordId],
        }],
        mergedTranscriptRecordId,
    });
}
