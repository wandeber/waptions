import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    open,
    rename,
    rm,
    stat,
    type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
    atomicWriteFile,
    ensurePrivateDirectory,
    fsyncDirectory,
    readJsonFile,
} from '../../persistence/fs-durable';
import { canonicalizeJson, sha256CanonicalJson } from '../../../src/lib/editorial-transcription/canonical-json';
import {
    normalizeSampleRanges,
    verifyTranscriptionCoverageRecordV2,
} from '../../../src/lib/editorial-transcription/range-coverage';
import type {
    HalfOpenSampleRange,
    Sha256Digest,
    TranscriptionCoverageRecordV2,
} from '../../../src/types/editorial';
import type {
    ManagedChunkRecordV1,
    ManagedChunkWordV1,
    ManagedCoverageHeadReaderPort,
    ManagedMergedWordV1,
    ManagedTranscriptManifestV1,
    ManagedTranscriptionCasPort,
    PreparedManagedCoverageUpdate,
} from './contracts';
import {
    ManagedTranscriptionError,
    throwIfManagedTranscriptionAborted,
} from './errors';

const MAX_PRIVATE_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_MERGE_RUNS = 32;
const WINNER_RUN_BUFFER_BYTES = 512 * 1024;
const MAX_SPEAKER_EVIDENCE_KEYS = 8_192;
const MAX_ACTIVE_OVERLAP_GROUPS = 512;
const MAX_DUPLICATE_EVIDENCE_PER_GROUP = 512;
const MAX_WORD_TEXT_LENGTH = 4_096;
const MAX_SPEAKER_ID_LENGTH = 512;

interface MergeCandidate extends ManagedMergedWordV1 {
    readonly decoded: HalfOpenSampleRange;
    readonly chunkRecordId: Sha256Digest;
}

interface DisjointSet {
    find(value: string): string;
    union(left: string, right: string): void;
    size(): number;
}

export interface FilesystemManagedTranscriptionCasOptions {
    readonly root: string;
    readonly coverageHeads: ManagedCoverageHeadReaderPort;
}

/**
 * Private immutable CAS plus an external-memory range merger.
 *
 * Chunks are admitted one at a time. Candidate and winner runs live in a private 0700 spool and
 * are merged with at most 32 open readers; a full source transcript is never represented as an
 * in-memory word array.
 */
export class FilesystemManagedTranscriptionCas implements ManagedTranscriptionCasPort {
    private readonly chunksRoot: string;
    private readonly manifestsRoot: string;
    private readonly wordsRoot: string;
    private readonly spoolRoot: string;

    constructor(private readonly options: FilesystemManagedTranscriptionCasOptions) {
        this.chunksRoot = join(options.root, 'chunks');
        this.manifestsRoot = join(options.root, 'manifests');
        this.wordsRoot = join(options.root, 'merged-words');
        this.spoolRoot = join(options.root, 'spool');
    }

    async initialize(): Promise<void> {
        await Promise.all([
            ensurePrivateDirectory(this.chunksRoot),
            ensurePrivateDirectory(this.manifestsRoot),
            ensurePrivateDirectory(this.wordsRoot),
            ensurePrivateDirectory(this.spoolRoot),
        ]);
    }

    async listCompatibleCoverage(input: {
        readonly projectId: string;
        readonly sourceFingerprint: Sha256Digest;
        readonly acquisitionProfileDigest: Sha256Digest;
    }): Promise<{ readonly records: readonly TranscriptionCoverageRecordV2[] }> {
        const records = await this.options.coverageHeads.readCoverageFamily(input);
        const verified: TranscriptionCoverageRecordV2[] = [];
        for (const record of records) {
            await verifyTranscriptionCoverageRecordV2(record);
            if (
                record.sourceFingerprint !== input.sourceFingerprint
                || record.acquisitionProfileDigest !== input.acquisitionProfileDigest
            ) {
                throw new ManagedTranscriptionError(
                    'CAS_CORRUPT',
                    false,
                    'The managed coverage family contains contradictory provenance.',
                );
            }
            verified.push(structuredClone(record));
        }
        verified.sort((left, right) => left.recordId.localeCompare(right.recordId));
        return { records: verified };
    }

    async getChunk(recordId: Sha256Digest): Promise<ManagedChunkRecordV1 | null> {
        assertDigest(recordId);
        const value = await readJsonFile<unknown>(
            this.chunkPath(recordId),
            MAX_PRIVATE_RECORD_BYTES,
        );
        if (value === null) return null;
        await verifyChunk(value, recordId);
        return structuredClone(value as ManagedChunkRecordV1);
    }

    async stageChunk(record: ManagedChunkRecordV1, signal: AbortSignal): Promise<void> {
        throwIfManagedTranscriptionAborted(signal);
        await verifyChunk(record, record.recordId);
        const bytes = `${canonicalizeJson(record)}\n`;
        if (Buffer.byteLength(bytes) > MAX_PRIVATE_RECORD_BYTES) {
            throw new ManagedTranscriptionError(
                'MEMORY_LIMIT_EXCEEDED',
                false,
                'The managed transcript chunk exceeds its private CAS bound.',
            );
        }
        await putImmutableFile(this.chunkPath(record.recordId), bytes);
        throwIfManagedTranscriptionAborted(signal);
    }

    async stageMergedTranscript(input: {
        readonly sourceFingerprint: Sha256Digest;
        readonly acquisitionProfileDigest: Sha256Digest;
        readonly sourceSampleCount: number;
        readonly language: string | null;
        readonly speakerMode: import('../../../src/types/editorial').EditorialSpeakerMode;
        readonly canonicalModel: string;
        readonly coreCoverage: readonly HalfOpenSampleRange[];
        readonly chunks: readonly {
            readonly recordId: Sha256Digest;
            readonly windowId: Sha256Digest;
            readonly decoded: HalfOpenSampleRange;
        }[];
        readonly signal: AbortSignal;
    }): Promise<ManagedTranscriptManifestV1> {
        validateMergeInput(input);
        const operationRoot = join(this.spoolRoot, randomUUID());
        await ensurePrivateDirectory(operationRoot);
        try {
            const candidateRuns: string[] = [];
            for (let chunkIndex = 0; chunkIndex < input.chunks.length; chunkIndex += 1) {
                throwIfManagedTranscriptionAborted(input.signal);
                const descriptor = input.chunks[chunkIndex];
                const chunk = await this.getChunk(descriptor.recordId);
                if (
                    !chunk
                    || chunk.windowId !== descriptor.windowId
                    || !equalRange(chunk.decoded, descriptor.decoded)
                    || chunk.sourceFingerprint !== input.sourceFingerprint
                    || chunk.acquisitionProfileDigest !== input.acquisitionProfileDigest
                    || chunk.canonicalModel !== input.canonicalModel
                ) {
                    throw new ManagedTranscriptionError(
                        'CAS_CORRUPT',
                        true,
                        'A managed transcript chunk is missing or inconsistent.',
                    );
                }
                const hasSpeaker = chunk.words.some(word => word.speaker !== null);
                const hasMissingSpeaker = chunk.words.some(word => word.speaker === null);
                if (
                    (input.speakerMode === 'none' && hasSpeaker)
                    || (input.speakerMode === 'diarized' && hasMissingSpeaker)
                ) {
                    throw new ManagedTranscriptionError(
                        'CAS_CORRUPT',
                        false,
                        'A managed transcript chunk contradicts the requested speaker mode.',
                    );
                }
                const runPath = join(operationRoot, `candidate-${chunkIndex}.ndjson`);
                await writeCandidateRun(runPath, chunk);
                candidateRuns.push(runPath);
            }
            const sortedCandidates = await collapseSortedRuns(
                candidateRuns,
                operationRoot,
                'candidate-merge',
                input.signal,
            );
            const winnerRuns = await selectDuplicateWinners(
                sortedCandidates,
                operationRoot,
                input.coreCoverage,
                input.signal,
            );
            const sortedWinners = await collapseSortedRuns(
                winnerRuns.paths,
                operationRoot,
                'winner-merge',
                input.signal,
            );
            const mergedWordsRecordId = await writeAliasedMergedWords({
                sortedWinners,
                outputRoot: this.wordsRoot,
                speakers: winnerRuns.speakers,
                signal: input.signal,
            });
            const body = {
                schemaVersion: 1 as const,
                sourceFingerprint: input.sourceFingerprint,
                sourceSampleCount: input.sourceSampleCount,
                language: input.language,
                speakerMode: input.speakerMode,
                canonicalModel: input.canonicalModel,
                coreCoverage: input.coreCoverage.map(range => ({ ...range })),
                chunkRecordIds: input.chunks.map(chunk => chunk.recordId),
                mergedWordsRecordId,
            };
            const recordId = await sha256CanonicalJson(body);
            const manifest: ManagedTranscriptManifestV1 = { ...body, recordId };
            const bytes = `${canonicalizeJson(manifest)}\n`;
            if (Buffer.byteLength(bytes) > MAX_PRIVATE_RECORD_BYTES) {
                throw new ManagedTranscriptionError(
                    'MEMORY_LIMIT_EXCEEDED',
                    false,
                    'The managed transcript manifest exceeds its private CAS bound.',
                );
            }
            await putImmutableFile(this.manifestPath(recordId), bytes);
            return manifest;
        } finally {
            await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    async getManifest(recordId: Sha256Digest): Promise<ManagedTranscriptManifestV1 | null> {
        assertDigest(recordId);
        const value = await readJsonFile<unknown>(
            this.manifestPath(recordId),
            MAX_PRIVATE_RECORD_BYTES,
        );
        if (value === null) return null;
        await verifyManifest(value, recordId);
        return structuredClone(value as ManagedTranscriptManifestV1);
    }

    async *iterateMergedWords(
        mergedWordsRecordId: Sha256Digest,
        signal?: AbortSignal,
    ): AsyncIterable<ManagedMergedWordV1> {
        assertDigest(mergedWordsRecordId);
        const path = this.wordsPath(mergedWordsRecordId);
        if (!await verifyFileDigest(path, mergedWordsRecordId, signal)) {
            throw new ManagedTranscriptionError(
                'CAS_CORRUPT',
                true,
                'The managed merged transcript failed digest verification.',
            );
        }
        let previous: ManagedMergedWordV1 | null = null;
        for await (const value of readNdjson<unknown>(path, signal)) {
            const word = validateMergedWord(value);
            if (previous && compareWords(previous, word) > 0) {
                throw new ManagedTranscriptionError(
                    'CAS_CORRUPT',
                    false,
                    'The managed merged transcript is not monotonic.',
                );
            }
            previous = word;
            yield word;
        }
    }

    async verifyRecord(recordId: Sha256Digest, signal?: AbortSignal): Promise<boolean> {
        assertDigest(recordId);
        throwIfManagedTranscriptionAborted(signal);
        if (await exists(this.chunkPath(recordId))) {
            return this.getChunk(recordId).then(value => value !== null, () => false);
        }
        if (await exists(this.manifestPath(recordId))) {
            return this.getManifest(recordId).then(value => value !== null, () => false);
        }
        if (await exists(this.wordsPath(recordId))) {
            return verifyFileDigest(this.wordsPath(recordId), recordId, signal);
        }
        return false;
    }

    async prepareCoverageUpdate(input: {
        readonly projectId: string;
        readonly sourceFingerprint: Sha256Digest;
        readonly acquisitionProfileDigest: Sha256Digest;
        readonly expectedCoverageRecordIds: readonly Sha256Digest[];
        readonly record: TranscriptionCoverageRecordV2;
        readonly pinRecordIds: readonly Sha256Digest[];
        readonly signal: AbortSignal;
    }): Promise<PreparedManagedCoverageUpdate | null> {
        throwIfManagedTranscriptionAborted(input.signal);
        await verifyTranscriptionCoverageRecordV2(input.record);
        const current = await this.listCompatibleCoverage(input);
        const currentIds = current.records.map(record => record.recordId).sort();
        const expectedIds = normalizeDigests(input.expectedCoverageRecordIds);
        if (!equalStrings(currentIds, expectedIds)) return null;
        const pins = normalizeDigests(input.pinRecordIds);
        for (const recordId of pins) {
            if (!await this.verifyRecord(recordId, input.signal)) {
                throw new ManagedTranscriptionError(
                    'CAS_CORRUPT',
                    true,
                    'A managed transcription pin target is missing or corrupt.',
                );
            }
        }
        const familyId = createHash('sha256')
            .update(`${input.sourceFingerprint}\0${input.acquisitionProfileDigest}`)
            .digest('hex');
        const capabilityId = `transcription-coverage:${randomUUID()}`;
        return {
            capabilityId,
            projectId: input.projectId,
            kind: 'coverage',
            sourceFingerprint: input.sourceFingerprint,
            acquisitionProfileDigest: input.acquisitionProfileDigest,
            expectedCoverageRecordIds: expectedIds,
            coverageRecordId: input.record.recordId,
            pinRecordIds: pins,
            durableWrites: () => [
                {
                    relativePath: `transcription/coverage/${input.record.recordId.slice(7)}.json`,
                    value: input.record,
                    mode: 0o600,
                },
                {
                    relativePath: `transcription/coverage-heads/${familyId}.json`,
                    value: {
                        schemaVersion: 1,
                        sourceFingerprint: input.sourceFingerprint,
                        acquisitionProfileDigest: input.acquisitionProfileDigest,
                        expectedCoverageRecordIds: expectedIds,
                        coverageRecordIds: [input.record.recordId],
                    },
                    mode: 0o600,
                },
                {
                    relativePath: `transcription/pins/${capabilityId.slice(
                        'transcription-coverage:'.length,
                    )}.json`,
                    value: {
                        schemaVersion: 1,
                        recordIds: pins,
                    },
                    mode: 0o600,
                },
            ],
            accept: () => undefined,
            reject: () => undefined,
        };
    }

    private chunkPath(recordId: Sha256Digest): string {
        return join(this.chunksRoot, `${recordId.slice(7)}.json`);
    }

    private manifestPath(recordId: Sha256Digest): string {
        return join(this.manifestsRoot, `${recordId.slice(7)}.json`);
    }

    private wordsPath(recordId: Sha256Digest): string {
        return join(this.wordsRoot, `${recordId.slice(7)}.ndjson`);
    }
}

async function writeCandidateRun(path: string, chunk: ManagedChunkRecordV1): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    try {
        for (let tokenIndex = 0; tokenIndex < chunk.words.length; tokenIndex += 1) {
            const word = chunk.words[tokenIndex];
            const candidate: MergeCandidate = {
                ...word,
                windowId: chunk.windowId,
                tokenIndex,
                decoded: { ...chunk.decoded },
                chunkRecordId: chunk.recordId,
            };
            await handle.writeFile(`${canonicalizeJson(candidate)}\n`);
        }
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function collapseSortedRuns(
    initialPaths: readonly string[],
    root: string,
    prefix: string,
    signal: AbortSignal,
): Promise<string> {
    if (initialPaths.length === 0) {
        const empty = join(root, `${prefix}-empty.ndjson`);
        await atomicWriteFile(empty, '', { mode: 0o600 });
        return empty;
    }
    let paths = [...initialPaths];
    let pass = 0;
    while (paths.length > 1) {
        const next: string[] = [];
        for (let index = 0; index < paths.length; index += MAX_MERGE_RUNS) {
            throwIfManagedTranscriptionAborted(signal);
            const batch = paths.slice(index, index + MAX_MERGE_RUNS);
            const output = join(root, `${prefix}-${pass}-${next.length}.ndjson`);
            await mergeSortedRuns(batch, output, signal);
            next.push(output);
        }
        paths = next;
        pass += 1;
    }
    return paths[0];
}

async function mergeSortedRuns(
    paths: readonly string[],
    output: string,
    signal: AbortSignal,
): Promise<void> {
    const iterators = paths.map(path => readNdjson<MergeCandidate>(path, signal)[Symbol.asyncIterator]());
    const current = await Promise.all(iterators.map(iterator => iterator.next()));
    const handle = await open(output, 'wx', 0o600);
    try {
        while (true) {
            throwIfManagedTranscriptionAborted(signal);
            let selected = -1;
            for (let index = 0; index < current.length; index += 1) {
                if (current[index].done) continue;
                if (
                    selected === -1
                    || compareWords(
                        current[index].value,
                        current[selected].value,
                    ) < 0
                ) {
                    selected = index;
                }
            }
            if (selected === -1) break;
            await handle.writeFile(`${canonicalizeJson(current[selected].value)}\n`);
            current[selected] = await iterators[selected].next();
        }
        await handle.sync();
    } finally {
        await handle.close();
        await Promise.all(iterators.map(iterator => iterator.return?.()));
    }
}

async function selectDuplicateWinners(
    sortedCandidates: string,
    root: string,
    coreCoverage: readonly HalfOpenSampleRange[],
    signal: AbortSignal,
): Promise<{ paths: string[]; speakers: DisjointSet }> {
    const speakers = createDisjointSet();
    const active: MergeCandidate[][] = [];
    const buffered: MergeCandidate[] = [];
    let bufferedBytes = 0;
    const paths: string[] = [];
    const flushBuffer = async () => {
        if (buffered.length === 0) return;
        buffered.sort(compareWords);
        const path = join(root, `winner-${paths.length}.ndjson`);
        const handle = await open(path, 'wx', 0o600);
        try {
            for (const word of buffered) {
                await handle.writeFile(`${canonicalizeJson(word)}\n`);
            }
            await handle.sync();
        } finally {
            await handle.close();
        }
        paths.push(path);
        buffered.length = 0;
        bufferedBytes = 0;
    };
    const finalizeGroup = async (group: MergeCandidate[]) => {
        reconcileSpeakerGroup(group, speakers);
        const winner = [...group].sort(compareDuplicateEvidence)[0];
        if (!ownsWord(coreCoverage, winner)) return;
        buffered.push(winner);
        bufferedBytes += Buffer.byteLength(canonicalizeJson(winner)) + 1;
        if (bufferedBytes >= WINNER_RUN_BUFFER_BYTES) await flushBuffer();
    };

    for await (const raw of readNdjson<unknown>(sortedCandidates, signal)) {
        const candidate = validateCandidate(raw);
        for (let index = active.length - 1; index >= 0; index -= 1) {
            if (active[index][0].endSample < candidate.startSample - 1) {
                const [closed] = active.splice(index, 1);
                await finalizeGroup(closed);
            }
        }
        const duplicate = findDuplicateGroup(active, candidate);
        if (duplicate) {
            if (duplicate.length >= MAX_DUPLICATE_EVIDENCE_PER_GROUP) {
                throw new ManagedTranscriptionError(
                    'MEMORY_LIMIT_EXCEEDED',
                    false,
                    'Managed overlap evidence exceeds its bound.',
                );
            }
            duplicate.push(candidate);
        } else {
            if (active.length >= MAX_ACTIVE_OVERLAP_GROUPS) {
                throw new ManagedTranscriptionError(
                    'MEMORY_LIMIT_EXCEEDED',
                    false,
                    'Managed overlap groups exceed their bound.',
                );
            }
            active.push([candidate]);
        }
    }
    for (const group of active) await finalizeGroup(group);
    await flushBuffer();
    if (speakers.size() > MAX_SPEAKER_EVIDENCE_KEYS) {
        throw new ManagedTranscriptionError(
            'MEMORY_LIMIT_EXCEEDED',
            false,
            'The managed diarization evidence catalog exceeds its bound.',
        );
    }
    return { paths, speakers };
}

async function writeAliasedMergedWords(input: {
    readonly sortedWinners: string;
    readonly outputRoot: string;
    readonly speakers: DisjointSet;
    readonly signal: AbortSignal;
}): Promise<Sha256Digest> {
    const temporary = join(input.outputRoot, `.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
        handle = await open(temporary, 'wx', 0o600);
        const hash = createHash('sha256');
        for await (const raw of readNdjson<unknown>(input.sortedWinners, input.signal)) {
            const candidate = validateCandidate(raw);
            const word: ManagedMergedWordV1 = {
                text: candidate.text,
                startSample: candidate.startSample,
                endSample: candidate.endSample,
                probability: candidate.probability,
                speaker: candidate.speaker ? {
                    providerSpeakerId: candidate.speaker.providerSpeakerId,
                    evidenceKey: input.speakers.find(candidate.speaker.evidenceKey),
                } : null,
                windowId: candidate.windowId,
                tokenIndex: candidate.tokenIndex,
            };
            const line = `${canonicalizeJson(word)}\n`;
            hash.update(line);
            await handle.writeFile(line);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        const recordId = `sha256:${hash.digest('hex')}` as Sha256Digest;
        const target = join(input.outputRoot, `${recordId.slice(7)}.ndjson`);
        // The synchronized temporary contains bytes matching the content-addressed target.
        // Rename atomically creates, refreshes or heals the final name without an ENOENT window.
        await rename(temporary, target);
        await fsyncDirectory(input.outputRoot);
        return recordId;
    } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

async function* readNdjson<T>(
    path: string,
    signal?: AbortSignal,
): AsyncIterable<T> {
    const stream = createReadStream(path, {
        encoding: 'utf8',
        highWaterMark: 64 * 1024,
        signal,
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            throwIfManagedTranscriptionAborted(signal);
            if (!line) continue;
            if (Buffer.byteLength(line) > MAX_PRIVATE_RECORD_BYTES) {
                throw new ManagedTranscriptionError(
                    'CAS_CORRUPT',
                    false,
                    'A managed transcript line exceeds its bound.',
                );
            }
            yield JSON.parse(line) as T;
        }
    } finally {
        lines.close();
        stream.destroy();
    }
}

async function putImmutableFile(path: string, bytes: string): Promise<void> {
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
        handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
            handle = undefined;
        }
        // Replacing a content-addressed name with its verified bytes is idempotent. Atomic rename
        // also repairs an older partial final-name write without first deleting the destination.
        await rename(temporary, path);
        await fsyncDirectory(dirname(path));
    } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

async function verifyChunk(value: unknown, recordId: Sha256Digest): Promise<void> {
    const record = value as Partial<ManagedChunkRecordV1>;
    if (
        !isPlainRecord(value)
        || !hasExactKeys(value, [
            'schemaVersion',
            'recordId',
            'sourceFingerprint',
            'acquisitionProfileDigest',
            'windowId',
            'decoded',
            'canonicalModel',
            'words',
        ])
        || record.schemaVersion !== 1
        || record.recordId !== recordId
        || !isDigest(record.sourceFingerprint)
        || !isDigest(record.acquisitionProfileDigest)
        || !isDigest(record.windowId)
        || !isRange(record.decoded)
        || typeof record.canonicalModel !== 'string'
        || !record.canonicalModel.trim()
        || !Array.isArray(record.words)
    ) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'The managed transcript chunk is invalid.',
        );
    }
    let previousEnd = record.decoded.startSample;
    for (const valueWord of record.words) {
        if (!isPlainRecord(valueWord) || !hasExactKeys(valueWord, [
            'text',
            'startSample',
            'endSample',
            'probability',
            'speaker',
        ])) {
            throw new ManagedTranscriptionError(
                'CAS_CORRUPT',
                false,
                'The managed transcript chunk word schema is invalid.',
            );
        }
        const word = validateChunkWord(valueWord);
        if (
            word.startSample < previousEnd
            || word.startSample < record.decoded.startSample
            || word.endSample > record.decoded.endSample
        ) {
            throw new ManagedTranscriptionError(
                'CAS_CORRUPT',
                false,
                'The managed transcript chunk timing is invalid.',
            );
        }
        previousEnd = word.endSample;
    }
    const { recordId: ignored, ...body } = record as ManagedChunkRecordV1;
    void ignored;
    if (await sha256CanonicalJson(body) !== recordId) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'The managed transcript chunk digest is invalid.',
        );
    }
}

async function verifyManifest(value: unknown, recordId: Sha256Digest): Promise<void> {
    const manifest = value as Partial<ManagedTranscriptManifestV1>;
    if (
        !isPlainRecord(value)
        || !hasExactKeys(value, [
            'schemaVersion',
            'recordId',
            'sourceFingerprint',
            'sourceSampleCount',
            'language',
            'speakerMode',
            'canonicalModel',
            'coreCoverage',
            'chunkRecordIds',
            'mergedWordsRecordId',
        ])
        || manifest.schemaVersion !== 1
        || manifest.recordId !== recordId
        || !isDigest(manifest.sourceFingerprint)
        || !Number.isSafeInteger(manifest.sourceSampleCount)
        || (manifest.sourceSampleCount as number) < 0
        || (manifest.language !== null && typeof manifest.language !== 'string')
        || (manifest.speakerMode !== 'none' && manifest.speakerMode !== 'diarized')
        || typeof manifest.canonicalModel !== 'string'
        || !manifest.canonicalModel.trim()
        || !Array.isArray(manifest.coreCoverage)
        || manifest.coreCoverage.some(range => !isRange(range))
        || !Array.isArray(manifest.chunkRecordIds)
        || manifest.chunkRecordIds.some(id => !isDigest(id))
        || new Set(manifest.chunkRecordIds).size !== manifest.chunkRecordIds.length
        || !isDigest(manifest.mergedWordsRecordId)
    ) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'The managed transcript manifest is invalid.',
        );
    }
    let normalizedCoverage: HalfOpenSampleRange[];
    try {
        normalizedCoverage = normalizeSampleRanges(
            manifest.coreCoverage as HalfOpenSampleRange[],
            manifest.sourceSampleCount as number,
        );
    } catch {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'The managed transcript manifest coverage is invalid.',
        );
    }
    if (!equalRanges(
        manifest.coreCoverage as HalfOpenSampleRange[],
        normalizedCoverage,
    )) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'The managed transcript manifest coverage is non-canonical.',
        );
    }
    const { recordId: ignored, ...body } = manifest as ManagedTranscriptManifestV1;
    void ignored;
    if (await sha256CanonicalJson(body) !== recordId) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'The managed transcript manifest digest is invalid.',
        );
    }
}

function validateCandidate(value: unknown): MergeCandidate {
    if (
        !isPlainRecord(value)
        || !hasExactKeys(value, [
            'text',
            'startSample',
            'endSample',
            'probability',
            'speaker',
            'windowId',
            'tokenIndex',
            'decoded',
            'chunkRecordId',
        ])
        || !isDigest(value.windowId)
        || !Number.isSafeInteger(value.tokenIndex)
        || (value.tokenIndex as number) < 0
        || !isRange(value.decoded)
        || !isDigest(value.chunkRecordId)
    ) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'A managed merge candidate is invalid.',
        );
    }
    const word = validateChunkWord(value);
    return {
        ...word,
        windowId: value.windowId,
        tokenIndex: value.tokenIndex as number,
        decoded: value.decoded,
        chunkRecordId: value.chunkRecordId,
    };
}

function validateMergedWord(value: unknown): ManagedMergedWordV1 {
    if (
        !isPlainRecord(value)
        || !hasExactKeys(value, [
            'text',
            'startSample',
            'endSample',
            'probability',
            'speaker',
            'windowId',
            'tokenIndex',
        ])
        || !isDigest(value.windowId)
        || !Number.isSafeInteger(value.tokenIndex)
        || (value.tokenIndex as number) < 0
    ) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'A managed merged word is invalid.',
        );
    }
    return {
        ...validateChunkWord(value),
        windowId: value.windowId,
        tokenIndex: value.tokenIndex as number,
    };
}

function validateChunkWord(value: unknown): ManagedChunkWordV1 {
    if (
        !isPlainRecord(value)
        || typeof value.text !== 'string'
        || !value.text.trim()
        || value.text.length > MAX_WORD_TEXT_LENGTH
        || !Number.isSafeInteger(value.startSample)
        || !Number.isSafeInteger(value.endSample)
        || (value.startSample as number) < 0
        || (value.endSample as number) <= (value.startSample as number)
        || (value.probability !== null
            && (typeof value.probability !== 'number'
                || !Number.isFinite(value.probability)
                || value.probability < 0
                || value.probability > 1))
        || (value.speaker !== null
            && (!isPlainRecord(value.speaker)
                || !hasExactKeys(value.speaker, [
                    'providerSpeakerId',
                    'evidenceKey',
                ])
                || typeof value.speaker.providerSpeakerId !== 'string'
                || !value.speaker.providerSpeakerId.trim()
                || value.speaker.providerSpeakerId.length > MAX_SPEAKER_ID_LENGTH
                || typeof value.speaker.evidenceKey !== 'string'
                || !value.speaker.evidenceKey.trim()
                || value.speaker.evidenceKey.length > MAX_SPEAKER_ID_LENGTH))
    ) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'A managed transcript word is invalid.',
        );
    }
    return {
        text: value.text.trim(),
        startSample: value.startSample as number,
        endSample: value.endSample as number,
        probability: value.probability as number | null,
        speaker: value.speaker === null ? null : {
            providerSpeakerId: value.speaker.providerSpeakerId as string,
            evidenceKey: value.speaker.evidenceKey as string,
        },
    };
}

function findDuplicateGroup(
    groups: readonly MergeCandidate[][],
    candidate: MergeCandidate,
): MergeCandidate[] | undefined {
    const normalized = normalizeToken(candidate.text);
    for (let index = groups.length - 1; index >= 0; index -= 1) {
        const representative = groups[index][0];
        if (normalizeToken(representative.text) !== normalized) continue;
        const overlap = Math.min(representative.endSample, candidate.endSample)
            - Math.max(representative.startSample, candidate.startSample);
        const shorter = Math.min(
            representative.endSample - representative.startSample,
            candidate.endSample - candidate.startSample,
        );
        const boundaryDistance = Math.max(
            Math.abs(representative.startSample - candidate.startSample),
            Math.abs(representative.endSample - candidate.endSample),
        );
        if ((overlap > 0 && overlap * 2 >= shorter) || boundaryDistance <= 1) {
            return groups[index];
        }
    }
    return undefined;
}

function reconcileSpeakerGroup(group: readonly MergeCandidate[], speakers: DisjointSet): void {
    const evidence = group.flatMap(word => word.speaker ? [word.speaker.evidenceKey] : []);
    if (evidence.length !== 0 && evidence.length !== group.length) {
        throw new ManagedTranscriptionError(
            'CAS_CORRUPT',
            false,
            'Managed overlap has incomplete speaker evidence.',
        );
    }
    for (let index = 1; index < evidence.length; index += 1) {
        speakers.union(evidence[0], evidence[index]);
    }
    if (evidence.length === 1) speakers.find(evidence[0]);
}

function compareDuplicateEvidence(left: MergeCandidate, right: MergeCandidate): number {
    const leftDistance = Math.min(
        left.startSample - left.decoded.startSample,
        left.decoded.endSample - left.endSample,
    );
    const rightDistance = Math.min(
        right.startSample - right.decoded.startSample,
        right.decoded.endSample - right.endSample,
    );
    return rightDistance - leftDistance
        || (right.probability ?? -1) - (left.probability ?? -1)
        || left.windowId.localeCompare(right.windowId)
        || left.tokenIndex - right.tokenIndex;
}

function compareWords(
    left: Pick<ManagedMergedWordV1, 'startSample' | 'endSample' | 'windowId' | 'tokenIndex'>,
    right: Pick<ManagedMergedWordV1, 'startSample' | 'endSample' | 'windowId' | 'tokenIndex'>,
): number {
    return left.startSample - right.startSample
        || left.endSample - right.endSample
        || left.windowId.localeCompare(right.windowId)
        || left.tokenIndex - right.tokenIndex;
}

function ownsWord(ranges: readonly HalfOpenSampleRange[], word: ManagedChunkWordV1): boolean {
    const midpoint = word.startSample + (word.endSample - word.startSample) / 2;
    return ranges.some(range => midpoint >= range.startSample && midpoint < range.endSample);
}

function createDisjointSet(): DisjointSet {
    const parent = new Map<string, string>();
    const find = (value: string): string => {
        const current = parent.get(value);
        if (!current) {
            parent.set(value, value);
            return value;
        }
        if (current === value) return value;
        const root = find(current);
        parent.set(value, root);
        return root;
    };
    return {
        find,
        union: (left, right) => {
            const leftRoot = find(left);
            const rightRoot = find(right);
            if (leftRoot === rightRoot) return;
            const first = leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
            parent.set(first === leftRoot ? rightRoot : leftRoot, first);
        },
        size: () => parent.size,
    };
}

async function verifyFileDigest(
    path: string,
    expected: Sha256Digest,
    signal?: AbortSignal,
): Promise<boolean> {
    const hash = createHash('sha256');
    const stream = createReadStream(path, {
        highWaterMark: 64 * 1024,
        signal,
    });
    try {
        for await (const chunk of stream) {
            throwIfManagedTranscriptionAborted(signal);
            hash.update(chunk as Buffer);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    } finally {
        stream.destroy();
    }
    return `sha256:${hash.digest('hex')}` === expected;
}

async function exists(path: string): Promise<boolean> {
    try {
        const metadata = await stat(path);
        return metadata.isFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

function validateMergeInput(input: {
    readonly sourceFingerprint: Sha256Digest;
    readonly acquisitionProfileDigest: Sha256Digest;
    readonly sourceSampleCount: number;
    readonly language: string | null;
    readonly speakerMode: string;
    readonly canonicalModel: string;
    readonly coreCoverage: readonly HalfOpenSampleRange[];
    readonly chunks: readonly {
        readonly recordId: Sha256Digest;
        readonly windowId: Sha256Digest;
        readonly decoded: HalfOpenSampleRange;
    }[];
}): void {
    let normalizedCoverage: HalfOpenSampleRange[];
    try {
        normalizedCoverage = normalizeSampleRanges(
            input.coreCoverage,
            input.sourceSampleCount,
        );
    } catch {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed merge request is invalid.',
        );
    }
    if (
        !isDigest(input.sourceFingerprint)
        || !isDigest(input.acquisitionProfileDigest)
        || !Number.isSafeInteger(input.sourceSampleCount)
        || input.sourceSampleCount < 0
        || (input.language !== null
            && (typeof input.language !== 'string'
                || input.language.length > 35
                || input.language !== input.language.trim().toLowerCase()))
        || (input.speakerMode !== 'none' && input.speakerMode !== 'diarized')
        || !input.canonicalModel.trim()
        || input.canonicalModel.length > 256
        || !equalRanges(input.coreCoverage, normalizedCoverage)
        || new Set(input.chunks.map(chunk => chunk.recordId)).size !== input.chunks.length
        || input.chunks.some(chunk => (
            !isDigest(chunk.recordId)
            || !isDigest(chunk.windowId)
            || !isRange(chunk.decoded)
            || chunk.decoded.endSample > input.sourceSampleCount
        ))
    ) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed merge request is invalid.',
        );
    }
}

function normalizeDigests(values: readonly Sha256Digest[]): Sha256Digest[] {
    if (values.some(value => !isDigest(value))) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'A managed transcription record identity is invalid.',
        );
    }
    return Array.from(new Set(values)).sort();
}

function assertDigest(value: unknown): asserts value is Sha256Digest {
    if (!isDigest(value)) {
        throw new ManagedTranscriptionError(
            'INVALID_INPUT',
            false,
            'The managed transcription record identity is invalid.',
        );
    }
}

function isDigest(value: unknown): value is Sha256Digest {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRange(value: unknown): value is HalfOpenSampleRange {
    return isPlainRecord(value)
        && hasExactKeys(value, ['startSample', 'endSample'])
        && Number.isSafeInteger(value.startSample)
        && Number.isSafeInteger(value.endSample)
        && (value.startSample as number) >= 0
        && (value.endSample as number) > (value.startSample as number);
}

function equalRange(left: HalfOpenSampleRange, right: HalfOpenSampleRange): boolean {
    return left.startSample === right.startSample && left.endSample === right.endSample;
}

function equalRanges(
    left: readonly HalfOpenSampleRange[],
    right: readonly HalfOpenSampleRange[],
): boolean {
    return left.length === right.length
        && left.every((range, index) => equalRange(range, right[index]));
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeToken(value: string): string {
    return value.normalize('NFKC').trim().toLocaleLowerCase('und');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype
            || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}
