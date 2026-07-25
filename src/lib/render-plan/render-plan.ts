import type { SubtitleTrackV4 } from '@/types/timeline';
import type {
    EditorManifestV4,
    RationalFrameRate,
    RenderProfile,
    VideoSourceDescriptorV3,
} from '@/types/video';
import type { AudioMixPlan } from '../audio-mix-plan';
import { frameToOutputSample } from '../audio-timebase';
import { validateEditorManifestV4 } from '../editor-document-v4';
import { framesToSeconds } from '../render-profile';
import { getContainRectangle, type ContainRectangle } from '../video-compositor';
import type { VideoTrackPlacementsV4 } from '../video-placement-v4';
import { buildDescriptorAudioMixPlanV4 } from './descriptor-audio-plan';
import { getDescriptorContentEndFrameV4 } from './descriptor-content-boundary';
import {
    createDescriptorRenderGraphV4,
} from './descriptor-render-graph';
import {
    buildDescriptorVideoPlanV4,
    resolveDescriptorVideoPlacementAtFrame,
} from './descriptor-video-plan';

export const RESOLVED_RENDER_PLAN_VERSION = 1 as const;
export const LEGACY_RENDER_BACKGROUND_COLOR = '#000000' as const;

export type HeadlessMediaKind = 'video' | 'audio';

/**
 * Immutable media identity captured by the coordinator beside the descriptor-only V4 manifest.
 *
 * Paths deliberately stay behind the media port. A renderer can ask for a source by opaque ID,
 * but it cannot reinterpret a path or silently accept bytes that no longer match this identity.
 */
export interface HeadlessMediaIdentity {
    sourceId: string;
    kind: HeadlessMediaKind;
    byteSourceCapabilityId: string;
    fingerprint: string;
    size: number;
    lastModified: number;
}

export interface HeadlessRenderSnapshotV1 {
    version: 1;
    snapshotId: string;
    manifest: EditorManifestV4;
    sourceIdentities: HeadlessMediaIdentity[];
}

export interface ResolvedRenderSourceV1 extends HeadlessMediaIdentity {
    originalName: string;
    mimeType: string;
    duration: number;
}

export interface ResolvedVideoSegmentV1 {
    kind: 'video';
    outputStartFrame: number;
    outputEndFrame: number;
    clipId: string;
    trackId: string;
    sourceId: string;
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    sourceSecondsPerOutputFrame: number;
    sourceWidth: number;
    sourceHeight: number;
    contain: ContainRectangle;
}

export interface ResolvedBackgroundSegmentV1 {
    kind: 'background';
    outputStartFrame: number;
    outputEndFrame: number;
}

export type ResolvedVideoSegment = ResolvedVideoSegmentV1 | ResolvedBackgroundSegmentV1;

export interface ResolvedRenderPlanV1 {
    version: typeof RESOLVED_RENDER_PLAN_VERSION;
    planId: string;
    sourceSnapshotId: string;
    documentRevision: number;
    audioGraphRevision: number;
    renderProfile: RenderProfile;
    backgroundColor: string;
    contentEndFrame: number;
    outputEndSample: number;
    videoSegments: ResolvedVideoSegment[];
    subtitleTracks: SubtitleTrackV4[];
    audioMixPlan: AudioMixPlan;
    sources: ResolvedRenderSourceV1[];
    requiredFontFamilies: string[];
    output: {
        container: 'mp4';
        videoCodec: 'h264';
        audioCodec: 'aac';
    };
}

export interface ResolvedVideoFrameRequest {
    frameIndex: number;
    projectTimeSeconds: number;
    sourceId: string;
    clipId: string;
    sourceTimeSeconds: number;
    sourceWidth: number;
    sourceHeight: number;
    contain: ContainRectangle;
}

/**
 * Resolves a descriptor-only V4 snapshot before the first asynchronous render boundary.
 *
 * The returned object contains every timeline decision needed by either backend. In particular,
 * FFmpeg receives resolved winning video segments and the canonical audio plan; it never sees the
 * original manifest and therefore cannot reconstruct track, gap, mute, solo, or link semantics.
 */
export function createResolvedRenderPlan(
    input: HeadlessRenderSnapshotV1,
): ResolvedRenderPlanV1 {
    if (input.version !== 1) throw new Error('Unsupported headless render snapshot version.');
    if (typeof input.snapshotId !== 'string' || input.snapshotId.trim().length === 0) {
        throw new Error('A headless render snapshot requires a stable snapshotId.');
    }

    const snapshot = cloneAndFreeze(input) as HeadlessRenderSnapshotV1;
    // This isolated baseline predates Core's canonical field. Omit only that coordinated field
    // from the legacy validator, then validate its exact lowercase value at the read boundary.
    const manifestGraph = { ...snapshot.manifest } as Record<string, unknown>;
    delete manifestGraph.renderBackgroundColor;
    const validation = validateEditorManifestV4(manifestGraph);
    if (!validation.valid) {
        const detail = validation.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join('; ');
        throw new Error(`Cannot render an invalid V4 manifest: ${detail}`);
    }
    const sources = resolveSourceIdentities(snapshot);
    const runtimeGraph = createDescriptorRenderGraphV4(snapshot.manifest);
    const videoPlan = buildDescriptorVideoPlanV4(runtimeGraph);
    const audioMixPlan = buildDescriptorAudioMixPlanV4(runtimeGraph);
    const contentEndFrame = getDescriptorContentEndFrameV4(runtimeGraph, audioMixPlan);
    const backgroundColor = resolveRenderBackgroundColor(snapshot.manifest);
    const videoSegments = buildResolvedVideoSegments(
        snapshot.manifest.videoSourceDescriptors,
        videoPlan,
        snapshot.manifest.renderProfile,
        contentEndFrame,
    );
    const subtitleTracks = snapshot.manifest.subtitleTracks.filter((track) => track.isVisible);
    const requiredFontFamilies = Array.from(new Set(
        subtitleTracks.map((track) => track.style.fontFamily).filter(Boolean),
    )).sort();
    const plan: ResolvedRenderPlanV1 = {
        version: RESOLVED_RENDER_PLAN_VERSION,
        planId: `render-plan-v1:${snapshot.snapshotId}:${snapshot.manifest.revision}:${snapshot.manifest.audioGraphRevision}`,
        sourceSnapshotId: snapshot.snapshotId,
        documentRevision: snapshot.manifest.revision,
        audioGraphRevision: snapshot.manifest.audioGraphRevision,
        renderProfile: snapshot.manifest.renderProfile,
        backgroundColor,
        contentEndFrame,
        outputEndSample: frameToOutputSample(contentEndFrame, snapshot.manifest.renderProfile.fps),
        videoSegments,
        subtitleTracks,
        audioMixPlan,
        sources,
        requiredFontFamilies,
        output: {
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
        },
    };
    return cloneAndFreeze(plan) as ResolvedRenderPlanV1;
}

/** Resolves one already-planned output frame without consulting a timeline graph. */
export function resolveRenderPlanVideoFrame(
    plan: ResolvedRenderPlanV1,
    frameIndex: number,
): ResolvedVideoFrameRequest | null {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= plan.contentEndFrame) {
        return null;
    }
    const segment = findVideoSegment(plan.videoSegments, frameIndex);
    if (!segment || segment.kind === 'background') return null;
    return {
        frameIndex,
        projectTimeSeconds: framesToSeconds(frameIndex, plan.renderProfile.fps),
        sourceId: segment.sourceId,
        clipId: segment.clipId,
        sourceTimeSeconds: Math.min(
            segment.sourceEndSeconds,
            segment.sourceStartSeconds
                + (frameIndex - segment.outputStartFrame) * segment.sourceSecondsPerOutputFrame,
        ),
        sourceWidth: segment.sourceWidth,
        sourceHeight: segment.sourceHeight,
        contain: segment.contain,
    };
}

function buildResolvedVideoSegments(
    sourceDescriptors: readonly VideoSourceDescriptorV3[],
    tracks: readonly VideoTrackPlacementsV4[],
    renderProfile: RenderProfile,
    contentEndFrame: number,
): ResolvedVideoSegment[] {
    if (contentEndFrame === 0) return [];
    const sourcesById = new Map(sourceDescriptors.map((source) => [source.id, source]));
    const boundaries = new Set<number>([0, contentEndFrame]);
    tracks.forEach((track) => track.placements.forEach((placement) => {
        if (placement.startFrame < contentEndFrame) boundaries.add(Math.max(0, placement.startFrame));
        if (placement.endFrame < contentEndFrame) boundaries.add(Math.max(0, placement.endFrame));
    }));
    const orderedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
    const segments: ResolvedVideoSegment[] = [];
    const sourceSecondsPerOutputFrame = renderProfile.fps.denominator
        / renderProfile.fps.numerator;

    for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
        const outputStartFrame = orderedBoundaries[index];
        const outputEndFrame = orderedBoundaries[index + 1];
        if (outputEndFrame <= outputStartFrame) continue;
        const resolved = resolveDescriptorVideoPlacementAtFrame(tracks, outputStartFrame);
        if (!resolved) {
            pushCoalescedSegment(segments, {
                kind: 'background',
                outputStartFrame,
                outputEndFrame,
            });
            continue;
        }
        const source = sourcesById.get(resolved.placement.clip.sourceId);
        if (!source) {
            throw new Error(`Resolved video clip "${resolved.placement.clip.id}" has no source descriptor.`);
        }
        const placement = resolved.placement;
        pushCoalescedSegment(segments, {
            kind: 'video',
            outputStartFrame,
            outputEndFrame,
            clipId: placement.clip.id,
            trackId: placement.trackId,
            sourceId: source.id,
            sourceStartSeconds: resolved.sourceTime,
            sourceEndSeconds: placement.clip.sourceEnd,
            sourceSecondsPerOutputFrame,
            sourceWidth: source.width,
            sourceHeight: source.height,
            contain: getContainRectangle(
                source.width,
                source.height,
                renderProfile.width,
                renderProfile.height,
            ),
        });
    }
    return segments;
}

function pushCoalescedSegment(
    segments: ResolvedVideoSegment[],
    next: ResolvedVideoSegment,
): void {
    const previous = segments.at(-1);
    if (!previous || previous.outputEndFrame !== next.outputStartFrame
        || previous.kind !== next.kind) {
        segments.push(next);
        return;
    }
    if (previous.kind === 'background' && next.kind === 'background') {
        previous.outputEndFrame = next.outputEndFrame;
        return;
    }
    if (previous.kind === 'video' && next.kind === 'video'
        && previous.clipId === next.clipId
        && previous.sourceId === next.sourceId) {
        previous.outputEndFrame = next.outputEndFrame;
        return;
    }
    segments.push(next);
}

function findVideoSegment(
    segments: readonly ResolvedVideoSegment[],
    frameIndex: number,
): ResolvedVideoSegment | null {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const segment = segments[middle];
        if (frameIndex < segment.outputStartFrame) high = middle - 1;
        else if (frameIndex >= segment.outputEndFrame) low = middle + 1;
        else return segment;
    }
    return null;
}

function resolveSourceIdentities(snapshot: HeadlessRenderSnapshotV1): ResolvedRenderSourceV1[] {
    const identitiesByKey = new Map<string, HeadlessMediaIdentity>();
    snapshot.sourceIdentities.forEach((identity) => {
        const key = `${identity.kind}:${identity.sourceId}`;
        if (identitiesByKey.has(key)) throw new Error(`Duplicate headless media identity "${key}".`);
        if (!/^[A-Za-z0-9:_-]{1,256}$/.test(identity.byteSourceCapabilityId)) {
            throw new Error(`Invalid byte-source capability for "${key}".`);
        }
        identitiesByKey.set(key, identity);
    });
    const resolved = [
        ...snapshot.manifest.videoSourceDescriptors.map((descriptor) => (
            resolveSourceIdentity('video', descriptor, identitiesByKey)
        )),
        ...snapshot.manifest.audioSourceDescriptors.map((descriptor) => (
            resolveSourceIdentity('audio', descriptor, identitiesByKey)
        )),
    ];
    if (resolved.length !== snapshot.sourceIdentities.length) {
        throw new Error('Headless media identities must exactly match the V4 source catalogs.');
    }
    return resolved;
}

function resolveSourceIdentity(
    kind: HeadlessMediaKind,
    descriptor: {
        id: string;
        originalName: string;
        mimeType: string;
        fingerprint: string;
        size: number;
        lastModified: number;
        duration: number;
    },
    identitiesByKey: ReadonlyMap<string, HeadlessMediaIdentity>,
): ResolvedRenderSourceV1 {
    const identity = identitiesByKey.get(`${kind}:${descriptor.id}`);
    if (!identity) throw new Error(`Missing ${kind} identity for source "${descriptor.id}".`);
    if (identity.fingerprint !== descriptor.fingerprint
        || identity.size !== descriptor.size
        || identity.lastModified !== descriptor.lastModified) {
        throw new Error(`Source identity changed for ${kind} source "${descriptor.id}".`);
    }
    return {
        ...identity,
        originalName: descriptor.originalName,
        mimeType: descriptor.mimeType,
        duration: descriptor.duration,
    };
}

function resolveRenderBackgroundColor(
    manifest: EditorManifestV4,
): string {
    if (!Object.prototype.hasOwnProperty.call(manifest, 'renderBackgroundColor')) {
        return LEGACY_RENDER_BACKGROUND_COLOR;
    }
    const color = Reflect.get(manifest, 'renderBackgroundColor');
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/.test(color)) {
        throw new Error(
            'The V4 renderBackgroundColor must be a canonical lowercase hexadecimal color.',
        );
    }
    return color;
}

function cloneAndFreeze(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
    const clone: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) clone[key] = cloneAndFreeze(nested);
    return Object.freeze(clone);
}

export function framesPerSecond(rate: RationalFrameRate): number {
    return rate.numerator / rate.denominator;
}
