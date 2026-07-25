import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ManagedMutationEnvelope, ManagedProjectEnvelopeV1, StateToken } from '../coordinator/types';
import { MANAGED_RUNTIME_API_VERSION, MANAGED_RUNTIME_SCHEMA_VERSION } from '../coordinator/types';
import { fakeSnapshot, type FakeEditorCommand, type FakeEditorState } from './fake-editor-port';

export async function temporaryRuntime(): Promise<{ path: string; cleanup(): Promise<void> }> {
    const path = await mkdtemp(join(tmpdir(), 'waptions-managed-runtime-'));
    return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export function testEnvelope(
    projectId = 'project-test',
    sessionId = 'session-test',
): ManagedProjectEnvelopeV1<FakeEditorState> {
    const now = new Date().toISOString();
    return {
        schemaVersion: MANAGED_RUNTIME_SCHEMA_VERSION,
        projectId,
        sessionId,
        name: 'Managed runtime test',
        createdAt: now,
        updatedAt: now,
        sessionRevision: 0,
        editor: fakeSnapshot(),
        eventSequence: 0,
        receiptRevision: 0,
        jobRevision: 0,
        artifactRevision: 0,
        grantRevision: 0,
        sourceRegistryRevision: 0,
        playback: {
            revision: 0,
            presenterViewId: null,
            playing: false,
            outputSample: 0,
            rate: 1,
            masterVolume: 1,
            masterMuted: false,
        },
        sourceRegistry: [],
        lastCoordinatorEpoch: 'initial',
        recoveryCount: 0,
    };
}

export function mutationRequest(
    token: StateToken,
    key: string,
    command: FakeEditorCommand = { append: key },
): ManagedMutationEnvelope<FakeEditorCommand> {
    return {
        apiVersion: MANAGED_RUNTIME_API_VERSION,
        sessionId: token.sessionId,
        sessionEpoch: token.sessionEpoch,
        expected: {
            sessionRevision: token.sessionRevision,
            documentRevision: token.documentRevision,
            audioGraphRevision: token.audioGraphRevision,
            narrativeRevision: token.narrativeRevision,
        },
        idempotencyKey: key,
        toolName: 'waptions_test_append',
        command,
    };
}
