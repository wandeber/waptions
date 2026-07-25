import type { EditorUiCommand, EditorUiSnapshot } from './contracts';
import { secondsToNarrativeSample } from './core-operation-mapper';

export const buildEditorialTranscriptionCommand = (
  snapshot: EditorUiSnapshot,
  providerId: string,
): Extract<EditorUiCommand, { type: 'transcription.start' }> | null => {
  const trackIds = snapshot.project.tracks
    .filter((track) => track.kind === 'video')
    .map((track) => track.id);
  const endSample = secondsToNarrativeSample(snapshot.project.durationSeconds);
  if (trackIds.length === 0 || endSample < 1 || providerId.trim().length === 0) return null;
  return {
    type: 'transcription.start',
    mode: 'editorial',
    trackIds,
    ranges: [{ startSample: 0, endSample, sampleRate: 16_000 }],
    language: 'es',
    speakerMode: 'detect',
    providerPolicy: 'managed-local-endpoint',
    providerId: providerId.trim(),
  };
};

export const buildManagedMediaImportCommand = (
  grantId: string,
  path: string,
): Extract<EditorUiCommand, { type: 'media.import' }> | null => (
  grantId.trim() && path.trim()
    ? {
        type: 'media.import',
        grantId: grantId.trim(),
        sources: [{ path: path.trim() }],
        placement: 'append-natural-order',
      }
    : null
);

export const buildManagedExportCommand = (
  grantId: string,
  destinationPath: string,
): Extract<EditorUiCommand, { type: 'export.start' }> | null => (
  grantId.trim() && destinationPath.trim()
    ? {
        type: 'export.start',
        format: 'mp4-h264-aac',
        grantId: grantId.trim(),
        destinationPath: destinationPath.trim(),
      }
    : null
);
