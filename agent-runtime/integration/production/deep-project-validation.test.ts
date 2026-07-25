import { describe, expect, it, vi } from 'vitest';
import { createEmptyManagedCoreSnapshot } from '../core-editor-port.js';
import type { StateToken } from '../../mcp/contracts.js';
import type { CoordinatorCallContext } from '../../server/coordinator-adapter.js';
import type {
    ProductionDeepValidationPort,
    ProductionDeepValidationPorts,
} from './contracts.js';
import { createProductionProjectValidationAuthority } from './deep-project-validation.js';

describe('createProductionProjectValidationAuthority', () => {
    it('reports corrupt manifest structure and failed authoritative hydration canonically', async () => {
        const hydration = validator([{ code: 'manifest-hydration-missing' }]);
        const authority = createProductionProjectValidationAuthority(ports({ hydration }));

        const result = await authority.validateProject('project-production', {
            manifest: { version: 4 } as never,
            scopes: ['hydrated'],
            deep: true,
            state: state(),
        }, context());

        expect(result.valid).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'invalid-graph-shape',
                path: 'structural',
            }),
            expect.objectContaining({
                code: 'manifest-hydration-missing',
                path: 'hydrated',
            }),
        ]));
        expect(hydration.validate).toHaveBeenCalledOnce();
    });

    it('checks stale sources, history/WAL receipts, transcript CAS, and render outputs through ports', async () => {
        const authority = createProductionProjectValidationAuthority(ports({
            sources: validator([{ code: 'source-stale', subjectId: 'source-7' }]),
            historyWal: validator([{ code: 'receipt-wal-mismatch', subjectId: 'receipt-9' }]),
            transcriptPins: validator([{ code: 'transcript-record-missing', subjectId: 'sha256:abc' }]),
            renderability: validator([{ code: 'artifact-output-not-renderable', subjectId: 'artifact-2' }]),
        }));

        const result = await authority.validateProject('project-production', {
            manifest: manifest(),
            scopes: ['sources', 'history-wal', 'transcript-pins', 'renderability'],
            deep: true,
            state: state(),
        }, context());

        expect(result.valid).toBe(false);
        expect(result.issues.map((issue) => [issue.code, issue.path])).toEqual([
            ['receipt-wal-mismatch', 'history-wal.receipt-9'],
            ['artifact-output-not-renderable', 'renderability.artifact-2'],
            ['source-stale', 'sources.source-7'],
            ['transcript-record-missing', 'transcript-pins.sha256:abc'],
        ]);
    });

    it('does not invoke storage-owning ports unless deep validation is requested and honors scopes', async () => {
        const source = validator([{ code: 'source-stale' }]);
        const hydration = validator([{ code: 'manifest-hydration-missing' }]);
        const authority = createProductionProjectValidationAuthority(ports({ source, hydration }));

        const shallow = await authority.validateProject('project-production', {
            manifest: manifest(),
            scopes: ['all'],
            deep: false,
            state: state(),
        }, context());
        const deep = await authority.validateProject('project-production', {
            manifest: manifest(),
            scopes: ['hydrated'],
            deep: true,
            state: state(),
        }, context());

        expect(shallow).toEqual({ valid: true, issues: [] });
        expect(source.validate).not.toHaveBeenCalled();
        expect(hydration.validate).toHaveBeenCalledOnce();
        expect(deep.issues).toEqual([expect.objectContaining({ path: 'hydrated' })]);
    });

    it('bounds and sanitizes adapter findings instead of exposing private paths', async () => {
        const sources = validator(Array.from({ length: 200 }, (_, index) => ({
            code: 'source-stale',
            subjectId: index === 0 ? '/private/media.mov' : `source-${index}`,
        })));
        const authority = createProductionProjectValidationAuthority(ports({ sources }));

        const result = await authority.validateProject('project-production', {
            manifest: manifest(),
            scopes: ['sources'],
            deep: true,
            state: state(),
        }, context());

        expect(result.issues).toHaveLength(128);
        expect(result.issues.every((issue) => (
            !issue.path.includes('/')
            && !issue.path.includes('\\')
            && !issue.message.includes('/private')
        ))).toBe(true);
    });
});

function ports(
    overrides: Partial<Record<'hydration' | 'source' | 'sources' | 'historyWal' | 'transcriptPins' | 'renderability', ProductionDeepValidationPort>> = {},
): ProductionDeepValidationPorts {
    const fallback = validator([]);
    return {
        hydration: overrides.hydration ?? fallback,
        sources: overrides.sources ?? overrides.source ?? fallback,
        historyWal: overrides.historyWal ?? fallback,
        transcriptPins: overrides.transcriptPins ?? fallback,
        renderability: overrides.renderability ?? fallback,
    };
}

function validator(findings: readonly { code: string; subjectId?: string }[]): ProductionDeepValidationPort & {
    validate: ReturnType<typeof vi.fn>;
} {
    return { validate: vi.fn().mockResolvedValue(findings) };
}

function manifest() {
    return createEmptyManagedCoreSnapshot('project-production', 'epoch-production')
        .state.snapshot.manifest;
}

function state(): StateToken {
    return {
        sessionId: 'session-production',
        projectId: 'project-production',
        sessionEpoch: 'epoch-production',
        sessionRevision: 0,
        documentRevision: 0,
        audioGraphRevision: 0,
        eventCursor: '0',
    };
}

function context(): CoordinatorCallContext {
    return { signal: new AbortController().signal };
}
