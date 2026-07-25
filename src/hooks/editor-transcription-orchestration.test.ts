import { describe, expect, it, vi } from 'vitest';
import type { NormalizedDiarizedSpeaker } from '@/lib/ai/openai-compatible-diarization';
import type { DiarizationJobGuard } from '@/lib/diarization-provenance';
import { createTimelineDiarizationAudioSnapshot } from '@/lib/timeline-diarization-audio';
import type { EditorDocumentV3 } from '@/types/video';
import type { OpenAICompatibleTranscriptionSettings } from '@/types/transcription';
import {
    requestDiarizationFromBrowser,
    resolveEditorTranscriptionRoute,
    resolvePerSourceTranscriptionRequest,
    runDiarizedEditorTranscription,
    type EditorDiarizationOrchestrationDependencies,
} from './editor-transcription-orchestration';

const CUSTOM_SETTINGS: OpenAICompatibleTranscriptionSettings = {
    enabled: true,
    requestMode: 'server',
    endpoint: 'http://localhost:43556/v1/audio/transcriptions',
    apiKey: 'local-test-key',
    model: 'whisper-1',
};

const GUARD: DiarizationJobGuard = {
    audioGraphRevision: 1,
    audioGraphSignature: 'audio-graph',
    targetTrackId: 'subtitle-track',
    setIdentity: null,
    memberTrackIdsByOrdinal: ['subtitle-track'],
    memberTrackIdsInRelativeDocumentOrder: ['subtitle-track'],
    members: [{
        trackId: 'subtitle-track',
        trackSignature: 'track',
        provenanceSignature: null,
        extensionMetadataSignature: null,
    }],
};

const SPEAKERS: NormalizedDiarizedSpeaker[] = [{
    sourceSpeakerLabel: 'SPEAKER_00',
    subtitles: [{ id: 'timeline-subtitle', startTime: 0, endTime: 1, text: 'Hello' }],
    transcription: {
        raw: [{ id: 'raw-subtitle', startTime: 0, endTime: 1, text: 'Hello' }],
        groups: {
            container: [{ id: 'raw-subtitle', startTime: 0, endTime: 1, text: 'Hello' }],
        },
        containerIds: ['container'],
    },
}];

function makeDocument(): EditorDocumentV3 {
    return {
        renderProfile: { fps: { numerator: 30, denominator: 1 } },
        videoSources: [{ id: 'source-one' }, { id: 'source-two' }],
    } as unknown as EditorDocumentV3;
}

function makeDependencies(
    overrides: Partial<EditorDiarizationOrchestrationDependencies> = {},
): EditorDiarizationOrchestrationDependencies {
    return {
        captureSnapshot: vi.fn(createTimelineDiarizationAudioSnapshot),
        createGuard: vi.fn(() => GUARD),
        encodeAudio: vi.fn(async () => ({
            blob: new Blob(['encoded-audio'], { type: 'audio/mp4' }),
            filename: 'timeline-diarization.m4a',
            durationSeconds: 12,
            outputStartSample: 0,
            outputEndSample: 576_000,
        })),
        requestFromBrowser: vi.fn(async () => ({ diarization: { speaker_segments: [] } })),
        requestThroughServer: vi.fn(async () => ({ diarization: { speaker_segments: [] } })),
        normalize: vi.fn(() => SPEAKERS),
        now: vi.fn(() => new Date('2026-07-17T12:00:00.000Z')),
        ...overrides,
    };
}

function makeInput(
    controller: AbortController,
    overrides: Partial<Parameters<typeof runDiarizedEditorTranscription>[0]> = {},
) {
    return {
        document: makeDocument(),
        targetTrackId: 'subtitle-track',
        settings: CUSTOM_SETTINGS,
        signal: controller.signal,
        browserOrigin: 'http://localhost:59940',
        onStatus: vi.fn(),
        apply: vi.fn(() => true),
        ...overrides,
    };
}

describe('resolveEditorTranscriptionRoute', () => {
    it('keeps custom, local, and built-in routes mutually exclusive', () => {
        expect(resolveEditorTranscriptionRoute({
            routeId: 'custom-openai-compatible',
            customOpenAITranscription: CUSTOM_SETTINGS,
            diarizationEnabled: true,
        })).toMatchObject({ kind: 'diarized-custom', settings: CUSTOM_SETTINGS });

        expect(resolveEditorTranscriptionRoute({
            routeId: 'custom-openai-compatible',
            customOpenAITranscription: CUSTOM_SETTINGS,
            diarizationEnabled: false,
        })).toEqual({
            kind: 'per-source-custom',
            settings: CUSTOM_SETTINGS,
        });

        expect(resolveEditorTranscriptionRoute({ routeId: 'whisper-1' })).toEqual({
            kind: 'per-source-built-in',
            modelId: 'whisper-1',
        });

        const localBrowserTranscription = {
            enabled: true,
            engine: 'whisper-webgpu' as const,
            manifestId: 'local-whisper',
        };
        expect(resolveEditorTranscriptionRoute({
            routeId: 'local-browser',
            localBrowserTranscription,
        })).toEqual({
            kind: 'per-source-local',
            settings: localBrowserTranscription,
        });
    });

    it('keeps ordinary custom and built-in Whisper distinct through request dispatch', () => {
        const customBrowserRoute = resolveEditorTranscriptionRoute({
            routeId: 'custom-openai-compatible',
            customOpenAITranscription: { ...CUSTOM_SETTINGS, requestMode: 'browser' },
            diarizationEnabled: false,
        });
        const customServerRoute = resolveEditorTranscriptionRoute({
            routeId: 'custom-openai-compatible',
            customOpenAITranscription: CUSTOM_SETTINGS,
            diarizationEnabled: false,
        });
        const builtInRoute = resolveEditorTranscriptionRoute({ routeId: 'whisper-1' });

        if (customBrowserRoute.kind === 'diarized-custom'
            || customServerRoute.kind === 'diarized-custom'
            || builtInRoute.kind === 'diarized-custom') {
            throw new Error('Ordinary submissions must not resolve to diarization.');
        }

        expect(resolvePerSourceTranscriptionRequest(customBrowserRoute)).toEqual({
            kind: 'custom-browser',
            settings: { ...CUSTOM_SETTINGS, requestMode: 'browser' },
        });
        expect(resolvePerSourceTranscriptionRequest(customServerRoute)).toEqual({
            kind: 'server',
            transportModelId: 'whisper-1',
            customOpenAITranscription: CUSTOM_SETTINGS,
        });
        expect(resolvePerSourceTranscriptionRequest(builtInRoute)).toEqual({
            kind: 'server',
            transportModelId: 'whisper-1',
            customOpenAITranscription: null,
        });
    });
});

describe('runDiarizedEditorTranscription', () => {
    it('captures one snapshot and sends one server request for the complete project', async () => {
        const controller = new AbortController();
        const dependencies = makeDependencies();
        const input = makeInput(controller);

        await expect(runDiarizedEditorTranscription(input, dependencies)).resolves.toBe('applied');

        expect(dependencies.captureSnapshot).toHaveBeenCalledOnce();
        expect(dependencies.createGuard).toHaveBeenCalledOnce();
        expect(dependencies.encodeAudio).toHaveBeenCalledOnce();
        const capturedSnapshot = vi.mocked(dependencies.captureSnapshot).mock.results[0].value;
        expect(dependencies.createGuard).toHaveBeenCalledWith(capturedSnapshot, 'subtitle-track');
        expect(dependencies.encodeAudio).toHaveBeenCalledWith(
            capturedSnapshot,
            expect.objectContaining({ signal: controller.signal }),
        );
        expect(dependencies.requestThroughServer).toHaveBeenCalledOnce();
        expect(dependencies.requestFromBrowser).not.toHaveBeenCalled();
        expect(input.apply).toHaveBeenCalledOnce();
        expect(input.apply).toHaveBeenCalledWith(
            'subtitle-track',
            SPEAKERS,
            {
                provider: 'custom-openai-compatible',
                model: 'whisper-1',
                generatedAt: '2026-07-17T12:00:00.000Z',
            },
            GUARD,
        );
    });

    it('uses the direct browser request only in browser mode', async () => {
        const controller = new AbortController();
        const requestFromBrowser = vi.fn(async () => ({ diarization: { speaker_segments: [] } }));
        const dependencies = makeDependencies({
            encodeAudio: vi.fn(async () => ({
                blob: new Blob(['opus-audio'], { type: 'audio/webm' }),
                filename: 'timeline-diarization.webm',
                durationSeconds: 12,
                outputStartSample: 0,
                outputEndSample: 576_000,
            })),
            requestFromBrowser,
        });
        const input = makeInput(controller, {
            settings: { ...CUSTOM_SETTINGS, requestMode: 'browser' },
        });

        await expect(runDiarizedEditorTranscription(input, dependencies)).resolves.toBe('applied');

        expect(requestFromBrowser).toHaveBeenCalledOnce();
        expect(requestFromBrowser).toHaveBeenCalledWith(expect.objectContaining({
            audio: expect.objectContaining({ type: 'audio/webm' }),
            filename: 'timeline-diarization.webm',
            signal: controller.signal,
        }));
        expect(dependencies.requestThroughServer).not.toHaveBeenCalled();
    });

    it('reconciles window-local speaker labels only through overlapping word evidence', async () => {
        const controller = new AbortController();
        const windows = [{
            core: { startSample: 0, endSample: 48_000 },
            decoded: { startSample: 0, endSample: 80_000 },
        }, {
            core: { startSample: 48_000, endSample: 96_000 },
            decoded: { startSample: 32_000, endSample: 96_000 },
        }];
        const secondWindowSpeakers: NormalizedDiarizedSpeaker[] = [{
            sourceSpeakerLabel: 'SPEAKER_00',
            subtitles: [{ id: 'world', startTime: 0.5, endTime: 1, text: 'world' }],
            transcription: {
                raw: [
                    { id: 'context', startTime: 0.033, endTime: 0.233, text: 'Hello' },
                    { id: 'world', startTime: 0.5, endTime: 1, text: 'world' },
                ],
                groups: {
                    second: [{ id: 'world', startTime: 0.5, endTime: 1, text: 'world' }],
                },
                containerIds: ['second'],
            },
        }];
        const normalize = vi.fn()
            .mockReturnValueOnce(SPEAKERS)
            .mockReturnValueOnce(secondWindowSpeakers);
        const dependencies = makeDependencies({
            planWindows: vi.fn(() => windows),
            encodeWindow: vi.fn(async (_snapshot, window) => ({
                blob: new Blob(['window'], { type: 'audio/mp4' }),
                filename: 'timeline-diarization.m4a',
                durationSeconds: (
                    window.decoded.endSample - window.decoded.startSample
                ) / 48_000,
                outputStartSample: window.decoded.startSample,
                outputEndSample: window.decoded.endSample,
            })),
            normalize,
        });
        const input = makeInput(controller);

        await expect(runDiarizedEditorTranscription(input, dependencies)).resolves.toBe('applied');

        expect(dependencies.encodeWindow).toHaveBeenCalledTimes(2);
        expect(dependencies.encodeAudio).not.toHaveBeenCalled();
        expect(dependencies.requestThroughServer).toHaveBeenCalledTimes(2);
        const appliedSpeakers = vi.mocked(input.apply).mock.calls[0][1];
        expect(appliedSpeakers).toHaveLength(1);
        expect(appliedSpeakers[0].sourceSpeakerLabel).toBe('SPEAKER_00@0');
        expect(appliedSpeakers[0].transcription.raw.map(word => word.text))
            .toEqual(['Hello', 'world']);
    });

    it('preserves an Opus/WebM filename and MIME type at the browser multipart boundary', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const uploadedFile = (init?.body as FormData).get('file');
            expect(uploadedFile).toBeInstanceOf(File);
            expect((uploadedFile as File).name).toBe('timeline-diarization.webm');
            expect((uploadedFile as File).type).toBe('audio/webm');
            return new Response(JSON.stringify({ diarization: { speaker_segments: [] } }), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        await expect(requestDiarizationFromBrowser({
            settings: { ...CUSTOM_SETTINGS, requestMode: 'browser' },
            audio: new Blob(['opus-audio'], { type: 'audio/webm' }),
            filename: 'timeline-diarization.webm',
            signal: controller.signal,
        }, fetchImpl)).resolves.toEqual({ diarization: { speaker_segments: [] } });

        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it.each(['render', 'request', 'post-response'] as const)(
        'does not publish tracks when cancelled at the %s boundary',
        async (boundary) => {
            const controller = new AbortController();
            const apply = vi.fn(() => true);
            const normalize = vi.fn(() => SPEAKERS);
            const dependencyOverrides: Partial<EditorDiarizationOrchestrationDependencies> = {
                normalize,
            };
            if (boundary === 'render') {
                dependencyOverrides.encodeAudio = vi.fn(async () => {
                    controller.abort();
                    throw new DOMException('Cancelled', 'AbortError');
                });
            } else if (boundary === 'request') {
                dependencyOverrides.requestThroughServer = vi.fn(async () => {
                    controller.abort();
                    throw new DOMException('Cancelled', 'AbortError');
                });
            } else {
                dependencyOverrides.requestThroughServer = vi.fn(async () => {
                    controller.abort();
                    return { diarization: { speaker_segments: [] } };
                });
            }
            const dependencies = makeDependencies(dependencyOverrides);
            const input = makeInput(controller, { apply });

            await expect(runDiarizedEditorTranscription(input, dependencies))
                .rejects.toMatchObject({ name: 'AbortError' });

            expect(apply).not.toHaveBeenCalled();
            if (boundary === 'post-response') expect(normalize).not.toHaveBeenCalled();
        },
    );

    it('leaves tracks untouched for a no-speech response', async () => {
        const controller = new AbortController();
        const apply = vi.fn(() => true);
        const dependencies = makeDependencies({ normalize: vi.fn(() => []) });

        await expect(runDiarizedEditorTranscription(
            makeInput(controller, { apply }),
            dependencies,
        )).resolves.toBe('no-speech');

        expect(apply).not.toHaveBeenCalled();
    });

    it('leaves tracks untouched when normalization rejects a malformed response', async () => {
        const controller = new AbortController();
        const apply = vi.fn(() => true);
        const dependencies = makeDependencies({
            normalize: vi.fn(() => {
                throw new Error('The transcriber returned an unsupported diarization response.');
            }),
        });

        await expect(runDiarizedEditorTranscription(
            makeInput(controller, { apply }),
            dependencies,
        )).rejects.toThrow('unsupported diarization response');

        expect(apply).not.toHaveBeenCalled();
    });

    it('reports a stale guard without claiming the generated set was applied', async () => {
        const controller = new AbortController();
        const apply = vi.fn(() => false);
        const dependencies = makeDependencies();

        await expect(runDiarizedEditorTranscription(
            makeInput(controller, { apply }),
            dependencies,
        )).resolves.toBe('stale');

        expect(apply).toHaveBeenCalledOnce();
    });

    it('does not encode or request when the target guard cannot be created', async () => {
        const controller = new AbortController();
        const apply = vi.fn(() => true);
        const dependencies = makeDependencies({ createGuard: vi.fn(() => null) });

        await expect(runDiarizedEditorTranscription(
            makeInput(controller, { apply }),
            dependencies,
        )).resolves.toBe('stale');

        expect(dependencies.encodeAudio).not.toHaveBeenCalled();
        expect(dependencies.requestThroughServer).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });
});
