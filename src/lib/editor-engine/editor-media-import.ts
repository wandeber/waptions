import {
    frameToOutputSample,
    nativeBoundaryToOutputSample,
    outputSampleToCoveringFrame,
} from '@/lib/audio-timebase';
import { hasAudioTrackCollision } from '@/lib/audio-timeline';
import { canonicalizeJson } from '@/lib/editorial-transcription/canonical-json';
import {
    validateEditorManifestV4,
    validateHydratedEditorDocumentV4,
} from '@/lib/editor-document-v4';
import { secondsToFrames } from '@/lib/render-profile';
import type { ResolvedEditorialTranscriptMapV1 } from '@/types/editorial';
import type {
    AudioClip,
    AudioSourceDescriptor,
    AudioTrack,
    EditorManifestV4,
    VideoSourceDescriptorV3,
} from '@/types/video';
import {
    applyEditorOperationBatch,
    assertAssetHydration,
    createDescriptorAssetHydration,
    manifestToPlanningDocument,
} from './editor-command-planner';
import { EditorCommandError } from './editor-command-errors';
import type { EditorSemanticOperation } from './editor-command';
import type { EditorMediaImportRequest } from './editor-engine-types';
import type { EditorAssetHydration, EditorIdGenerator } from './editor-ports';

const MEDIA_IMPORT_MAX_SOURCES = 256;

type OrderedImportSource =
    | { kind: 'video'; descriptor: VideoSourceDescriptorV3 }
    | { kind: 'audio'; descriptor: AudioSourceDescriptor };

export interface PreparedEditorMediaImport {
    candidate: EditorManifestV4;
    hydration: EditorAssetHydration;
    sourceRegistrations: EditorAssetHydration;
    sourceIds: string[];
    orderedSources: OrderedImportSource[];
    descriptorChanged: boolean;
}

export interface EditorMediaImportProposal {
    manifest: EditorManifestV4;
    sourceRegistrations: EditorAssetHydration;
    sourceIds: string[];
    placedClipIds: string[];
    changed: boolean;
    noOpReason?: string;
}

export function prepareEditorMediaImport(input: {
    current: EditorManifestV4;
    request: EditorMediaImportRequest;
    hydration: EditorAssetHydration;
    existingHydration: EditorAssetHydration;
}): PreparedEditorMediaImport {
    const requestedVideo = input.request.sources.videoSourceDescriptors;
    const requestedAudio = input.request.sources.audioSourceDescriptors;
    const requestedCount = requestedVideo.length + requestedAudio.length;
    if (requestedCount === 0 || requestedCount > MEDIA_IMPORT_MAX_SOURCES) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `Media import requires between 1 and ${MEDIA_IMPORT_MAX_SOURCES} sources.`,
        );
    }

    const requestedVideoIds = new Set(requestedVideo.map((source) => source.id));
    const requestedAudioIds = new Set(requestedAudio.map((source) => source.id));
    if (requestedVideoIds.size !== requestedVideo.length
        || requestedAudioIds.size !== requestedAudio.length) {
        throw new EditorCommandError('INVALID_REQUEST', 'Imported source IDs must be unique.');
    }
    const crossClassId = Array.from(requestedVideoIds).find((id) => requestedAudioIds.has(id));
    if (crossClassId) {
        throw sourceChanged('One imported source ID was assigned to two media classes.', crossClassId);
    }

    // The request carries durable descriptors; the separate capability payload must prove them
    // exactly and is never included in the idempotency digest.
    try {
        assertAssetHydration(
            {
                ...structuredClone(input.current),
                videoSourceDescriptors: structuredClone(requestedVideo),
                audioSourceDescriptors: structuredClone(requestedAudio),
            },
            input.hydration,
            {
                videoSourceIds: Array.from(requestedVideoIds),
                audioSourceIds: Array.from(requestedAudioIds),
            },
        );
    } catch (error) {
        throw new EditorCommandError(
            'SOURCE_CHANGED',
            'Imported media hydration does not match the requested immutable descriptors.',
            { cause: error },
        );
    }

    const currentVideo = new Map(input.current.videoSourceDescriptors.map((source) => [
        source.id,
        source,
    ]));
    const currentAudio = new Map(input.current.audioSourceDescriptors.map((source) => [
        source.id,
        source,
    ]));
    const importedVideo = new Map(input.hydration.videoSources.map((source) => [source.id, source]));
    const importedAudio = new Map(input.hydration.audioSources.map((source) => [source.id, source]));
    const existingVideo = new Map(input.existingHydration.videoSources.map((source) => [
        source.id,
        source,
    ]));
    const existingAudio = new Map(input.existingHydration.audioSources.map((source) => [
        source.id,
        source,
    ]));
    const newVideo: VideoSourceDescriptorV3[] = [];
    const newAudio: AudioSourceDescriptor[] = [];

    requestedVideo.forEach((descriptor) => {
        if (currentAudio.has(descriptor.id)) {
            throw sourceChanged('A video source ID is already registered as audio.', descriptor.id);
        }
        const existing = currentVideo.get(descriptor.id);
        if (!existing) {
            newVideo.push(structuredClone(descriptor));
            return;
        }
        assertReusedDescriptor(existing, descriptor, descriptor.id);
        assertReusedContent(existingVideo.get(descriptor.id), importedVideo.get(descriptor.id), descriptor.id);
    });
    requestedAudio.forEach((descriptor) => {
        if (currentVideo.has(descriptor.id)) {
            throw sourceChanged('An audio source ID is already registered as video.', descriptor.id);
        }
        const existing = currentAudio.get(descriptor.id);
        if (!existing) {
            newAudio.push(structuredClone(descriptor));
            return;
        }
        assertReusedDescriptor(existing, descriptor, descriptor.id);
        assertReusedContent(existingAudio.get(descriptor.id), importedAudio.get(descriptor.id), descriptor.id);
    });

    newVideo.sort(compareDescriptors);
    newAudio.sort(compareDescriptors);
    const candidate = structuredClone(input.current);
    candidate.videoSourceDescriptors.push(...newVideo);
    candidate.audioSourceDescriptors.push(...newAudio);

    const orderedSources: OrderedImportSource[] = [
        ...requestedVideo.map((descriptor): OrderedImportSource => ({
            kind: 'video',
            descriptor: structuredClone(descriptor),
        })),
        ...requestedAudio.map((descriptor): OrderedImportSource => ({
            kind: 'audio',
            descriptor: structuredClone(descriptor),
        })),
    ].sort(compareOrderedSources);

    return {
        candidate,
        hydration: mergeHydration(candidate, input.hydration),
        sourceRegistrations: {
            videoSources: newVideo.map((descriptor) => structuredClone(importedVideo.get(descriptor.id)!)),
            audioSources: newAudio.map((descriptor) => structuredClone(importedAudio.get(descriptor.id)!)),
        },
        sourceIds: orderedSources.map((source) => source.descriptor.id),
        orderedSources,
        descriptorChanged: newVideo.length > 0 || newAudio.length > 0,
    };
}

export function applyPreparedEditorMediaImport(input: {
    prepared: PreparedEditorMediaImport;
    placement: EditorMediaImportRequest['placement'];
    commandScope: string;
    nowIso: string;
    ids: EditorIdGenerator;
    bodies: ResolvedEditorialTranscriptMapV1;
}): EditorMediaImportProposal {
    const { prepared } = input;
    if (!prepared.descriptorChanged && input.placement.kind === 'register-only') {
        return {
            manifest: structuredClone(prepared.candidate),
            sourceRegistrations: cloneHydration(prepared.sourceRegistrations),
            sourceIds: [...prepared.sourceIds],
            placedClipIds: [],
            changed: false,
            noOpReason: 'sources-already-registered',
        };
    }

    assertValidManifest(prepared.candidate);
    if (input.placement.kind === 'register-only') {
        const manifest = structuredClone(prepared.candidate);
        manifest.revision += 1;
        assertHydratedManifest(manifest, prepared.hydration, input.bodies);
        return {
            manifest,
            sourceRegistrations: cloneHydration(prepared.sourceRegistrations),
            sourceIds: [...prepared.sourceIds],
            placedClipIds: [],
            changed: true,
        };
    }

    const operations: EditorSemanticOperation[] = [];
    const placedClipIds: string[] = [];
    const hasVideo = prepared.orderedSources.some((source) => source.kind === 'video');
    const hasAudio = prepared.orderedSources.some((source) => source.kind === 'audio');
    const videoTrackId = hasVideo
        ? resolveVideoTrack(prepared.candidate, input.placement.videoTrackId, input, operations)
        : null;
    const audioTrack = hasAudio
        ? resolveAudioTrack(prepared.candidate, input.placement.audioTrackId, input, operations)
        : null;
    let cursor = input.placement.timelineStartFrame;
    const audioSources = {
        videoSources: prepared.candidate.videoSourceDescriptors,
        audioSources: prepared.candidate.audioSourceDescriptors,
    };
    const collisionTrack = audioTrack ? structuredClone(audioTrack) : null;

    prepared.orderedSources.forEach((source, index) => {
        const clipId = input.ids.generate(
            'clip',
            `${input.commandScope}:media-import:${source.kind}:${source.descriptor.id}:${index}`,
        );
        placedClipIds.push(clipId);
        if (source.kind === 'video') {
            operations.push({
                operationId: `media.import.place.${index + 1}`,
                type: 'video-clip.insert',
                payload: {
                    clipId,
                    sourceId: source.descriptor.id,
                    trackId: videoTrackId!,
                    timelineStartFrame: cursor,
                    sourceStartSeconds: 0,
                    sourceEndSeconds: source.descriptor.duration,
                    audio: source.descriptor.hasAudio ? {
                        linkState: 'linked',
                        muted: false,
                        gainDb: 0,
                        fadeInFrames: 0,
                        fadeOutFrames: 0,
                    } : null,
                },
            });
            cursor = safeAddFrames(
                cursor,
                Math.max(1, secondsToFrames(
                    source.descriptor.duration,
                    prepared.candidate.renderProfile.fps,
                    'nearest',
                )),
            );
            return;
        }

        const durationSamples = nativeBoundaryToOutputSample(
            source.descriptor.nativeSampleCount,
            source.descriptor.nativeSampleRate,
        );
        const clip: Extract<AudioClip, { source: { kind: 'audio-source' } }> = {
            id: clipId,
            timelineStartFrame: cursor,
            muted: false,
            gainDb: 0,
            source: {
                kind: 'audio-source',
                audioSourceId: source.descriptor.id,
            },
            sourceStartSample: 0,
            sourceEndSample: source.descriptor.nativeSampleCount,
            timelineDurationSamples: durationSamples,
            fadeInSamples: 0,
            fadeOutSamples: 0,
        };
        if (collisionTrack && hasAudioTrackCollision(
            collisionTrack,
            clip,
            { kind: 'audio-source', descriptor: source.descriptor },
            prepared.candidate.renderProfile,
            audioSources,
        )) {
            throw new EditorCommandError(
                'OVERLAP_CONFLICT',
                'Natural media placement overlaps an existing audio clip.',
                { details: { operationId: `media.import.place.${index + 1}`, ids: [clipId] } },
            );
        }
        collisionTrack?.clips.push(structuredClone(clip));
        operations.push({
            operationId: `media.import.place.${index + 1}`,
            type: 'audio-clip.insert',
            payload: {
                trackId: audioTrack!.id,
                clip,
            },
        });
        cursor = outputSampleToCoveringFrame(
            safeAddSamples(
                frameToOutputSample(cursor, prepared.candidate.renderProfile.fps),
                durationSamples,
            ),
            prepared.candidate.renderProfile.fps,
        );
    });

    const planned = applyEditorOperationBatch(prepared.candidate, operations, {
        commandScope: input.commandScope,
        nowIso: input.nowIso,
        ids: input.ids,
        assets: prepared.hydration,
        bodies: input.bodies,
    });
    if (!planned.changed) {
        throw new EditorCommandError('INTERNAL_ERROR', 'Media placement unexpectedly produced no changes.');
    }
    return {
        manifest: planned.manifest,
        sourceRegistrations: cloneHydration(prepared.sourceRegistrations),
        sourceIds: [...prepared.sourceIds],
        placedClipIds,
        changed: true,
    };
}

export function compareCanonicalNaturalNames(left: string, right: string): number {
    const leftTokens = tokenizeNaturalName(left);
    const rightTokens = tokenizeNaturalName(right);
    const tokenCount = Math.min(leftTokens.length, rightTokens.length);
    for (let index = 0; index < tokenCount; index += 1) {
        const leftToken = leftTokens[index];
        const rightToken = rightTokens[index];
        if (leftToken.kind !== rightToken.kind) return leftToken.kind === 'number' ? -1 : 1;
        if (leftToken.kind === 'text' && rightToken.kind === 'text') {
            const compared = compareCodePoints(leftToken.value, rightToken.value);
            if (compared !== 0) return compared;
        } else if (leftToken.kind === 'number' && rightToken.kind === 'number') {
            if (leftToken.significant.length !== rightToken.significant.length) {
                return leftToken.significant.length - rightToken.significant.length;
            }
            const compared = compareCodePoints(leftToken.significant, rightToken.significant);
            if (compared !== 0) return compared;
            if (leftToken.raw.length !== rightToken.raw.length) {
                return leftToken.raw.length - rightToken.raw.length;
            }
        }
    }
    if (leftTokens.length !== rightTokens.length) return leftTokens.length - rightTokens.length;
    const normalized = compareCodePoints(
        left.normalize('NFC').toLowerCase(),
        right.normalize('NFC').toLowerCase(),
    );
    return normalized || compareCodePoints(left.normalize('NFC'), right.normalize('NFC'));
}

function resolveVideoTrack(
    manifest: EditorManifestV4,
    requestedId: string | undefined,
    context: Pick<Parameters<typeof applyPreparedEditorMediaImport>[0], 'commandScope' | 'ids'>,
    operations: EditorSemanticOperation[],
): string {
    const existing = requestedId
        ? manifest.videoTracks.find((track) => track.id === requestedId)
        : manifest.videoTracks[0];
    if (requestedId && !existing) throw notFoundTrack('video', requestedId);
    if (existing) {
        if (existing.locked) throw lockedTrack('video', existing.id);
        return existing.id;
    }
    const trackId = context.ids.generate('track', `${context.commandScope}:media-import:video-track`);
    operations.push({
        operationId: 'media.import.create-video-track',
        type: 'track.add',
        payload: {
            trackKind: 'video',
            trackId,
            name: `Video ${manifest.videoTracks.length + 1}`,
        },
    });
    return trackId;
}

function resolveAudioTrack(
    manifest: EditorManifestV4,
    requestedId: string | undefined,
    context: Pick<Parameters<typeof applyPreparedEditorMediaImport>[0], 'commandScope' | 'ids'>,
    operations: EditorSemanticOperation[],
): AudioTrack {
    const existing = requestedId
        ? manifest.audioTracks.find((track) => track.id === requestedId)
        : manifest.audioTracks[0];
    if (requestedId && !existing) throw notFoundTrack('audio', requestedId);
    if (existing) {
        if (existing.locked) throw lockedTrack('audio', existing.id);
        return existing;
    }
    const trackId = context.ids.generate('track', `${context.commandScope}:media-import:audio-track`);
    const track: AudioTrack = {
        id: trackId,
        name: `Audio ${manifest.audioTracks.length + 1}`,
        muted: false,
        solo: false,
        locked: false,
        gainDb: 0,
        clips: [],
    };
    operations.push({
        operationId: 'media.import.create-audio-track',
        type: 'track.add',
        payload: {
            trackKind: 'audio',
            trackId,
            name: track.name,
        },
    });
    return track;
}

function assertReusedDescriptor(
    existing: VideoSourceDescriptorV3 | AudioSourceDescriptor,
    incoming: VideoSourceDescriptorV3 | AudioSourceDescriptor,
    sourceId: string,
): void {
    if (canonicalizeJson(existing) !== canonicalizeJson(incoming)) {
        throw sourceChanged('A registered source ID was reused with different descriptor metadata.', sourceId);
    }
}

function assertReusedContent(
    existing: EditorAssetHydration['videoSources'][number]
        | EditorAssetHydration['audioSources'][number]
        | undefined,
    incoming: EditorAssetHydration['videoSources'][number]
        | EditorAssetHydration['audioSources'][number]
        | undefined,
    sourceId: string,
): void {
    if (!existing || !incoming
        || existing.handle.identity.contentDigest !== incoming.handle.identity.contentDigest
        || existing.handle.identity.byteLength !== incoming.handle.identity.byteLength) {
        throw sourceChanged('A registered source ID was reused with different immutable content.', sourceId);
    }
}

function mergeHydration(
    manifest: EditorManifestV4,
    imported: EditorAssetHydration,
): EditorAssetHydration {
    const merged = createDescriptorAssetHydration(manifest);
    const importedVideo = new Map(imported.videoSources.map((source) => [source.id, source]));
    const importedAudio = new Map(imported.audioSources.map((source) => [source.id, source]));
    return {
        videoSources: merged.videoSources.map(
            (source) => structuredClone(importedVideo.get(source.id) ?? source),
        ),
        audioSources: merged.audioSources.map(
            (source) => structuredClone(importedAudio.get(source.id) ?? source),
        ),
    };
}

function assertValidManifest(manifest: EditorManifestV4): void {
    const result = validateEditorManifestV4(manifest);
    if (!result.valid) {
        throw new EditorCommandError('INVALID_DOCUMENT', 'Imported descriptors produced an invalid V4 manifest.', {
            details: { issues: result.issues.slice(0, 50) },
        });
    }
}

function assertHydratedManifest(
    manifest: EditorManifestV4,
    hydration: EditorAssetHydration,
    bodies: ResolvedEditorialTranscriptMapV1,
): void {
    assertAssetHydration(manifest, hydration);
    const result = validateHydratedEditorDocumentV4(
        manifestToPlanningDocument(manifest, hydration),
        bodies,
    );
    if (!result.valid) {
        throw new EditorCommandError('INVALID_DOCUMENT', 'Imported media hydration validation failed.', {
            details: { issues: result.issues.slice(0, 50) },
        });
    }
}

function cloneHydration(value: EditorAssetHydration): EditorAssetHydration {
    return structuredClone(value);
}

function compareDescriptors(
    left: VideoSourceDescriptorV3 | AudioSourceDescriptor,
    right: VideoSourceDescriptorV3 | AudioSourceDescriptor,
): number {
    return compareCanonicalNaturalNames(left.originalName, right.originalName)
        || compareCodePoints(left.id, right.id);
}

function compareOrderedSources(left: OrderedImportSource, right: OrderedImportSource): number {
    return compareCanonicalNaturalNames(left.descriptor.originalName, right.descriptor.originalName)
        || compareCodePoints(left.kind, right.kind)
        || compareCodePoints(left.descriptor.id, right.descriptor.id);
}

type NaturalToken =
    | { kind: 'text'; value: string }
    | { kind: 'number'; raw: string; significant: string };

function tokenizeNaturalName(value: string): NaturalToken[] {
    const normalized = value.normalize('NFC').toLowerCase();
    const tokens: NaturalToken[] = [];
    let cursor = 0;
    const pattern = /[0-9]+/g;
    let match = pattern.exec(normalized);
    while (match) {
        if (match.index > cursor) {
            tokens.push({ kind: 'text', value: normalized.slice(cursor, match.index) });
        }
        const raw = match[0];
        tokens.push({
            kind: 'number',
            raw,
            significant: raw.replace(/^0+(?=[0-9])/, ''),
        });
        cursor = match.index + raw.length;
        match = pattern.exec(normalized);
    }
    if (cursor < normalized.length) {
        tokens.push({ kind: 'text', value: normalized.slice(cursor) });
    }
    return tokens;
}

function compareCodePoints(left: string, right: string): number {
    return left === right ? 0 : left < right ? -1 : 1;
}

function safeAddFrames(left: number, right: number): number {
    const value = left + right;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new EditorCommandError('INVALID_OPERATION', 'Natural media placement exceeds frame bounds.');
    }
    return value;
}

function safeAddSamples(left: number, right: number): number {
    const value = left + right;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new EditorCommandError('INVALID_OPERATION', 'Natural media placement exceeds sample bounds.');
    }
    return value;
}

function sourceChanged(message: string, sourceId: string): EditorCommandError {
    return new EditorCommandError('SOURCE_CHANGED', message, {
        details: { ids: [sourceId] },
    });
}

function notFoundTrack(kind: 'video' | 'audio', trackId: string): EditorCommandError {
    return new EditorCommandError('NOT_FOUND', `The requested ${kind} track does not exist.`, {
        details: { ids: [trackId] },
    });
}

function lockedTrack(kind: 'video' | 'audio', trackId: string): EditorCommandError {
    return new EditorCommandError('LOCKED_TARGET', `The requested ${kind} track is locked.`, {
        details: { ids: [trackId] },
    });
}
