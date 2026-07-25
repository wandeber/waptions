import type {
    DurableJobEnqueueInput,
    DurableJobRecord,
    DurableJobScheduler,
} from '../../jobs/durable-job-scheduler';
import type {
    ManagedMutationEnvelope,
    ManagedMutationResult,
    StateToken,
} from '../../coordinator/types';
import { managedError } from '../../coordinator/errors';
import type {
    CanonicalToolCall,
    CoordinatorResult,
    JsonValue,
    ToolWarning,
} from '../../mcp/contracts';
import { STABLE_ERROR_CODES, type StableErrorCode } from '../../mcp/constants';
import { projectJobRecord } from '../canonical-projections';
import type { CoordinatorCallContext } from '../../server/coordinator-adapter';
import { canonicalDigest } from '../../persistence/canonical-json';
import { normalizeSampleRanges } from '../../../src/lib/editorial-transcription/range-coverage';
import type { HalfOpenSampleRange, Sha256Digest } from '../../../src/types/editorial';
import type {
    ManagedCredentialCapabilityAuthorityPort,
    ManagedEndpointCapabilityAuthorityPort,
    ManagedTranscriptionFactoryDependencies,
    ManagedTranscriptionJobInputV1,
    ManagedTranscriptionJobKind,
} from './contracts';
import { ManagedTranscriptionError } from './errors';
import { registerManagedTranscriptionJobHandlers } from './managed-transcription-job-handler';

const CONTEXT_SAMPLES = 2 * 16_000;
const CAPABILITY_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const MAX_SOURCES = 256;
const MAX_TARGETS = 256;
const MAX_RANGES = 256;

type CanonicalTranscriptionKind = 'editorial' | 'subtitle';
type CanonicalSpeakerMode = 'none' | 'diarized';

interface CanonicalRangeRequest {
    readonly sourceId: string;
    readonly startSample16k: number;
    readonly endSample16k: number;
}

interface CanonicalProviderPolicy {
    readonly kind: 'browser-local' | 'managed-local-endpoint' | 'openai-compatible';
    readonly endpointCapabilityId?: string;
    readonly credentialCapabilityId?: string;
    readonly model?: string;
}

interface CanonicalTranscriptionStartRequest {
    readonly apiVersion: '2026-07-25';
    readonly sessionId: string;
    readonly sessionEpoch: string;
    readonly expected: ManagedMutationEnvelope['expected'];
    readonly idempotencyKey: string;
    readonly transcriptionKind: CanonicalTranscriptionKind;
    readonly targetTrackIds: readonly string[];
    readonly ranges: readonly CanonicalRangeRequest[];
    readonly language: string | null;
    readonly speakerMode: CanonicalSpeakerMode;
    readonly providerPolicy: CanonicalProviderPolicy;
}

export interface ManagedTranscriptionStartSource {
    readonly sourceId: string;
    readonly sourceFingerprint: Sha256Digest;
    /** Length of the source-zero audio timeline on the canonical 16 kHz grid. */
    readonly sourceSampleCount: number;
}

/**
 * Core owns target authorization and source selection. This projection deliberately exposes
 * source identities only; paths, File objects, and decoded audio stay behind the media port.
 */
export interface ManagedTranscriptionStartCorePort {
    planStart(input: {
        readonly projectId: string;
        readonly capturedState: StateToken;
        readonly transcriptionKind: CanonicalTranscriptionKind;
        readonly targetTrackIds: readonly string[];
        readonly signal: AbortSignal;
    }): Promise<{
        readonly targetIds: readonly string[];
        readonly sources: readonly ManagedTranscriptionStartSource[];
    }>;
}

/**
 * Configuration values are read only at start time and converted straight into opaque,
 * process-local capabilities. Implementations must never return these values from a tool result.
 */
export interface ManagedTranscriptionProviderConfigurationPort {
    resolveLocalCredential?(input: {
        readonly credentialCapabilityId: string;
        readonly projectId: string;
        readonly sessionEpoch: string;
        readonly signal: AbortSignal;
    }): Promise<string>;
    resolveOpenAiCompatible?(input: {
        readonly endpointCapabilityId: string;
        readonly credentialCapabilityId?: string;
        readonly projectId: string;
        readonly sessionEpoch: string;
        readonly signal: AbortSignal;
    }): Promise<{
        readonly endpoint: string;
        readonly credential?: string;
    }>;
}

export interface ManagedTranscriptionStartCoordinatorPort {
    resolveProjectId(sessionId: string): string;
    getProject(projectId: string): { readonly state: StateToken };
    enqueueJob(
        projectId: string,
        request: ManagedMutationEnvelope,
        input: Omit<
            DurableJobEnqueueInput<ManagedTranscriptionJobInputV1>,
            'projectId' | 'capturedState'
        >,
    ): Promise<ManagedMutationResult<{
        readonly job: DurableJobRecord<ManagedTranscriptionJobInputV1>;
    }>>;
}

export interface ManagedTranscriptionStartServiceDependencies {
    readonly coordinator: ManagedTranscriptionStartCoordinatorPort;
    readonly core: ManagedTranscriptionStartCorePort;
    readonly endpoints: ManagedEndpointCapabilityAuthorityPort;
    readonly credentials: ManagedCredentialCapabilityAuthorityPort;
    readonly providerConfiguration?: ManagedTranscriptionProviderConfigurationPort;
}

/** Public tool seam and pre-recovery handler registration owned by runtime composition. */
export interface ManagedTranscriptionRegistrationBundle {
    readonly handler: (
        call: CanonicalToolCall,
        context: CoordinatorCallContext,
    ) => Promise<CoordinatorResult>;
    install(
        scheduler: DurableJobScheduler,
    ): ReturnType<typeof registerManagedTranscriptionJobHandlers>;
}

export interface ManagedTranscriptionIntegrationDependencies
extends ManagedTranscriptionStartServiceDependencies {
    /** CAS, retained-media, freshness and Core-publication ports consumed by the durable worker. */
    readonly jobDependencies: ManagedTranscriptionFactoryDependencies;
}

export class ManagedTranscriptionStartService {
    constructor(private readonly dependencies: ManagedTranscriptionStartServiceDependencies) {}

    async handle(
        call: CanonicalToolCall,
        context: CoordinatorCallContext,
    ): Promise<CoordinatorResult> {
        context.signal.throwIfAborted();
        const request = parseCanonicalRequest(call);
        const projectId = this.dependencies.coordinator.resolveProjectId(request.sessionId);
        const { state } = this.dependencies.coordinator.getProject(projectId);
        const planned = await this.dependencies.core.planStart({
            projectId,
            capturedState: state,
            transcriptionKind: request.transcriptionKind,
            targetTrackIds: request.targetTrackIds,
            signal: context.signal,
        });
        const input = await this.mapInput(request, projectId, state, planned, context.signal);
        const mintedCapabilities = capabilityIds(input.providerPolicy);
        try {
            const result = await this.dependencies.coordinator.enqueueJob(
                projectId,
                managedRequest(call, request),
                {
                    kind: input.kind,
                    input,
                    inputDigest: canonicalDigest(input, 512 * 1024),
                    cancellable: true,
                    resumable: true,
                },
            );
            // A receipt replay did not adopt this attempt's newly minted capabilities.
            if (!result.ok || result.replayed) revokeCapabilities(this.dependencies, mintedCapabilities);
            return projectMutationResult(result);
        } catch (error) {
            revokeCapabilities(this.dependencies, mintedCapabilities);
            throw error;
        }
    }

    private async mapInput(
        request: CanonicalTranscriptionStartRequest,
        projectId: string,
        capturedState: StateToken,
        planned: Awaited<ReturnType<ManagedTranscriptionStartCorePort['planStart']>>,
        signal: AbortSignal,
    ): Promise<ManagedTranscriptionJobInputV1> {
        const sources = mapSources(request.ranges, planned.sources);
        const targetIds = validateOpaqueIdList(planned.targetIds, MAX_TARGETS, 'Core transcription targets');
        if (sources.length === 0 || targetIds.length === 0) invalidRequest('No authorized transcription source or target is available.');
        const providerPolicy = await this.mapProviderPolicy(request.providerPolicy, {
            projectId,
            sessionEpoch: capturedState.sessionEpoch,
            signal,
        });
        return {
            schemaVersion: 1,
            kind: toManagedKind(request.transcriptionKind),
            projectId,
            capturedState: cloneState(capturedState),
            providerPolicy,
            language: request.language,
            speakerMode: request.speakerMode,
            contextSamples: CONTEXT_SAMPLES,
            sources,
            targetIds,
        };
    }

    private async mapProviderPolicy(
        policy: CanonicalProviderPolicy,
        scope: { readonly projectId: string; readonly sessionEpoch: string; readonly signal: AbortSignal },
    ): Promise<ManagedTranscriptionJobInputV1['providerPolicy']> {
        if (policy.model !== undefined) {
            invalidRequest('The managed transcription runtime uses its fixed editorial model.');
        }
        if (policy.kind === 'browser-local') {
            throw new ManagedTranscriptionError(
                'HEADLESS_BROWSER_LOCAL_UNAVAILABLE',
                false,
                'Browser-local transcription is unavailable in the headless managed runtime.',
            );
        }
        if (policy.kind === 'managed-local-endpoint') {
            if (policy.endpointCapabilityId !== undefined) {
                invalidRequest('The managed local endpoint is selected by the runtime and cannot be overridden.');
            }
            const credentialCapabilityId = policy.credentialCapabilityId === undefined
                ? undefined
                : await this.issueLocalCredential(policy.credentialCapabilityId, scope);
            // The worker mints the exact localhost default when this is omitted. Keeping only the
            // policy marker makes a recovered job safe without persisting a URL or endpoint token.
            return {
                kind: 'managed-local-endpoint',
                ...(credentialCapabilityId ? { credentialCapabilityId } : {}),
            };
        }
        if (policy.endpointCapabilityId === undefined) {
            invalidRequest('An OpenAI-compatible transcription endpoint reference is required.');
        }
        const resolver = this.dependencies.providerConfiguration?.resolveOpenAiCompatible;
        if (!resolver) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The managed OpenAI-compatible transcription configuration is unavailable.',
                true,
            );
        }
        const configured = await resolver({
            endpointCapabilityId: policy.endpointCapabilityId,
            ...(policy.credentialCapabilityId
                ? { credentialCapabilityId: policy.credentialCapabilityId }
                : {}),
            projectId: scope.projectId,
            sessionEpoch: scope.sessionEpoch,
            signal: scope.signal,
        });
        const endpointCapabilityId = await this.dependencies.endpoints.issue({
            endpoint: configured.endpoint,
            kind: 'server',
            scope: { projectId: scope.projectId, sessionEpoch: scope.sessionEpoch },
            lifetimeMilliseconds: CAPABILITY_LIFETIME_MS,
        });
        try {
            const credentialCapabilityId = configured.credential === undefined
                ? undefined
                : this.dependencies.credentials.issue({
                    secret: configured.credential,
                    scope: { projectId: scope.projectId, sessionEpoch: scope.sessionEpoch },
                    endpointCapabilityId,
                    lifetimeMilliseconds: CAPABILITY_LIFETIME_MS,
                });
            return {
                kind: 'managed-server-endpoint',
                endpointCapabilityId,
                ...(credentialCapabilityId ? { credentialCapabilityId } : {}),
            };
        } catch (error) {
            this.dependencies.endpoints.revoke(endpointCapabilityId);
            throw error;
        }
    }

    private async issueLocalCredential(
        credentialReference: string,
        scope: { readonly projectId: string; readonly sessionEpoch: string; readonly signal: AbortSignal },
    ): Promise<string> {
        const resolve = this.dependencies.providerConfiguration?.resolveLocalCredential;
        if (!resolve) {
            throw managedError(
                'COORDINATOR_UNAVAILABLE',
                'The managed local transcription credential authority is unavailable.',
                true,
            );
        }
        const secret = await resolve({
            credentialCapabilityId: credentialReference,
            projectId: scope.projectId,
            sessionEpoch: scope.sessionEpoch,
            signal: scope.signal,
        });
        return this.dependencies.credentials.issue({
            secret,
            scope: { projectId: scope.projectId, sessionEpoch: scope.sessionEpoch },
            lifetimeMilliseconds: CAPABILITY_LIFETIME_MS,
        });
    }
}

export function createManagedTranscriptionIntegration(
    dependencies: ManagedTranscriptionIntegrationDependencies,
): ManagedTranscriptionRegistrationBundle {
    const service = new ManagedTranscriptionStartService(dependencies);
    return Object.freeze({
        handler: service.handle.bind(service),
        // Runtime composition calls this during ManagedCoordinator.start(), before scheduler.recover().
        install: (scheduler: DurableJobScheduler) => registerManagedTranscriptionJobHandlers(
            scheduler,
            dependencies.jobDependencies,
        ),
    });
}

function parseCanonicalRequest(call: CanonicalToolCall): CanonicalTranscriptionStartRequest {
    if (call.toolName !== 'waptions_transcription_start') {
        invalidRequest('The transcription integration received a different canonical tool.');
    }
    if (!isDigest(call.requestHash)) invalidRequest('The canonical request hash is invalid.');
    const request = requiredRecord(call.request, 'canonical transcription request');
    const apiVersion = requiredString(request, 'apiVersion');
    if (apiVersion !== '2026-07-25') invalidRequest('The managed transcription API version is unsupported.');
    const rangesValue = request.ranges;
    const ranges = rangesValue === undefined
        ? []
        : parseRanges(rangesValue);
    return {
        apiVersion,
        sessionId: requiredOpaqueId(request, 'sessionId'),
        sessionEpoch: requiredOpaqueId(request, 'sessionEpoch'),
        expected: parseExpectedRevisions(requiredRecord(request.expected, 'expected revisions')),
        idempotencyKey: requiredOpaqueId(request, 'idempotencyKey'),
        transcriptionKind: enumValue(request, 'transcriptionKind', ['editorial', 'subtitle']),
        targetTrackIds: validateOpaqueIdList(requiredArray(request, 'targetTrackIds'), MAX_TARGETS, 'targetTrackIds'),
        ranges,
        language: parseLanguage(request.language),
        speakerMode: enumValue(request, 'speakerMode', ['none', 'diarized']),
        providerPolicy: parseProviderPolicy(requiredRecord(request.providerPolicy, 'providerPolicy')),
    };
}

function parseRanges(value: unknown): readonly CanonicalRangeRequest[] {
    if (!Array.isArray(value) || value.length > MAX_RANGES) invalidRequest('The transcription ranges are invalid.');
    return value.map((candidate) => {
        const range = requiredRecord(candidate, 'transcription range');
        assertExactKeys(range, ['sourceId', 'startSample16k', 'endSample16k'], 'transcription range');
        const startSample16k = requiredSafeInteger(range, 'startSample16k');
        const endSample16k = requiredSafeInteger(range, 'endSample16k');
        if (startSample16k < 0 || endSample16k <= startSample16k) {
            invalidRequest('The transcription range must be a non-empty half-open interval.');
        }
        return {
            sourceId: requiredOpaqueId(range, 'sourceId'),
            startSample16k,
            endSample16k,
        };
    });
}

function parseProviderPolicy(value: Record<string, unknown>): CanonicalProviderPolicy {
    const kind = enumValue(value, 'kind', [
        'browser-local',
        'managed-local-endpoint',
        'openai-compatible',
    ]);
    const allowed = ['kind', 'endpointCapabilityId', 'credentialCapabilityId', 'model'];
    assertOnlyKeys(value, allowed, 'providerPolicy');
    const endpointCapabilityId = optionalOpaqueId(value, 'endpointCapabilityId');
    const credentialCapabilityId = optionalOpaqueId(value, 'credentialCapabilityId');
    const model = value.model === undefined ? undefined : requiredNonEmptyString(value, 'model');
    if (kind === 'browser-local' && (endpointCapabilityId || credentialCapabilityId || model)) {
        invalidRequest('Browser-local transcription does not accept managed provider references.');
    }
    return {
        kind,
        ...(endpointCapabilityId ? { endpointCapabilityId } : {}),
        ...(credentialCapabilityId ? { credentialCapabilityId } : {}),
        ...(model ? { model } : {}),
    };
}

function mapSources(
    requestedRanges: readonly CanonicalRangeRequest[],
    plannedSources: readonly ManagedTranscriptionStartSource[],
): readonly ManagedTranscriptionJobInputV1['sources'][number][] {
    if (!Array.isArray(plannedSources) || plannedSources.length === 0 || plannedSources.length > MAX_SOURCES) {
        invalidRequest('Core did not provide valid transcription sources.');
    }
    const sources = new Map<string, ManagedTranscriptionStartSource>();
    for (const source of plannedSources) {
        if (
            !source
            || !isOpaqueId(source.sourceId)
            || !isDigest(source.sourceFingerprint)
            || !Number.isSafeInteger(source.sourceSampleCount)
            || source.sourceSampleCount <= 0
            || sources.has(source.sourceId)
        ) {
            invalidRequest('Core did not provide valid transcription source identities.');
        }
        sources.set(source.sourceId, source);
    }
    const rangesBySource = new Map<string, HalfOpenSampleRange[]>();
    for (const range of requestedRanges) {
        const source = sources.get(range.sourceId);
        if (!source) invalidRequest('A requested transcription range is not authorized for this job.');
        const ranges = rangesBySource.get(range.sourceId) ?? [];
        ranges.push({ startSample: range.startSample16k, endSample: range.endSample16k });
        rangesBySource.set(range.sourceId, ranges);
    }
    const selected = requestedRanges.length === 0
        ? Array.from(sources.values()).map(source => ({
            source,
            ranges: [{ startSample: 0, endSample: source.sourceSampleCount }],
        }))
        : Array.from(rangesBySource.entries()).map(([sourceId, ranges]) => ({
            source: sources.get(sourceId)!,
            ranges,
        }));
    return selected.map(({ source, ranges }) => ({
        sourceId: source.sourceId,
        sourceFingerprint: source.sourceFingerprint,
        sourceSampleCount: source.sourceSampleCount,
        ranges: normalizeRanges(ranges, source.sourceSampleCount),
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function normalizeRanges(
    ranges: readonly HalfOpenSampleRange[],
    sourceSampleCount: number,
): readonly HalfOpenSampleRange[] {
    try {
        return normalizeSampleRanges(ranges, sourceSampleCount);
    } catch {
        invalidRequest('A transcription range is outside the authorized source timeline.');
    }
}

function managedRequest(
    call: CanonicalToolCall,
    request: CanonicalTranscriptionStartRequest,
): ManagedMutationEnvelope<{ readonly kind: 'transcription-start' }> {
    return {
        apiVersion: request.apiVersion,
        sessionId: request.sessionId,
        sessionEpoch: request.sessionEpoch,
        expected: request.expected,
        idempotencyKey: request.idempotencyKey,
        toolName: call.toolName,
        canonicalRequestHash: call.requestHash,
        command: { kind: 'transcription-start' },
    };
}

function projectMutationResult(
    result: ManagedMutationResult<{ readonly job: DurableJobRecord<ManagedTranscriptionJobInputV1> }>,
): CoordinatorResult {
    if (!result.ok) {
        return {
            ok: false,
            error: {
                code: canonicalErrorCode(result.error.code),
                message: result.error.message,
                retryable: result.error.retryable,
            },
            ...(result.state ? { state: cloneState(result.state) } : {}),
        };
    }
    const job = projectJobRecord(result.data.job);
    return {
        ok: true,
        data: { jobId: job.jobId, job: job as unknown as JsonValue },
        state: cloneState(result.state),
        ...(result.committedState ? { committedState: cloneState(result.committedState) } : {}),
        warnings: result.warnings.map(message => toolWarning(message)),
        replayed: result.replayed,
    };
}

function capabilityIds(policy: ManagedTranscriptionJobInputV1['providerPolicy']): {
    readonly endpoint?: string;
    readonly credential?: string;
} {
    return policy.kind === 'browser-local'
        ? {}
        : {
            ...(policy.kind === 'managed-server-endpoint'
                ? { endpoint: policy.endpointCapabilityId }
                : {}),
            ...(policy.credentialCapabilityId ? { credential: policy.credentialCapabilityId } : {}),
        };
}

function revokeCapabilities(
    dependencies: Pick<ManagedTranscriptionStartServiceDependencies, 'endpoints' | 'credentials'>,
    capabilities: { readonly endpoint?: string; readonly credential?: string },
): void {
    if (capabilities.credential) dependencies.credentials.revoke(capabilities.credential);
    if (capabilities.endpoint) dependencies.endpoints.revoke(capabilities.endpoint);
}

function parseExpectedRevisions(value: Record<string, unknown>): ManagedMutationEnvelope['expected'] {
    assertOnlyKeys(value, [
        'sessionRevision',
        'documentRevision',
        'audioGraphRevision',
        'narrativeRevision',
    ], 'expected revisions');
    return {
        sessionRevision: requiredSafeInteger(value, 'sessionRevision'),
        documentRevision: requiredSafeInteger(value, 'documentRevision'),
        ...(value.audioGraphRevision === undefined
            ? {}
            : { audioGraphRevision: requiredSafeInteger(value, 'audioGraphRevision') }),
        ...(value.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: requiredSafeInteger(value, 'narrativeRevision') }),
    };
}

function parseLanguage(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 64 || value !== value.trim().toLowerCase()) {
        invalidRequest('The transcription language must be normalized.');
    }
    return value;
}

function toManagedKind(kind: CanonicalTranscriptionKind): ManagedTranscriptionJobKind {
    return kind === 'editorial' ? 'editorial-transcription' : 'subtitle-transcription';
}

function validateOpaqueIdList(
    value: readonly unknown[],
    maximum: number,
    label: string,
): readonly string[] {
    if (value.length === 0 || value.length > maximum) invalidRequest(`${label} are invalid.`);
    const ids = value.map((candidate) => {
        if (typeof candidate !== 'string' || !isOpaqueId(candidate)) invalidRequest(`${label} contain an invalid identifier.`);
        return candidate;
    });
    if (new Set(ids).size !== ids.length) invalidRequest(`${label} must be unique.`);
    return ids;
}

function cloneState(value: StateToken): StateToken {
    return {
        sessionId: value.sessionId,
        projectId: value.projectId,
        sessionEpoch: value.sessionEpoch,
        sessionRevision: value.sessionRevision,
        documentRevision: value.documentRevision,
        audioGraphRevision: value.audioGraphRevision,
        ...(value.narrativeRevision === undefined ? {} : { narrativeRevision: value.narrativeRevision }),
        eventCursor: value.eventCursor,
    };
}

function toolWarning(message: string): ToolWarning {
    return {
        code: 'PARTIAL_RESULT',
        message: message.slice(0, 1_024) || 'The result was normalized.',
    };
}

function canonicalErrorCode(code: string): StableErrorCode {
    return (STABLE_ERROR_CODES as readonly string[]).includes(code)
        ? code as StableErrorCode
        : 'INTERNAL_ERROR';
}

function enumValue<const Value extends string>(
    value: Record<string, unknown>,
    key: string,
    allowed: readonly Value[],
): Value {
    const candidate = value[key];
    if (typeof candidate !== 'string' || !allowed.includes(candidate as Value)) {
        invalidRequest(`The ${key} value is invalid.`);
    }
    return candidate as Value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) invalidRequest(`The ${label} is invalid.`);
    return value;
}

function requiredArray(value: Record<string, unknown>, key: string): readonly unknown[] {
    const candidate = value[key];
    if (!Array.isArray(candidate)) invalidRequest(`The ${key} field is invalid.`);
    return candidate;
}

function requiredString(value: Record<string, unknown>, key: string): string {
    const candidate = value[key];
    if (typeof candidate !== 'string' || !candidate) invalidRequest(`The ${key} field is invalid.`);
    return candidate;
}

function requiredNonEmptyString(value: Record<string, unknown>, key: string): string {
    const candidate = requiredString(value, key);
    if (candidate !== candidate.trim()) invalidRequest(`The ${key} field is invalid.`);
    return candidate;
}

function requiredOpaqueId(value: Record<string, unknown>, key: string): string {
    const candidate = requiredString(value, key);
    if (!isOpaqueId(candidate)) invalidRequest(`The ${key} field is invalid.`);
    return candidate;
}

function optionalOpaqueId(value: Record<string, unknown>, key: string): string | undefined {
    if (value[key] === undefined) return undefined;
    return requiredOpaqueId(value, key);
}

function requiredSafeInteger(value: Record<string, unknown>, key: string): number {
    const candidate = value[key];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
        invalidRequest(`The ${key} field is invalid.`);
    }
    return candidate as number;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        invalidRequest(`The ${label} fields are invalid.`);
    }
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    if (Object.keys(value).some(key => !keys.includes(key))) invalidRequest(`The ${label} fields are invalid.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpaqueId(value: string): boolean {
    return value.length > 0
        && value.length <= 256
        && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value);
}

function isDigest(value: string): value is Sha256Digest {
    return /^sha256:[a-f0-9]{64}$/.test(value);
}

function invalidRequest(message: string): never {
    throw managedError('INVALID_REQUEST', message);
}
