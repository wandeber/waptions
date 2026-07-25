import { describe, expect, it } from 'vitest';
import {
  mapEditorUiCommand,
  secondsToNarrativeSample,
  secondsToOutputSample,
  secondsToProjectFrame,
} from './core-operation-mapper';

describe('mapEditorUiCommand', () => {
  it('keeps exact Core operation names and integer timing domains', () => {
    expect(mapEditorUiCommand({
      type: 'project.set-name',
      name: 'Exact vocabulary',
    }, { operationId: 'rename:0' })).toEqual({
      tool: 'edit',
      operations: [{
        operationId: 'rename:0',
        type: 'project.set-name',
        payload: { name: 'Exact vocabulary' },
      }],
    });
    expect(mapEditorUiCommand({
      type: 'track.delete',
      trackKind: 'video',
      trackId: 'track-a',
      policy: 'rehome',
      rehomeTrackId: 'track-b',
    }, { operationId: 'delete-track:0' })).toEqual({
      tool: 'edit',
      operations: [{
        operationId: 'delete-track:0',
        type: 'track.delete',
        payload: {
          trackKind: 'video',
          trackId: 'track-a',
          policy: 'rehome',
          rehomeTrackId: 'track-b',
        },
      }],
    });
    expect(mapEditorUiCommand({
      type: 'video-clip.trim',
      clipId: 'video-a',
      sourceStartSeconds: 1,
      sourceEndSeconds: 8,
      timelineStartFrame: 30,
    }, { operationId: 'trim-video:0' })).toMatchObject({
      tool: 'edit',
      operations: [{
        operationId: 'trim-video:0',
        type: 'video-clip.trim',
        payload: {
          clipId: 'video-a',
          sourceStartSeconds: 1,
          sourceEndSeconds: 8,
          timelineStartFrame: 30,
        },
      }],
    });
    expect(mapEditorUiCommand({
      type: 'audio-clip.trim',
      clipId: 'audio-a',
      sourceRange: {
        domain: 'audio-source-native-samples',
        audioSourceId: 'source-a',
        nativeSampleRateHz: 44_100,
        startNativeSample: 4_410,
        endNativeSample: 44_100,
      },
    }, { operationId: 'trim-audio:0' })).toEqual({
      tool: 'edit',
      operations: [{
        operationId: 'trim-audio:0',
        type: 'audio-clip.trim',
        payload: {
          clipId: 'audio-a',
          sourceRange: {
            domain: 'native-samples',
            audioSourceId: 'source-a',
            nativeSampleRateHz: 44_100,
            startNativeSample: 4_410,
            endNativeSample: 44_100,
          },
        },
      }],
    });
    expect(mapEditorUiCommand({
      type: 'audio-clip.set-fades',
      clipId: 'audio-a',
      fadeInOutputSamples48k: 48_000,
      fadeOutOutputSamples48k: 96_000,
    }, { operationId: 'fade-audio:0' })).toMatchObject({
      tool: 'edit',
      operations: [{
        operationId: 'fade-audio:0',
        type: 'audio-clip.set-fades',
        payload: {
          fadeInOutputSamples48k: 48_000,
          fadeOutOutputSamples48k: 96_000,
        },
      }],
    });
    expect(mapEditorUiCommand({
      type: 'video-clip.set-audio',
      clipId: 'video-a',
      muted: false,
      gainDb: -2,
      fadeInOutputSamples48k: 24_000,
      fadeOutOutputSamples48k: 48_000,
    }, { operationId: 'fade-video:0', projectFps: 30 })).toMatchObject({
      tool: 'edit',
      operations: [{
        operationId: 'fade-video:0',
        type: 'video-clip.set-audio',
        payload: {
          clipId: 'video-a',
          audio: {
            linkState: 'linked',
            muted: false,
            gainDb: -2,
            fadeInFrames: 15,
            fadeOutFrames: 30,
          },
        },
      }],
    });
    expect(mapEditorUiCommand({
      type: 'narrative.change-global-margins',
      preMarginSamples16k: 3_200,
      postMarginSamples16k: 4_800,
    }, { operationId: 'margins:0' })).toMatchObject({
      tool: 'edit',
      operations: [{
        operationId: 'margins:0',
        type: 'narrative.change-global-margins',
        payload: {
          preSamples16k: 3_200,
          postSamples16k: 4_800,
        },
      }],
    });
  });

  it('routes view, playback, history, jobs, transcription, and export separately', () => {
    expect(mapEditorUiCommand({ type: 'view.select', ids: ['clip'] })).toEqual({
      tool: 'view',
      patch: { selectionIds: ['clip'] },
    });
    expect(mapEditorUiCommand({ type: 'playback.seek', timelineFrame: 90 })).toEqual({
      tool: 'playback',
      action: 'seek',
      frame: 90,
    });
    expect(mapEditorUiCommand({ type: 'history.undo' })).toEqual({
      tool: 'history',
      action: 'undo',
    });
    expect(mapEditorUiCommand({
      type: 'transcription.start',
      mode: 'editorial',
      trackIds: ['video-1'],
      ranges: [{ startSample: 0, endSample: 16_000, sampleRate: 16_000 }],
      language: 'es',
      speakerMode: 'detect',
      providerPolicy: 'managed-local-endpoint',
      providerId: 'lazy-whisper-api',
    })).toEqual({
      tool: 'transcription',
      action: 'start',
      request: {
        mode: 'editorial',
        trackIds: ['video-1'],
        ranges: [{ startSample: 0, endSample: 16_000, sampleRate: 16_000 }],
        language: 'es',
        speakerMode: 'detect',
        providerPolicy: 'managed-local-endpoint',
        providerId: 'lazy-whisper-api',
      },
    });
    expect(mapEditorUiCommand({ type: 'job.cancel', jobId: 'job-1' })).toEqual({
      tool: 'job-cancel',
      jobId: 'job-1',
    });
  });

  it('rejects fractional or negative Core timing values', () => {
    expect(() => mapEditorUiCommand({
      type: 'video-clip.move',
      clipId: 'clip',
      trackId: 'track',
      timelineFrame: 1.5,
    }, { operationId: 'invalid:0', projectFps: 30 })).toThrow(/safe integer/);
    expect(() => mapEditorUiCommand({
      type: 'narrative.change-block-margin',
      blockId: 'block',
      side: 'start',
      marginSamples16k: -1,
    }, { operationId: 'invalid:0' })).toThrow(/non-negative/);
    expect(() => mapEditorUiCommand({
      type: 'audio-clip.trim',
      clipId: 'audio-a',
      sourceRange: {
        domain: 'audio-source-native-samples',
        audioSourceId: 'source-a',
        nativeSampleRateHz: 48_000,
        startNativeSample: 9_600,
        endNativeSample: 4_800,
      },
    }, { operationId: 'invalid:0' })).toThrow(/positive range/);
    expect(() => mapEditorUiCommand({
      type: 'video-clip.set-audio',
      clipId: 'video-a',
      muted: false,
      gainDb: 0,
      fadeInOutputSamples48k: 12.5,
      fadeOutOutputSamples48k: 0,
    }, { operationId: 'invalid:0' })).toThrow(/safe integer/);
    expect(() => mapEditorUiCommand({
      type: 'audio-clip.move',
      clipId: 'audio-a',
      trackId: 'audio-track',
      timelineFrame: -1,
    }, { operationId: 'invalid:0' })).toThrow(/non-negative/);
    expect(() => mapEditorUiCommand({
      type: 'audio-clip.trim',
      clipId: 'audio-a',
      sourceRange: {
        domain: 'audio-source-native-samples',
        audioSourceId: 'source-a',
        nativeSampleRateHz: 0,
        startNativeSample: 0,
        endNativeSample: 1,
      },
    }, { operationId: 'invalid:0' })).toThrow(/positive safe integer/);
    expect(() => mapEditorUiCommand({
      type: 'subtitle.insert',
      trackId: 'subtitle-track',
      subtitleId: 'subtitle',
      startOutputSample: 48_000,
      endOutputSample: 48_000,
      text: 'Invalid range',
    }, { operationId: 'invalid:0' })).toThrow(/positive half-open range/);
  });

  it('rejects a durable mapping without a retry-stable operation id', () => {
    expect(() => mapEditorUiCommand({
      type: 'project.set-name',
      name: 'Missing identity',
    })).toThrow(/operationId/);
  });

  it('normalizes presentation seconds before commands reach Core', () => {
    expect(secondsToProjectFrame(1.5, 30)).toBe(45);
    expect(secondsToOutputSample(1.5)).toBe(72_000);
    expect(secondsToNarrativeSample(1.5)).toBe(24_000);
    expect(secondsToProjectFrame(Number.NaN, 30)).toBe(0);
    expect(secondsToOutputSample(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
