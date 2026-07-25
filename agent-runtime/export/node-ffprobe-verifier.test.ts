import { describe, expect, it } from 'vitest';
import {
    buildOwnedMp4FfprobeArgs,
    parseOwnedMp4Inspection,
} from './node-ffprobe-verifier';

describe('owned staged-output FFprobe verification', () => {
    it('uses only the inherited staged-output descriptor', () => {
        const args = buildOwnedMp4FfprobeArgs();

        expect(args).toContain('/dev/fd/3');
        expect(args).toContain('-count_frames');
        expect(args.join('\n')).not.toContain('pipe:3');
        expect(args.join('\n')).not.toContain('.mp4');
    });

    it('parses exact H.264/AAC/yuv420p/48k/stereo frame metadata', () => {
        const inspection = parseOwnedMp4Inspection(Buffer.from(JSON.stringify({
            streams: [
                {
                    index: 0,
                    codec_type: 'video',
                    codec_name: 'h264',
                    pix_fmt: 'yuv420p',
                    nb_read_frames: '30000',
                    duration: '1001.000000',
                },
                {
                    index: 1,
                    codec_type: 'audio',
                    codec_name: 'aac',
                    sample_rate: '48000',
                    channels: 2,
                    channel_layout: 'stereo',
                    duration: '1001.000000',
                },
            ],
            format: {
                format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
                duration: '1001.000000',
            },
        })));

        expect(inspection).toEqual({
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            pixelFormat: 'yuv420p',
            audioSampleRate: 48_000,
            audioChannels: 2,
            audioChannelLayout: 'stereo',
            videoFrameCount: 30_000,
            videoDurationSeconds: 1001,
            audioDurationSeconds: 1001,
            durationSeconds: 1001,
        });
    });

    it.each([
        {
            streams: [],
            format: { format_name: 'mov,mp4', duration: '1' },
        },
        {
            streams: [
                {
                    codec_type: 'video',
                    codec_name: 'h264',
                    pix_fmt: 'yuv420p',
                    nb_read_frames: 'not-a-number',
                    duration: '1',
                },
                {
                    codec_type: 'audio',
                    codec_name: 'aac',
                    sample_rate: '48000',
                    channels: 2,
                    channel_layout: 'stereo',
                    duration: '1',
                },
            ],
            format: { format_name: 'mov,mp4', duration: '1' },
        },
    ])('fails closed on incomplete or ambiguous probe metadata', (document) => {
        expect(() => parseOwnedMp4Inspection(
            Buffer.from(JSON.stringify(document)),
        )).toThrowError(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    });
});
