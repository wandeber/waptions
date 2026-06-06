import {
    Output,
    Mp4OutputFormat,
    WebMOutputFormat,
    BufferTarget,
    CanvasSource,
    Input,
    BlobSource,
    ALL_FORMATS,
    AudioSampleSource,
} from 'mediabunny';
import type { ExportOptions, ExportResult } from '@/types/export';
import { videoCache } from './video-cache';
import { renderSubtitles } from './subtitle-renderer';
import { waitForFonts } from './fonts/google-fonts';
import { SubtitleTrack } from '@/types/timeline';

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
    format: 'mp4',
    quality: 'high',
    includeAudio: true,
};

interface ExportContext {
    videoFile: File;
    tracks: SubtitleTrack[];
    options: ExportOptions;
}


/**
 * Export a video with subtitles using mediabunny.
 * Uses WebCodecs for fast encoding without FFmpeg.
 */
export async function exportProject(context: ExportContext): Promise<ExportResult> {
    const { videoFile, tracks, options } = context;
    const { format, quality, fps: optionsFps, includeAudio, onProgress, onCancel } = options;

    try {
        // ENSURE FONTS ARE LOADED - Collect all unique fonts from tracks
        const uniqueFonts = Array.from(new Set(tracks.map(t => t.style.fontFamily)));
        await waitForFonts(uniqueFonts);

        // Get video info
        const input = new Input({
            source: new BlobSource(videoFile),
            formats: ALL_FORMATS,
        });

        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
            return { success: false, error: 'No video track found' };
        }

        const videoDuration = await input.computeDuration();

        // Calculate absolute content end from all tracks
        const lastSubEnd = tracks.reduce((max, track) => {
            const trackMax = track.subtitles.reduce((tMax, s) => Math.max(tMax, s.endTime), 0);
            return Math.max(max, trackMax);
        }, 0);

        const packetStats = await videoTrack.computePacketStats(100);
        const videoFps = optionsFps ?? Math.round(packetStats.averagePacketRate);
        const frameDuration = 1 / videoFps;

        // Align durations to frame boundaries for Sacred Frames
        const snappedVideoDuration = Math.round(videoDuration / frameDuration) * frameDuration;
        const snappedSubEnd = Math.round(lastSubEnd / frameDuration) * frameDuration;

        const exportDuration = Math.max(snappedVideoDuration, snappedSubEnd);
        const totalFrames = Math.round(exportDuration / frameDuration);

        const canvasWidth = videoTrack.displayWidth;
        const canvasHeight = videoTrack.displayHeight;
        const mediaId = 'export-' + Date.now();

        // Ensure VideoCache uses native resolution for this export mediaId
        videoCache.setTargetResolution(canvasWidth, canvasHeight, mediaId);

        // Calculate intelligent bitrate
        const sourceBitrate = videoDuration > 0 ? (videoFile.size * 8) / videoDuration : 5000000;
        const multipliers = { low: 0.5, medium: 0.8, high: 1.2, very_high: 2.0 };
        let targetBitrate = sourceBitrate * (multipliers[quality] || multipliers.high);

        const pixelCount = canvasWidth * canvasHeight;
        const baseBitrate = (pixelCount / (1920 * 1080)) * 10000000;
        const minBitrate = Math.max(500000, baseBitrate * 0.2);
        const maxBitrate = Math.max(50000000, baseBitrate * 5);
        targetBitrate = Math.max(minBitrate, Math.min(maxBitrate, targetBitrate));

        // Setup output
        const outputFormat = format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat();
        const output = new Output({
            format: outputFormat,
            target: new BufferTarget(),
        });

        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');

        if (!ctx) return { success: false, error: 'Failed to create canvas context' };

        const videoSource = new CanvasSource(canvas, {
            codec: format === 'webm' ? 'vp9' : 'avc',
            bitrate: Math.round(targetBitrate),
        });
        output.addVideoTrack(videoSource, { frameRate: videoFps });

        let cancelled = false;

        // Handle audio track if included
        let audioSource: AudioSampleSource | null = null;
        if (includeAudio) {
            const inputAudioTrack = await input.getPrimaryAudioTrack();
            if (inputAudioTrack) {
                const { getFirstEncodableAudioCodec, AudioSampleSource, AudioSampleSink } = await import('mediabunny');
                const codec = (await getFirstEncodableAudioCodec(['aac', 'opus'])) || 'aac';

                audioSource = new AudioSampleSource({
                    codec: codec as 'aac' | 'opus',
                    bitrate: 128000,
                });
                output.addAudioTrack(audioSource);

                // Start audio processing in background or interleaved
                // For simplicity in this implementation, we interleave or process after video
                const audioSink = new AudioSampleSink(inputAudioTrack);

                // Audio processing loop (independent from video loop but part of same output)
                (async () => {
                    try {
                        for await (const sample of audioSink.samples()) {
                            if (cancelled) break;
                            await audioSource.add(sample);
                            sample.close();
                        }
                    } catch (e) {
                        console.error('Audio encoding error:', e);
                    } finally {
                        audioSource?.close();
                    }
                })();
            }
        }

        await output.start();

        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            if (onCancel?.()) {
                cancelled = true;
                break;
            }

            const time = frameIndex / videoFps;

            // Get video frame - Only request if within video duration
            // Use a small epsilon to avoid floating point issues at exactly the end
            const isWithinVideo = time < snappedVideoDuration - (frameDuration / 2);
            const frame = isWithinVideo
                ? await videoCache.getFrameAt(mediaId, videoFile, time, { mode: 'export', fps: videoFps })
                : null;

            if (frame) {
                ctx.clearRect(0, 0, canvasWidth, canvasHeight);
                ctx.drawImage(frame.canvas, 0, 0, canvasWidth, canvasHeight);
            } else {
                // Fill with black if no frame available or beyond video duration
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            }

            // Render subtitles from all tracks on top
            tracks.forEach(track => {
                if (track.isVisible) {
                    renderSubtitles(ctx, track.subtitles, track.style, time, canvasWidth, canvasHeight);
                }
            });

            // Add frame to output
            await videoSource.add(time, frameDuration);

            onProgress?.(frameIndex / totalFrames);
        }

        // Cleanup
        videoCache.clearVideo(mediaId);

        if (cancelled) {
            await output.cancel();
            return { success: false, cancelled: true };
        }

        videoSource.close();
        await output.finalize();
        onProgress?.(1);

        return {
            success: true,
            buffer: output.target.buffer || undefined,
        };
    } catch (error) {
        console.error('Export failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown export error',
        };
    }
}

export function getExportMimeType(format: 'mp4' | 'webm'): string {
    return format === 'webm' ? 'video/webm' : 'video/mp4';
}

export function getExportFileExtension(format: 'mp4' | 'webm'): string {
    return `.${format}`;
}
