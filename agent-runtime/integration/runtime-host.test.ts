import { describe, expect, it, vi } from 'vitest';
import type { CanonicalToolCall, CoordinatorResult } from '../mcp/contracts.js';
import type { CoordinatorCallContext } from '../server/coordinator-adapter.js';
import { CanonicalToolRouter, type CanonicalToolHandler } from './canonical-tool-router.js';
import { ManagedRuntimeHost } from './runtime-host.js';
import { TOOL_NAMES } from '../mcp/constants.js';

function router(result: CoordinatorResult): CanonicalToolRouter {
    const handler = vi.fn<CanonicalToolHandler>().mockResolvedValue(result);
    return new CanonicalToolRouter({
        handlers: Object.fromEntries(TOOL_NAMES.map((name) => [name, handler])) as never,
    });
}

describe('ManagedRuntimeHost', () => {
    it('resolves the stable project receipt scope without evaluating mutation guards', async () => {
        const authority = { resolveProjectId: vi.fn().mockReturnValue('project-1') };
        const host = new ManagedRuntimeHost(authority, router({
            ok: false,
            error: { code: 'INVALID_REQUEST', message: 'unused', retryable: false },
        }));
        const call = mutationCall();

        await expect(host.resolveReceiptScope(call, context())).resolves.toEqual({
            ok: true,
            scope: {
                projectId: 'project-1',
                toolName: 'waptions_edit_apply',
                idempotencyKey: 'request-1',
            },
        });
        expect(authority.resolveProjectId).toHaveBeenCalledWith('session-1');
    });

    it('forwards the exact canonical call and request hash to the router', async () => {
        const expected: CoordinatorResult = {
            ok: false,
            error: { code: 'INVALID_REQUEST', message: 'expected', retryable: false },
        };
        const canonicalRouter = router(expected);
        const route = vi.spyOn(canonicalRouter, 'route');
        const host = new ManagedRuntimeHost(
            { resolveProjectId: () => 'project-1' },
            canonicalRouter,
        );
        const call = mutationCall();

        await expect(host.executeMutation({
            ...call,
            receiptScope: {
                projectId: 'project-1',
                toolName: call.toolName,
                idempotencyKey: call.identity.idempotencyKey,
            },
        }, context())).resolves.toBe(expected);
        expect(route.mock.calls[0]?.[0].requestHash).toBe(call.requestHash);
    });

    it('reports an unavailable event stream as a retryable coordinator failure', async () => {
        const host = new ManagedRuntimeHost(
            { resolveProjectId: () => 'project-1' },
            router({
                ok: false,
                error: { code: 'INVALID_REQUEST', message: 'unused', retryable: false },
            }),
        );

        expect(() => host.subscribeToEvents(
            'session-1',
            () => undefined,
            context(),
        )).toThrow(expect.objectContaining({
            code: 'COORDINATOR_UNAVAILABLE',
            retryable: true,
        }));
    });
});

function mutationCall() {
    const call: CanonicalToolCall & {
        mutation: true;
        identity: {
            sessionId: string;
            sessionEpoch: string;
            idempotencyKey: string;
            expected: { sessionRevision: number; documentRevision: number };
        };
    } = {
        toolName: 'waptions_edit_apply',
        request: { apiVersion: '2026-07-25' },
        canonicalRequest: '{"apiVersion":"2026-07-25"}',
        requestHash: `sha256:${'a'.repeat(64)}`,
        mutation: true,
        identity: {
            sessionId: 'session-1',
            sessionEpoch: 'epoch-1',
            idempotencyKey: 'request-1',
            expected: { sessionRevision: 0, documentRevision: 0 },
        },
    };
    return call;
}

function context(): CoordinatorCallContext {
    return { signal: new AbortController().signal };
}
