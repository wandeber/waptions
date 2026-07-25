import { validateHydratedEditorDocumentV4 } from '@/lib/editor-document-v4';
import { EditorialTranscriptionCoordinator } from '@/lib/editorial-transcription/orchestrator';
import type { RationalDuration } from '@/lib/editorial-transcription/pcm';
import type { EditorialPcmWindowDecoder } from '@/lib/storage/editorial-pcm-window-cache';
import {
    EditorialTranscriptRepository,
} from '@/lib/storage/editorial-transcript-repository';
import type {
    ResolvedEditorialTranscriptMapV1,
    ResolvedEditorialTranscriptRecordBodyV1,
    Sha256Digest,
} from '@/types/editorial';
import type { EditorDocumentV4 } from '@/types/video';

export interface TimelineEditorialProjectContext {
    projectId: string;
    persistenceGeneration: number;
    sessionId: string;
}

export interface TimelineEditorialRuntimeDependencies {
    repository?: EditorialTranscriptRepository;
    coordinator?: EditorialTranscriptionCoordinator;
    quietWindowDecoder?: EditorialPcmWindowDecoder | null;
}

/**
 * Runtime-only transcript/body boundary shared by project load, planners, and history navigation.
 *
 * This service is intentionally not a Zustand slice. Consequently bodies, endpoint state,
 * credentials, PCM windows, and acquisition errors are unreachable from ordinary store/history
 * serialization. The document retains only descriptors and stable record IDs.
 */
export class TimelineEditorialRuntime {
    private repository: EditorialTranscriptRepository;
    private coordinator: EditorialTranscriptionCoordinator;
    private quietWindowDecoder: EditorialPcmWindowDecoder | null;
    private context: TimelineEditorialProjectContext | null = null;
    private bodies = new Map<Sha256Digest, ResolvedEditorialTranscriptRecordBodyV1>();
    private navigationSerial = 0;

    constructor(dependencies: TimelineEditorialRuntimeDependencies = {}) {
        this.repository = dependencies.repository ?? new EditorialTranscriptRepository();
        this.coordinator = dependencies.coordinator ?? new EditorialTranscriptionCoordinator({
            repository: this.repository,
        });
        this.quietWindowDecoder = dependencies.quietWindowDecoder ?? null;
    }

    configure(dependencies: TimelineEditorialRuntimeDependencies): void {
        if (dependencies.repository) this.repository = dependencies.repository;
        if (dependencies.coordinator) this.coordinator = dependencies.coordinator;
        if (Object.prototype.hasOwnProperty.call(dependencies, 'quietWindowDecoder')) {
            this.quietWindowDecoder = dependencies.quietWindowDecoder ?? null;
        }
    }

    attachProject(context: TimelineEditorialProjectContext): void {
        if (this.context?.projectId !== context.projectId
            || this.context.persistenceGeneration !== context.persistenceGeneration
            || this.context.sessionId !== context.sessionId) {
            this.bodies.clear();
            this.navigationSerial += 1;
        }
        this.context = { ...context };
    }

    async detachProject(): Promise<void> {
        const context = this.context;
        this.context = null;
        this.bodies.clear();
        this.navigationSerial += 1;
        if (context) {
            await this.coordinator.releaseSessionPins(context.projectId, context.sessionId);
        }
    }

    async releaseCurrentSessionPins(): Promise<void> {
        const context = this.context;
        if (context) await this.coordinator.releaseSessionPins(context.projectId, context.sessionId);
    }

    getProjectContext(): TimelineEditorialProjectContext | null {
        return this.context ? { ...this.context } : null;
    }

    getCoordinator(): EditorialTranscriptionCoordinator {
        return this.coordinator;
    }

    getRepository(): EditorialTranscriptRepository {
        return this.repository;
    }

    getQuietWindowDecoder(): EditorialPcmWindowDecoder | null {
        return this.quietWindowDecoder;
    }

    getStatus(): { hydratedRecordCount: number; quietAssistedRefinementAvailable: boolean } {
        return {
            hydratedRecordCount: this.bodies.size,
            // Quiet-assisted refinement is reported unavailable until the real bounded decoder is
            // injected. A UI must never infer availability merely from the persisted setting.
            quietAssistedRefinementAvailable: this.quietWindowDecoder !== null,
        };
    }

    injectResolvedBodies(bodies: ResolvedEditorialTranscriptMapV1): void {
        Object.entries(bodies).forEach(([recordId, body]) => {
            this.bodies.set(recordId as Sha256Digest, body);
        });
    }

    getResolvedBodies(): ResolvedEditorialTranscriptMapV1 {
        return Object.freeze(Object.fromEntries(this.bodies)) as ResolvedEditorialTranscriptMapV1;
    }

    /** Resolves every declared descriptor through integrity-checking CAS reads, then deep-validates. */
    async hydrateDocument(
        document: EditorDocumentV4,
        expectedContext = this.context,
    ): Promise<ResolvedEditorialTranscriptMapV1> {
        const serial = ++this.navigationSerial;
        const context = expectedContext ? { ...expectedContext } : null;
        const map = await this.resolveDocumentDetached(document);
        if (serial !== this.navigationSerial || !contextsEqual(this.context, context)) {
            throw new DOMException('Editorial transcript hydration became stale.', 'AbortError');
        }
        if (!this.publishResolvedDocument(document, map, context, () => undefined)) {
            throw new DOMException('Editorial transcript hydration became stale.', 'AbortError');
        }
        return map;
    }

    /** Resolves a not-yet-published project without disturbing the currently attached session. */
    async resolveDocumentDetached(document: EditorDocumentV4): Promise<ResolvedEditorialTranscriptMapV1> {
        const resolved = new Map<Sha256Digest, ResolvedEditorialTranscriptRecordBodyV1>();
        for (const descriptor of document.editorialTranscriptDescriptors) {
            const body = await this.repository.getRecord(descriptor.recordId, {
                descriptor,
                referenced: true,
            });
            if (!body) throw new Error('A referenced editorial transcript record is unavailable.');
            resolved.set(descriptor.recordId, body as ResolvedEditorialTranscriptRecordBodyV1);
        }
        const map = Object.freeze(Object.fromEntries(resolved)) as ResolvedEditorialTranscriptMapV1;
        const validation = validateHydratedEditorDocumentV4(document, map);
        if (!validation.valid) {
            throw new Error(`Editorial transcript graph is corrupt: ${validation.issues[0]?.message ?? 'invalid graph'}`);
        }
        return map;
    }

    /**
     * Publishes resolved bodies and their owning document in one synchronous critical section.
     *
     * Callers must complete every asynchronous read and their own revision checks first. The
     * callback then makes the matching Zustand document visible without leaving a stale body cache
     * behind when a project switch invalidates the expected runtime context.
     */
    publishResolvedDocument(
        document: EditorDocumentV4,
        bodies: ResolvedEditorialTranscriptMapV1,
        expectedContext: TimelineEditorialProjectContext | null,
        publishDocument: () => void,
    ): boolean {
        if (!contextsEqual(this.context, expectedContext)) return false;
        const validation = validateHydratedEditorDocumentV4(document, bodies);
        if (!validation.valid) {
            throw new Error(`Editorial transcript graph is corrupt: ${validation.issues[0]?.message ?? 'invalid graph'}`);
        }

        const previousBodies = this.bodies;
        this.bodies = new Map(
            Object.entries(bodies) as [Sha256Digest, ResolvedEditorialTranscriptRecordBodyV1][],
        );
        try {
            publishDocument();
        } catch (error) {
            this.bodies = previousBodies;
            throw error;
        }
        return true;
    }
}

/**
 * Deterministic bridge for legacy floating-point container durations.
 *
 * This does not claim the source duration is exact. It represents the number's shortest decimal
 * spelling when that fraction is safe; otherwise it rounds to the nearest microsecond. Container
 * integrations should replace it with a demuxer-owned rational as soon as one is available.
 */
export function approximateSecondsAsRationalDuration(seconds: number): RationalDuration {
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error('Editorial source duration must be a finite non-negative number.');
    }
    const text = seconds.toString().toLowerCase();
    const [coefficient, exponentText] = text.split('e');
    const exponent = exponentText ? Number(exponentText) : 0;
    const [integerPart, fractionalPart = ''] = coefficient.split('.');
    const digits = `${integerPart}${fractionalPart}`;
    const decimalPlaces = fractionalPart.length - exponent;
    if (/^\d+$/.test(digits)) {
        const numerator = Number(digits) * (decimalPlaces < 0 ? 10 ** -decimalPlaces : 1);
        const denominator = decimalPlaces > 0 ? 10 ** decimalPlaces : 1;
        if (Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)) {
            return reduceRational({ numerator, denominator });
        }
    }
    return reduceRational({ numerator: Math.round(seconds * 1_000_000), denominator: 1_000_000 });
}

function reduceRational(duration: RationalDuration): RationalDuration {
    let left = duration.numerator;
    let right = duration.denominator;
    while (right !== 0) [left, right] = [right, left % right];
    const divisor = Math.abs(left) || 1;
    return { numerator: duration.numerator / divisor, denominator: duration.denominator / divisor };
}

function contextsEqual(
    left: TimelineEditorialProjectContext | null,
    right: TimelineEditorialProjectContext | null,
): boolean {
    return left?.projectId === right?.projectId
        && left?.persistenceGeneration === right?.persistenceGeneration
        && left?.sessionId === right?.sessionId;
}

export const timelineEditorialRuntime = new TimelineEditorialRuntime();
