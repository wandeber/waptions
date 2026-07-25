import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { createVideoSourceFingerprint } from '../../../src/lib/video-timeline';
import type { EditorAssetHydration } from '../../../src/lib/editor-engine/editor-ports';
import type {
    AudioSourceDescriptor,
    VideoSourceDescriptorV3,
} from '../../../src/types/video';
import type {
    ImmutableMediaIdentityV1,
    VerifiedMediaHandleV1,
} from '../../../src/types/waptions-agent-protocol';
import { ManagedMediaError, throwIfAborted } from '../../media/errors';
import type {
    ManagedMediaProbePort,
    ManagedMediaProbeResult,
} from '../../media/probe';
import type { MediaProbeMetadata } from '../../source-registry/contracts';
import { compareCanonicalNaturalNames } from '../../source-registry/natural-sort';
import type {
    CoreMediaImportPort,
    ManagedMediaCatalogRecord,
    ManagedMediaImportRequest,
    ManagedMediaImportResponse,
    ManagedMediaProbeRequest,
    ManagedMediaProbeResponse,
} from './contracts';
import {
    descriptorVersion,
    inferMediaMimeType,
    PathGrantMediaAdapter,
} from './path-grant-media-adapter';

const MAX_MEDIA_HANDLES = 256;
const MAX_CONCURRENT_PROBES = 4;

export class ManagedMediaToolService {
    constructor(
        private readonly adapter: PathGrantMediaAdapter,
        private readonly probes: ManagedMediaProbePort,
        private readonly core: CoreMediaImportPort,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async probe(request: ManagedMediaProbeRequest): Promise<ManagedMediaProbeResponse> {
        const hasPaths = request.paths !== undefined;
        const hasSelection = request.selection !== undefined;
        if (hasPaths === hasSelection) {
            throw new ManagedMediaError(
                'INVALID_REQUEST',
                'Media probe requires exactly one explicit-path or granted-directory selection.',
            );
        }
        if (request.selection) {
            return this.probeGrantedDirectory(request);
        }
        const paths = request.paths ?? [];
        validateCount(paths.length, 'Media probe paths');
        if (new Set(paths).size !== paths.length) {
            throw new ManagedMediaError('INVALID_REQUEST', 'Media probe paths must be unique.');
        }
        throwIfAborted(request.signal);
        const capabilities = paths.map((requestedPath) => ({
            requestedPath,
            capabilityId: this.adapter.registerProbePath({
                grantId: request.grantId,
                requestedPath,
                displayName: basename(requestedPath),
                scope: {
                    sessionId: request.sessionId,
                    sessionEpoch: request.sessionEpoch,
                },
            }),
        }));
        try {
            const results = await mapBounded(
                capabilities,
                MAX_CONCURRENT_PROBES,
                async (candidate, index) => {
                    const probed = await this.probes.probeCapability(
                        candidate.capabilityId,
                        `${request.operationId}:probe:${index}`,
                        request.signal,
                    );
                    return this.publishProbe(candidate.capabilityId, probed);
                },
            );
            return Object.freeze({
                handles: Object.freeze(results.map((record) => record.handle)),
                media: Object.freeze(results.map((record) => Object.freeze({
                    handle: record.handle,
                    displayName: record.displayName,
                    mediaClass: record.class,
                    mimeType: record.mimeType,
                    metadata: Object.freeze(structuredClone(record.metadata)),
                }))),
                jobIds: Object.freeze([]) as readonly [],
            });
        } catch (error) {
            await this.adapter.discardUncommittedCapabilities(
                capabilities.map(({ capabilityId }) => capabilityId),
            );
            throw error;
        }
    }

    private async probeGrantedDirectory(
        request: ManagedMediaProbeRequest,
    ): Promise<ManagedMediaProbeResponse> {
        const selection = request.selection!;
        validateCount(selection.maximumResults, 'Directory media probe results');
        const maximumCandidates = selection.maximumCandidates ?? MAX_MEDIA_HANDLES;
        if (
            !Number.isSafeInteger(maximumCandidates)
            || maximumCandidates < selection.maximumResults
            || maximumCandidates > 500
        ) {
            throw new ManagedMediaError(
                'INVALID_REQUEST',
                'Directory media probe candidate bound is outside allowed limits.',
            );
        }
        throwIfAborted(request.signal);
        const capabilities = await this.adapter.registerProbeDirectory({
            grantId: request.grantId,
            scope: {
                sessionId: request.sessionId,
                sessionEpoch: request.sessionEpoch,
            },
            maximumCandidates,
            requireVideo: selection.requireVideo ?? true,
        });
        const retained = new Set<string>();
        try {
            const records: ManagedMediaCatalogRecord[] = [];
            let offset = 0;
            while (offset < capabilities.length && records.length < selection.maximumResults) {
                const remaining = selection.maximumResults - records.length;
                const batch = capabilities.slice(
                    offset,
                    offset + Math.min(MAX_CONCURRENT_PROBES, remaining),
                );
                offset += batch.length;
                const settled = await Promise.allSettled(batch.map(async (candidate, index) => {
                    const probed = await this.probes.probeCapability(
                        candidate.capabilityId,
                        `${request.operationId}:directory:${offset - batch.length + index}`,
                        request.signal,
                    );
                    if (
                        (selection.requireVideo ?? true)
                        && probed.metadata.videoStreams.length === 0
                    ) {
                        throw new ManagedMediaError(
                            'UNSUPPORTED_MEDIA',
                            'Directory selection requires a supported video stream.',
                        );
                    }
                    return this.publishProbe(candidate.capabilityId, probed);
                }));
                for (let index = 0; index < settled.length; index += 1) {
                    const outcome = settled[index]!;
                    const capabilityId = batch[index]!.capabilityId;
                    if (outcome.status === 'fulfilled') {
                        retained.add(capabilityId);
                        records.push(outcome.value);
                        continue;
                    }
                    if (
                        outcome.reason instanceof ManagedMediaError
                        && outcome.reason.code === 'UNSUPPORTED_MEDIA'
                    ) {
                        continue;
                    }
                    throw outcome.reason;
                }
            }
            if (records.length < selection.maximumResults) {
                throw new ManagedMediaError(
                    'NOT_ENOUGH_VIDEO_SOURCES',
                    'The granted directory did not contain enough supported media sources.',
                    {
                        details: {
                            requested: selection.maximumResults,
                            discovered: records.length,
                        },
                    },
                );
            }
            await this.adapter.discardUncommittedCapabilities(
                capabilities
                    .map(({ capabilityId }) => capabilityId)
                    .filter((capabilityId) => !retained.has(capabilityId)),
            );
            return responseFromRecords(records);
        } catch (error) {
            await this.adapter.discardUncommittedCapabilities(
                capabilities.map(({ capabilityId }) => capabilityId),
            );
            throw error;
        }
    }

    async import(request: ManagedMediaImportRequest): Promise<ManagedMediaImportResponse> {
        const replay = await this.core.replayImport?.(request);
        if (replay) {
            return {
                sourceIds: replay.ok ? Object.freeze([...replay.sourceIds]) : [],
                placedClipIds: replay.ok ? Object.freeze([...replay.placedClipIds]) : [],
                result: replay,
            };
        }
        validateCount(request.mediaHandles.length, 'Media import handles');
        if (new Set(request.mediaHandles).size !== request.mediaHandles.length) {
            throw new ManagedMediaError('INVALID_REQUEST', 'Media import handles must be unique.');
        }
        throwIfAborted(request.signal);
        const records = request.mediaHandles.map((handleId) => {
            const record = this.adapter.get(handleId);
            if (!record) {
                throw new ManagedMediaError(
                    'SOURCE_UNREADABLE',
                    'A managed media handle was not found.',
                );
            }
            return record;
        }).sort((left, right) => {
            const name = compareCanonicalNaturalNames(left.displayName, right.displayName);
            return name !== 0 ? name : left.sourceId.localeCompare(right.sourceId);
        });
        const videoSourceDescriptors = records.flatMap((record) => (
            record.videoDescriptor ? [structuredClone(record.videoDescriptor)] : []
        ));
        const audioSourceDescriptors = records.flatMap((record) => (
            record.audioDescriptor ? [structuredClone(record.audioDescriptor)] : []
        ));
        const hydration: EditorAssetHydration = {
            videoSources: records.flatMap((record) => (
                record.class === 'video'
                    ? [structuredClone(recordHydration(record)) as EditorAssetHydration['videoSources'][number]]
                    : []
            )),
            audioSources: records.flatMap((record) => (
                record.class === 'audio'
                    ? [structuredClone(recordHydration(record)) as EditorAssetHydration['audioSources'][number]]
                    : []
            )),
        };
        const releasePin = this.adapter.pinUncommitted(request.mediaHandles);
        let authorityCommitted = false;
        let result;
        try {
            result = await this.core.importMedia({
                request: {
                    ...structuredClone(request.request),
                    sources: {
                        videoSourceDescriptors,
                        audioSourceDescriptors,
                    },
                    placement: structuredClone(request.placement),
                },
                hydration,
                signal: request.signal,
                revalidate: async (signal) => {
                    const leases = [];
                    try {
                        for (const record of records) {
                            throwIfAborted(signal);
                            const lease = await this.adapter.open(record.handle.handleId, signal);
                            leases.push(lease);
                            await lease.assertCurrent(signal);
                            assertIdentity(record, lease.identity);
                        }
                    } finally {
                        await Promise.allSettled(leases.map((lease) => lease.close()));
                    }
                },
                commitAuthority: () => {
                    if (authorityCommitted) {
                        throw new ManagedMediaError(
                            'INTERNAL_ERROR',
                            'Managed media authority was committed more than once.',
                        );
                    }
                    this.adapter.markCommitted(records.map((record) => record.sourceId));
                    authorityCommitted = true;
                },
            });
        } finally {
            await releasePin();
        }
        if (!result.ok) {
            if (authorityCommitted) {
                throw new ManagedMediaError(
                    'INTERNAL_ERROR',
                    'Core rejected media after committing its retained authority.',
                );
            }
            return {
                sourceIds: [],
                placedClipIds: [],
                result,
            };
        }
        if (!authorityCommitted
            || !sameStringSet(result.sourceIds, records.map((record) => record.sourceId))) {
            throw new ManagedMediaError(
                'INTERNAL_ERROR',
                'Core did not atomically commit the expected managed media authority.',
            );
        }
        return {
            sourceIds: Object.freeze([...result.sourceIds]),
            placedClipIds: Object.freeze([...result.placedClipIds]),
            result,
        };
    }

    private publishProbe(
        capabilityId: string,
        probed: ManagedMediaProbeResult,
    ): ManagedMediaCatalogRecord {
        const mediaClass = probed.metadata.videoStreams.length > 0 ? 'video' : 'audio';
        if (mediaClass === 'audio' && probed.metadata.audioStreams.length === 0) {
            throw new ManagedMediaError(
                'UNSUPPORTED_MEDIA',
                'The source has no supported audio or video streams.',
            );
        }
        const fileIdentity = this.adapter.capabilityIdentity(capabilityId);
        const sourceId = `${mediaClass}-${randomUUID()}`;
        const handleId = `media-handle:${randomUUID()}`;
        const mimeType = inferMediaMimeType(probed.displayName, mediaClass);
        const fileMetadata = {
            name: probed.displayName,
            type: mimeType,
            size: probed.identity.byteLength,
            lastModified: Math.max(0, Math.round(fileIdentity.modifiedMilliseconds)),
        };
        const fingerprint = createVideoSourceFingerprint(fileMetadata);
        const identity = publicIdentity({
            handleId,
            fingerprint,
            probed,
            fileIdentity,
        });
        const handle: VerifiedMediaHandleV1 = Object.freeze({
            schemaVersion: 1,
            handleId,
            capabilityId,
            identity,
            verifiedAt: this.now().toISOString(),
        });
        const common = {
            id: sourceId,
            originalName: fileMetadata.name,
            mimeType: fileMetadata.type,
            size: fileMetadata.size,
            lastModified: fileMetadata.lastModified,
            fingerprint,
            duration: probed.metadata.durationUs / 1_000_000,
            bitrate: probed.metadata.bitRate ?? null,
        };
        const videoDescriptor = mediaClass === 'video'
            ? toVideoDescriptor(common, probed.metadata)
            : undefined;
        const audioDescriptor = mediaClass === 'audio'
            ? toAudioDescriptor(common, probed.metadata)
            : undefined;
        const record: ManagedMediaCatalogRecord = Object.freeze({
            handle,
            sourceId,
            displayName: probed.displayName,
            mimeType,
            lastModified: fileMetadata.lastModified,
            registeredIdentity: probed.identity,
            metadata: structuredClone(probed.metadata),
            class: mediaClass,
            ...(videoDescriptor ? { videoDescriptor } : {}),
            ...(audioDescriptor ? { audioDescriptor } : {}),
        });
        this.adapter.publishCatalogRecord(capabilityId, record);
        return record;
    }
}

function responseFromRecords(
    records: readonly ManagedMediaCatalogRecord[],
): ManagedMediaProbeResponse {
    return Object.freeze({
        handles: Object.freeze(records.map((record) => record.handle)),
        media: Object.freeze(records.map((record) => Object.freeze({
            handle: record.handle,
            displayName: record.displayName,
            mediaClass: record.class,
            mimeType: record.mimeType,
            metadata: Object.freeze(structuredClone(record.metadata)),
        }))),
        jobIds: Object.freeze([]) as readonly [],
    });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length
        && new Set(left).size === left.length
        && left.every((value) => right.includes(value));
}

async function mapBounded<T, R>(
    values: readonly T[],
    maximumConcurrency: number,
    operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    let failed = false;
    let failure: unknown;
    const workers = Array.from(
        { length: Math.min(maximumConcurrency, values.length) },
        async () => {
            while (!failed) {
                const index = cursor;
                cursor += 1;
                if (index >= values.length) return;
                try {
                    results[index] = await operation(values[index]!, index);
                } catch (error) {
                    if (!failed) {
                        failed = true;
                        failure = error;
                    }
                }
            }
        },
    );
    await Promise.all(workers);
    if (failed) throw failure;
    return results;
}

function publicIdentity(input: {
    handleId: string;
    fingerprint: string;
    probed: ManagedMediaProbeResult;
    fileIdentity: ReturnType<PathGrantMediaAdapter['capabilityIdentity']>;
}): ImmutableMediaIdentityV1 {
    const metadataDigest = createHash('sha256')
        .update(JSON.stringify(input.probed.metadata))
        .digest('hex');
    return Object.freeze({
        schemaVersion: 1,
        contentDigest: input.probed.identity.sha256,
        descriptorFingerprint: input.fingerprint,
        byteLength: input.probed.identity.byteLength,
        immutableVersion: descriptorVersion(input.probed.identity),
        stableStatIdentity: {
            device: input.fileIdentity.device,
            fileId: input.fileIdentity.inode,
            modifiedNanoseconds: String(
                Math.max(0, Math.round(input.fileIdentity.modifiedMilliseconds * 1_000_000)),
            ),
        },
        streamMetadataRefs: [
            {
                kind: 'probe' as const,
                ref: `probe:${input.handleId}`,
                digest: `sha256:${metadataDigest}` as const,
            },
            ...input.probed.metadata.videoStreams.map((stream) => ({
                kind: 'video-stream' as const,
                ref: `probe:${input.handleId}:video:${stream.index}`,
            })),
            ...input.probed.metadata.audioStreams.map((stream) => ({
                kind: 'audio-stream' as const,
                ref: `probe:${input.handleId}:audio:${stream.index}`,
            })),
        ],
    });
}

function toVideoDescriptor(
    common: {
        id: string;
        originalName: string;
        mimeType: string;
        size: number;
        lastModified: number;
        fingerprint: string;
        duration: number;
        bitrate: number | null;
    },
    metadata: MediaProbeMetadata,
): VideoSourceDescriptorV3 {
    const primary = metadata.videoStreams.find(
        (stream) => stream.index === metadata.primaryVideoStreamIndex,
    ) ?? metadata.videoStreams[0];
    if (!primary) {
        throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Primary video stream is missing.');
    }
    return Object.freeze({
        ...common,
        fps: primary.frameRate.numerator / primary.frameRate.denominator,
        width: primary.width,
        height: primary.height,
        bitrate: primary.bitRate ?? common.bitrate,
        hasAudio: metadata.audioStreams.length > 0,
    });
}

function toAudioDescriptor(
    common: {
        id: string;
        originalName: string;
        mimeType: string;
        size: number;
        lastModified: number;
        fingerprint: string;
        duration: number;
        bitrate: number | null;
    },
    metadata: MediaProbeMetadata,
): AudioSourceDescriptor {
    const primary = metadata.audioStreams.find(
        (stream) => stream.index === metadata.primaryAudioStreamIndex,
    ) ?? metadata.audioStreams[0];
    if (!primary) {
        throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Primary audio stream is missing.');
    }
    const nativeSampleCount = Math.round(common.duration * primary.sampleRate);
    if (!Number.isSafeInteger(nativeSampleCount) || nativeSampleCount <= 0) {
        throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Audio sample count is invalid.');
    }
    return Object.freeze({
        ...common,
        nativeSampleRate: primary.sampleRate,
        nativeSampleCount,
        nativeChannelCount: primary.channels,
        bitrate: primary.bitRate ?? common.bitrate,
        codec: primary.codec,
    });
}

function recordHydration(record: ManagedMediaCatalogRecord) {
    const descriptor = record.videoDescriptor ?? record.audioDescriptor;
    if (!descriptor) {
        throw new ManagedMediaError('INTERNAL_ERROR', 'Managed media descriptor is missing.');
    }
    return {
        ...structuredClone(descriptor),
        handle: structuredClone(record.handle),
        fileMetadata: {
            name: descriptor.originalName,
            type: descriptor.mimeType,
            size: descriptor.size,
            lastModified: descriptor.lastModified,
        },
    };
}

function assertIdentity(
    record: ManagedMediaCatalogRecord,
    actual: ManagedMediaCatalogRecord['registeredIdentity'],
): void {
    const expected = record.registeredIdentity;
    if (expected.sha256 !== actual.sha256
        || expected.byteLength !== actual.byteLength
        || expected.statIdentity !== actual.statIdentity) {
        throw new ManagedMediaError('SOURCE_CHANGED', 'Managed media identity changed.');
    }
}

function validateCount(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MEDIA_HANDLES) {
        throw new ManagedMediaError(
            'INVALID_REQUEST',
            `${label} must contain between 1 and ${MAX_MEDIA_HANDLES} entries.`,
        );
    }
}
