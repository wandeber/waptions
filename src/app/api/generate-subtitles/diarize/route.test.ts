import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const actionMock = vi.hoisted(() => ({
    run: vi.fn(async () => ({ diarization: { speaker_segments: [] } })),
}));

vi.mock('@/lib/actions/generate-diarized-subtitles.action', () => ({
    GenerateDiarizedSubtitlesAction: actionMock,
}));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));

import { POST } from './route';

function request(form: FormData): NextRequest {
    return new NextRequest('http://localhost/api/generate-subtitles/diarize', {
        method: 'POST',
        body: form,
    });
}

describe('generate diarized subtitles route bounds', () => {
    beforeEach(() => actionMock.run.mockClear());

    it('accepts one bounded window and propagates the request signal', async () => {
        const form = new FormData();
        form.append('audio', new File(['audio'], 'window.m4a', { type: 'audio/mp4' }));
        const input = request(form);

        const response = await POST(input, { params: Promise.resolve({}) });

        expect(response.status).toBe(200);
        expect(actionMock.run).toHaveBeenCalledWith(expect.objectContaining({
            audioFile: expect.any(File),
            signal: input.signal,
        }), { user: null });
    });

    it('rejects duplicate and unsupported fields before provider work', async () => {
        const duplicate = new FormData();
        duplicate.append('audio', new File(['a'], 'a.m4a'));
        duplicate.append('audio', new File(['b'], 'b.m4a'));
        expect((await POST(request(duplicate), { params: Promise.resolve({}) })).status).toBe(400);

        const unknown = new FormData();
        unknown.append('audio', new File(['a'], 'a.m4a'));
        unknown.append('endpoint', 'http://localhost:8000');
        expect((await POST(request(unknown), { params: Promise.resolve({}) })).status).toBe(400);
        expect(actionMock.run).not.toHaveBeenCalled();
    });
});
