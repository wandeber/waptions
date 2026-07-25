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
      clips: [{
        id: 'clip',
        trackId: 'video-track',
        sourceId: 'source',
        kind: 'video',
        label: 'Source',
        startSeconds: 0,
        durationSeconds: 10,
        sourceOffsetSeconds: 0,
        linkedTargetIds: [],
      }],
      locked: false,
      height: 96,
    }];
    expect(buildEditorialTranscriptionCommand(snapshot, ' lazy-whisper-api ')).toEqual({
      type: 'transcription.start',
      transcriptionKind: 'editorial',
      targetTrackIds: ['video-track'],
      ranges: [{ sourceId: 'source', startSample16k: 0, endSample16k: 160_000 }],
      language: 'es',
      speakerMode: 'diarized',
      providerPolicy: {
        kind: 'managed-local-endpoint',
        endpointCapabilityId: 'lazy-whisper-api',
      },
    });
  });

  it('uses the managed local transcription default when no endpoint capability is supplied', () => {
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.project.tracks = [{
      id: 'video-track',
      kind: 'video',
      name: 'Video',
      clips: [],
      locked: false,
      height: 96,
    }];

    expect(buildEditorialTranscriptionCommand(snapshot)).toEqual({
      type: 'transcription.start',
      transcriptionKind: 'editorial',
      targetTrackIds: ['video-track'],
      language: 'es',
      speakerMode: 'diarized',
      providerPolicy: { kind: 'managed-local-endpoint' },
    });
  });

  it('uses the source duration as an absolute range end and ignores non-target tracks', () => {
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.project.tracks = [
      {
        id: 'video-track',
        kind: 'video',
        name: 'Video',
        clips: [{
          id: 'trimmed-video',
          trackId: 'video-track',
          sourceId: 'video-source',
          kind: 'video',
          label: 'Trimmed video',
          startSeconds: 0,
          durationSeconds: 5,
          sourceOffsetSeconds: 10,
          sourceDurationSeconds: 20,
          linkedTargetIds: [],
        }],
        locked: false,
        height: 96,
      },
      {
        id: 'audio-track',
        kind: 'audio',
        name: 'Audio',
        clips: [{
          id: 'audio',
          trackId: 'audio-track',
          sourceId: 'audio-source',
          kind: 'audio',
          label: 'Audio',
          startSeconds: 0,
          durationSeconds: 30,
          sourceOffsetSeconds: 0,
          linkedTargetIds: [],
        }],
        locked: false,
        height: 72,
      },
    ];

    expect(buildEditorialTranscriptionCommand(snapshot)?.ranges).toEqual([{
      sourceId: 'video-source',
      startSample16k: 0,
      endSample16k: 320_000,
    }]);
  });

  it('builds capability-backed import/export requests and rejects legacy paths', () => {
    expect(buildManagedMediaImportCommand(
      [' media-handle '],
      { kind: 'place', ordering: 'natural', timelineStartFrame: 0 },
    )).toEqual({
      type: 'media.import',
      mediaHandles: ['media-handle'],
      placement: { kind: 'place', ordering: 'natural', timelineStartFrame: 0 },
    });
    const destination = {
      schemaVersion: 1 as const,
      destinationId: 'destination',
      grantId: 'grant',
      stagingHandleId: 'staging',
      mode: 'create-only' as const,
      outputName: 'video.mp4',
      verifiedParentIdentity: 'parent',
      expiresAt: '2026-07-25T12:00:00.000Z',
    };
    expect(buildManagedExportCommand(destination)).toEqual({
      type: 'export.start',
      exportKind: 'mp4-h264-aac',
      destination,
    });
    expect(buildManagedMediaImportCommand('grant', '/media/source.mov')).toBeNull();
    expect(buildManagedExportCommand('grant', '/exports/video.mp4')).toBeNull();
    expect(buildManagedMediaImportCommand('', '/media/source.mov')).toBeNull();
    expect(buildManagedExportCommand('grant', '')).toBeNull();
  });
});
