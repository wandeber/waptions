import type { Subtitle, SubtitleTrack } from '@/types/timeline';
import type {
    AudioSourceAsset,
    EditorDocumentV3,
    EditorManifestV2,
    EditorManifestV3,
    RenderProfile,
    TrackTranscriptionProvenanceV3,
    TrackTranscriptionState,
    VideoClipAudioSettings,
    VideoSourceAssetV3,
} from '@/types/video';
import { getEditorAudioGraphSignature, validateEditorDocumentV3 } from './editor-document-v3';
import { createDefaultRenderProfile, normalizeFrameRate, secondsToFrames } from './render-profile';
import { createDefaultVideoTracks } from './video-tracks';

export interface EditorDocumentV2MigrationInput {
    manifest: EditorManifestV2;
    loadedVideoSources: readonly VideoSourceAssetV3[];
    renderProfile?: RenderProfile;
}

export interface LegacyEditorDocumentMigrationInput {
    tracks: readonly SubtitleTrack[];
    rawTranscription: readonly Subtitle[] | null;
    transcriptionGroups: Record<string, Subtitle[]> | null;
    transcriptionContainerIds: readonly string[] | null;
    loadedVideoSource: VideoSourceAssetV3 | null;
    renderProfile?: RenderProfile;
}

/**
 * Migrates an already-loaded v2 graph without importing probe/decoder modules. File lookup and
 * media inspection are I/O concerns owned by callers; keeping this transform pure makes a failed
 * migration harmless and deterministic across IndexedDB and bundle imports.
 */
export function migrateEditorDocumentV2ToV3(input: EditorDocumentV2MigrationInput): EditorDocumentV3 {
    const { manifest } = input;
    const renderProfile = input.renderProfile ?? createMigrationRenderProfile(
        manifest.projectFps,
        input.loadedVideoSources[0],
    );
    const videoSources = input.loadedVideoSources.map((source) => ({ ...source }));
    const videoSourcesById = new Map(videoSources.map((source) => [source.id, source]));
    const videoClips = manifest.videoClips.map((clip) => {
        const source = videoSourcesById.get(clip.sourceId);
        if (!source) throw new Error(`V2 clip "${clip.id}" references missing source "${clip.sourceId}".`);
        return {
            ...clip,
            audio: source.hasAudio
                ? migrateRuntimeAudioSettings(clip, Math.max(1, secondsToFrames(
                    clip.sourceEnd - clip.sourceStart,
                    renderProfile.fps,
                    'nearest',
                )))
                : null,
        };
    });
    const subtitleTracks = manifest.tracks.map((track) => ({
        ...track,
        timingDomain: 'video-ripple' as const,
    }));
    const base: EditorDocumentV3 = {
        version: 3,
        revision: manifest.revision,
        audioGraphRevision: 0,
        renderProfile,
        subtitleTracks,
        videoSources,
        videoClips,
        videoTracks: createDefaultVideoTracks(videoClips),
        audioSources: [],
        audioTracks: [],
        activeSubtitleTrackId: manifest.activeTrackId,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: {},
    };
    base.transcriptionByTrackId = migrateTranscriptionState(manifest.transcriptionByTrackId, base);
    assertValidMigration(base, 'v2');
    return base;
}

/** Migrates legacy scalar state after its optional video File has already been inspected. */
export function migrateLegacyEditorDocumentToV3(input: LegacyEditorDocumentMigrationInput): EditorDocumentV3 {
    const source = input.loadedVideoSource;
    const renderProfile = input.renderProfile ?? createMigrationRenderProfile(source?.fps ?? 30, source ?? undefined);
    const activeTrackId = input.tracks[0]?.id ?? null;
    const transcriptionByTrackId: Record<string, TrackTranscriptionState> = {};
    if (activeTrackId && input.transcriptionGroups && input.transcriptionContainerIds) {
        transcriptionByTrackId[activeTrackId] = {
            raw: input.rawTranscription ? [...input.rawTranscription] : [],
            groups: input.transcriptionGroups,
            containerIds: [...input.transcriptionContainerIds],
        };
    }
    const sourceEnd = source ? Math.floor(source.duration * renderProfile.fps.numerator
        / renderProfile.fps.denominator) * renderProfile.fps.denominator / renderProfile.fps.numerator : 0;
    const v2: EditorManifestV2 = {
        version: 2,
        revision: 1,
        projectFps: renderProfile.fps.numerator / renderProfile.fps.denominator,
        tracks: [...input.tracks],
        sourceDescriptors: source ? [withoutFile(source)] : [],
        videoClips: source && sourceEnd > 0 ? [{
            id: createMigrationId('video_clip', source.id),
            sourceId: source.id,
            sourceStart: 0,
            sourceEnd,
        }] : [],
        activeTrackId,
        transcriptionByTrackId,
    };
    return migrateEditorDocumentV2ToV3({
        manifest: v2,
        loadedVideoSources: source ? [source] : [],
        renderProfile,
    });
}

/** Builds the durable form and deliberately drops transient selection and runtime File objects. */
export function createEditorManifestV3(document: EditorDocumentV3): EditorManifestV3 {
    return {
        version: 3,
        revision: document.revision,
        audioGraphRevision: document.audioGraphRevision,
        renderProfile: document.renderProfile,
        subtitleTracks: document.subtitleTracks,
        videoSourceDescriptors: document.videoSources.map(withoutFile),
        videoClips: document.videoClips,
        videoTracks: document.videoTracks,
        audioSourceDescriptors: document.audioSources.map(withoutFile),
        audioTracks: document.audioTracks,
        activeSubtitleTrackId: document.activeSubtitleTrackId,
        transcriptionByTrackId: document.transcriptionByTrackId,
    };
}

export function hydrateEditorDocumentV3(
    manifest: EditorManifestV3,
    videoSources: readonly VideoSourceAssetV3[],
    audioSources: readonly AudioSourceAsset[],
): EditorDocumentV3 {
    const normalizedManifest = normalizeLegacyEditorManifestV3(manifest);
    const document: EditorDocumentV3 = {
        version: 3,
        revision: normalizedManifest.revision,
        audioGraphRevision: normalizedManifest.audioGraphRevision,
        renderProfile: normalizedManifest.renderProfile,
        subtitleTracks: normalizedManifest.subtitleTracks,
        videoSources: [...videoSources],
        videoClips: normalizedManifest.videoClips,
        videoTracks: normalizedManifest.videoTracks,
        audioSources: [...audioSources],
        audioTracks: normalizedManifest.audioTracks,
        activeSubtitleTrackId: normalizedManifest.activeSubtitleTrackId,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: normalizedManifest.transcriptionByTrackId,
    };
    assertValidMigration(document, 'v3');
    return document;
}

/**
 * Adds the deterministic first video lane only when the field is absent from an older V3 graph.
 *
 * Keeping document/bundle version 3 avoids a media migration for a presentation-only concept.
 * Older Waptions builds do not understand lanes and may flatten membership if they reopen and
 * resave a newer file; that compatibility boundary is accepted until a future major format bump.
 */
export function normalizeLegacyEditorManifestV3(manifest: EditorManifestV3): EditorManifestV3 {
    if (Object.prototype.hasOwnProperty.call(manifest, 'videoTracks')) return manifest;
    return {
        ...manifest,
        videoTracks: createDefaultVideoTracks(manifest.videoClips),
    };
}

function migrateTranscriptionState(
    states: Record<string, TrackTranscriptionState>,
    document: EditorDocumentV3,
): Record<string, TrackTranscriptionProvenanceV3> {
    const signature = getEditorAudioGraphSignature(document);
    return Object.fromEntries(Object.entries(states).map(([trackId, state]) => [trackId, {
        ...state,
        sourceDocumentRevision: document.revision,
        sourceAudioGraphRevision: document.audioGraphRevision,
        sourceAudioGraphSignature: signature,
        stale: false,
    }]));
}

function migrateRuntimeAudioSettings(clip: object, durationFrames: number): VideoClipAudioSettings {
    const candidate = 'audio' in clip ? clip.audio : null;
    const settings = coerceSafeAudioSettings(candidate, durationFrames);
    if (settings) return settings;
    return { linkState: 'linked', muted: false, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 };
}

function coerceSafeAudioSettings(value: unknown, durationFrames: number): VideoClipAudioSettings | null {
    if (typeof value !== 'object' || value === null) return null;
    const settings = value as Record<string, unknown>;
    const linkState = settings.linkState === undefined ? 'linked' : settings.linkState;
    const muted = settings.muted;
    const gainDb = settings.gainDb;
    const fadeInFrames = settings.fadeInFrames;
    const fadeOutFrames = settings.fadeOutFrames;
    const valid = (linkState === 'linked' || linkState === 'detached')
        && typeof muted === 'boolean'
        && typeof gainDb === 'number'
        && Number.isFinite(gainDb)
        && gainDb >= -60
        && gainDb <= 12
        && typeof fadeInFrames === 'number'
        && Number.isSafeInteger(fadeInFrames)
        && fadeInFrames >= 0
        && typeof fadeOutFrames === 'number'
        && Number.isSafeInteger(fadeOutFrames)
        && fadeOutFrames >= 0
        && fadeInFrames + fadeOutFrames <= durationFrames;
    if (!valid) return null;
    return {
        linkState,
        muted,
        gainDb,
        fadeInFrames,
        fadeOutFrames,
    } as VideoClipAudioSettings;
}

function createMigrationRenderProfile(
    fps: number,
    source?: Pick<VideoSourceAssetV3, 'width' | 'height'>,
): RenderProfile {
    return createDefaultRenderProfile({
        fps: decimalFrameRateToRational(fps),
        width: source?.width ?? 1920,
        height: source?.height ?? 1080,
        // Existing media has already established the project's edit/output contract. Locking
        // both dimensions prevents a later audio-only import from unexpectedly redefining it.
        isFrameRateLocked: source !== undefined,
        isCanvasSizeLocked: source !== undefined,
    });
}

function decimalFrameRateToRational(fps: number): { numerator: number; denominator: number } {
    if (!Number.isFinite(fps) || fps <= 0) return { numerator: 30, denominator: 1 };
    const broadcastRates = [24_000, 30_000, 60_000, 120_000];
    const broadcast = broadcastRates.find((numerator) => Math.abs(fps - numerator / 1_001) < 0.001);
    if (broadcast) return { numerator: broadcast, denominator: 1_001 };
    const denominator = 1_000_000;
    return normalizeFrameRate({ numerator: Math.round(fps * denominator), denominator });
}

function withoutFile<T extends { file: File }>(asset: T): Omit<T, 'file'> {
    const { file, ...descriptor } = asset;
    void file;
    return descriptor;
}

function createMigrationId(prefix: string, sourceId: string): string {
    return `${prefix}_${sourceId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function assertValidMigration(document: EditorDocumentV3, sourceVersion: string): void {
    const validation = validateEditorDocumentV3(document);
    if (!validation.valid) {
        const details = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        throw new Error(`Invalid ${sourceVersion} editor migration: ${details}`);
    }
}
