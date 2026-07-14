import {
    AudioSampleSource,
    BufferTarget,
    CanvasSource,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
    getFirstEncodableAudioCodec,
} from 'mediabunny';
import type {
    ExportOptions,
    ExportProjectRequest,
    ExportResult,
    LegacyExportProjectContext,
} from '@/types/export';
import type { ClipPlacement, EditorDocumentV3, RationalFrameRate } from '@/types/video';
import { videoCache } from './video-cache';
import { renderSubtitles } from './subtitle-renderer';
import { waitForFonts } from './fonts/google-fonts';
import {
    buildClipPlacements,
    getSourceFrameAtOrBefore,
    getTimelineContentEndFrame,
    projectTimeToSourceTime,
    resolveClipAtProjectTime,
} from './video-timeline';
import { calculateActiveTimelineBitrate } from './export-bitrate';
import { frameToOutputSample } from './audio-timebase';
import { framesToSeconds, normalizeFrameRate } from './render-profile';
import { TimelineAudioRenderer } from './timeline-audio-renderer';

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
    format: 'mp4',
    quality: 'high',
    includeAudio: true,
};

class ExportCancelledError extends Error {
    constructor() {
        super('Export was cancelled.');
        this.name = 'AbortError';
    }
}

/** Exact exclusive content boundary shared by the timeline, playback, and export. */
export function getExportContentEndFrame(document: EditorDocumentV3): number {
    return getTimelineContentEndFrame(document.videoClips, document.subtitleTracks, {
        renderProfile: document.renderProfile,
        videoSources: document.videoSources,
        audioSources: document.audioSources,
        audioTracks: document.audioTracks,
    });
}

/**
 * Resolves the visual clip for one canonical output frame.
 *
 * Returning null is deliberate: export paints the canvas black before every frame, so subtitle
 * and independent-audio tails continue at the locked canvas size after the video program ends.
 */
export function resolveExportVideoPlacement(
    document: EditorDocumentV3,
    frameIndex: number,
): ClipPlacement | null {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return null;
    const placements = buildClipPlacements(document.videoClips, document.renderProfile.fps);
    return resolveClipAtProjectTime(
        placements,
        framesToSeconds(frameIndex, document.renderProfile.fps),
    );
}

/** Exports the complete v3 editor graph with deterministic video, subtitle, and audio tails. */
export async function exportProject(request: ExportProjectRequest): Promise<ExportResult> {
    let output: Output | null = null;
    let videoSource: CanvasSource | null = null;
    let audioSource: AudioSampleSource | null = null;
    let outputTarget: BufferTarget | null = null;
    let videoSourceClosed = false;
    let audioSourceClosed = false;
    const mediaIds = new Set<string>();

    const closeVideoSource = (): void => {
        if (!videoSource || videoSourceClosed) return;
        videoSource.close();
        videoSourceClosed = true;
    };
    const closeAudioSource = (): void => {
        if (!audioSource || audioSourceClosed) return;
        audioSource.close();
        audioSourceClosed = true;
    };

    try {
        const document = normalizeExportRequest(request);
        const { format, quality, includeAudio = true, onProgress, onCancel } = request.options;
        if (document.videoClips.length === 0) {
            return { success: false, error: 'The timeline has no video clips.' };
        }

        const sourcesById = new Map(document.videoSources.map((source) => [source.id, source]));
        const firstSource = sourcesById.get(document.videoClips[0].sourceId);
        if (!firstSource) return { success: false, error: 'The first clip source is missing.' };

        await waitForFonts(Array.from(new Set(
            document.subtitleTracks.map((track) => track.style.fontFamily),
        )));
        throwIfCancelled(onCancel);

        const frameRate = document.renderProfile.fps;
        const frameRateNumber = frameRate.numerator / frameRate.denominator;
        const contentEndFrame = getExportContentEndFrame(document);
        const audioEndSample = frameToOutputSample(contentEndFrame, frameRate);
        const placements = buildClipPlacements(document.videoClips, frameRate);
        const canvasWidth = document.renderProfile.width;
        const canvasHeight = document.renderProfile.height;

        const sourceBitrate = calculateActiveTimelineBitrate(document.videoSources, document.videoClips);
        const multipliers = { low: 0.5, medium: 0.8, high: 1.2, very_high: 2.0 };
        const baseBitrate = canvasWidth * canvasHeight / (1920 * 1080) * 10_000_000;
        const targetBitrate = Math.max(
            Math.max(500_000, baseBitrate * 0.2),
            Math.min(Math.max(50_000_000, baseBitrate * 5), sourceBitrate * multipliers[quality]),
        );

        outputTarget = new BufferTarget();
        output = new Output({
            format: format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat(),
            target: outputTarget,
        });
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const context2d = canvas.getContext('2d');
        if (!context2d) throw new Error('Failed to create canvas context.');

        videoSource = new CanvasSource(canvas, {
            codec: format === 'webm' ? 'vp9' : 'avc',
            bitrate: Math.round(targetBitrate),
        });
        output.addVideoTrack(videoSource, { frameRate: frameRateNumber });

        if (includeAudio) {
            const requiredCodec = format === 'webm' ? 'opus' : 'aac';
            const codec = await getFirstEncodableAudioCodec([requiredCodec]);
            if (!codec) {
                throw new Error(`${requiredCodec.toUpperCase()} audio encoding is unavailable.`);
            }
            // The track is always present when requested, even if the mix plan has no audible
            // contributors. TimelineAudioRenderer then emits exact zero-valued samples through
            // the exclusive content boundary instead of silently omitting the track.
            audioSource = new AudioSampleSource({ codec, bitrate: 128_000 });
            output.addAudioTrack(audioSource);
        }

        await output.start();
        const exportId = crypto.randomUUID();
        for (let frameIndex = 0; frameIndex < contentEndFrame; frameIndex += 1) {
            throwIfCancelled(onCancel);
            const projectTime = framesToSeconds(frameIndex, frameRate);
            const nextProjectTime = framesToSeconds(frameIndex + 1, frameRate);
            const placement = resolveClipAtProjectTime(placements, projectTime);
            const activeSource = placement ? sourcesById.get(placement.clip.sourceId) ?? null : null;

            // Paint first on every iteration. If video ended before subtitle or audio content,
            // this black frame becomes the stable visual tail on which subtitles still render.
            context2d.fillStyle = '#000';
            context2d.fillRect(0, 0, canvasWidth, canvasHeight);
            if (placement && activeSource) {
                const sourceFrame = getSourceFrameAtOrBefore(
                    projectTimeToSourceTime(placement, projectTime),
                    activeSource.fps,
                    activeSource.duration,
                );
                const mediaId = `export:${exportId}:${activeSource.id}`;
                mediaIds.add(mediaId);
                videoCache.setTargetResolution(canvasWidth, canvasHeight, mediaId);
                const frame = await videoCache.getFrameAt(
                    mediaId,
                    activeSource.file,
                    sourceFrame.time,
                    { mode: 'export', fps: activeSource.fps },
                );
                if (frame) {
                    const sourceRatio = activeSource.width / activeSource.height;
                    const canvasRatio = canvasWidth / canvasHeight;
                    const drawWidth = canvasRatio > sourceRatio ? canvasHeight * sourceRatio : canvasWidth;
                    const drawHeight = canvasRatio > sourceRatio ? canvasHeight : canvasWidth / sourceRatio;
                    context2d.drawImage(
                        frame.canvas,
                        (canvasWidth - drawWidth) / 2,
                        (canvasHeight - drawHeight) / 2,
                        drawWidth,
                        drawHeight,
                    );
                }
            }

            document.subtitleTracks.forEach((track) => {
                if (track.isVisible) {
                    renderSubtitles(
                        context2d,
                        track.subtitles,
                        track.style,
                        projectTime,
                        canvasWidth,
                        canvasHeight,
                    );
                }
            });
            await videoSource.add(projectTime, nextProjectTime - projectTime);
            onProgress?.((frameIndex + 1) / contentEndFrame * 0.8);
        }
        closeVideoSource();

        if (audioSource) {
            const renderer = new TimelineAudioRenderer(document, audioSource);
            await renderer.render({
                outputEndSample: audioEndSample,
                shouldCancel: onCancel,
                onProgress: (progress) => onProgress?.(0.8 + progress * 0.18),
            });
            closeAudioSource();
        }

        throwIfCancelled(onCancel);
        await output.finalize();
        onProgress?.(1);
        return { success: true, buffer: outputTarget.buffer || undefined };
    } catch (error) {
        if (isAbortError(error)) return { success: false, cancelled: true };
        console.error('Export failed:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown export error' };
    } finally {
        // Sources signal track completion to Mediabunny and must be closed even if setup, frame
        // decoding, audio decoding, or encoding fails. Output.cancel releases encoders/muxers for
        // every non-finalized state; it is safe to await here because this is the terminal cleanup.
        closeVideoSource();
        closeAudioSource();
        if (output && output.state !== 'finalized' && output.state !== 'canceled') {
            try {
                await output.cancel();
            } catch (cleanupError) {
                console.error('Failed to cancel export output during cleanup:', cleanupError);
            }
        }
        mediaIds.forEach((mediaId) => videoCache.clearVideo(mediaId));
    }
}

function normalizeExportRequest(request: ExportProjectRequest): EditorDocumentV3 {
    if ('document' in request) return request.document;
    return migrateLegacyExportContext(request);
}

/** Keeps the existing UI compiling while WP9 moves it to the canonical store snapshot. */
function migrateLegacyExportContext(request: LegacyExportProjectContext): EditorDocumentV3 {
    const firstSource = request.videoSources.find((source) => (
        source.id === request.videoClips[0]?.sourceId
    ));
    const frameRate = decimalFrameRateToRational(
        request.options.fps ?? firstSource?.fps ?? 30,
    );
    const audioSourcesById = new Map(request.videoSources.map((source) => [source.id, source]));
    return {
        version: 3,
        revision: 1,
        audioGraphRevision: 1,
        renderProfile: {
            fps: frameRate,
            width: firstSource?.width ?? 1920,
            height: firstSource?.height ?? 1080,
            audioSampleRate: 48_000,
            isFrameRateLocked: firstSource !== undefined,
            isCanvasSizeLocked: firstSource !== undefined,
        },
        subtitleTracks: request.tracks.map((track) => ({ ...track, timingDomain: 'video-ripple' })),
        videoSources: request.videoSources,
        videoClips: request.videoClips.map((clip) => ({
            ...clip,
            audio: audioSourcesById.get(clip.sourceId)?.hasAudio ? {
                linkState: 'linked',
                muted: false,
                gainDb: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
            } : null,
        })),
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: request.tracks[0]?.id ?? null,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
}

function decimalFrameRateToRational(fps: number): RationalFrameRate {
    if (!Number.isFinite(fps) || fps <= 0) return { numerator: 30, denominator: 1 };
    const broadcastRates = [24_000, 30_000, 60_000, 120_000];
    const broadcast = broadcastRates.find((numerator) => Math.abs(fps - numerator / 1_001) < 0.001);
    if (broadcast) return { numerator: broadcast, denominator: 1_001 };
    return normalizeFrameRate({ numerator: Math.round(fps * 1_000_000), denominator: 1_000_000 });
}

function throwIfCancelled(onCancel?: () => boolean): void {
    if (onCancel?.()) throw new ExportCancelledError();
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export function getExportMimeType(format: 'mp4' | 'webm'): string {
    return format === 'webm' ? 'video/webm' : 'video/mp4';
}

export function getExportFileExtension(format: 'mp4' | 'webm'): string {
    return `.${format}`;
}
