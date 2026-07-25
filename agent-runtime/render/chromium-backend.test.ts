import { describe, expect, it, vi } from 'vitest';

import { ChromiumWebCodecsRenderBackend } from './chromium-backend';

describe('Chromium WebCodecs render backend capability selection', () => {
    it('accepts the explicit deterministic descriptor fallback without claiming Chromium exists', async () => {
        const backend = new ChromiumWebCodecsRenderBackend(
            {
                probe: vi.fn().mockResolvedValue({
                    chromiumAvailable: false,
                    webCodecs: false,
                    h264Encoder: true,
                    aacEncoder: true,
                    mp4Muxer: true,
                    implementation: 'deterministic-ffmpeg-raw-descriptor',
                }),
                render: vi.fn(),
            },
            { authority: 'process-wide-decoded-memory-v1' } as never,
            {} as never,
        );

        await expect(backend.probe({} as never)).resolves.toMatchObject({
            supported: true,
            backend: 'chromium-webcodecs',
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
        });
    });

    it('keeps a missing Chromium/WebCodecs implementation unavailable without the fallback', async () => {
        const backend = new ChromiumWebCodecsRenderBackend(
            {
                probe: vi.fn().mockResolvedValue({
                    chromiumAvailable: false,
                    webCodecs: false,
                    h264Encoder: true,
                    aacEncoder: true,
                    mp4Muxer: true,
                }),
                render: vi.fn(),
            },
            { authority: 'process-wide-decoded-memory-v1' } as never,
            {} as never,
        );

        await expect(backend.probe({} as never)).resolves.toMatchObject({
            supported: false,
            backend: 'chromium-webcodecs',
        });
    });
});
