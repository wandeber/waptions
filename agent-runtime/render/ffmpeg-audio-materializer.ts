import { constants } from 'node:fs';
import {
    chmod,
    mkdtemp,
    open,
    rmdir,
    unlink,
    type FileHandle,
} from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AUDIO_MIX_CHUNK_SIZE,
    downmixFrameToStereoInto,
    renderAudioMixWindow,
    resolveContributorSourceSpan,
    type DecodeAudioContributorRequest,
    type DecodedAudioContributor,
} from '../../src/lib/audio-dsp';
import type { AudioMixContributor } from '../../src/lib/audio-mix-plan';
import type {
    HeadlessMediaIdentity,
    ResolvedRenderPlanV1,
    VerifiedRenderMediaSourceSet,
} from '../../src/lib/render-plan';
import {
    HeadlessRenderError,
    throwIfAborted,
    type HeadlessRenderBackendProgress,
    type HeadlessSourceRangeRead,
} from './contracts';
import {
    buildFfmpegAudioDecoderArgs,
    buildFfmpegAudioMetadataArgs,
} from './ffmpeg-command';
import type { ImmutableSourceHandleResolverPort } from './node-ffmpeg-handles';
import {
    collectBoundedProcessOutput,
    NodeBackendProcessTracker,
    NodeBoundedFfmpegProcessRunner,
    type NodeBackendProcessLimits,
} from './node-ffmpeg-process';

export interface CanonicalPcmScratch {
    readonly fileDescriptor: number;
    readonly byteLength: number;
    close(): Promise<void>;
}
export interface FfmpegAudioMaterializationResult {
    scratch: CanonicalPcmScratch;
    sourceRangesRead: HeadlessSourceRangeRead[];
    peakAudioMixBytes: number;
    peakScratchBytes: number;
}

export interface FfmpegAudioMaterializerRequest {
    plan: ResolvedRenderPlanV1;
    mediaSources: VerifiedRenderMediaSourceSet;
    sourceHandles: ImmutableSourceHandleResolverPort;
    processes: NodeBoundedFfmpegProcessRunner;
    tracker: NodeBackendProcessTracker;
    ffmpegExecutable: string;
    ffprobeExecutable: string;
    processLimits: NodeBackendProcessLimits;
    maximumAudioMixBytes: number;
    maximumScratchBytes: number;
    signal?: AbortSignal;
    onProgress?: (progress: HeadlessRenderBackendProgress) => void;
}

interface AudioStreamMetadata {
    sampleRate: number;
    channels: number;
}

export async function materializeCanonicalAudio(
    request: FfmpegAudioMaterializerRequest,
): Promise<FfmpegAudioMaterializationResult> {
    if (endianness() !== 'LE') {
        throw new HeadlessRenderError(
            'CODEC_UNAVAILABLE',
            'The Node FFmpeg backend requires a little-endian host for f32le scratch.',
        );
    }
    const expectedBytes = checkedMultiply(request.plan.outputEndSample, 2, 4);
    if (expectedBytes > request.maximumScratchBytes) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'Canonical audio exceeds the configured scratch-byte limit.',
        );
    }
    const scratch = await createPrivatePcmScratch(expectedBytes);
    const sourceRanges = new SourceAudioRangeAccumulator();
    const metadata = new Map<string, AudioStreamMetadata>();
    let peakAudioMixBytes = 0;
    try {
        const maximumWindowSamples = Math.min(
            AUDIO_MIX_CHUNK_SIZE,
            Math.floor(request.maximumAudioMixBytes / 64),
        );
        if (maximumWindowSamples < 1) {
            throw new HeadlessRenderError(
                'RESOURCE_LIMIT',
                'The audio-mix budget cannot hold one canonical sample window.',
            );
        }
        for (
            let startSample = 0;
            startSample < request.plan.outputEndSample;
            startSample += maximumWindowSamples
        ) {
            throwIfAborted(request.signal);
            const endSample = Math.min(
                request.plan.outputEndSample,
                startSample + maximumWindowSamples,
            );
            const outputSampleCount = endSample - startSample;
            const interleaved = new Float32Array(outputSampleCount * 2);
            const mixedEnd = Math.min(endSample, request.plan.audioMixPlan.totalSampleCount);
            let peakDecodedBytes = 0;
            if (startSample < mixedEnd) {
                const dspBytes = outputSampleCount * 32;
                const maximumDecodedBytes = request.maximumAudioMixBytes - dspBytes;
                if (maximumDecodedBytes <= 0) {
                    throw new HeadlessRenderError(
                        'RESOURCE_LIMIT',
                        'The audio-mix budget leaves no room for decoded contributor PCM.',
                    );
                }
                const mix = await renderAudioMixWindow(
                    request.plan.audioMixPlan,
                    async (contributor, window) => {
                        const decoded = await decodeContributorWindow(
                            request,
                            contributor,
                            window,
                            maximumDecodedBytes,
                            metadata,
                        );
                        peakDecodedBytes = Math.max(
                            peakDecodedBytes,
                            decoded.audio.channels.reduce(
                                (total, channel) => total + channel.byteLength,
                                0,
                            ),
                        );
                        sourceRanges.add(contributor, window);
                        return decoded.audio;
                    },
                    {
                        startSample,
                        endSample: mixedEnd,
                        chunkSize: maximumWindowSamples,
                        signal: request.signal,
                    },
                );
                for (let index = 0; index < mix.endSample - mix.startSample; index += 1) {
                    interleaved[index * 2] = mix.channels[0][index];
                    interleaved[index * 2 + 1] = mix.channels[1][index];
                }
                peakAudioMixBytes = Math.max(
                    peakAudioMixBytes,
                    peakDecodedBytes + dspBytes,
                    interleaved.byteLength
                        + mix.channels[0].byteLength
                        + mix.channels[1].byteLength,
                );
            } else {
                peakAudioMixBytes = Math.max(peakAudioMixBytes, interleaved.byteLength);
            }
            await writeAllAt(
                scratch.handle,
                Buffer.from(
                    interleaved.buffer,
                    interleaved.byteOffset,
                    interleaved.byteLength,
                ),
                startSample * 2 * 4,
            );
            request.onProgress?.({
                stage: 'audio',
                completedUnits: endSample,
                totalUnits: request.plan.outputEndSample,
            });
        }
        await scratch.handle.sync();
        throwIfAborted(request.signal);
        return {
            scratch: {
                fileDescriptor: scratch.handle.fd,
                byteLength: expectedBytes,
                close: scratch.close,
            },
            sourceRangesRead: sourceRanges.values(),
            peakAudioMixBytes,
            peakScratchBytes: expectedBytes,
        };
    } catch (error) {
        await scratch.close().catch(() => undefined);
        throw error;
    }
}

async function decodeContributorWindow(
    request: FfmpegAudioMaterializerRequest,
    contributor: AudioMixContributor,
    window: DecodeAudioContributorRequest,
    maximumDecodedBytes: number,
    metadataCache: Map<string, AudioStreamMetadata>,
): Promise<{ audio: DecodedAudioContributor }> {
    const source = getContributorSourceIdentity(request.plan, contributor);
    const key = `${source.kind}:${source.sourceId}`;
    let metadata = metadataCache.get(key);
    if (!metadata) {
        metadata = await probeAudioMetadata(request, source);
        metadataCache.set(key, metadata);
    }
    const [decodeStart, decodeEnd] = resolveDecodeSampleWindow(
        contributor,
        window,
        metadata.sampleRate,
    );
    const maximumFrames = Math.floor(maximumDecodedBytes / (metadata.channels * 4));
    if (decodeEnd - decodeStart > maximumFrames || maximumFrames < 1) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'A contributor decode window exceeds the bounded audio-mix allocation.',
        );
    }
    const handle = await request.sourceHandles.acquire(
        request.mediaSources,
        source,
        request.signal,
    );
    try {
        assertAcquiredSource(source, handle.identity, handle.fileDescriptor);
        await handle.assertCurrent(request.signal);
        throwIfAborted(request.signal);
        const session = request.processes.start({
            executable: request.ffmpegExecutable,
            args: buildFfmpegAudioDecoderArgs({
                startSample: decodeStart,
                endSample: decodeEnd,
            }),
            stdio: ['ignore', 'pipe', 'pipe', handle.fileDescriptor],
            limits: request.processLimits,
            tracker: request.tracker,
            signal: request.signal,
            maximumStdoutBytes: maximumDecodedBytes,
        });
        let bytes: Buffer;
        try {
            [bytes] = await Promise.all([
                collectBoundedProcessOutput(
                    session.stdout,
                    maximumDecodedBytes,
                    request.signal,
                ),
                session.wait(),
            ]);
        } catch (error) {
            await session.terminate(toRenderError(error));
            throw error;
        }
        await handle.assertCurrent(request.signal);
        const frameBytes = metadata.channels * 4;
        if (bytes.byteLength === 0 || bytes.byteLength % frameBytes !== 0) {
            throw new HeadlessRenderError(
                'RENDER_FAILED',
                'FFmpeg returned incomplete native audio frames.',
            );
        }
        return {
            audio: downmixInterleavedPcm(
                bytes,
                metadata,
                decodeStart,
            ),
        };
    } finally {
        await handle.close();
    }
}

async function probeAudioMetadata(
    request: FfmpegAudioMaterializerRequest,
    source: HeadlessMediaIdentity,
): Promise<AudioStreamMetadata> {
    const handle = await request.sourceHandles.acquire(
        request.mediaSources,
        source,
        request.signal,
    );
    try {
        assertAcquiredSource(source, handle.identity, handle.fileDescriptor);
        await handle.assertCurrent(request.signal);
        throwIfAborted(request.signal);
        const maximumProbeBytes = Math.min(64 * 1024, request.processLimits.maximumStderrBytes);
        const session = request.processes.start({
            executable: request.ffprobeExecutable,
            args: buildFfmpegAudioMetadataArgs(),
            stdio: ['ignore', 'pipe', 'pipe', handle.fileDescriptor],
            limits: request.processLimits,
            tracker: request.tracker,
            signal: request.signal,
            maximumStdoutBytes: maximumProbeBytes,
        });
        let bytes: Buffer;
        try {
            [bytes] = await Promise.all([
                collectBoundedProcessOutput(
                    session.stdout,
                    maximumProbeBytes,
                    request.signal,
                ),
                session.wait(),
            ]);
        } catch (error) {
            await session.terminate(toRenderError(error));
            throw error;
        }
        await handle.assertCurrent(request.signal);
        return parseAudioMetadata(bytes);
    } finally {
        await handle.close();
    }
}

function parseAudioMetadata(bytes: Uint8Array): AudioStreamMetadata {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
        throw new HeadlessRenderError(
            'RENDER_FAILED',
            'FFprobe returned invalid audio metadata.',
            false,
            { cause: error instanceof Error ? error : undefined },
        );
    }
    const stream = (
        parsed
        && typeof parsed === 'object'
        && Array.isArray((parsed as { streams?: unknown }).streams)
    ) ? (parsed as { streams: unknown[] }).streams[0] : null;
    const sampleRate = Number((stream as { sample_rate?: unknown } | null)?.sample_rate);
    const channels = Number((stream as { channels?: unknown } | null)?.channels);
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0
        || !Number.isSafeInteger(channels) || channels <= 0 || channels > 32) {
        throw new HeadlessRenderError(
            'CODEC_UNAVAILABLE',
            'The selected source does not expose bounded native audio metadata.',
        );
    }
    return { sampleRate, channels };
}

function downmixInterleavedPcm(
    bytes: Uint8Array,
    metadata: AudioStreamMetadata,
    startSample: number,
): DecodedAudioContributor {
    const frames = bytes.byteLength / (metadata.channels * 4);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nativeFrame = new Array<number>(metadata.channels);
    const stereo: [number, number] = [0, 0];
    for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < metadata.channels; channel += 1) {
            const sample = view.getFloat32((frame * metadata.channels + channel) * 4, true);
            if (!Number.isFinite(sample)) {
                throw new HeadlessRenderError(
                    'RENDER_FAILED',
                    'FFmpeg decoded a non-finite audio sample.',
                );
            }
            nativeFrame[channel] = sample;
        }
        downmixFrameToStereoInto(nativeFrame, stereo);
        left[frame] = stereo[0];
        right[frame] = stereo[1];
    }
    return {
        sampleRate: metadata.sampleRate,
        startSample,
        channels: [left, right],
    };
}

function resolveDecodeSampleWindow(
    contributor: AudioMixContributor,
    window: DecodeAudioContributorRequest,
    decodedSampleRate: number,
): [number, number] {
    const contributorOutputCount = contributor.outputEndSample - contributor.outputStartSample;
    if (contributorOutputCount <= 0
        || window.outputStartSample < contributor.outputStartSample
        || window.outputEndSample > contributor.outputEndSample
        || window.outputEndSample <= window.outputStartSample) {
        throw new HeadlessRenderError(
            'INVALID_SNAPSHOT',
            'The canonical DSP requested an invalid contributor interval.',
        );
    }
    const [sourceStart, sourceEnd] = resolveContributorSourceSpan(
        contributor,
        decodedSampleRate,
    );
    const firstIndex = window.outputStartSample - contributor.outputStartSample;
    const lastIndex = window.outputEndSample - contributor.outputStartSample - 1;
    const firstPosition = sourceCentrePosition(
        sourceStart,
        sourceEnd,
        contributorOutputCount,
        firstIndex,
    );
    const lastPosition = sourceCentrePosition(
        sourceStart,
        sourceEnd,
        contributorOutputCount,
        lastIndex,
    );
    const decodeStart = Math.max(0, Math.floor(Math.min(firstPosition, lastPosition)) - 1);
    const decodeEnd = Math.max(
        decodeStart + 1,
        Math.ceil(Math.max(firstPosition, lastPosition)) + 2,
    );
    if (!Number.isSafeInteger(decodeStart) || !Number.isSafeInteger(decodeEnd)) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'The contributor source interval does not fit in safe native samples.',
        );
    }
    return [decodeStart, decodeEnd];
}

function sourceCentrePosition(
    startPosition: number,
    endPosition: number,
    outputSampleCount: number,
    outputIndex: number,
): number {
    return startPosition
        + (outputIndex + 0.5) * (endPosition - startPosition) / outputSampleCount
        - 0.5;
}

function getContributorSourceIdentity(
    plan: ResolvedRenderPlanV1,
    contributor: AudioMixContributor,
): HeadlessMediaIdentity {
    const kind = contributor.source.kind === 'audio-source' ? 'audio' : 'video';
    const sourceId = contributor.source.kind === 'audio-source'
        ? contributor.source.audioSourceId
        : contributor.source.videoSourceId;
    const source = plan.sources.find((candidate) => (
        candidate.kind === kind && candidate.sourceId === sourceId
    ));
    if (!source) {
        throw new HeadlessRenderError(
            'SOURCE_CHANGED',
            'The canonical audio plan references an unknown immutable source.',
        );
    }
    return source;
}

function assertAcquiredSource(
    expected: HeadlessMediaIdentity,
    actual: HeadlessMediaIdentity,
    fileDescriptor: number,
): void {
    const keys: Array<keyof HeadlessMediaIdentity> = [
        'sourceId',
        'kind',
        'byteSourceCapabilityId',
        'fingerprint',
        'size',
        'lastModified',
    ];
    if (!Number.isSafeInteger(fileDescriptor) || fileDescriptor < 0
        || keys.some((key) => actual[key] !== expected[key])) {
        throw new HeadlessRenderError(
            'SOURCE_CHANGED',
            'The acquired seekable source handle does not match the resolved identity.',
        );
    }
}

class SourceAudioRangeAccumulator {
    private readonly ranges = new Map<string, HeadlessSourceRangeRead>();

    add(
        contributor: AudioMixContributor,
        window: DecodeAudioContributorRequest,
    ): void {
        const sourceKind = contributor.source.kind === 'audio-source' ? 'audio' : 'video';
        const sourceId = contributor.source.kind === 'audio-source'
            ? contributor.source.audioSourceId
            : contributor.source.videoSourceId;
        const key = `${sourceKind}:${sourceId}`;
        const next: HeadlessSourceRangeRead = {
            sourceId,
            sourceKind,
            kind: 'audio-output-samples',
            start: window.outputStartSample,
            end: window.outputEndSample,
        };
        const previous = this.ranges.get(key);
        this.ranges.set(key, previous ? {
            ...previous,
            start: Math.min(previous.start, next.start),
            end: Math.max(previous.end, next.end),
        } : next);
    }

    values(): HeadlessSourceRangeRead[] {
        return Array.from(this.ranges.values()).sort((left, right) => (
            left.sourceKind.localeCompare(right.sourceKind)
            || left.sourceId.localeCompare(right.sourceId)
        ));
    }
}

async function createPrivatePcmScratch(byteLength: number): Promise<{
    handle: FileHandle;
    close(): Promise<void>;
}> {
    const directory = await mkdtemp(join(tmpdir(), 'waptions-render-'));
    await chmod(directory, 0o700);
    const filename = join(directory, 'canonical-audio.pcm');
    let handle: FileHandle | null = null;
    try {
        handle = await open(
            filename,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
            0o600,
        );
        await handle.truncate(byteLength);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(filename).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
        throw error;
    }
    let closed = false;
    return {
        handle,
        async close() {
            if (closed) return;
            closed = true;
            const failures: unknown[] = [];
            await handle!.close().catch((error) => failures.push(error));
            await unlink(filename).catch((error) => failures.push(error));
            await rmdir(directory).catch((error) => failures.push(error));
            if (failures.length > 0) {
                throw new HeadlessRenderError(
                    'CLEANUP_FAILED',
                    'Private canonical-audio scratch cleanup failed.',
                    false,
                    {
                        cause: failures[0] instanceof Error ? failures[0] : undefined,
                    },
                );
            }
        },
    };
}

async function writeAllAt(
    handle: FileHandle,
    bytes: Uint8Array,
    position: number,
): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            position + offset,
        );
        if (result.bytesWritten <= 0) {
            throw new HeadlessRenderError(
                'RENDER_FAILED',
                'Canonical audio scratch stopped accepting bytes.',
            );
        }
        offset += result.bytesWritten;
    }
}

function checkedMultiply(...values: number[]): number {
    const result = values.reduce((product, value) => product * value, 1);
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new HeadlessRenderError(
            'RESOURCE_LIMIT',
            'Canonical audio scratch size overflowed.',
        );
    }
    return result;
}

function toRenderError(error: unknown): HeadlessRenderError {
    return error instanceof HeadlessRenderError
        ? error
        : new HeadlessRenderError(
            'RENDER_FAILED',
            error instanceof Error ? error.message : 'FFmpeg audio decoding failed.',
            false,
            error instanceof Error ? { cause: error } : undefined,
        );
}
