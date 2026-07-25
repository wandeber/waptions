import type { SubtitleTrackV4 } from '@/types/timeline';
import type { Sha256Digest } from '@/types/editorial';
import type {
    AudioClip,
    AudioSourceAsset,
    EditorDocumentV3,
    EditorDocumentV4,
    EditorManifestV3,
    EditorManifestV4,
    TrackTranscriptionProvenanceV3,
    TransientMediaSelectionV4,
    VideoClipV4,
    VideoSourceAssetV3,
    VideoTrack,
    VideoTrackV4,
} from '@/types/video';
import {
    type EditorDocumentV2MigrationInput,
    type LegacyEditorDocumentMigrationInput,
    migrateEditorDocumentV2ToV3,
    migrateLegacyEditorDocumentToV3,
    normalizeLegacyEditorManifestV3,
} from './editor-document-migration';
import { validateEditorDocumentV3, validateEditorManifestV3 } from './editor-document-v3';
import {
    validateEditorDocumentV4,
    validateEditorManifestV4,
} from './editor-document-v4';
import { getVideoClipDurationFramesV4 } from './video-placement-v4';

export type EditorDocumentV4MigrationRequest =
    | { sourceVersion: 1; input: LegacyEditorDocumentMigrationInput }
    | { sourceVersion: 2; input: EditorDocumentV2MigrationInput }
    | { sourceVersion: 3; input: EditorDocumentV3 }
    | { sourceVersion: 4; input: EditorDocumentV4 };

export interface EditorHistoryProjectionMigrationV4 {
    projections: EditorDocumentV4[];
    /** Descriptor IDs needed by the reconstructed current/Undo/Redo/WAL projection set. */
    requiredRecordIds: Sha256Digest[];
}

/**
 * Converts one valid V3 runtime graph to explicit V4 placement without changing media order.
 *
 * V3 preview/export used one cumulative cursor over the global `videoClips` array, even after
 * clips gained visual-lane membership. Migration deliberately computes that cursor first and
 * only then attaches the exact owning lane as `trackId`. Computing a cursor per lane would make
 * clips overlap and would change the rendered video and linked-audio mix on first open.
 */
export function migrateEditorDocumentV3ToV4(document: EditorDocumentV3): EditorDocumentV4 {
    assertValidV3Document(document, 'V3 document');
    const migrated = migrateRuntimeGraph(document);
    assertValidV4Document(migrated, 'V3 to V4 document migration');
    return migrated;
}

/** Composes the existing pure V2-to-V3 transform with the single authoritative V3-to-V4 step. */
export function migrateEditorDocumentV2ToV4(input: EditorDocumentV2MigrationInput): EditorDocumentV4 {
    return migrateEditorDocumentV3ToV4(migrateEditorDocumentV2ToV3(input));
}

/** Composes scalar V1 through V2/V3 so there is no independent legacy-to-V4 interpretation. */
export function migrateLegacyEditorDocumentToV4(
    input: LegacyEditorDocumentMigrationInput,
): EditorDocumentV4 {
    return migrateEditorDocumentV3ToV4(migrateLegacyEditorDocumentToV3(input));
}

/**
 * Versioned dispatcher used by load/import compatibility boundaries.
 *
 * A valid V4 object is returned by reference: reopening a current projection must be a true no-op,
 * not a normalization pass that could hide corruption or produce an unrequested history change.
 */
export function migrateEditorDocumentToV4(request: EditorDocumentV4MigrationRequest): EditorDocumentV4 {
    if (request.sourceVersion === 1) return migrateLegacyEditorDocumentToV4(request.input);
    if (request.sourceVersion === 2) return migrateEditorDocumentV2ToV4(request.input);
    return migrateLoadedEditorDocumentToV4(request.input);
}

/** Migrates an already hydrated V3 graph or validates and returns a current V4 graph unchanged. */
export function migrateLoadedEditorDocumentToV4(
    document: EditorDocumentV3 | EditorDocumentV4,
): EditorDocumentV4 {
    if (document.version === 3) return migrateEditorDocumentV3ToV4(document);
    assertValidV4Document(document, 'V4 document');
    return document;
}

/**
 * Converts a descriptor-only V3 manifest without requiring source Files or media inspection.
 *
 * Pre-lane V3 manifests are normalized only at this version-aware boundary, matching the existing
 * V3 hydration policy. A present malformed lane graph is still rejected by the V3 validator.
 */
export function migrateEditorManifestV3ToV4(manifest: EditorManifestV3): EditorManifestV4 {
    const normalized = normalizeLegacyEditorManifestV3(manifest);
    const validation = validateEditorManifestV3(normalized);
    if (!validation.valid) throwMigrationError('V3 manifest', validation.issues);
    const migrated = migrateManifestGraph(normalized);
    assertValidV4Manifest(migrated, 'V3 to V4 manifest migration');
    return migrated;
}

/** Builds the durable descriptor-only shape and drops File objects plus transient selection. */
export function createEditorManifestV4(document: EditorDocumentV4): EditorManifestV4 {
    assertValidV4Document(document, 'V4 document');
    const manifest: EditorManifestV4 = {
        version: 4,
        revision: document.revision,
        audioGraphRevision: document.audioGraphRevision,
        renderProfile: cloneRenderProfile(document.renderProfile),
        subtitleTracks: document.subtitleTracks.map(cloneSubtitleTrack),
        videoSourceDescriptors: document.videoSources.map(withoutFile),
        videoClips: document.videoClips.map(cloneVideoClip),
        videoTracks: document.videoTracks.map((track) => ({ ...track })),
        audioSourceDescriptors: document.audioSources.map(withoutFile),
        audioTracks: cloneAudioTracks(document.audioTracks),
        activeSubtitleTrackId: document.activeSubtitleTrackId,
        transcriptionByTrackId: cloneTranscriptionProvenance(document.transcriptionByTrackId),
        globalEditingMode: document.globalEditingMode,
        editorialTranscriptDescriptors: document.editorialTranscriptDescriptors.map((descriptor) => ({ ...descriptor })),
        narrative: cloneJsonDomain(document.narrative),
        dependentLinks: cloneJsonDomain(document.dependentLinks),
    };
    assertValidV4Manifest(manifest, 'V4 manifest creation');
    return manifest;
}

/** Reattaches already-loaded assets and validates File identity before exposing a runtime graph. */
export function hydrateEditorDocumentV4(
    manifest: EditorManifestV4,
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: readonly AudioSourceAsset[],
): EditorDocumentV4 {
    assertValidV4Manifest(manifest, 'V4 manifest');
    const document: EditorDocumentV4 = {
        version: 4,
        revision: manifest.revision,
        audioGraphRevision: manifest.audioGraphRevision,
        renderProfile: cloneRenderProfile(manifest.renderProfile),
        subtitleTracks: manifest.subtitleTracks.map(cloneSubtitleTrack),
        videoSources: videoSources.map((source) => ({ ...source })),
        videoClips: manifest.videoClips.map(cloneVideoClip),
        videoTracks: manifest.videoTracks.map((track) => ({ ...track })),
        audioSources: audioSources.map((source) => ({ ...source })),
        audioTracks: cloneAudioTracks(manifest.audioTracks),
        activeSubtitleTrackId: manifest.activeSubtitleTrackId,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: cloneTranscriptionProvenance(manifest.transcriptionByTrackId),
        globalEditingMode: manifest.globalEditingMode,
        editorialTranscriptDescriptors: manifest.editorialTranscriptDescriptors.map((descriptor) => ({ ...descriptor })),
        narrative: cloneJsonDomain(manifest.narrative),
        dependentLinks: cloneJsonDomain(manifest.dependentLinks),
    };
    assertValidV4Document(document, 'V4 hydration');
    return document;
}

/**
 * Migrates independently reconstructed history projections as one all-or-nothing sequence.
 *
 * The storage-v3 owner remains responsible for replaying V3 patches and diffing adjacent V4
 * projections. This helper owns only the semantic document conversion and descriptor-ID union,
 * preventing a caller from accidentally publishing a partially migrated Undo/Redo/WAL chain.
 */
export function migrateEditorHistoryProjectionSequenceToV4(
    projections: readonly (EditorDocumentV3 | EditorDocumentV4)[],
): EditorHistoryProjectionMigrationV4 {
    const migrated = projections.map(migrateLoadedEditorDocumentToV4);
    const requiredRecordIds = new Set<Sha256Digest>();
    migrated.forEach((document) => {
        document.editorialTranscriptDescriptors.forEach((descriptor) => requiredRecordIds.add(descriptor.recordId));
        document.narrative?.sourceRecordIds.forEach((recordId) => requiredRecordIds.add(recordId));
        document.dependentLinks.forEach((link) => {
            if (link.association.kind === 'transcript-bound') {
                requiredRecordIds.add(link.association.binding.transcriptRecordId);
            }
        });
    });
    return { projections: migrated, requiredRecordIds: Array.from(requiredRecordIds).sort() };
}

/**
 * Optional persisted history must never prevent a valid current project from opening.
 *
 * Returning null is the explicit signal for the storage owner to discard navigable auxiliary
 * history and surface its existing generic recovery warning. The current projection is purposely
 * not accepted here, so it cannot be confused with optional state during fallback.
 */
export function tryMigrateOptionalEditorHistoryProjectionSequenceToV4(
    projections: readonly (EditorDocumentV3 | EditorDocumentV4)[],
): EditorHistoryProjectionMigrationV4 | null {
    try {
        return migrateEditorHistoryProjectionSequenceToV4(projections);
    } catch {
        return null;
    }
}

function migrateRuntimeGraph(document: EditorDocumentV3): EditorDocumentV4 {
    const trackIdByClipId = buildTrackIdByClipId(document.videoTracks);
    let timelineCursor = 0;
    const videoClips = document.videoClips.map((clip) => {
        const trackId = trackIdByClipId.get(clip.id);
        if (!trackId) throw new Error('Valid V3 graph lost video-track ownership during migration.');
        const migrated: VideoClipV4 = {
            ...clip,
            audio: clip.audio ? { ...clip.audio } : null,
            trackId,
            timelineStartFrame: timelineCursor,
        };
        timelineCursor = addSafeFrames(
            timelineCursor,
            getVideoClipDurationFramesV4(migrated, document.renderProfile),
        );
        return migrated;
    });
    return {
        version: 4,
        revision: document.revision,
        audioGraphRevision: document.audioGraphRevision,
        renderProfile: cloneRenderProfile(document.renderProfile),
        subtitleTracks: document.subtitleTracks.map(migrateSubtitleTrack),
        videoSources: document.videoSources.map((source) => ({ ...source })),
        videoClips,
        videoTracks: document.videoTracks.map(migrateVideoTrack),
        audioSources: document.audioSources.map((source) => ({ ...source })),
        audioTracks: cloneAudioTracks(document.audioTracks),
        activeSubtitleTrackId: document.activeSubtitleTrackId,
        transientSelection: cloneSelection(document.transientSelection),
        transcriptionByTrackId: cloneTranscriptionProvenance(document.transcriptionByTrackId),
        globalEditingMode: 'ripple',
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
    };
}

function migrateManifestGraph(manifest: EditorManifestV3): EditorManifestV4 {
    const trackIdByClipId = buildTrackIdByClipId(manifest.videoTracks);
    let timelineCursor = 0;
    const videoClips = manifest.videoClips.map((clip) => {
        const trackId = trackIdByClipId.get(clip.id);
        if (!trackId) throw new Error('Valid V3 manifest lost video-track ownership during migration.');
        const migrated: VideoClipV4 = {
            ...clip,
            audio: clip.audio ? { ...clip.audio } : null,
            trackId,
            timelineStartFrame: timelineCursor,
        };
        timelineCursor = addSafeFrames(
            timelineCursor,
            getVideoClipDurationFramesV4(migrated, manifest.renderProfile),
        );
        return migrated;
    });
    return {
        version: 4,
        revision: manifest.revision,
        audioGraphRevision: manifest.audioGraphRevision,
        renderProfile: cloneRenderProfile(manifest.renderProfile),
        subtitleTracks: manifest.subtitleTracks.map(migrateSubtitleTrack),
        videoSourceDescriptors: manifest.videoSourceDescriptors.map((source) => ({ ...source })),
        videoClips,
        videoTracks: manifest.videoTracks.map(migrateVideoTrack),
        audioSourceDescriptors: manifest.audioSourceDescriptors.map((source) => ({ ...source })),
        audioTracks: cloneAudioTracks(manifest.audioTracks),
        activeSubtitleTrackId: manifest.activeSubtitleTrackId,
        transcriptionByTrackId: cloneTranscriptionProvenance(manifest.transcriptionByTrackId),
        globalEditingMode: 'ripple',
        editorialTranscriptDescriptors: [],
        narrative: null,
        dependentLinks: [],
    };
}

function buildTrackIdByClipId(videoTracks: readonly VideoTrack[]): Map<string, string> {
    const trackIdByClipId = new Map<string, string>();
    videoTracks.forEach((track) => track.clipIds.forEach((clipId) => {
        if (trackIdByClipId.has(clipId)) {
            throw new Error('V3 video lane membership is not a disjoint clip partition.');
        }
        trackIdByClipId.set(clipId, track.id);
    }));
    return trackIdByClipId;
}

function migrateSubtitleTrack(track: EditorDocumentV3['subtitleTracks'][number]): SubtitleTrackV4 {
    const { timingDomain, ...base } = track;
    return {
        ...base,
        style: { ...base.style, position: { ...base.style.position } },
        subtitles: base.subtitles.map((subtitle) => ({ ...subtitle })),
        unlinkedVideoEditResponse: timingDomain === 'video-ripple'
            ? 'follow-project-ripple'
            : 'stay-absolute',
    };
}

function cloneSubtitleTrack(track: SubtitleTrackV4): SubtitleTrackV4 {
    return {
        ...track,
        style: { ...track.style, position: { ...track.style.position } },
        subtitles: track.subtitles.map((subtitle) => ({ ...subtitle })),
    };
}

function migrateVideoTrack(track: VideoTrack): VideoTrackV4 {
    return { id: track.id, name: track.name, visible: true, locked: false };
}

function cloneVideoClip(clip: VideoClipV4): VideoClipV4 {
    return { ...clip, audio: clip.audio ? { ...clip.audio } : null };
}

function cloneAudioTracks(tracks: EditorDocumentV3['audioTracks']): EditorDocumentV3['audioTracks'] {
    return tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
            ...clip,
            source: { ...clip.source },
        } as AudioClip)),
    }));
}

function cloneTranscriptionProvenance(
    provenance: Record<string, TrackTranscriptionProvenanceV3>,
): Record<string, TrackTranscriptionProvenanceV3> {
    return Object.fromEntries(Object.entries(provenance).map(([trackId, state]) => [trackId, {
        ...state,
        raw: state.raw.map((subtitle) => ({ ...subtitle })),
        groups: Object.fromEntries(Object.entries(state.groups).map(([groupId, subtitles]) => [
            groupId,
            subtitles.map((subtitle) => ({ ...subtitle })),
        ])),
        containerIds: [...state.containerIds],
        extensions: state.extensions ? cloneJsonDomain(state.extensions) : undefined,
    }]));
}

function cloneSelection(selection: EditorDocumentV3['transientSelection']): TransientMediaSelectionV4 {
    if (selection.kind === 'subtitles') return { ...selection, subtitleIds: [...selection.subtitleIds] };
    return { ...selection };
}

function cloneRenderProfile(profile: EditorDocumentV3['renderProfile']): EditorDocumentV3['renderProfile'] {
    return { ...profile, fps: { ...profile.fps } };
}

function cloneJsonDomain<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => cloneJsonDomain(item)) as T;
    // Persisted V4 narrative/link values are plain JSON objects. Provenance extensions are open
    // to future runtime-owned object types, so preserve any non-plain value by reference rather
    // than silently converting a Date, typed array, or future class instance into an empty map.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, cloneJsonDomain(item)])) as T;
}

function withoutFile<T extends { file: File }>(asset: T): Omit<T, 'file'> {
    const { file, ...descriptor } = asset;
    void file;
    return descriptor;
}

function addSafeFrames(start: number, duration: number): number {
    const end = start + duration;
    if (!Number.isSafeInteger(end)) throw new RangeError('Migrated V4 placement exceeds the safe frame range.');
    return end;
}

function assertValidV3Document(document: EditorDocumentV3, label: string): void {
    const validation = validateEditorDocumentV3(document);
    if (!validation.valid) throwMigrationError(label, validation.issues);
}

function assertValidV4Document(document: EditorDocumentV4, label: string): void {
    const validation = validateEditorDocumentV4(document);
    if (!validation.valid) throwMigrationError(label, validation.issues);
}

function assertValidV4Manifest(manifest: EditorManifestV4, label: string): void {
    const validation = validateEditorManifestV4(manifest);
    if (!validation.valid) throwMigrationError(label, validation.issues);
}

function throwMigrationError(
    label: string,
    issues: readonly { path: string; message: string }[],
): never {
    const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`Invalid ${label}: ${details}`);
}
