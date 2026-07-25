import type {
  EditorUiCommand,
  EditorUiExportDestinationCapability,
  EditorUiSnapshot,
} from './contracts';
import { secondsToNarrativeSample } from './core-operation-mapper';

export const buildEditorialTranscriptionCommand = (
  snapshot: EditorUiSnapshot,
  endpointCapabilityId = '',
): Extract<EditorUiCommand, { type: 'transcription.start' }> | null => {
  const targetTrackIds = snapshot.project.tracks
    .filter((track) => track.kind === 'video')
    .map((track) => track.id);
  const sourceRangeEnds = new Map<string, number>();
  for (const track of snapshot.project.tracks) {
    if (!targetTrackIds.includes(track.id)) continue;
    for (const clip of track.clips) {
      if (!clip.sourceId) continue;
      sourceRangeEnds.set(
        clip.sourceId,
        Math.max(
          sourceRangeEnds.get(clip.sourceId) ?? 0,
          clip.sourceDurationSeconds
            ?? clip.sourceOffsetSeconds + clip.durationSeconds,
        ),
      );
    }
  }
  const ranges = Array.from(sourceRangeEnds).map(([sourceId, endSeconds]) => ({
    sourceId,
    startSample16k: 0,
    endSample16k: secondsToNarrativeSample(endSeconds),
  })).filter((range) => range.endSample16k > 0);
  if (targetTrackIds.length === 0) return null;
  const normalizedCapabilityId = endpointCapabilityId.trim();
  return {
    type: 'transcription.start',
    transcriptionKind: 'editorial',
    targetTrackIds,
    ...(ranges.length > 0 ? { ranges } : {}),
    language: 'es',
    speakerMode: 'diarized',
    providerPolicy: {
      kind: 'managed-local-endpoint',
      ...(normalizedCapabilityId
        ? { endpointCapabilityId: normalizedCapabilityId }
        : {}),
    },
  };
};

type MediaImportCommand = Extract<EditorUiCommand, { type: 'media.import' }>;

export function buildManagedMediaImportCommand(
  mediaHandles: readonly string[],
  placement: MediaImportCommand['placement'],
): MediaImportCommand | null;
/** Legacy UI prompts cannot manufacture verified media handles, so they fail closed. */
export function buildManagedMediaImportCommand(
  legacyGrantId: string,
  legacyPath: string,
): MediaImportCommand | null;
export function buildManagedMediaImportCommand(
  mediaHandlesOrLegacyGrant: readonly string[] | string,
  placementOrLegacyPath: MediaImportCommand['placement'] | string,
): MediaImportCommand | null {
  if (typeof mediaHandlesOrLegacyGrant === 'string'
    || typeof placementOrLegacyPath === 'string') return null;
  const mediaHandles = Array.from(new Set(
    mediaHandlesOrLegacyGrant.map((handle) => handle.trim()).filter(Boolean),
  ));
  return mediaHandles.length > 0
    ? { type: 'media.import', mediaHandles, placement: placementOrLegacyPath }
    : null;
}

type ExportCommand = Extract<EditorUiCommand, { type: 'export.start' }>;

export function buildManagedExportCommand(
  destination: EditorUiExportDestinationCapability,
  exportKind?: ExportCommand['exportKind'],
): ExportCommand | null;
/** Legacy path grants are insufficient because export requires a staged destination capability. */
export function buildManagedExportCommand(
  legacyGrantId: string,
  legacyDestinationPath: string,
): ExportCommand | null;
export function buildManagedExportCommand(
  destinationOrLegacyGrant: EditorUiExportDestinationCapability | string,
  exportKindOrLegacyPath: ExportCommand['exportKind'] | string = 'mp4-h264-aac',
): ExportCommand | null {
  if (typeof destinationOrLegacyGrant === 'string'
    || !destinationOrLegacyGrant.destinationId.trim()
    || !destinationOrLegacyGrant.grantId.trim()
    || !destinationOrLegacyGrant.stagingHandleId.trim()
    || !destinationOrLegacyGrant.outputName.trim()
    || !destinationOrLegacyGrant.verifiedParentIdentity.trim()
    || !destinationOrLegacyGrant.expiresAt.trim()) return null;
  return {
    type: 'export.start',
    exportKind: exportKindOrLegacyPath as ExportCommand['exportKind'],
    destination: destinationOrLegacyGrant,
  };
}
