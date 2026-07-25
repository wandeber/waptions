import { describe, expect, it } from 'vitest';
import { createEmptyEditorUiSnapshot } from './contracts';
import {
  buildEditorialTranscriptionCommand,
  buildManagedExportCommand,
  buildManagedMediaImportCommand,
} from './command-builders';

describe('managed editor command builders', () => {
  it('builds a complete editorial transcription request in the 16 kHz domain', () => {
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.project.durationSeconds = 10;
    snapshot.project.tracks = [{
      id: 'video-track',
      kind: 'video',
      name: 'Video',
      clips: [],
      locked: false,
      height: 96,
    }];
    expect(buildEditorialTranscriptionCommand(snapshot, ' lazy-whisper-api ')).toEqual({
      type: 'transcription.start',
      mode: 'editorial',
      trackIds: ['video-track'],
      ranges: [{ startSample: 0, endSample: 160_000, sampleRate: 16_000 }],
      language: 'es',
      speakerMode: 'detect',
      providerPolicy: 'managed-local-endpoint',
      providerId: 'lazy-whisper-api',
    });
  });

  it('builds complete granted import/export requests and rejects empty authority', () => {
    expect(buildManagedMediaImportCommand('grant', '/media/source.mov')).toEqual({
      type: 'media.import',
      grantId: 'grant',
      sources: [{ path: '/media/source.mov' }],
      placement: 'append-natural-order',
    });
    expect(buildManagedExportCommand('grant', '/exports/video.mp4')).toEqual({
      type: 'export.start',
      format: 'mp4-h264-aac',
      grantId: 'grant',
      destinationPath: '/exports/video.mp4',
    });
    expect(buildManagedMediaImportCommand('', '/media/source.mov')).toBeNull();
    expect(buildManagedExportCommand('grant', '')).toBeNull();
  });
});
