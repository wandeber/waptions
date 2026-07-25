import {
    Input,
    ALL_FORMATS,
    VideoSampleSink,
    BufferTarget,
    Output,
    Mp4OutputFormat,
    AudioSampleSink,
    AudioSampleSource,
    getFirstEncodableAudioCodec,
    type AudioSample,
    type AudioCodec,
    type InputAudioTrack,
    type InputVideoTrack,
} from 'mediabunny';
import type { MediaBudgetLease, MediaBudgetManager } from './media-byte-source/budget-manager';
import { mediaRuntimeBudgets } from './media-byte-source/budgets';
import { createAdmittedMediabunnyInput } from './media-byte-source/mediabunny-adapter';
import type { MediaByteSourceInput } from './media-byte-source/types';
import { throwIfAborted } from './media-byte-source/types';

export interface MediaTrackInspection {
    duration: number;
    video: {
        width: number;
        height: number;
        fps: number;
        codec: string | null;
    } | null;
    audio: {
        sampleRate: number;
        numberOfChannels: number;
        codec: string | null;
        bitrate: number | null;
    } | null;
}

export interface MediaInspectionInput {
    computeDuration(): Promise<number>;
    getPrimaryVideoTrack(): Promise<InputVideoTrack | null>;
    getPrimaryAudioTrack(): Promise<InputAudioTrack | null>;
    dispose(): void;
}

type MaybePromise<T> = T | Promise<T>;

export type MediaInspectionInputFactory = (
    source: MediaByteSourceInput,
) => MaybePromise<MediaInspectionInput>;

const createMediaInspectionInput: MediaInspectionInputFactory = (source) => (
    createAdmittedMediabunnyInput(source, (admittedSource) => new Input({
        source: admittedSource,
        formats: ALL_FORMATS,
    }))
);

type AudioExtractionInput = Pick<Input, 'getPrimaryAudioTrack' | 'dispose'>;
type AudioExtractionOutput = Pick<Output, 'state' | 'addAudioTrack' | 'start' | 'finalize' | 'cancel'>;
type AudioExtractionSink = Pick<AudioSampleSink, 'samples'>;

/**
 * Construction seam for the resource-owning audio extraction pipeline.
 *
 * Production uses the concrete Mediabunny implementations below. Tests inject small stateful
 * fakes so every terminal path can assert exact ownership without depending on browser codecs.
 */
export interface AudioExtractionDependencies {
    createInput(source: MediaByteSourceInput): MaybePromise<AudioExtractionInput>;
    createTarget(): BufferTarget;
    createOutput(target: BufferTarget): AudioExtractionOutput;
    selectCodec(): Promise<AudioCodec>;
    createSource(codec: AudioCodec): AudioSampleSource;
    createSink(track: InputAudioTrack): AudioExtractionSink;
}

const defaultAudioExtractionDependencies: AudioExtractionDependencies = {
    createInput: (source) => createAdmittedMediabunnyInput(source, (admittedSource) => new Input({
        source: admittedSource,
        formats: ALL_FORMATS,
    })),
    createTarget: () => new BufferTarget(),
    createOutput: (target) => new Output({
        format: new Mp4OutputFormat(),
        target,
    }),
    selectCodec: async () => (
        (await getFirstEncodableAudioCodec(['aac', 'opus'])) || 'aac'
    ),
    createSource: (codec) => new AudioSampleSource({
        codec,
        bitrate: 128000,
    }),
    createSink: (track) => new AudioSampleSink(track),
};

function normalizeFrameRate(averagePacketRate: number): number {
    // Container packet clocks introduce small floating-point deviations around common rates.
    // Pick the nearest candidate because broadcast and integer rates are closer than the
    // tolerance (for example, 29.97 and 30). The broadcast entries retain their exact rational
    // values so source-frame crops and the render profile use the same authoritative grid.
    const commonFrameRates = [
        24_000 / 1_001,
        24,
        25,
        30_000 / 1_001,
        30,
        50,
        60_000 / 1_001,
        60,
    ];
    const nearest = commonFrameRates.reduce((best, candidate) => (
        Math.abs(candidate - averagePacketRate) < Math.abs(best - averagePacketRate)
            ? candidate
            : best
    ));
    return Math.abs(nearest - averagePacketRate) < 0.1 ? nearest : averagePacketRate;
}

/**
 * Opens a media container once and returns the metadata shared by import classification,
 * video descriptors, and audio descriptors.
 *
 * The Input owns demuxer state and any reads started by track inspection. It must be disposed
 * after the final metadata promise settles, including when probing malformed input throws.
 * Tracks are lightweight views owned by the Input and must not outlive this function.
 */
export async function inspectMediaTracks(
    file: MediaByteSourceInput,
    inputFactory: MediaInspectionInputFactory = createMediaInspectionInput,
): Promise<MediaTrackInspection> {
    const input = await inputFactory(file);
    try {
        const [duration, videoTrack, audioTrack] = await Promise.all([
            input.computeDuration(),
            input.getPrimaryVideoTrack(),
            input.getPrimaryAudioTrack(),
        ]);
        const videoPacketStats = videoTrack
            ? await videoTrack.computePacketStats(300)
            : null;

        let audioBitrate: number | null = null;
        if (audioTrack) {
            try {
                const audioPacketStats = await audioTrack.computePacketStats(300);
                audioBitrate = Number.isFinite(audioPacketStats.averageBitrate)
                    ? Math.max(0, Math.round(audioPacketStats.averageBitrate))
                    : null;
            } catch {
                // Packet statistics are optional metadata. A valid decodable audio track must
                // remain importable when a container cannot provide a reliable bitrate estimate.
                audioBitrate = null;
            }
        }

        return {
            duration,
            video: videoTrack && videoPacketStats
                ? {
                    width: videoTrack.displayWidth,
                    height: videoTrack.displayHeight,
                    fps: normalizeFrameRate(videoPacketStats.averagePacketRate),
                    codec: videoTrack.codec,
                }
                : null,
            audio: audioTrack
                ? {
                    sampleRate: audioTrack.sampleRate,
                    numberOfChannels: audioTrack.numberOfChannels,
                    codec: audioTrack.codec,
                    bitrate: audioBitrate,
                }
                : null,
        };
    } finally {
        input.dispose();
    }
}

/**
 * Get video metadata using mediabunny.
 * Returns duration, dimensions, and FPS.
 */
export async function getVideoInfo(videoFile: File): Promise<{
    duration: number;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    hasAudio: boolean;
}> {
    const inspection = await inspectMediaTracks(videoFile);
    if (!inspection.video) {
        throw new Error('No video track found in the file');
    }

    // Calculate average bitrate (bits per second)
    const bitrate = inspection.duration > 0
        ? Math.round((videoFile.size * 8) / inspection.duration)
        : 0;

    return {
        duration: inspection.duration,
        width: inspection.video.width,
        height: inspection.video.height,
        fps: inspection.video.fps,
        bitrate,
        hasAudio: inspection.audio !== null,
    };
}

export async function getAudioInfo(audioFile: File): Promise<{
    duration: number;
    sampleRate: number;
    numberOfChannels: number;
    codec: string | null;
    bitrate: number | null;
}> {
    const inspection = await inspectMediaTracks(audioFile);
    if (!inspection.audio) {
        throw new Error('No audio track found in the file');
    }
    return {
        duration: inspection.duration,
        sampleRate: inspection.audio.sampleRate,
        numberOfChannels: inspection.audio.numberOfChannels,
        codec: inspection.audio.codec,
        bitrate: inspection.audio.bitrate,
    };
}

interface ThumbnailTrack {
    readonly displayWidth: number;
    readonly displayHeight: number;
    canDecode(): Promise<boolean>;
}

interface ThumbnailSample {
    draw(
        context: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number,
    ): void;
    close(): void;
}

interface ThumbnailInput {
    getPrimaryVideoTrack(): Promise<ThumbnailTrack | null>;
    dispose(): void;
}

interface ThumbnailSink {
    getSample(timestamp: number): Promise<ThumbnailSample | null>;
}

export interface ThumbnailDependencies {
    createInput(source: MediaByteSourceInput): MaybePromise<ThumbnailInput>;
    createSink(track: ThumbnailTrack): ThumbnailSink;
    createCanvas(): HTMLCanvasElement;
    decodedPixelBudget: MediaBudgetManager;
}

export interface GenerateThumbnailOptions {
    readonly signal?: AbortSignal;
    readonly dependencies?: ThumbnailDependencies;
}

const defaultThumbnailDependencies: ThumbnailDependencies = {
    createInput: (source) => createAdmittedMediabunnyInput(source, (admittedSource) => new Input({
        source: admittedSource,
        formats: ALL_FORMATS,
    }) as unknown as ThumbnailInput),
    createSink: (track) => new VideoSampleSink(track as InputVideoTrack) as unknown as ThumbnailSink,
    createCanvas: () => document.createElement('canvas'),
    decodedPixelBudget: mediaRuntimeBudgets.decodedPixels,
};

/**
 * Generates a bounded thumbnail and closes the Input, sample, and pixel leases on every exit.
 */
export async function generateThumbnail(
    videoFile: MediaByteSourceInput,
    timeInSeconds: number,
    options: GenerateThumbnailOptions = {},
): Promise<string> {
    const dependencies = options.dependencies ?? defaultThumbnailDependencies;
    const input = await dependencies.createInput(videoFile);
    let inputDisposed = false;
    let frame: ThumbnailSample | null = null;
    let frameClosed = false;
    let sourcePixelLease: MediaBudgetLease | null = null;
    let canvasPixelLease: MediaBudgetLease | null = null;
    const disposeInput = () => {
        if (inputDisposed) return;
        inputDisposed = true;
        input.dispose();
    };
    const closeFrame = () => {
        if (!frame || frameClosed) return;
        frameClosed = true;
        frame.close();
    };

    try {
        throwIfAborted(options.signal);
        const videoTrack = await input.getPrimaryVideoTrack();
        throwIfAborted(options.signal);
        if (!videoTrack) throw new Error('No video track found in the file');
        if (!await videoTrack.canDecode()) {
            throw new Error('Video codec not supported for decoding');
        }
        throwIfAborted(options.signal);

        const originalWidth = Math.max(1, Math.round(videoTrack.displayWidth));
        const originalHeight = Math.max(1, Math.round(videoTrack.displayHeight));
        const sourceBytes = originalWidth * originalHeight * 4;
        if (!Number.isSafeInteger(sourceBytes)) {
            throw new RangeError('Thumbnail source dimensions exceed the decoded-pixel address space.');
        }
        const sourceReservation = await dependencies.decodedPixelBudget.reserve(sourceBytes, {
            label: 'thumbnail-source-frame',
            signal: options.signal,
        });
        sourcePixelLease = sourceReservation.commit();

        const sink = dependencies.createSink(videoTrack);
        frame = await sink.getSample(timeInSeconds);
        throwIfAborted(options.signal);
        if (!frame) throw new Error('Could not get frame at specified time');

        const targetWidth = 400;
        const targetHeight = Math.max(1, Math.round(targetWidth / (originalWidth / originalHeight)));
        const canvasReservation = await dependencies.decodedPixelBudget.reserve(
            targetWidth * targetHeight * 4,
            { label: 'thumbnail-canvas', signal: options.signal },
        );
        canvasPixelLease = canvasReservation.commit();
        const canvas = dependencies.createCanvas();
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not get canvas context');

        frame.draw(context, 0, 0, targetWidth, targetHeight);
        closeFrame();
        sourcePixelLease.release();
        sourcePixelLease = null;
        throwIfAborted(options.signal);
        return canvas.toDataURL('image/jpeg', 0.7);
    } finally {
        try {
            closeFrame();
        } finally {
            sourcePixelLease?.release();
            canvasPixelLease?.release();
            disposeInput();
        }
    }
}

/**
 * Extract audio track from video file as a separate blob for Whisper.
 * It decodes the original audio and re-encodes it as AAC/MP4.
 * This significantly reduces file size and ensures compatibility.
 */
export async function extractAudio(
    videoFile: MediaByteSourceInput,
    dependencies: AudioExtractionDependencies = defaultAudioExtractionDependencies,
): Promise<Blob> {
    const input = await dependencies.createInput(videoFile);
    let inputDisposed = false;
    let output: AudioExtractionOutput | null = null;
    let source: AudioSampleSource | null = null;
    let sourceClosed = false;
    let operationFailed = false;

    const disposeInput = (): void => {
        if (inputDisposed) return;
        // Mark ownership as released before calling into the library. Even if disposal itself
        // throws, a later cleanup branch must not call a non-idempotent terminal method twice.
        inputDisposed = true;
        input.dispose();
    };
    const closeSource = (): void => {
        if (!source || sourceClosed) return;
        sourceClosed = true;
        source.close();
    };

    try {
        const audioTrack = await input.getPrimaryAudioTrack();
        if (!audioTrack) {
            throw new Error('No audio track found in the file');
        }

        const codec = await dependencies.selectCodec();
        const target = dependencies.createTarget();
        output = dependencies.createOutput(target);
        source = dependencies.createSource(codec);
        output.addAudioTrack(source);

        // The sink borrows the track from Input. Input therefore stays alive through the final
        // sample read and is disposed only after the output reaches a terminal state below.
        const sink = dependencies.createSink(audioTrack);
        await output.start();

        // Decoded samples can legally start at a small negative timestamp because
        // some containers store audio priming/offset metadata. Output encoders do
        // not accept negative timestamps, so sanitize each sample before handing it
        // to the AudioSampleSource and always close every owned sample afterward.
        for await (const sample of sink.samples()) {
            await addNonNegativeAudioSample(source, sample);
        }

        closeSource();
        await output.finalize();

        if (!target.buffer) {
            throw new Error('Failed to extract audio buffer');
        }

        return new Blob([target.buffer], { type: 'audio/mp4' });
    } catch (error) {
        operationFailed = true;
        throw error;
    } finally {
        let cleanupError: unknown = null;
        try {
            closeSource();
        } catch (error) {
            cleanupError = error;
        }

        if (
            operationFailed
            && output
            && output.state !== 'finalized'
            && output.state !== 'finalizing'
            && output.state !== 'canceled'
        ) {
            try {
                // Output.cancel is the terminal release for encoders, muxers, and targets after
                // setup, start, or sample encoding fails. Mediabunny intentionally disallows
                // cancel once finalization has begun, so the `finalizing` state is excluded.
                await output.cancel();
            } catch (error) {
                cleanupError ??= error;
            }
        }

        try {
            disposeInput();
        } catch (error) {
            cleanupError ??= error;
        }

        // Preserve the actual extraction error when cleanup also fails. On the successful path,
        // however, a terminal cleanup failure is the relevant failure and must reach the caller.
        if (!operationFailed && cleanupError) {
            throw cleanupError;
        }
    }
}

export async function addNonNegativeAudioSample(source: AudioSampleSource, sample: AudioSample): Promise<boolean> {
    let sampleForEncoder: AudioSample | null = null;

    try {
        const sampleEndTimestamp = sample.timestamp + sample.duration;
        if (sampleEndTimestamp <= 0) {
            return false;
        }

        // When the sample overlaps zero, clone it before changing metadata so
        // the original decoded sample can still be closed exactly once. This is
        // a tiny timing correction for encoder compatibility, not a full trim.
        sampleForEncoder = sample.timestamp < 0 ? sample.clone() : sample;
        if (sampleForEncoder.timestamp < 0) {
            sampleForEncoder.setTimestamp(0);
        }

        await source.add(sampleForEncoder);
        return true;
    } finally {
        if (sampleForEncoder && sampleForEncoder !== sample) {
            sampleForEncoder.close();
        }

        sample.close();
    }
}
