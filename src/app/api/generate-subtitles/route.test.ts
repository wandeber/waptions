import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TRANSCRIPTION_REQUEST_MAX_BYTES } from '@/lib/ai/transcription-http-policy';

const actionMock = vi.hoisted(() => ({
    run: vi.fn(async () => ({ subtitles: [] })),
}));

vi.mock('@/lib/actions/generate-subtitles.action', () => ({
    GenerateSubtitlesAction: actionMock,
}));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));

import { POST } from './route';

function request(form: FormData): NextRequest {
    return new NextRequest('http://localhost/api/generate-subtitles', {
        method: 'POST',
        body: form,
    });
}

describe('generate subtitles route bounds', () => {
    beforeEach(() => actionMock.run.mockClear());

    it('accepts one exact bounded window and propagates cancellation', async () => {
        const form = new FormData();
        form.append('audio', new File(['wav'], 'window.wav', { type: 'audio/wav' }));
        form.append('model', 'whisper-1');
        const input = request(form);

        const response = await POST(input, { params: Promise.resolve({}) });

        expect(response.status).toBe(200);
        expect(actionMock.run).toHaveBeenCalledWith(expect.objectContaining({
            audioFile: expect.any(File),
            model: 'whisper-1',
            signal: input.signal,
        }), { user: null });
    });

    it('rejects oversized, duplicate, and unknown fields before provider work', async () => {
        const oversized = request(new FormData());
        oversized.headers.set('content-length', String(TRANSCRIPTION_REQUEST_MAX_BYTES + 1));
        expect((await POST(oversized, { params: Promise.resolve({}) })).status).toBe(413);

        const duplicate = new FormData();
        duplicate.append('audio', new File(['a'], 'a.wav'));
        duplicate.append('audio', new File(['b'], 'b.wav'));
        expect((await POST(request(duplicate), { params: Promise.resolve({}) })).status).toBe(400);

        const unknown = new FormData();
        unknown.append('audio', new File(['a'], 'a.wav'));
        unknown.append('surprise', 'value');
        expect((await POST(request(unknown), { params: Promise.resolve({}) })).status).toBe(400);
        expect(actionMock.run).not.toHaveBeenCalled();
    });
});
