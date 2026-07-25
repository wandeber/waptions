import { validateEditorManifestV4 } from '../../../src/lib/editor-document-v4.js';
import type { EditorManifestV4 } from '../../../src/types/video.js';
import type {
    ManagedProjectValidationAuthority,
    ManagedProjectValidationIssue,
} from '../managed-tool-handlers.js';
import {
    PRODUCTION_VALIDATION_SCOPES,
    type ProductionDeepValidationPorts,
    type ProductionValidationFinding,
    type ProductionValidationScope,
} from './contracts.js';

const MAX_VALIDATION_ISSUES = 128;
const SAFE_CODE = /^[a-z][a-z0-9-]{0,127}$/;
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type DeepScope = Exclude<ProductionValidationScope, 'structural'>;

const DEEP_PORTS: Readonly<Record<DeepScope, keyof ProductionDeepValidationPorts>> = {
    hydrated: 'hydration',
    sources: 'sources',
    'history-wal': 'historyWal',
    'transcript-pins': 'transcriptPins',
    renderability: 'renderability',
};

/**
 * Builds the production deep-validation seam without taking filesystem, CAS, source, artifact,
 * or output ownership itself. Private authorities are injected and can therefore be configured
 * before recovery while this adapter only returns canonical MCP-safe findings.
 */
export function createProductionProjectValidationAuthority(
    ports: ProductionDeepValidationPorts,
): ManagedProjectValidationAuthority {
    assertValidationPorts(ports);
    return {
        validateProject: async (projectId, input, context) => {
            const scopes = normalizeScopes(input.scopes);
            const findings: ManagedProjectValidationIssue[] = structuralFindings(input.manifest);

            // A non-deep request deliberately stays inside the pure manifest validator. All
            // storage-owning checks require the caller to opt into the authoritative deep pass.
            if (input.deep) {
                for (const scope of scopes) {
                    if (scope === 'structural') continue;
                    const port = ports[DEEP_PORTS[scope]];
                    try {
                        const deepFindings = await port.validate({
                            projectId,
                            manifest: structuredClone(input.manifest),
                            state: { ...input.state },
                            context,
                            scope,
                        });
                        findings.push(...canonicalFindings(scope, deepFindings));
                    } catch (error) {
                        if (context.signal.aborted) throw error;
                        findings.push(issue(scope, 'authority-unavailable'));
                    }
                }
            }

            const issues = sortAndBound(findings);
            return {
                valid: issues.length === 0,
                issues,
            };
        },
    };
}

function assertValidationPorts(ports: ProductionDeepValidationPorts): void {
    if (!ports || typeof ports !== 'object') {
        throw new TypeError('Production validation ports are required.');
    }
    for (const name of Object.values(DEEP_PORTS)) {
        const port = ports[name];
        if (!port || typeof port.validate !== 'function') {
            throw new TypeError(`Production validation port "${name}" is required.`);
        }
    }
}

function normalizeScopes(scopes: readonly string[]): readonly ProductionValidationScope[] {
    const requested = new Set(scopes);
    const all = requested.has('all');
    // Structural validation is always local and pure, even when callers selected a deep scope.
    return PRODUCTION_VALIDATION_SCOPES.filter((scope) => (
        scope === 'structural' || all || requested.has(scope)
    ));
}

function structuralFindings(manifest: EditorManifestV4): ManagedProjectValidationIssue[] {
    const result = validateEditorManifestV4(manifest);
    return result.issues.map((finding) => issue(
        'structural',
        canonicalCode(finding.code),
    ));
}

function canonicalFindings(
    scope: DeepScope,
    findings: readonly ProductionValidationFinding[],
): ManagedProjectValidationIssue[] {
    if (!Array.isArray(findings)) {
        return [issue(scope, 'authority-invalid-response')];
    }
    return findings.map((finding) => issue(
        scope,
        canonicalCode(finding?.code),
        canonicalSubject(finding?.subjectId),
    ));
}

function issue(
    scope: ProductionValidationScope,
    code: string,
    subjectId?: string,
): ManagedProjectValidationIssue {
    const path = subjectId === undefined ? scope : `${scope}.${subjectId}`;
    return {
        code,
        path,
        // Do not forward adapter errors: they can contain a private path, capability, or endpoint.
        message: `Authoritative ${scope} validation reported ${code}.`,
    };
}

function canonicalCode(value: unknown): string {
    return typeof value === 'string' && SAFE_CODE.test(value)
        ? value
        : 'authority-invalid-finding';
}

function canonicalSubject(value: unknown): string | undefined {
    return typeof value === 'string' && SAFE_SUBJECT.test(value)
        ? value
        : undefined;
}

function sortAndBound(
    findings: readonly ManagedProjectValidationIssue[],
): readonly ManagedProjectValidationIssue[] {
    return findings
        .slice()
        .sort((left, right) => (
            left.path.localeCompare(right.path)
            || left.code.localeCompare(right.code)
        ))
        .slice(0, MAX_VALIDATION_ISSUES);
}
