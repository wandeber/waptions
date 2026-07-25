import { createHash } from 'node:crypto';
import {
    createResolvedRenderPlan,
    framesPerSecond,
} from '../../../src/lib/render-plan';
import { validateEditorManifestV4 } from '../../../src/lib/editor-document-v4';
import { canonicalJson } from '../../persistence/canonical-json';
import type {
    HeadlessMp4Inspection,
    HeadlessMp4VerifierPort,
    HeadlessRenderExecutionPort,
} from '../../export/contracts';
import {
    DEFAULT_HEADLESS_RENDER_LIMITS,
    HeadlessRenderError,
    throwIfAborted,
} from '../../render/contracts';
import type { ArtifactRegistry, StagedArtifact } from '../../artifacts/artifact-registry';
import type {
    ManagedExportJobService,
    ManagedExportRequest,
    ManagedExportSuccess,
    ManagedExportTerminalProposal,
    ManagedProofEvidenceV1,
} from './contracts';
import type { ManagedWebmRenderPort } from './node-webm-renderer';
import type {
    ManagedOutputLease,
    PathGrantOutputAuthority,
} from './path-grant-output-authority';
import { writeManagedPortableBundle } from './portable-bundle-writer';
import { createManagedStreamingSink } from './streaming-output';

const MAX_STRUCTURED_EXPORT_BYTES = 64 * 1024 * 1024;

export class ProductionManagedExportJobService implements ManagedExportJobService {
    constructor(
        private readonly outputs: PathGrantOutputAuthority,
        private readonly artifacts: ArtifactRegistry,
        private readonly renderer: HeadlessRenderExecutionPort,
        private readonly mp4Verifier: HeadlessMp4VerifierPort,
        private readonly webm: ManagedWebmRenderPort,
    ) {}

    async prepare(request: ManagedExportRequest): Promise<ManagedExportTerminalProposal> {
        validateRequest(request);
        const lease = this.outputs.acquireDestination(request.destination);
        let transferred = false;
        try {
            let success: ManagedExportSuccess;
            switch (request.exportKind) {
                case 'mp4-h264-aac':
                    success = await this.renderMp4(request, lease);
                    break;
                case 'webm':
                    success = await this.renderWebm(request, lease);
                    break;
                case 'portable-bundle':
                    success = await this.writeBundle(request, lease);
                    break;
                case 'reference-snapshot':
                    success = await this.writeReferenceSnapshot(request, lease);
                    break;
                case 'proof-record':
                    success = await this.writeProof(request, lease);
                    break;
            }
            const artifact = await this.stageExportArtifact(request, lease, success);
            const candidate = lease.candidate({
                contentDigest: success.contentDigest,
                byteLength: success.byteLength,
            });
            transferred = true;
            return terminalProposal(success, candidate, artifact);
        } finally {
            if (!transferred) await lease.abort().catch(() => undefined);
        }
    }

    private async stageExportArtifact(
        request: ManagedExportRequest,
        lease: ManagedOutputLease,
        success: ManagedExportSuccess,
    ): Promise<StagedArtifact> {
        const artifact = await this.artifacts.stage(
            request.projectId,
            `export:${request.exportKind}`,
            success.mediaType,
            lease.stream(request.signal),
            {
                sourceIds: exportSourceIds(request),
                signal: request.signal,
            },
        );
        try {
            const current = await lease.hash(request.signal);
            if (artifact.record.digest !== success.contentDigest
                || artifact.record.byteLength !== success.byteLength
                || current.digest !== success.contentDigest
                || current.bytes !== success.byteLength) {
                throw new HeadlessRenderError(
                    'INVALID_OUTPUT',
                    'The canonical export artifact differs from the staged output.',
                );
            }
            return artifact;
        } catch (error) {
            await artifact.reject();
            throw error;
        }
    }

    private async renderMp4(
        request: ManagedExportRequest,
        lease: ManagedOutputLease,
    ): Promise<ManagedExportSuccess> {
        const snapshot = requireMaterial(request.material.renderSnapshot, 'render snapshot');
        const plan = createResolvedRenderPlan(snapshot);
        request.onProgress?.({ stage: 'rendering', fraction: 0 });
        const rendered = await this.renderer.render({
            jobId: request.jobId,
            plan,
            outputCapability: lease.renderCapability,
            limits: DEFAULT_HEADLESS_RENDER_LIMITS,
            signal: request.signal,
            onProgress: (progress) => request.onProgress?.({
                stage: `rendering:${progress.stage}`,
                fraction: progress.totalUnits > 0
                    ? progress.completedUnits / progress.totalUnits
                    : undefined,
            }),
            resetOutputForFallback: () => lease.reset(request.signal),
        });
        throwIfAborted(request.signal);
        const inspection = await this.mp4Verifier.inspect(
            lease.renderCapability,
            request.signal,
        );
        validateMp4Inspection(plan, inspection);
        await lease.sync(request.signal);
        const hashed = await lease.hash(request.signal);
        return {
            jobId: request.jobId,
            jobKind: exportJobKind(request.exportKind),
            exportKind: request.exportKind,
            outputId: lease.outputId,
            contentDigest: hashed.digest,
            byteLength: hashed.bytes,
            mediaType: 'video/mp4',
            planId: plan.planId,
            backend: rendered.backend,
            codecs: { video: 'h264', audio: 'aac' },
            durationSeconds: inspection.durationSeconds,
            sourceRangesRead: rendered.sourceRangesRead,
            diagnostics: rendered.diagnostics,
            warnings: Object.freeze([...rendered.warnings]),
        };
    }

    private async renderWebm(
        request: ManagedExportRequest,
        lease: ManagedOutputLease,
    ): Promise<ManagedExportSuccess> {
        const snapshot = requireMaterial(request.material.renderSnapshot, 'render snapshot');
        const plan = createResolvedRenderPlan(snapshot);
        const rendered = await this.webm.render({
            jobId: request.jobId,
            plan,
            outputCapability: lease.renderCapability,
            signal: request.signal,
        });
        await lease.sync(request.signal);
        const hashed = await lease.hash(request.signal);
        return {
            jobId: request.jobId,
            jobKind: exportJobKind(request.exportKind),
            exportKind: request.exportKind,
            outputId: lease.outputId,
            contentDigest: hashed.digest,
            byteLength: hashed.bytes,
            mediaType: 'video/webm',
            planId: plan.planId,
            backend: rendered.backend,
            codecs: { video: rendered.videoCodec, audio: rendered.audioCodec },
            durationSeconds: rendered.durationSeconds,
            sourceRangesRead: rendered.sourceRangesRead,
            diagnostics: rendered.diagnostics,
            warnings: Object.freeze([...rendered.warnings]),
        };
    }

    private async writeBundle(
        request: ManagedExportRequest,
        lease: ManagedOutputLease,
    ): Promise<ManagedExportSuccess> {
        const material = requireMaterial(request.material.portableBundle, 'portable bundle material');
        const sink = createManagedStreamingSink(lease.handle);
        await writeManagedPortableBundle({
            entries: material.entries,
            sink,
            signal: request.signal,
            onEntry: (completed, total) => request.onProgress?.({
                stage: 'writing-bundle',
                fraction: completed / total,
            }),
        });
        await sink.sync(request.signal);
        const hashed = await lease.hash(request.signal);
        return structuredSuccess(request, lease, hashed, 'application/vnd.waptions.project+zip');
    }

    private async writeReferenceSnapshot(
        request: ManagedExportRequest,
        lease: ManagedOutputLease,
    ): Promise<ManagedExportSuccess> {
        const snapshot = projectReferenceSnapshot(
            requireMaterial(request.material.referenceSnapshot, 'reference snapshot'),
        );
        assertPublicProjection(snapshot);
        const envelope = withCanonicalDigest('reference-snapshot', snapshot);
        await writeCanonicalValue(lease, envelope, request.signal);
        const hashed = await lease.hash(request.signal);
        return structuredSuccess(request, lease, hashed, 'application/json');
    }

    private async writeProof(
        request: ManagedExportRequest,
        lease: ManagedOutputLease,
    ): Promise<ManagedExportSuccess> {
        const proof = projectProofEvidence(requireMaterial(request.material.proof, 'proof evidence'));
        assertPublicProjection(proof);
        const envelope = withCanonicalDigest('proof-record', proof);
        const markdown = request.destination.outputName.toLowerCase().endsWith('.md');
        await writeCanonicalValue(
            lease,
            markdown ? proofMarkdown(envelope) : envelope,
            request.signal,
        );
        const hashed = await lease.hash(request.signal);
        return structuredSuccess(
            request,
            lease,
            hashed,
            markdown ? 'text/markdown' : 'application/json',
        );
    }
}

function projectReferenceSnapshot(
    value: NonNullable<ManagedExportRequest['material']['referenceSnapshot']>,
) {
    const validation = validateEditorManifestV4(value.manifest);
    if (!validation.valid) {
        throw new HeadlessRenderError('INVALID_SNAPSHOT', 'Reference manifest is invalid.');
    }
    return {
        schemaVersion: value.schemaVersion,
        apiVersion: value.apiVersion,
        runtimeVersion: value.runtimeVersion,
        schemaBundleDigest: value.schemaBundleDigest,
        state: projectState(value.state),
        manifestDigest: value.manifestDigest,
        manifest: projectPublicManifest(value.manifest),
        sources: value.sources.map(projectReferenceSource),
        transcriptRecordIds: [...value.transcriptRecordIds],
        historyEntryIds: [...value.historyEntryIds],
    };
}

function projectProofEvidence(
    value: NonNullable<ManagedExportRequest['material']['proof']>,
) {
    return {
        schemaVersion: value.schemaVersion,
        runtimeVersion: value.runtimeVersion,
        pluginVersion: value.pluginVersion,
        schemaBundleDigest: value.schemaBundleDigest,
        state: projectState(value.state),
        sources: value.sources.map(projectReferenceSource),
        operations: value.operations.map((operation) => ({
            toolName: operation.toolName,
            idempotencyKey: operation.idempotencyKey,
            requestDigest: operation.requestDigest,
            resultingSessionRevision: operation.resultingSessionRevision,
            jobIds: [...operation.jobIds],
            artifactIds: [...operation.artifactIds],
        })),
        editSummary: projectEvidenceRecord(value.editSummary, [
            'clips', 'videoClips', 'audioClips', 'subtitleCues', 'tracks', 'cuts',
            'durationFrames', 'outputSamples',
        ]),
        undoRedoEvidence: projectEvidenceRecord(value.undoRedoEvidence, [
            'passed', 'undoCount', 'redoCount', 'historyEntries', 'revision',
        ]),
        reconnectEvidence: projectEvidenceRecord(value.reconnectEvidence, [
            'passed', 'recoveryCount', 'eventSequence', 'restoredSources',
        ]),
        memoryCaps: projectEvidenceRecord(value.memoryCaps, [
            'decodedBytes', 'peakDecodedBytes', 'maximumDecodedBytes', 'residentBytes',
            'maximumResidentBytes', 'videoDecoderSessions', 'audioMixBytes',
        ]),
    };
}

function projectPublicManifest(
    value: NonNullable<ManagedExportRequest['material']['referenceSnapshot']>['manifest'],
) {
    return {
        version: value.version,
        revision: value.revision,
        audioGraphRevision: value.audioGraphRevision,
        renderProfile: structuredClone(value.renderProfile),
        renderBackgroundColor: value.renderBackgroundColor,
        subtitleTracks: structuredClone(value.subtitleTracks),
        videoSourceDescriptors: structuredClone(value.videoSourceDescriptors),
        videoClips: structuredClone(value.videoClips),
        videoTracks: structuredClone(value.videoTracks),
        audioSourceDescriptors: structuredClone(value.audioSourceDescriptors),
        audioTracks: structuredClone(value.audioTracks),
        activeSubtitleTrackId: value.activeSubtitleTrackId,
        transcriptionByTrackId: Object.fromEntries(
            Object.entries(value.transcriptionByTrackId).map(([trackId, provenance]) => [
                trackId,
                {
                    raw: structuredClone(provenance.raw),
                    groups: structuredClone(provenance.groups),
                    containerIds: [...provenance.containerIds],
                    ...(provenance.provider === undefined ? {} : { provider: provenance.provider }),
                    ...(provenance.model === undefined ? {} : { model: provenance.model }),
                    ...(provenance.generatedAt === undefined
                        ? {}
                        : { generatedAt: provenance.generatedAt }),
                    sourceDocumentRevision: provenance.sourceDocumentRevision,
                    sourceAudioGraphRevision: provenance.sourceAudioGraphRevision,
                    sourceAudioGraphSignature: provenance.sourceAudioGraphSignature,
                    stale: provenance.stale,
                },
            ]),
        ),
        globalEditingMode: value.globalEditingMode,
        editorialTranscriptDescriptors: structuredClone(value.editorialTranscriptDescriptors),
        narrative: structuredClone(value.narrative),
        dependentLinks: structuredClone(value.dependentLinks),
    };
}

function projectEvidenceRecord<T extends string | number | boolean>(
    value: Readonly<Record<string, T>>,
    allowedKeys: readonly string[],
): Readonly<Record<string, T>> {
    const output: Record<string, T> = {};
    for (const key of allowedKeys) {
        if (Object.hasOwn(value, key)) output[key] = value[key]!;
    }
    return Object.freeze(output);
}

function projectState(value: ManagedProofEvidenceV1['state']) {
    return {
        sessionId: value.sessionId,
        projectId: value.projectId,
        sessionEpoch: value.sessionEpoch,
        sessionRevision: value.sessionRevision,
        documentRevision: value.documentRevision,
        audioGraphRevision: value.audioGraphRevision,
        ...(value.narrativeRevision === undefined
            ? {}
            : { narrativeRevision: value.narrativeRevision }),
        eventCursor: value.eventCursor,
    };
}

function projectReferenceSource(
    value: ManagedProofEvidenceV1['sources'][number],
) {
    return {
        sourceId: value.sourceId,
        displayName: value.displayName,
        mediaClass: value.mediaClass,
        contentDigest: value.contentDigest,
        byteLength: value.byteLength,
        descriptorFingerprint: value.descriptorFingerprint,
        probe: {
            containerFormats: [...value.probe.containerFormats],
            ...(value.probe.containerLongName === undefined
                ? {}
                : { containerLongName: value.probe.containerLongName }),
            durationUs: value.probe.durationUs,
            ...(value.probe.startTimeUs === undefined
                ? {}
                : { startTimeUs: value.probe.startTimeUs }),
            ...(value.probe.bitRate === undefined ? {} : { bitRate: value.probe.bitRate }),
            videoStreams: value.probe.videoStreams.map((stream) => ({
                index: stream.index,
                codec: stream.codec,
                ...(stream.profile === undefined ? {} : { profile: stream.profile }),
                ...(stream.pixelFormat === undefined
                    ? {}
                    : { pixelFormat: stream.pixelFormat }),
                width: stream.width,
                height: stream.height,
                frameRate: { ...stream.frameRate },
                ...(stream.durationUs === undefined ? {} : { durationUs: stream.durationUs }),
                ...(stream.bitRate === undefined ? {} : { bitRate: stream.bitRate }),
            })),
            audioStreams: value.probe.audioStreams.map((stream) => ({
                index: stream.index,
                codec: stream.codec,
                ...(stream.profile === undefined ? {} : { profile: stream.profile }),
                sampleRate: stream.sampleRate,
                channels: stream.channels,
                ...(stream.channelLayout === undefined
                    ? {}
                    : { channelLayout: stream.channelLayout }),
                ...(stream.durationUs === undefined ? {} : { durationUs: stream.durationUs }),
                ...(stream.bitRate === undefined ? {} : { bitRate: stream.bitRate }),
            })),
            ...(value.probe.primaryVideoStreamIndex === undefined
                ? {}
                : { primaryVideoStreamIndex: value.probe.primaryVideoStreamIndex }),
            ...(value.probe.primaryAudioStreamIndex === undefined
                ? {}
                : { primaryAudioStreamIndex: value.probe.primaryAudioStreamIndex }),
        },
    };
}

function terminalProposal(
    success: ManagedExportSuccess,
    candidate: ReturnType<ManagedOutputLease['candidate']>,
    artifact: StagedArtifact,
): ManagedExportTerminalProposal {
    return Object.freeze({
        jobKind: success.jobKind,
        outputs: Object.freeze([candidate]),
        artifacts: Object.freeze([artifact]),
        jobResult: Object.freeze(success),
        events: Object.freeze([
            Object.freeze({
                type: 'artifact.created' as const,
                data: Object.freeze({
                    artifactId: artifact.record.artifactId,
                    outputId: success.outputId,
                    exportKind: success.exportKind,
                    kind: artifact.record.kind,
                    mediaType: artifact.record.mediaType,
                    contentDigest: artifact.record.digest,
                    byteLength: artifact.record.byteLength,
                }),
            }),
            Object.freeze({
                type: 'job.changed' as const,
                data: Object.freeze({
                    jobId: success.jobId,
                    jobKind: success.jobKind,
                    exportKind: success.exportKind,
                    outputId: success.outputId,
                    artifactId: artifact.record.artifactId,
                    status: 'succeeded',
                    terminal: true,
                    contentDigest: success.contentDigest,
                    byteLength: success.byteLength,
                }),
            }),
        ]),
    });
}

function exportSourceIds(request: ManagedExportRequest): readonly string[] {
    const sourceIds = request.material.renderSnapshot?.sourceIdentities.map(
        (source) => source.sourceId,
    ) ?? request.material.referenceSnapshot?.sources.map((source) => source.sourceId)
        ?? request.material.proof?.sources.map((source) => source.sourceId)
        ?? [];
    return Object.freeze(Array.from(new Set(sourceIds)).sort());
}

async function writeCanonicalValue(
    lease: ManagedOutputLease,
    value: unknown,
    signal?: AbortSignal,
): Promise<void> {
    throwIfAborted(signal);
    const text = typeof value === 'string'
        ? value
        : `${canonicalJson(value, MAX_STRUCTURED_EXPORT_BYTES)}\n`;
    const bytes = Buffer.from(text);
    if (bytes.byteLength > MAX_STRUCTURED_EXPORT_BYTES) {
        throw new RangeError('Structured export exceeds its byte limit.');
    }
    await lease.handle.writeFile(bytes);
    await lease.sync(signal);
}

function withCanonicalDigest(kind: string, value: unknown) {
    const contentDigest = `sha256:${createHash('sha256')
        .update(canonicalJson(value, MAX_STRUCTURED_EXPORT_BYTES))
        .digest('hex')}` as const;
    return {
        kind,
        contentDigest,
        value,
    };
}

function proofMarkdown(envelope: ReturnType<typeof withCanonicalDigest>): string {
    const proof = envelope.value as NonNullable<ManagedExportRequest['material']['proof']>;
    const canonicalEnvelope = canonicalJson(envelope, MAX_STRUCTURED_EXPORT_BYTES);
    const longestBacktickRun = Math.max(
        0,
        ...Array.from(canonicalEnvelope.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
    const rows = [
        '# Waptions proof record',
        '',
        `- Content digest: \`${envelope.contentDigest}\``,
        `- Runtime: \`${proof.runtimeVersion}\``,
        `- Plugin: \`${proof.pluginVersion}\``,
        `- Project: \`${proof.state.projectId}\``,
        `- Session revision: ${proof.state.sessionRevision}`,
        `- Sources: ${proof.sources.length}`,
        `- Operations: ${proof.operations.length}`,
        '',
        '## Sources',
        '',
        '| Source | Type | Bytes | Digest |',
        '| --- | --- | ---: | --- |',
        ...proof.sources.map((source) => (
            `| ${escapeMarkdown(source.displayName)} | ${source.mediaClass} | ${source.byteLength} | \`${source.contentDigest}\` |`
        )),
        '',
        '## Canonical proof envelope',
        '',
        `${fence}json`,
        canonicalEnvelope,
        fence,
        '',
    ];
    return `${rows.join('\n')}\n`;
}

function structuredSuccess(
    request: ManagedExportRequest,
    lease: ManagedOutputLease,
    hashed: { digest: `sha256:${string}`; bytes: number },
    mediaType: string,
): ManagedExportSuccess {
    return {
        jobId: request.jobId,
        jobKind: exportJobKind(request.exportKind),
        exportKind: request.exportKind,
        outputId: lease.outputId,
        contentDigest: hashed.digest,
        byteLength: hashed.bytes,
        mediaType,
        warnings: Object.freeze([]),
    };
}

function exportJobKind(
    kind: ManagedExportRequest['exportKind'],
): `export:${ManagedExportRequest['exportKind']}` {
    return `export:${kind}`;
}

function validateMp4Inspection(
    plan: ReturnType<typeof createResolvedRenderPlan>,
    inspection: HeadlessMp4Inspection,
): void {
    if (inspection.container !== 'mp4'
        || !['h264', 'avc', 'avc1'].includes(inspection.videoCodec.toLowerCase())
        || inspection.audioCodec?.toLowerCase() !== 'aac'
        || inspection.pixelFormat?.toLowerCase() !== 'yuv420p'
        || inspection.audioSampleRate !== 48_000
        || inspection.audioChannels !== 2
        || inspection.videoFrameCount !== plan.contentEndFrame) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'Staged MP4 is not exact-frame H.264/yuv420p with AAC/48 kHz/stereo.',
        );
    }
    const expected = plan.contentEndFrame / framesPerSecond(plan.renderProfile.fps);
    const tolerance = 1 / framesPerSecond(plan.renderProfile.fps);
    const durations = [
        inspection.durationSeconds,
        inspection.videoDurationSeconds,
        inspection.audioDurationSeconds,
    ];
    if (durations.some((duration) => (
        duration === null
        || !Number.isFinite(duration)
        || Math.abs(duration - expected) > tolerance + Number.EPSILON
    ))) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'Staged MP4 stream durations differ from the resolved render boundary.',
        );
    }
}

function assertPublicProjection(value: unknown): void {
    const forbiddenAuthorityKey = /(?:path|grant|capability|authority|filedescriptor|storageref|signedurl|bridgeurl|endpoint|authorization|password|secret|apikey|access[_-]?token|refresh[_-]?token|(?:^|[_-])token$|(?:^|[_-])url$|(?:^|[_-])uri$)/i;
    const seen = new Set<object>();
    const visit = (candidate: unknown, path: string): void => {
        if (typeof candidate === 'string') {
            if (/^(?:[a-z][a-z0-9+.-]*:\/\/|file:|data:|blob:|\/|\\\\|[A-Za-z]:[\\/])/i.test(candidate)) {
                throw new Error(`Structured export contains a forbidden path or URL at ${path}.`);
            }
            return;
        }
        if (!candidate || typeof candidate !== 'object') return;
        if (seen.has(candidate)) throw new Error('Structured export must be acyclic.');
        seen.add(candidate);
        if (Array.isArray(candidate)) {
            candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
        } else {
            for (const [key, item] of Object.entries(candidate)) {
                if (forbiddenAuthorityKey.test(key)) {
                    throw new Error(`Structured export contains forbidden authority field "${key}".`);
                }
                visit(item, `${path}.${key}`);
            }
        }
        seen.delete(candidate);
    };
    visit(value, '$');
}

function validateRequest(request: ManagedExportRequest): void {
    if (!request.projectId || !request.jobId || request.destination.mode !== 'create-only') {
        throw new Error('Managed export request is invalid.');
    }
}

function requireMaterial<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`Managed export requires ${label}.`);
    return value;
}

function escapeMarkdown(value: string): string {
    return value.replace(/[|\\`]/g, '\\$&').replace(/\r?\n/g, ' ');
}
