import { describe, expect, it } from 'vitest';
import { RuntimeDiagnostics } from '../../diagnostics/runtime-diagnostics';
import { DurableJobScheduler } from '../../jobs/durable-job-scheduler';
import { ManagedFilesystemStore } from '../../persistence/managed-filesystem-store';
import {
    temporaryRuntime,
    testEnvelope,
} from '../../testing/runtime-test-helpers';
import type { ManagedTranscriptionJobInputV1 } from './contracts';
import {
    validateManagedTranscriptionJobInput,
} from './managed-transcription-job-handler';

describe('managed transcription durable input boundary', () => {
    it.each([
        {
            label: 'URL in endpoint capability',
            endpointCapabilityId:
                'transcription-endpoint:http://localhost:43556/v1/audio/transcriptions',
        },
        {
            label: 'Bearer value in credential capability',
            endpointCapabilityId:
                'transcription-endpoint:00000000-0000-4000-8000-000000000001',
            credentialCapabilityId: 'transcription-credential:Bearer credential-sentinel',
        },
        {
            label: 'API key in credential capability',
            endpointCapabilityId:
                'transcription-endpoint:00000000-0000-4000-8000-000000000001',
            credentialCapabilityId: 'transcription-credential:apiKey=credential-sentinel',
        },
    ])('rejects $label before a job file exists', async ({
        endpointCapabilityId,
        credentialCapabilityId,
    }) => {
        const runtime = await temporaryRuntime();
        try {
            const store = new ManagedFilesystemStore(runtime.path);
            await store.initialize();
            const envelope = testEnvelope('transcription-boundary-project');
            await store.createProject(envelope);
            const scheduler = new DurableJobScheduler(store, new RuntimeDiagnostics());
            scheduler.register('editorial-transcription', {
                validateInput: input => validateManagedTranscriptionJobInput(
                    input as ManagedTranscriptionJobInputV1,
                    'editorial-transcription',
                ),
                run: async () => {
                    throw new Error('invalid input reached execution');
                },
            });
            const input = jobInput(endpointCapabilityId, credentialCapabilityId);

            await expect(scheduler.enqueue({
                projectId: envelope.projectId,
                kind: 'editorial-transcription',
                input,
                inputDigest: `sha256:${'0'.repeat(64)}`,
                capturedState: input.capturedState,
                cancellable: true,
                resumable: true,
            })).rejects.toMatchObject({
                transcriptionCode: 'INVALID_INPUT',
            });
            await expect(store.readNamespace(
                envelope.projectId,
                'jobs',
            )).resolves.toEqual([]);
            await scheduler.close();
        } finally {
            await runtime.cleanup();
        }
    });
});

function jobInput(
    endpointCapabilityId: string,
    credentialCapabilityId?: string,
): ManagedTranscriptionJobInputV1 {
    return {
        schemaVersion: 1,
        kind: 'editorial-transcription',
        projectId: 'transcription-boundary-project',
        capturedState: {
            sessionId: 'session-1',
            projectId: 'transcription-boundary-project',
            sessionEpoch: 'epoch-1',
            sessionRevision: 1,
            documentRevision: 1,
            audioGraphRevision: 1,
            narrativeRevision: 1,
            eventCursor: 'event-1',
        },
        providerPolicy: {
            kind: 'managed-local-endpoint',
            endpointCapabilityId,
            ...(credentialCapabilityId ? { credentialCapabilityId } : {}),
        },
        language: 'es',
        speakerMode: 'none',
        contextSamples: 0,
        sources: [{
            sourceId: 'source-1',
            sourceFingerprint: `sha256:${'d'.repeat(64)}`,
            sourceSampleCount: 1_600,
            ranges: [{ startSample: 0, endSample: 1_600 }],
        }],
        targetIds: ['track-1'],
    };
}
