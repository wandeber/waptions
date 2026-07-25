import {
    ALL_FORMATS,
    AudioSampleSource,
    BlobSource,
    CanvasSink,
    CanvasSource,
    Input,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
    getFirstEncodableAudioCodec,
    type InputVideoTrack,
    type WrappedCanvas,
} from 'mediabunny';
import type {
    ExportOptions,
    ExportProjectContext,
    ExportResult,
} from '@/types/export';
import type {
    EditorDocumentV3,
    EditorDocumentV4,
    VideoSourceAssetV3,
} from '@/types/video';
import { renderSubtitles } from './subtitle-renderer';
import { waitForFonts } from './fonts/google-fonts';
import { getSourceFrameAtOrBefore } from './video-timeline';
import {
    buildVideoFrameRuntimePlan,
    resolveVideoFrameRuntimePlacementAtFrame,
    type VideoFrameRuntimePlacement,
} from './video-frame-plan';
import { frameToOutputSample } from './audio-timebase';
import { DEFAULT_RENDER_BACKGROUND_COLOR, framesToSeconds } from './render-profile';
import { TimelineAudioRenderer } from './timeline-audio-renderer';
import { clearVideoFrameToBlack, drawContainedVideoFrame } from './video-compositor';
import {
    VideoFrameSession,
    type VideoFrameSessionBackend,
    type VideoFrameSessionInput,
} from './video-frame-session';
import { runtimeDiagnostics } from './runtime-diagnostics';
import {
    awaitExportPhase,
    calculateExportVideoBitrate,
    createExportRuntimeSnapshot,
    createExportProgressReporter,
    getExportContentEndFrame,
    isExportAbortError,
    throwIfExportAborted,
} from './export-job';
import {
    createExportDestinationRuntime,
    type ExportDestinationRuntime,
} from './export-destination';

export { getExportContentEndFrame } from './export-job';
export { estimateExportOutputBytes } from './export-job';
export { createExportDocumentSnapshot } from './export-job';

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
    format: 'mp4',
    quality: 'high',
    includeAudio: true,
};

const EXPORT_VIDEO_SESSION_BACKEND: VideoFrameSessionBackend = {
    createInput: (file) => new Input({
        source: new BlobSource(file),
        formats: ALL_FORMATS,
    }) as unknown as VideoFrameSessionInput,
    // Export consumes each pooled canvas before requesting the next frame. A pool of two permits
    // decoder handoff between current and next while preventing the five-frame preview pool from
    // being multiplied by large export canvases.
    createSink: (track) => new CanvasSink(track as InputVideoTrack, { poolSize: 2 }),
};

/**
 * Resolves the visual clip for one canonical output frame.
 *
 * Returning null is deliberate: export paints the canvas black before every frame, so subtitle
 * and independent-audio tails continue at the locked canvas size after the video program ends.
 */
export function resolveExportVideoPlacement(
    document: EditorDocumentV3 | EditorDocumentV4,
    frameIndex: number,
): VideoFrameRuntimePlacement | null {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return null;
    return resolveVideoFrameRuntimePlacementAtFrame(
        buildVideoFrameRuntimePlan(document),
        frameIndex,
    )?.placement ?? null;
}

/**
 * Exports one immutable V3 editor snapshot into an already-authorized destination.
 *
 * This job never calls the shared preview cache. It owns one source-native VideoFrameSession at a
 * time and disposes it on source switches, cancellation, or completion, so a long export cannot
 * evict warmed playhead frames or retain a frame per source. Every asynchronous boundary observes
 * the caller's AbortSignal, while terminal cleanup remains idempotent and awaited.
 */
export async function exportProject(request: ExportProjectContext): Promise<ExportResult> {
    const startedAt = now();
    const signal = request.options.signal;
    const reportProgress = createExportProgressReporter(request.options.onProgress);
    let output: Output | null = null;
    let videoSource: CanvasSource | null = null;
    let audioSource: AudioSampleSource | null = null;
    let videoReader: ExportVideoFrameReader | null = null;
    let destinationRuntime: ExportDestinationRuntime | null = null;
    let videoSourceClosed = false;
    let audioSourceClosed = false;
    let finalizePromise: Promise<void> | null = null;
    let outcome: 'completed' | 'failed' | 'aborted' = 'failed';
    let terminalReason: unknown;

    const closeVideoSource = (): void => {
        if (!videoSource || videoSourceClosed) return;
        videoSourceClosed = true;
        videoSource.close();
    };
    const closeAudioSource = (): void => {
        if (!audioSource || audioSourceClosed) return;
        audioSourceClosed = true;
        audioSource.close();
    };

    runtimeDiagnostics.increment('export', 'started');

    try {
        // The File System Access writable is already open when exportProject is called. Establish
        // its idempotent owner before snapshotting, validation, cancellation checks, font loading,
        // or progress callbacks so every early exit reaches one awaited terminal operation.
        destinationRuntime = createExportDestinationRuntime(request.destination, signal);
        const destination = destinationRuntime;
        const exportSnapshot = createExportRuntimeSnapshot(request.document);
        const document = exportSnapshot.document;
        const videoPlan = exportSnapshot.videoPlan;
        throwIfExportAborted(signal);
        reportProgress(0);
        const { format, quality, includeAudio = true } = request.options;
        if (document.videoClips.length === 0) {
            return { success: false, error: 'The timeline has no video clips.' };
        }

        const sourcesById = new Map(document.videoSources.map((source) => [source.id, source]));
        const firstSource = sourcesById.get(document.videoClips[0].sourceId);
        if (!firstSource) return { success: false, error: 'The first clip source is missing.' };

        await awaitExportPhase(waitForFonts(Array.from(new Set(
            document.subtitleTracks.map((track) => track.style.fontFamily),
        ))), signal);
        throwIfExportAborted(signal);

        const frameRate = document.renderProfile.fps;
        const frameRateNumber = frameRate.numerator / frameRate.denominator;
        const contentEndFrame = getExportContentEndFrame(document);
        const audioEndSample = frameToOutputSample(contentEndFrame, frameRate);
        const canvasWidth = document.renderProfile.width;
        const canvasHeight = document.renderProfile.height;
        output = new Output({
            // Streaming MP4 deliberately places metadata at the end. Mediabunny's in-memory fast
            // start mode would retain every media chunk and defeat the bounded destination.
            format: format === 'webm'
                ? new WebMOutputFormat()
                : new Mp4OutputFormat({ fastStart: false }),
            target: destination.target,
        });
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const context2d = canvas.getContext('2d');
        if (!context2d) throw new Error('Failed to create canvas context.');

        videoSource = new CanvasSource(canvas, {
            codec: format === 'webm' ? 'vp9' : 'avc',
            bitrate: calculateExportVideoBitrate(document, quality),
        });
        output.addVideoTrack(videoSource, { frameRate: frameRateNumber });

        if (includeAudio) {
            const requiredCodec = format === 'webm' ? 'opus' : 'aac';
            const codec = await awaitExportPhase(
                getFirstEncodableAudioCodec([requiredCodec]),
                signal,
            );
            if (!codec) {
                throw new Error(`${requiredCodec.toUpperCase()} audio encoding is unavailable.`);
            }
            // A requested audio track is present even for an empty mix. TimelineAudioRenderer
            // emits exact silence through subtitle and black-video tails using the shared DSP.
            audioSource = new AudioSampleSource({ codec, bitrate: 128_000 });
            output.addAudioTrack(audioSource);
        }

        await awaitExportPhase(output.start(), signal);
        videoReader = new ExportVideoFrameReader(signal);
        const videoProgressWeight = audioSource ? 0.8 : 0.98;
        for (let frameIndex = 0; frameIndex < contentEndFrame; frameIndex += 1) {
            throwIfExportAborted(signal);
            const projectTime = framesToSeconds(frameIndex, frameRate);
            const nextProjectTime = framesToSeconds(frameIndex + 1, frameRate);
            const resolved = resolveVideoFrameRuntimePlacementAtFrame(videoPlan, frameIndex);
            const activeSource = resolved
                ? sourcesById.get(resolved.placement.clip.sourceId) ?? null
                : null;

            // Paint first on every iteration. If video ends before subtitle or audio content, the
            // configured project background is the deterministic tail beneath any subtitles.
            clearVideoFrameToBlack(
                context2d,
                canvasWidth,
                canvasHeight,
                document.version === 4
                    ? document.renderBackgroundColor
                    : DEFAULT_RENDER_BACKGROUND_COLOR,
            );
            if (resolved && activeSource) {
                const sourceFrame = getSourceFrameAtOrBefore(
                    resolved.sourceTime,
                    activeSource.fps,
                    activeSource.duration,
                );
                const frame = await videoReader.getFrame(activeSource, sourceFrame.time);
                throwIfExportAborted(signal);
                if (frame) {
                    // This is the sole contain operation in export. VideoFrameSession decodes at
                    // source aspect and the compositor owns all letterboxing decisions.
                    drawContainedVideoFrame(
                        context2d,
                        frame.canvas,
                        activeSource.width,
                        activeSource.height,
                        canvasWidth,
                        canvasHeight,
                    );
                }
            }

            document.subtitleTracks.forEach((track) => {
                if (!track.isVisible) return;
                renderSubtitles(
                    context2d,
                    track.subtitles,
                    track.style,
                    projectTime,
                    canvasWidth,
                    canvasHeight,
                );
            });
            await awaitExportPhase(
                videoSource.add(projectTime, nextProjectTime - projectTime),
                signal,
            );
            runtimeDiagnostics.increment('export', 'framesRendered');
            reportProgress((frameIndex + 1) / Math.max(1, contentEndFrame) * videoProgressWeight);
        }
        closeVideoSource();
        await videoReader.dispose();
        videoReader = null;

        if (audioSource) {
            const renderer = new TimelineAudioRenderer(document, audioSource);
            let previousAudioProgress = -1;
            await renderer.render({
                outputEndSample: audioEndSample,
                signal,
                onProgress: (progress) => {
                    // Renderer progress advances once per bounded audio window. Counting it here
                    // avoids exposing DSP internals merely for diagnostics.
                    if (progress > previousAudioProgress) {
                        runtimeDiagnostics.increment('export', 'audioBlocksRendered');
                        previousAudioProgress = progress;
                    }
                    reportProgress(0.8 + progress * 0.18);
                },
            });
            closeAudioSource();
        }

        throwIfExportAborted(signal);
        destination.prepareCommit();
        finalizePromise = output.finalize();
        await awaitExportPhase(finalizePromise, signal);
        throwIfExportAborted(signal);
        const bytesWritten = destination.getBytesWritten();
        let result: Extract<ExportResult, { success: true }>;
        let deliveryCounter: 'streamed' | 'memoryFallback';
        if (destination.kind === 'stream') {
            result = { success: true, delivery: 'streamed', bytesWritten };
            deliveryCounter = 'streamed';
        } else {
            const buffer = destination.getMemoryBuffer();
            if (!buffer) {
                throw new Error('The in-memory export completed without an output buffer.');
            }
            result = { success: true, delivery: 'memory', bytesWritten, buffer };
            deliveryCounter = 'memoryFallback';
        }

        // Final memory assembly and the consumer's terminal progress callback can still fail after
        // the muxer finalizes. Keep the destination under failure ownership until every fallible
        // delivery step succeeds, then publish success diagnostics immediately before returning.
        reportProgress(1);
        runtimeDiagnostics.increment('export', deliveryCounter);
        outcome = 'completed';
        return result;
    } catch (error) {
        terminalReason = error;
        if (isExportAbortError(error) || signal?.aborted) {
            outcome = 'aborted';
            return { success: false, cancelled: true };
        }
        console.error('Export failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown export error',
        };
    } finally {
        // Close signals track completion and is deliberately guarded because Mediabunny may also
        // force-close sources during Output.cancel(). AudioSample instances remain owned by the
        // renderer until each source.add() promise resolves, then close in its own finally block.
        closeVideoSource();
        closeAudioSource();
        await videoReader?.dispose();

        // Aborting during finalize causes the streaming destination to reject its pending writer.
        // Await the original promise before returning so no muxer work or rejection escapes the
        // export job after its result has been delivered.
        if (finalizePromise && output?.state === 'finalizing') {
            try {
                await finalizePromise;
            } catch {
                // The primary failure/cancellation contract was already selected above.
            }
        }
        if (output && output.state !== 'finalized' && output.state !== 'canceled'
            && output.state !== 'finalizing') {
            try {
                await output.cancel();
            } catch (cleanupError) {
                console.error('Failed to cancel export output during cleanup:', cleanupError);
            }
        }
        if (outcome !== 'completed' && destinationRuntime) {
            try {
                // Output.cancel() cannot reach a StreamTarget writer before Output.start(). The
                // destination therefore owns an independent terminal guard, and awaiting it here
                // closes that pre-start gap while remaining a no-op after Mediabunny already
                // aborted the same underlying writer.
                await destinationRuntime.abort(terminalReason ?? signal?.reason);
            } catch (cleanupError) {
                console.error('Failed to abort export destination during cleanup:', cleanupError);
            }
        }

        runtimeDiagnostics.increment('export', outcome);
        runtimeDiagnostics.setGauge('export', 'bufferedBytes', 0);
        runtimeDiagnostics.observeTiming('export', 'duration', Math.max(0, now() - startedAt));
    }
}

/**
 * Owns one export-only decode session. Source switches dispose the previous Input before opening
 * the next one, which bounds decoded state to the current pooled frame and prevents any insertion
 * into the preview LRU.
 */
class ExportVideoFrameReader {
    private session: VideoFrameSession | null = null;
    private sourceId: string | null = null;
    private disposed = false;
    private disposePromise: Promise<void> | null = null;
    private generation = 0;
    private readonly handleAbort = () => { void this.dispose(); };

    constructor(private readonly signal?: AbortSignal) {
        signal?.addEventListener('abort', this.handleAbort, { once: true });
    }

    async getFrame(
        source: VideoSourceAssetV3,
        sourceTime: number,
    ): Promise<WrappedCanvas | null> {
        throwIfExportAborted(this.signal);
        if (this.disposed) throw new Error('The export video reader has been disposed.');
        if (!this.session || this.sourceId !== source.id) {
            await this.disposeSession();
            const generation = ++this.generation;
            const session = await VideoFrameSession.open({
                file: source.file,
                generation,
                signal: this.signal ?? new AbortController().signal,
                backend: EXPORT_VIDEO_SESSION_BACKEND,
            });
            if (this.disposed || this.signal?.aborted || generation !== this.generation) {
                await session.dispose();
                throwIfExportAborted(this.signal);
                return null;
            }
            this.session = session;
            this.sourceId = source.id;
        }
        const frame = await this.session.request('export', sourceTime);
        throwIfExportAborted(this.signal);
        return frame;
    }

    async dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        this.signal?.removeEventListener('abort', this.handleAbort);
        this.disposePromise = this.disposeSession();
        return this.disposePromise;
    }

    private async disposeSession(): Promise<void> {
        const session = this.session;
        this.session = null;
        this.sourceId = null;
        if (session) await session.dispose();
    }
}

export function getExportMimeType(format: 'mp4' | 'webm'): string {
    return format === 'webm' ? 'video/webm' : 'video/mp4';
}

export function getExportFileExtension(format: 'mp4' | 'webm'): string {
    return `.${format}`;
}

function now(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
