import type { StateToken } from '../../coordinator/types';
import { managedError } from '../../coordinator/errors';
import type {
    DurableJobHandler,
    DurableJobRecord,
    DurableJobScheduler,
    DurableJobTerminalPublication,
    JobExecutionContext,
} from '../../jobs/durable-job-scheduler';
import { canonicalJson } from '../../persistence/canonical-json';
import type { StagedOutputDestinationCapabilityV1 } from '../../../src/types/waptions-agent-protocol';
import type {
    ManagedExportJobKind,
    ManagedExportJobService,
    ManagedExportKind,
    ManagedExportMaterial,
    ManagedExportSuccess,
    ManagedExportTerminalProposal,
} from './contracts';

/** Every registered export kind has its own handler so scheduler limits remain per kind. */
export const MANAGED_EXPORT_DURABLE_JOB_KINDS = [
    'export:mp4-h264-aac',
    'export:webm',
    'export:portable-bundle',
    'export:reference-snapshot',
    'export:proof-record',
] as const satisfies readonly ManagedExportJobKind[];

export type ManagedExportDurableJobKind = (typeof MANAGED_EXPORT_DURABLE_JOB_KINDS)[number];

/**
 * Closed, durable export request. Material is deliberately referenced rather than embedded:
 * portable bundles contain streaming functions and are not safe to serialize into a job record.
 */
export interface ManagedExportDurableJobInputV1 {
    readonly schemaVersion: 1;
    readonly kind: ManagedExportDurableJobKind;
    readonly projectId: string;
    /** Must equal the durable record ID once runtime composition can bind that ID before enqueue. */
    readonly jobId: string;
    readonly capturedState: StateToken;
    readonly destination: StagedOutputDestinationCapabilityV1;
    /** Opaque, composition-owned durable reference for recreating export material. */
    readonly materialReference: string;
}

export interface ManagedExportMaterialFactory {
    /**
     * Rebuilds non-serializable material from the opaque durable reference. Implementations must
     * be restart-safe and may only use composition-owned authorities, never caller filesystem
     * paths or persisted secrets.
     */
    resolveMaterial(
        input: ManagedExportDurableJobInputV1,
        execution: {
            readonly signal: AbortSignal;
            readonly onProgress: (update: {
                readonly stage: string;
                readonly fraction?: number;
            }) => void;
        },
    ): Promise<ManagedExportMaterial>;
    /** Releases resolver-owned temporary state after a failed or cancelled export. */
    cleanup?(input: ManagedExportDurableJobInputV1): Promise<void> | void;
}

export interface ManagedExportDurableJobResultV1 {
    readonly schemaVersion: 1;
    readonly job: ManagedExportSuccess;
    readonly artifactIds: readonly string[];
    /** Ordered proposal events retained for the composition terminal-event seam. */
    readonly events: ManagedExportTerminalProposal['events'];
}

export interface ManagedExportDurableHandlerDependencies {
    readonly service: ManagedExportJobService;
    readonly materials: ManagedExportMaterialFactory;
}

/**
 * Adapts an export proposal into the scheduler's atomic artifact/output terminal publication.
 *
 * Runtime composition seam (intentionally not wired here): register these handlers before
 * `scheduler.recover()`, restore and reconcile output staging first, and make the material
 * factory recreate its material reference after restart. The current scheduler does not expose
 * its generated record ID to handlers, so composition must bind `input.jobId` to that durable ID
 * before enqueueing. It also must extend its terminal transaction to persist `result.events` in
 * order with the artifact/output/job writes: `DurableJobTerminalPublication` currently carries
 * artifacts and outputs only. This module preserves those events without pretending to publish
 * them outside that missing composition seam.
 */
export class ManagedExportDurableJobHandler implements DurableJobHandler<
    ManagedExportDurableJobInputV1,
    never,
    ManagedExportDurableJobResultV1
> {
    constructor(
        readonly kind: ManagedExportDurableJobKind,
        private readonly dependencies: ManagedExportDurableHandlerDependencies,
    ) {}

    validateInput(input: ManagedExportDurableJobInputV1): void {
        validateManagedExportDurableJobInput(input, this.kind);
    }

    async run(
        input: ManagedExportDurableJobInputV1,
        context: JobExecutionContext<never>,
    ): Promise<{
        result: ManagedExportDurableJobResultV1;
        artifactIds: readonly string[];
        terminalPublication: DurableJobTerminalPublication;
    }> {
        this.validateInput(input);
        throwIfAborted(context.signal);

        let proposal: ManagedExportTerminalProposal | undefined;
        const publications: NonNullable<DurableJobTerminalPublication['outputs']>[number][] = [];
        let transferred = false;
        let progress = Promise.resolve();
        const onProgress = (update: { readonly stage: string; readonly fraction?: number }) => {
            progress = progress.then(() => context.update({
                stage: update.stage,
                ...(update.fraction === undefined ? {} : { fraction: update.fraction }),
            }));
        };
        try {
            const material = await this.dependencies.materials.resolveMaterial(input, {
                signal: context.signal,
                onProgress,
            });
            throwIfAborted(context.signal);
            proposal = await this.dependencies.service.prepare({
                projectId: input.projectId,
                jobId: input.jobId,
                exportKind: exportKindFor(input.kind),
                destination: input.destination,
                material,
                signal: context.signal,
                onProgress,
            });
            await progress;
            throwIfAborted(context.signal);
            validateProposal(input, proposal);

            // Publication is intentionally deferred until every export byte and artifact has
            // been staged. Scheduler persistence receives the prepared handles atomically.
            for (const output of proposal.outputs) {
                throwIfAborted(context.signal);
                publications.push(await output.preparePublication(context.signal));
            }
            throwIfAborted(context.signal);

            const artifactIds = Object.freeze(proposal.artifacts.map((artifact) => artifact.record.artifactId));
            const result = durableResult(proposal, artifactIds);
            const terminalPublication: DurableJobTerminalPublication = Object.freeze({
                artifacts: proposal.artifacts,
                outputs: Object.freeze([...publications]),
            });
            transferred = true;
            return { result, artifactIds, terminalPublication };
        } finally {
            if (!transferred) {
                await rejectProposal(proposal, publications);
                await this.cleanupInput(input);
            }
        }
    }

    async cleanup(record: DurableJobRecord<ManagedExportDurableJobInputV1>): Promise<void> {
        await this.cleanupInput(record.input);
    }

    private async cleanupInput(input: ManagedExportDurableJobInputV1): Promise<void> {
        await Promise.resolve(this.dependencies.materials.cleanup?.(input)).catch(() => undefined);
    }
}

export function createManagedExportDurableJobHandlers(
    dependencies: ManagedExportDurableHandlerDependencies,
): Readonly<Record<ManagedExportDurableJobKind, ManagedExportDurableJobHandler>> {
    return Object.freeze(Object.fromEntries(MANAGED_EXPORT_DURABLE_JOB_KINDS.map((kind) => [
        kind,
        new ManagedExportDurableJobHandler(kind, dependencies),
    ])) as Record<ManagedExportDurableJobKind, ManagedExportDurableJobHandler>);
}

/** Registers all five canonical export kinds before durable recovery begins. */
export function registerManagedExportDurableJobHandlers(
    scheduler: DurableJobScheduler,
    dependencies: ManagedExportDurableHandlerDependencies,
): Readonly<Record<ManagedExportDurableJobKind, ManagedExportDurableJobHandler>> {
    const handlers = createManagedExportDurableJobHandlers(dependencies);
    for (const kind of MANAGED_EXPORT_DURABLE_JOB_KINDS) scheduler.register(kind, handlers[kind]);
    return handlers;
}

/** Creates an immutable copy only after the full closed-schema validation succeeds. */
export function createManagedExportDurableJobInput(
    input: ManagedExportDurableJobInputV1,
): ManagedExportDurableJobInputV1 {
    validateManagedExportDurableJobInput(input);
    return Object.freeze({
        ...structuredClone(input),
        capturedState: Object.freeze(structuredClone(input.capturedState)),
        destination: Object.freeze(structuredClone(input.destination)),
    });
}

export function validateManagedExportDurableJobInput(
    input: ManagedExportDurableJobInputV1,
    expectedKind?: ManagedExportDurableJobKind,
): void {
    if (!isRecord(input)
        || !hasExactKeys(input, [
            'schemaVersion', 'kind', 'projectId', 'jobId', 'capturedState', 'destination',
            'materialReference',
        ])
        || input.schemaVersion !== 1
        || !isManagedExportDurableJobKind(input.kind)
        || (expectedKind !== undefined && input.kind !== expectedKind)
        || !isOpaqueId(input.projectId, 128)
        || !isOpaqueId(input.jobId, 128)
        || !isOpaqueId(input.materialReference, 256)
        || !validateStateToken(input.capturedState)
        || input.capturedState.projectId !== input.projectId
        || !validateDestination(input.destination)) {
        throw invalidInput();
    }
    assertPathAndSecretFree(input);
    canonicalJson(input, 512 * 1024);
}

function validateProposal(
    input: ManagedExportDurableJobInputV1,
    proposal: ManagedExportTerminalProposal,
): void {
    const expectedKind = input.kind;
    const expectedExportKind = exportKindFor(expectedKind);
    const artifactIds = proposal.artifacts.map((artifact) => artifact.record.artifactId);
    if (
        proposal.jobKind !== expectedKind
        || proposal.jobResult.jobKind !== expectedKind
        || proposal.jobResult.exportKind !== expectedExportKind
        || proposal.jobResult.jobId !== input.jobId
        || proposal.outputs.length !== 1
        || proposal.artifacts.length !== 1
        || proposal.outputs[0]?.outputId !== proposal.jobResult.outputId
        || proposal.outputs[0]?.contentDigest !== proposal.jobResult.contentDigest
        || proposal.outputs[0]?.byteLength !== proposal.jobResult.byteLength
        || proposal.artifacts[0]?.record.projectId !== input.projectId
        || proposal.artifacts[0]?.record.digest !== proposal.jobResult.contentDigest
        || proposal.artifacts[0]?.record.byteLength !== proposal.jobResult.byteLength
        || artifactIds[0] === undefined
        || !sameOrderedEventIds(proposal, artifactIds[0])
    ) {
        throw managedError('INVALID_REQUEST', 'Managed export terminal proposal is inconsistent.');
    }
}

function sameOrderedEventIds(
    proposal: ManagedExportTerminalProposal,
    artifactId: string,
): boolean {
    const [artifactCreated, jobChanged] = proposal.events;
    return proposal.events.length === 2
        && artifactCreated?.type === 'artifact.created'
        && artifactCreated.data.artifactId === artifactId
        && artifactCreated.data.outputId === proposal.jobResult.outputId
        && jobChanged?.type === 'job.changed'
        && jobChanged.data.jobId === proposal.jobResult.jobId
        && jobChanged.data.artifactId === artifactId
        && jobChanged.data.outputId === proposal.jobResult.outputId;
}

function durableResult(
    proposal: ManagedExportTerminalProposal,
    artifactIds: readonly string[],
): ManagedExportDurableJobResultV1 {
    const result: ManagedExportDurableJobResultV1 = {
        schemaVersion: 1,
        job: structuredClone(proposal.jobResult),
        artifactIds: Object.freeze([...artifactIds]),
        events: Object.freeze(proposal.events.map((event) => Object.freeze({
            type: event.type,
            data: Object.freeze(structuredClone(event.data)),
        }))),
    };
    assertPathAndSecretFree(result);
    canonicalJson(result, 1024 * 1024);
    return Object.freeze(result);
}

async function rejectProposal(
    proposal: ManagedExportTerminalProposal | undefined,
    publications: readonly NonNullable<DurableJobTerminalPublication['outputs']>[number][],
): Promise<void> {
    await Promise.allSettled([
        ...publications.map((publication) => publication.reject()),
        ...(proposal?.artifacts ?? []).map((artifact) => artifact.reject()),
        ...(proposal?.outputs ?? []).map((output) => output.abort()),
    ]);
}

function exportKindFor(kind: ManagedExportDurableJobKind): ManagedExportKind {
    return kind.slice('export:'.length) as ManagedExportKind;
}

function validateStateToken(value: unknown): value is StateToken {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'sessionId', 'projectId', 'sessionEpoch', 'sessionRevision', 'documentRevision',
            'audioGraphRevision', 'eventCursor',
        ], ['narrativeRevision'])) {
        return false;
    }
    return isOpaqueId(value.sessionId, 128)
        && isOpaqueId(value.projectId, 128)
        && isOpaqueId(value.sessionEpoch, 128)
        && isOpaqueId(value.eventCursor, 256)
        && nonNegativeSafeInteger(value.sessionRevision)
        && nonNegativeSafeInteger(value.documentRevision)
        && nonNegativeSafeInteger(value.audioGraphRevision)
        && (value.narrativeRevision === undefined || nonNegativeSafeInteger(value.narrativeRevision));
}

function validateDestination(value: unknown): value is StagedOutputDestinationCapabilityV1 {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'schemaVersion', 'destinationId', 'grantId', 'stagingHandleId', 'mode', 'outputName',
            'verifiedParentIdentity', 'expiresAt',
        ])
        || value.schemaVersion !== 1
        || value.mode !== 'create-only'
        || !isOpaqueId(value.destinationId, 256)
        || !isOpaqueId(value.grantId, 256)
        || !isOpaqueId(value.stagingHandleId, 256)
        || !isOpaqueId(value.verifiedParentIdentity, 256)
        || typeof value.outputName !== 'string'
        || !/^[^/\\\0]{1,255}$/.test(value.outputName)
        || !Number.isFinite(Date.parse(String(value.expiresAt)))
        || Date.parse(String(value.expiresAt)) <= Date.now()) {
        return false;
    }
    return true;
}

function assertPathAndSecretFree(value: unknown): void {
    const forbiddenKey = /(?:api.?key|authorization|password|secret|access.?token|refresh.?token|signed.?url|endpoint|(?:^|[_-])path$|(?:^|[_-])url$|(?:^|[_-])uri$)/i;
    const pathOrUrl = /^(?:[a-z][a-z0-9+.-]*:\/\/|file:|data:|blob:|\/|\\\\|[A-Za-z]:[\\/])/i;
    const seen = new Set<object>();
    const visit = (candidate: unknown, location: string): void => {
        if (typeof candidate === 'string') {
            if (pathOrUrl.test(candidate)) {
                throw managedError('INVALID_REQUEST', `Managed export input contains a path or URL at ${location}.`);
            }
            return;
        }
        if (candidate === null || typeof candidate !== 'object') return;
        if (seen.has(candidate)) {
            throw managedError('INVALID_REQUEST', 'Managed export input cannot contain cycles.');
        }
        seen.add(candidate);
        for (const [key, nested] of Object.entries(candidate)) {
            if (forbiddenKey.test(key)) {
                throw managedError('INVALID_REQUEST', `Managed export input contains sensitive field "${key}".`);
            }
            visit(nested, `${location}.${key}`);
        }
        seen.delete(candidate);
    };
    visit(value, '$');
}

function hasExactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): boolean {
    const keys = Object.keys(value);
    return required.every((key) => Object.hasOwn(value, key))
        && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isManagedExportDurableJobKind(value: unknown): value is ManagedExportDurableJobKind {
    return typeof value === 'string'
        && (MANAGED_EXPORT_DURABLE_JOB_KINDS as readonly string[]).includes(value);
}

function isOpaqueId(value: unknown, maximumLength: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximumLength
        && /^[A-Za-z0-9:_-]+$/.test(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidInput(): ReturnType<typeof managedError> {
    return managedError('INVALID_REQUEST', 'Managed export durable job input is invalid.');
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
