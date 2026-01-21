import {
    Input,
    ALL_FORMATS,
    BlobSource,
    VideoSampleSink,
    BufferTarget,
    Output,
    Mp4OutputFormat,
    AudioSampleSink,
    AudioSampleSource,
    getFirstEncodableAudioCodec,
    type AudioCodec
} from 'mediabunny';

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
}> {
    const input = new Input({
        source: new BlobSource(videoFile),
        formats: ALL_FORMATS,
    });

    const duration = await input.computeDuration();
    const videoTrack = await input.getPrimaryVideoTrack();

    if (!videoTrack) {
        throw new Error('No video track found in the file');
    }

    // Get frame rate from packet statistics (check more packets for accuracy)
    const packetStats = await videoTrack.computePacketStats(300);
    let fps = packetStats.averagePacketRate;

    // Help with common frame rates to avoid float jitter
    const commonFpss = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
    for (const common of commonFpss) {
        if (Math.abs(fps - common) < 0.1) {
            fps = common;
            break;
        }
    }

    // Calculate average bitrate (bits per second)
    const bitrate = duration > 0 ? Math.round((videoFile.size * 8) / duration) : 0;

    return {
        duration,
        width: videoTrack.displayWidth,
        height: videoTrack.displayHeight,
        fps,
        bitrate,
    };
}

/**
 * Generate a thumbnail from a video at a specific time.
 */
export async function generateThumbnail(
    videoFile: File,
    timeInSeconds: number
): Promise<string> {
    const input = new Input({
        source: new BlobSource(videoFile),
        formats: ALL_FORMATS,
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
        throw new Error('No video track found in the file');
    }

    const canDecode = await videoTrack.canDecode();
    if (!canDecode) {
        throw new Error('Video codec not supported for decoding');
    }

    const sink = new VideoSampleSink(videoTrack);
    const frame = await sink.getSample(timeInSeconds);

    if (!frame) {
        throw new Error('Could not get frame at specified time');
    }

    const originalWidth = videoTrack.displayWidth;
    const originalHeight = videoTrack.displayHeight;
    const aspectRatio = originalWidth / originalHeight;

    const canvas = document.createElement('canvas');
    const targetWidth = 400; // Slightly larger for better detail
    const targetHeight = targetWidth / aspectRatio;

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
        throw new Error('Could not get canvas context');
    }

    frame.draw(ctx, 0, 0, targetWidth, targetHeight);
    frame.close();

    return canvas.toDataURL('image/jpeg', 0.7);
}

/**
 * Extract audio track from video file as a separate blob for Whisper.
 * It decodes the original audio and re-encodes it as AAC/MP4.
 * This significantly reduces file size and ensures compatibility.
 */
export async function extractAudio(videoFile: File): Promise<Blob> {
    const input = new Input({
        source: new BlobSource(videoFile),
        formats: ALL_FORMATS,
    });

    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
        throw new Error('No audio track found in the file');
    }

    // We output to a buffer using Mp4 format (audio-only)
    const target = new BufferTarget();
    const output = new Output({
        format: new Mp4OutputFormat(),
        target: target,
    });

    // Setup transcoding to AAC (standard and small)
    const codec = (await getFirstEncodableAudioCodec(['aac', 'opus'])) || 'aac';
    const source = new AudioSampleSource({
        codec: codec as AudioCodec,
        bitrate: 128000,
    });

    output.addAudioTrack(source);

    // Use a sink to pull decoded samples from the input
    const sink = new AudioSampleSink(audioTrack);

    await output.start();

    // Loop through all samples and add them to the encoder
    for await (const sample of sink.samples()) {
        await source.add(sample);
        sample.close();
    }

    await output.finalize();

    if (!target.buffer) {
        throw new Error('Failed to extract audio buffer');
    }

    return new Blob([target.buffer], { type: 'audio/mp4' });
}
