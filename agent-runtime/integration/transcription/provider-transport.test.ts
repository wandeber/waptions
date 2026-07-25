import { describe, expect, it, vi } from 'vitest';
import type {
    ManagedProviderRequest,
    ResolvedManagedEndpointCapability,
} from './contracts';
import { ManagedTranscriptionError } from './errors';
import { ManagedTranscriptionProvider } from './provider-transport';
import {
    EditorialProviderTimeoutError,
} from '../../../src/lib/editorial-transcription/server-provider-transport';

const endpoint: ResolvedManagedEndpointCapability = {
    capabilityId: 'transcription-endpoint:test',
    kind: 'local',
    endpoint: 'http://localhost:43556/v1/audio/transcriptions',
    endpointIdentityDigest: `sha256:${'1'.repeat(64)}`,
    scope: { projectId: 'project-1', sessionEpoch: 'epoch-1' },
    expiresAtMilliseconds: Date.now() + 10_000,
    pinnedLoopbackAddress: '127.0.0.1',
    pinnedLoopbackFamily: 4,
};

describe('managed transcription provider transport', () => {
    it('rejects redirects and never consumes their response body', async () => {
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            expect(init.redirect).toBe('error');
            return new Response(null, { status: 302 });
        });
        const provider = new ManagedTranscriptionProvider({ fetchImpl });

        await expect(provider.transcribe(requestFixture())).rejects.toMatchObject({
            transcriptionCode: 'PROVIDER_REJECTED',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('projects diarization evidence without retaining the provider response', async () => {
        const fetchImpl = vi.fn(async (...args: [string, RequestInit]) => {
            void args;
            return new Response(
                JSON.stringify(editMaxResponse()),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                },
            );
        });
        const provider = new ManagedTranscriptionProvider({ fetchImpl });
        const request = requestFixture();
        const result = await provider.transcribe({
            ...request,
            speakerMode: 'diarized',
            credential: {
                capabilityId: 'transcription-credential:test',
                secret: 'test-only-provider-secret',
                scope: endpoint.scope,
                endpointCapabilityId: endpoint.capabilityId,
                expiresAtMilliseconds: Date.now() + 10_000,
            },
        });

        expect(result.canonicalModel).toBe('qwen3-asr-1.7b');
        expect(result.words).toEqual([
            expect.objectContaining({
                text: 'hola',
                speaker: {
                    providerSpeakerId: 'SPEAKER_00',
                    evidenceKey: `${request.window.windowId}:SPEAKER_00`,
                },
            }),
        ]);
        const headers = fetchImpl.mock.calls[0][1]?.headers as Headers;
        expect(headers.get('authorization')).toBe('Bearer test-only-provider-secret');
        expect(JSON.stringify(result)).not.toContain('test-only-provider-secret');
        result.release();
        expect(provider.memoryBudget.snapshot().currentBytes).toBe(0);
    });

    it('maps arbitrary transport diagnostics to a closed error', async () => {
        const provider = new ManagedTranscriptionProvider({
            fetchImpl: async () => {
                throw new Error(
                    'http://localhost:43556 Bearer should-never-cross-boundary',
                );
            },
        });
        let caught: unknown;
        try {
            await provider.transcribe(requestFixture());
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ManagedTranscriptionError);
        expect((caught as Error).message).toBe(
            'The managed transcription provider is unreachable.',
        );
        expect((caught as Error).message).not.toContain('localhost');
    });

    it('rejects an adversarial response before parsing beyond the aggregate budget', async () => {
        const provider = new ManagedTranscriptionProvider({
            fetchImpl: async () => new Response('x'.repeat(512 * 1024), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        });

        await expect(provider.transcribe(requestFixture())).rejects.toMatchObject({
            transcriptionCode: 'PROVIDER_RESPONSE_TOO_LARGE',
        });
        expect(provider.memoryBudget.snapshot().peakBytes).toBeLessThanOrEqual(
            provider.memoryBudget.maxBytes,
        );
        provider.memoryBudget.assertDrained();
    });

    it('preserves the closed timeout and caller-cancellation classifications', async () => {
        const timedOut = new ManagedTranscriptionProvider({
            fetchImpl: async () => {
                throw new EditorialProviderTimeoutError();
            },
        });
        await expect(timedOut.transcribe(requestFixture())).rejects.toMatchObject({
            transcriptionCode: 'PROVIDER_TIMEOUT',
            retryable: true,
        });

        const controller = new AbortController();
        const cancelled = new ManagedTranscriptionProvider({
            fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    reject(new DOMException('cancelled', 'AbortError'));
                }, { once: true });
            }),
        });
        const request = requestFixture();
        const pending = cancelled.transcribe({ ...request, signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancelled.memoryBudget.snapshot().currentBytes).toBe(0);
    });
});

function requestFixture(): ManagedProviderRequest {
    const sampleCount = 16_000;
    return {
        endpoint,
        wav: new Blob([new Uint8Array(44 + sampleCount * 2)], { type: 'audio/wav' }),
        sourceFingerprint: `sha256:${'2'.repeat(64)}`,
        window: {
            windowId: `sha256:${'3'.repeat(64)}`,
            core: { startSample: 0, endSample: sampleCount },
            decoded: { startSample: 0, endSample: sampleCount },
            chunkRecordIds: [],
        },
        language: 'es',
        speakerMode: 'none',
        signal: new AbortController().signal,
    };
}

function editMaxResponse() {
    return {
        model: 'qwen3-asr-1.7b',
        text: 'hola',
        words: [{
            start: 0.1,
            end: 0.5,
            start_sample: 1_600,
            end_sample: 8_000,
            word: 'hola',
            probability: 0.95,
            speaker: 'SPEAKER_00',
        }],
        editing: {
            schema_version: 1,
            profile: 'edit-max-v1',
            requested_model: 'qwen-1.7b-edit-max',
            canonical_model: 'qwen3-asr-1.7b',
            timeline: {
                sample_rate_hz: 16_000,
                sample_count: 16_000,
                duration: 1,
                time_origin: 'decoded_audio_start',
            },
            speech_regions: [{
                id: 0,
                start_sample: 1_600,
                end_sample: 8_000,
                start: 0.1,
                end: 0.5,
                evidence: 'alignment_acoustic',
                word_start_index: 0,
                word_end_index: 1,
                vad_peak_probability: 0.95,
                vad_mean_probability: 0.9,
                start_energy_confirmed: true,
                end_energy_confirmed: true,
            }],
            edit_boundaries: [{
                region_id: 0,
                type: 'speech_start',
                sample: 1_600,
                time: 0.1,
                evidence: 'alignment_acoustic',
                energy_confirmed: true,
            }, {
                region_id: 0,
                type: 'speech_end',
                sample: 8_000,
                time: 0.5,
                evidence: 'alignment_acoustic',
                energy_confirmed: true,
            }],
        },
        diarization: {
            model: 'pyannote/speaker-diarization-community-1',
            device: 'cpu',
            num_speakers: 1,
            speakers: ['SPEAKER_00'],
            processing_seconds: 0.1,
            segments: [{ start: 0.1, end: 0.5, speaker: 'SPEAKER_00' }],
            speaker_segments: [],
        },
    };
}
