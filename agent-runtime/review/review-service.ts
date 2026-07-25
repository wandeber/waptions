import type { MediaBudgetLease, MediaBudgetManager } from '../../src/lib/media-byte-source/budget-manager';
import {
    linkAbortSignals,
    throwIfAborted,
} from '../../src/lib/media-byte-source/types';
import { BoundedConcurrency } from '../media/concurrency';
import type { ManagedSourceRegistryPort, ProbedMediaMetadata } from '../media/contracts';
import { createReviewArtifactKey } from './artifact-key';
import type {
    ReviewArtifactPort,
    ReviewDiagnostics,
    ReviewKind,
    ReviewKindResult,
    ReviewParameters,
    ReviewRange,
    ReviewRequest,
    ReviewBackendPort,
    StagedReviewArtifact,
} from './contracts';

const MAX_REVIEW_RANGES = 64;
const MAX_PROXY_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_ARTIFACT_BYTES = 4 * 1024 * 1024;
const AUDIO_WORKING_SET_BYTES = 1024 * 1024;

interface ArtifactFormat {
    readonly extension: string;
    readonly mediaType: string;
}

interface SourceGate {
    readonly concurrency: BoundedConcurrency;
    users: number;
}

const artifactFormats: Readonly<Record<ReviewKind, ArtifactFormat>> = {
    'contact-sheet': { extension: 'jpg', mediaType: 'image/jpeg' },
    'thumbnail-strip': { extension: 'jpg', mediaType: 'image/jpeg' },
    waveform: { extension: 'png', mediaType: 'image/png' },
    'audio-map': { extension: 'json', mediaType: 'application/json' },
    'silence-speech': { extension: 'json', mediaType: 'application/json' },
    'scene-cuts': { extension: 'json', mediaType: 'application/json' },
    proxy: { extension: 'mp4', mediaType: 'video/mp4' },
};

const audioRequiredKinds = new Set<ReviewKind>([
    'waveform',
    'audio-map',
    'silence-speech',
]);

export class ManagedMediaReviewService {
    private jobsStarted = 0;
    private jobsSucceeded = 0;
    private jobsCancelled = 0;
    private noAudioResults = 0;
    private artifactsPublished = 0;
    private readonly sourceGates = new Map<string, SourceGate>();

    constructor(
        private readonly sources: ManagedSourceRegistryPort,
        private readonly artifacts: ReviewArtifactPort,
        private readonly backend: ReviewBackendPort,
        /** Must be the same process-wide manager injected into preview and render. */
        private readonly decodedPixelBudget: MediaBudgetManager,
        private readonly pcmBudget: MediaBudgetManager,
        /** Process-wide limiter shared with probe jobs. */
        private readonly processConcurrency: BoundedConcurrency,
    ) {}

    async review(request: ReviewRequest): Promise<readonly ReviewKindResult[]> {
        let gate = this.sourceGates.get(request.sourceId);
        if (!gate) {
            gate = { concurrency: new BoundedConcurrency(1), users: 0 };
            this.sourceGates.set(request.sourceId, gate);
        }
        gate.users++;
        try {
            return await gate.concurrency.run(
                () => this.reviewExclusive(request),
                request.signal,
            );
        } finally {
            gate.users--;
            if (gate.users === 0 && this.sourceGates.get(request.sourceId) === gate) {
                this.sourceGates.delete(request.sourceId);
            }
        }
    }

    private async reviewExclusive(request: ReviewRequest): Promise<readonly ReviewKindResult[]> {
        const requestedRanges = normalizeRanges(request.ranges);
        const kinds = normalizeKinds(request.kinds);
        const parameters = normalizeParameters(request.parameters);
        const lease = await this.sources.acquire(request.sourceId, request.signal);
        const linked = linkAbortSignals(request.signal, lease.replacementSignal);
        const results: ReviewKindResult[] = [];
        try {
            const ranges = clampRangesToDuration(
                requestedRanges,
                lease.descriptor.metadata.durationSeconds,
            );
            for (const kind of kinds) {
                for (const range of ranges) {
                    throwIfAborted(linked.signal);
                    if (audioRequiredKinds.has(kind) && !lease.descriptor.metadata.audio) {
                        this.noAudioResults++;
                        results.push(Object.freeze({
                            kind,
                            range,
                            status: 'not-applicable',
                            code: 'NO_AUDIO',
                            artifacts: [],
                        }));
                        continue;
                    }
                    if (requiresVideo(kind) && !lease.descriptor.metadata.video) {
                        throw new Error(`Review kind "${kind}" requires a video stream.`);
                    }
                    const result = await this.processConcurrency.run(
                        () => this.runOne({
                            kind,
                            range,
                            parameters,
                            metadata: lease.descriptor.metadata,
                            sourceFingerprint: lease.descriptor.identity.fingerprint,
                            backendVersion: this.backend.algorithmVersion,
                            handle: lease.handle,
                            assertSourceCurrent: lease.assertCurrent,
                            signal: linked.signal,
                        }),
                        linked.signal,
                    );
                    results.push(result);
                }
            }
            return Object.freeze(results);
        } finally {
            linked.dispose();
            await lease.close();
        }
    }

    diagnostics(): ReviewDiagnostics {
        return Object.freeze({
            jobsStarted: this.jobsStarted,
            jobsSucceeded: this.jobsSucceeded,
            jobsCancelled: this.jobsCancelled,
            noAudioResults: this.noAudioResults,
            artifactsPublished: this.artifactsPublished,
            processConcurrency: this.processConcurrency.snapshot(),
        });
    }

    private async runOne(input: {
        kind: ReviewKind;
        range: ReviewRange;
        parameters: Required<ReviewParameters>;
        metadata: ProbedMediaMetadata;
        sourceFingerprint: string;
        backendVersion: string;
        handle: import('node:fs/promises').FileHandle;
        assertSourceCurrent(signal?: AbortSignal): Promise<void>;
        signal: AbortSignal;
    }): Promise<ReviewKindResult> {
        this.jobsStarted++;
        const format = artifactFormats[input.kind];
        const contentKey = createReviewArtifactKey(input);
        let staging: StagedReviewArtifact | null = null;
        let decodedLease: MediaBudgetLease | null = null;
        let pcmLease: MediaBudgetLease | null = null;
        try {
            staging = await this.artifacts.stage({
                contentKey,
                kind: input.kind,
                extension: format.extension,
                mediaType: format.mediaType,
                maximumBytes: maximumArtifactBytes(input.kind),
                signal: input.signal,
            });
            decodedLease = await reserveDecodedPixels(
                input.kind,
                input.metadata,
                input.parameters,
                this.decodedPixelBudget,
                input.signal,
            );
            pcmLease = await reservePcm(
                input.kind,
                this.pcmBudget,
                input.signal,
            );
            const backendResult = await this.backend.run({
                kind: input.kind,
                handle: input.handle,
                metadata: input.metadata,
                range: input.range,
                parameters: input.parameters,
                stagingPath: staging.stagingPath,
                maximumOutputBytes: maximumArtifactBytes(input.kind),
                signal: input.signal,
            });
            throwIfAborted(input.signal);
            if (backendResult.structuredData !== undefined) {
                await staging.writeJson(backendResult.structuredData, input.signal);
            }
            await input.assertSourceCurrent(input.signal);
            const artifact = await staging.commit(input.signal);
            staging = null;
            this.jobsSucceeded++;
            this.artifactsPublished++;
            return Object.freeze({
                kind: input.kind,
                range: input.range,
                status: 'succeeded',
                artifacts: Object.freeze([artifact]),
            });
        } catch (error) {
            if (input.signal.aborted || isAbortError(error)) this.jobsCancelled++;
            throw error;
        } finally {
            pcmLease?.release();
            decodedLease?.release();
            await staging?.discard();
        }
    }
}

function normalizeRanges(ranges: readonly ReviewRange[]): readonly ReviewRange[] {
    if (ranges.length === 0 || ranges.length > MAX_REVIEW_RANGES) {
        throw new RangeError(`Review requires between 1 and ${MAX_REVIEW_RANGES} ranges.`);
    }
    const normalized = ranges.map((range) => {
        if (
            !Number.isFinite(range.startSeconds)
            || !Number.isFinite(range.endSeconds)
            || range.startSeconds < 0
            || range.endSeconds <= range.startSeconds
        ) {
            throw new RangeError('Review ranges must be finite, positive, and non-empty.');
        }
        return Object.freeze({
            startSeconds: range.startSeconds,
            endSeconds: range.endSeconds,
        });
    }).sort((left, right) => left.startSeconds - right.startSeconds);
    for (let index = 1; index < normalized.length; index++) {
        if (normalized[index - 1]!.endSeconds > normalized[index]!.startSeconds) {
            throw new RangeError('Review ranges must not overlap.');
        }
    }
    return Object.freeze(normalized);
}

function clampRangesToDuration(
    ranges: readonly ReviewRange[],
    durationSeconds: number,
): readonly ReviewRange[] {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error('The probed source duration is not usable for review.');
    }
    return Object.freeze(ranges.map((range) => {
        if (range.startSeconds >= durationSeconds) {
            throw new RangeError('A review range starts after the source ends.');
        }
        return Object.freeze({
            startSeconds: range.startSeconds,
            endSeconds: Math.min(durationSeconds, range.endSeconds),
        });
    }));
}

function normalizeKinds(kinds: readonly ReviewKind[]): readonly ReviewKind[] {
    if (kinds.length === 0) throw new RangeError('At least one review kind is required.');
    return Object.freeze(Array.from(new Set(kinds)));
}

function normalizeParameters(value: ReviewParameters = {}): Required<ReviewParameters> {
    return Object.freeze({
        maximumFrames: integerInRange(value.maximumFrames ?? 12, 1, 32, 'maximumFrames'),
        thumbnailWidth: integerInRange(value.thumbnailWidth ?? 320, 64, 640, 'thumbnailWidth'),
        silenceThresholdDb: numberInRange(
            value.silenceThresholdDb ?? -40,
            -100,
            0,
            'silenceThresholdDb',
        ),
        minimumSilenceSeconds: numberInRange(
            value.minimumSilenceSeconds ?? 0.35,
            0.05,
            10,
            'minimumSilenceSeconds',
        ),
        sceneThreshold: numberInRange(value.sceneThreshold ?? 0.35, 0.01, 0.99, 'sceneThreshold'),
        proxyWidth: integerInRange(value.proxyWidth ?? 1280, 160, 1920, 'proxyWidth'),
    });
}

async function reserveDecodedPixels(
    kind: ReviewKind,
    metadata: ProbedMediaMetadata,
    parameters: Required<ReviewParameters>,
    budget: MediaBudgetManager,
    signal: AbortSignal,
): Promise<MediaBudgetLease | null> {
    const video = metadata.video;
    let bytes = 0;
    if (video && requiresVideo(kind)) {
        const sourceFrames = kind === 'scene-cuts' || kind === 'proxy' ? 2 : 1;
        bytes += video.width * video.height * 4 * sourceFrames;
        if (kind === 'contact-sheet' || kind === 'thumbnail-strip') {
            const cellHeight = Math.max(1, Math.round(
                parameters.thumbnailWidth * video.height / video.width,
            ));
            bytes += parameters.maximumFrames
                * parameters.thumbnailWidth
                * cellHeight
                * 4;
        }
    } else if (kind === 'waveform') {
        bytes = 1600 * 320 * 4;
    }
    if (bytes === 0) return null;
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Review pixel estimate is unsafe.');
    return (await budget.reserve(bytes, {
        label: `managed-review:${kind}`,
        signal,
    })).commit();
}

async function reservePcm(
    kind: ReviewKind,
    budget: MediaBudgetManager,
    signal: AbortSignal,
): Promise<MediaBudgetLease | null> {
    if (!audioRequiredKinds.has(kind)) return null;
    return (await budget.reserve(AUDIO_WORKING_SET_BYTES, {
        label: `managed-review-audio:${kind}`,
        signal,
    })).commit();
}

function requiresVideo(kind: ReviewKind): boolean {
    return kind === 'contact-sheet'
        || kind === 'thumbnail-strip'
        || kind === 'scene-cuts'
        || kind === 'proxy';
}

function maximumArtifactBytes(kind: ReviewKind): number {
    if (kind === 'proxy') return MAX_PROXY_ARTIFACT_BYTES;
    if (kind === 'contact-sheet' || kind === 'thumbnail-strip' || kind === 'waveform') {
        return MAX_IMAGE_ARTIFACT_BYTES;
    }
    return MAX_JSON_ARTIFACT_BYTES;
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
    }
    return value;
}

function numberInRange(value: number, minimum: number, maximum: number, label: string): number {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
    }
    return value;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}
