import {
    Output,
    Mp4OutputFormat,
    WebMOutputFormat,
    BufferTarget,
    CanvasSource,
    QUALITY_LOW,
    QUALITY_MEDIUM,
    QUALITY_HIGH,
    QUALITY_VERY_HIGH,
    Input,
    BlobSource,
    ALL_FORMATS,
    AudioSampleSource,
} from 'mediabunny';
import type { ExportOptions, ExportResult } from '@/types/export';
import { videoCache } from './video-cache';
import { renderSubtitles } from './subtitle-renderer';
import { waitForFonts } from './fonts/google-fonts';
import { AnimationStyle, Subtitle } from '@/types/timeline';

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
    format: 'mp4',
    quality: 'high',
    includeAudio: true,
};

const qualityMap = {
    low: QUALITY_LOW,
    medium: QUALITY_MEDIUM,
    high: QUALITY_HIGH,
    very_high: QUALITY_VERY_HIGH,
};


interface ExportContext {
    videoFile: File;
    subtitles: Subtitle[];
    animationStyle: AnimationStyle;
    options: ExportOptions;
}


/**
 * Export a video with subtitles using mediabunny.
 * Uses WebCodecs for fast encoding without FFmpeg.
 */
export async function exportProject(context: ExportContext): Promise<ExportResult> {
    const { videoFile, subtitles, animationStyle, options } = context;
    const { format, quality, fps: optionsFps, includeAudio, onProgress, onCancel } = options;

    try {
        console.log('exportProject started', { format, quality, duration: videoFile.size });

        // ENSURE FONTS ARE LOADED
        await waitForFonts([animationStyle.fontFamily]);

        // Get video info
        const input = new Input({
            source: new BlobSource(videoFile),
            formats: ALL_FORMATS,
        });

        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
            return { success: false, error: 'No video track found' };
        }

        const duration = await input.computeDuration();
        const packetStats = await videoTrack.computePacketStats(100);
        const videoFps = optionsFps ?? Math.round(packetStats.averagePacketRate);
        const canvasWidth = videoTrack.displayWidth;
        const canvasHeight = videoTrack.displayHeight;

        // Setup output
        const outputFormat = format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat();
        const output = new Output({
            format: outputFormat,
            target: new BufferTarget(),
        });

        // Create canvas for rendering
        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            return { success: false, error: 'Failed to create canvas context' };
        }

        // Add video track
        const videoSource = new CanvasSource(canvas, {
            codec: format === 'webm' ? 'vp9' : 'avc',
            bitrate: qualityMap[quality],
        });
        output.addVideoTrack(videoSource, { frameRate: videoFps });

        // Render each frame
        const totalFrames = Math.ceil(duration * videoFps);
        let cancelled = false;
        const mediaId = 'export-' + Date.now();

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

            // Get video frame
            const frame = await videoCache.getFrameAt(mediaId, videoFile, time);
            if (frame) {
                if (frameIndex % 10 === 0) console.log(`Rendering frame ${frameIndex}/${totalFrames} at ${time.toFixed(2)}s`);
                ctx.clearRect(0, 0, canvasWidth, canvasHeight);
                ctx.drawImage(frame.canvas, 0, 0, canvasWidth, canvasHeight);
            } else {
                console.warn(`No frame found at ${time.toFixed(2)}s`);
                // Fill with black if no frame available
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            }

            // Render subtitles on top
            renderSubtitles(ctx, subtitles, animationStyle, time, canvasWidth, canvasHeight);

            // Add frame to output
            const frameDuration = 1 / videoFps;
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
