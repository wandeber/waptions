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
} from 'mediabunny';
import type { ExportOptions, ExportResult } from '@/types/export';
import type { SubtitleAnimationStyle } from '@/components/video-editor/subtitle-editor/types';
import { videoCache } from './video-cache';

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

export interface Subtitle {
    id: string;
    startTime: number;
    endTime: number;
    text: string;
}

interface ExportContext {
    videoFile: File;
    subtitles: Subtitle[];
    animationStyle: SubtitleAnimationStyle;
    options: ExportOptions;
}

/**
 * Render subtitles onto a canvas at a specific time.
 * Port from VideoViewport.tsx renderSubtitles logic.
 */
function renderSubtitles(
    ctx: CanvasRenderingContext2D,
    subtitles: Subtitle[],
    currentTime: number,
    canvasWidth: number,
    canvasHeight: number,
    animationStyle: SubtitleAnimationStyle
): void {
    // Find active subtitles at this time
    const activeSubtitles = subtitles.filter((subtitle) => {
        const isActive = currentTime >= subtitle.startTime && currentTime < subtitle.endTime;
        const isExiting = currentTime >= subtitle.endTime - animationStyle.fadeOutDuration
            && currentTime < subtitle.endTime;
        return isActive || isExiting;
    });

    if (activeSubtitles.length === 0) return;

    // Process text helper
    const processText = (text: string): string => {
        let result = text;
        if (animationStyle.textCase === 'uppercase') {
            result = result.toUpperCase();
        } else if (animationStyle.textCase === 'lowercase') {
            result = result.toLowerCase();
        }
        if (animationStyle.hidePunctuation) {
            const regex = new RegExp(
                `[${animationStyle.punctuationChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]`,
                'g'
            );
            result = result.replace(regex, '');
        }
        if (animationStyle.removeAccents) {
            result = result
                .replace(/[áàäâã]/g, 'a')
                .replace(/[éèëê]/g, 'e')
                .replace(/[íìïî]/g, 'i')
                .replace(/[óòöôõ]/g, 'o')
                .replace(/[úùüû]/g, 'u')
                .replace(/[ÁÀÄÂÃ]/g, 'A')
                .replace(/[ÉÈËÊ]/g, 'E')
                .replace(/[ÍÌÏÎ]/g, 'I')
                .replace(/[ÓÒÖÔÕ]/g, 'O')
                .replace(/[ÚÙÜÛ]/g, 'U');
        }
        return result;
    };

    // Easing functions
    const easeOutBack = (x: number): number => {
        if (!animationStyle.useElasticEffect) return x;
        const c1 = animationStyle.bounceStrength;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    };

    const easeOutExpo = (x: number): number => {
        return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
    };

    // Sort and get the timing bounds from active subtitles
    const sortedActive = [...activeSubtitles].sort((a, b) => a.startTime - b.startTime);
    const firstSubtitle = sortedActive[0];
    const lastSubtitle = sortedActive[sortedActive.length - 1];

    // Calculate opacity and scale based on animation timing
    let opacity = 1;
    let scale = 1;

    // Fade in with scale
    if (currentTime >= firstSubtitle.startTime
        && currentTime < firstSubtitle.startTime + animationStyle.fadeInDuration) {
        const progress = (currentTime - firstSubtitle.startTime) / animationStyle.fadeInDuration;
        opacity = easeOutExpo(progress);
        const scaleProgress = easeOutBack(progress);
        scale = 1 + ((animationStyle.initialScale - 1) * (1 - scaleProgress));
    }

    // Fade out
    if (currentTime >= lastSubtitle.endTime - animationStyle.fadeOutDuration
        && currentTime < lastSubtitle.endTime) {
        const progress = (lastSubtitle.endTime - currentTime) / animationStyle.fadeOutDuration;
        opacity = progress;
    }

    opacity = Math.max(0, Math.min(1, opacity));

    // Configure canvas context
    ctx.save();
    const x = (canvasWidth * animationStyle.position.x) / 100;
    const y = (canvasHeight * animationStyle.position.y) / 100;
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.translate(-x, -y);

    const fontSize = animationStyle.fontSize * (canvasHeight / 1080);
    const fontWeight = animationStyle.fontWeight;
    ctx.font = `${fontWeight} ${fontSize}px ${animationStyle.fontFamily}`;
    ctx.textAlign = animationStyle.textAlign;
    ctx.textBaseline = 'middle';

    // Get all lines from all active subtitles
    interface ProcessedLine {
        text: string;
        metrics: TextMetrics;
    }

    let allLines: ProcessedLine[] = [];
    for (const subtitle of sortedActive) {
        const text = processText(subtitle.text);
        const lines = text
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => ({
                text: line,
                metrics: ctx.measureText(line),
            }));
        allLines.push(...lines);
    }

    // Limit to configured number of lines
    allLines = allLines.slice(0, animationStyle.numberOfLines);

    if (allLines.length === 0) {
        ctx.restore();
        return;
    }

    // Calculate dimensions
    const maxLineWidth = Math.max(...allLines.map((line) => line.metrics.width));
    const lineHeight = fontSize * 1.2;
    const totalTextHeight = lineHeight * allLines.length;

    const padding = {
        vertical: animationStyle.backgroundMarginVertical,
        horizontal: animationStyle.backgroundMarginHorizontal,
    };
    const bgWidth = maxLineWidth + padding.horizontal * 2;
    const bgHeight = totalTextHeight + padding.vertical * 2;

    // Calculate background position
    let bgX: number;
    switch (animationStyle.textAlign) {
        case 'left':
            bgX = x - bgWidth / 2 + maxLineWidth / 2 + animationStyle.backgroundOffsetX;
            break;
        case 'right':
            bgX = x - bgWidth / 2 - maxLineWidth / 2 + animationStyle.backgroundOffsetX;
            break;
        default:
            bgX = x - bgWidth / 2 + animationStyle.backgroundOffsetX;
    }
    const bgY = y - bgHeight / 2 + animationStyle.backgroundOffsetY;

    // Draw background
    if (animationStyle.backgroundOpacity > 0) {
        ctx.fillStyle = `${animationStyle.backgroundColor}${Math.round(
            opacity * animationStyle.backgroundOpacity * 255
        )
            .toString(16)
            .padStart(2, '0')}`;

        if (animationStyle.backgroundBorderRadius > 0) {
            const radius = Math.min(animationStyle.backgroundBorderRadius, bgHeight / 2, bgWidth / 2);
            ctx.beginPath();
            ctx.moveTo(bgX + radius, bgY);
            ctx.lineTo(bgX + bgWidth - radius, bgY);
            ctx.quadraticCurveTo(bgX + bgWidth, bgY, bgX + bgWidth, bgY + radius);
            ctx.lineTo(bgX + bgWidth, bgY + bgHeight - radius);
            ctx.quadraticCurveTo(bgX + bgWidth, bgY + bgHeight, bgX + bgWidth - radius, bgY + bgHeight);
            ctx.lineTo(bgX + radius, bgY + bgHeight);
            ctx.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - radius);
            ctx.lineTo(bgX, bgY + radius);
            ctx.quadraticCurveTo(bgX + radius, bgY, bgX + radius, bgY);
            ctx.closePath();
            ctx.fill();

            if (animationStyle.backgroundBorderWidth > 0) {
                ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255)
                    .toString(16)
                    .padStart(2, '0')}`;
                ctx.lineWidth = animationStyle.backgroundBorderWidth;
                ctx.stroke();
            }
        } else {
            ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
            if (animationStyle.backgroundBorderWidth > 0) {
                ctx.strokeStyle = `${animationStyle.backgroundBorderColor}${Math.round(opacity * 255)
                    .toString(16)
                    .padStart(2, '0')}`;
                ctx.lineWidth = animationStyle.backgroundBorderWidth;
                ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
            }
        }
    }

    // Draw text
    ctx.strokeStyle = `${animationStyle.strokeColor}${Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0')}`;
    ctx.fillStyle = `${animationStyle.textColor}${Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0')}`;
    ctx.lineWidth = animationStyle.strokeWidth;

    let currentY = y - totalTextHeight / 2 + lineHeight / 2;
    allLines.forEach((line) => {
        ctx.strokeText(line.text, x, currentY);
        ctx.fillText(line.text, x, currentY);
        currentY += lineHeight;
    });

    ctx.restore();
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
        let audioSource: any = null;
        if (includeAudio) {
            const inputAudioTrack = await input.getPrimaryAudioTrack();
            if (inputAudioTrack) {
                const { getFirstEncodableAudioCodec, AudioSampleSource, AudioSampleSink } = await import('mediabunny');
                const codec = (await getFirstEncodableAudioCodec(['aac', 'opus'])) || 'aac';

                audioSource = new AudioSampleSource({
                    codec: codec as any,
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
            renderSubtitles(ctx, subtitles, time, canvasWidth, canvasHeight, animationStyle);

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
