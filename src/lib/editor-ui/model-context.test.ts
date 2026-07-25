import { describe, expect, it } from 'vitest';
import { createEmptyEditorUiSnapshot } from './contracts';
import { buildEditorUiModelContext } from './model-context';

describe('buildEditorUiModelContext', () => {
  it('publishes a bounded allowlist without transcript, media, URL, path, or credential data', () => {
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.project.name = 'N'.repeat(200);
    snapshot.project.tracks = [{
      id: 'video-track',
      kind: 'video',
      name: '/Users/private/source.mov',
      locked: false,
      visible: true,
      height: 96,
      clips: [{
        id: 'clip-secret',
        trackId: 'video-track',
        sourceId: 'source-secret',
        kind: 'video',
        label: 'secret transcript and api-key-value',
        text: 'the complete transcript must not leak',
        startSeconds: 0,
        durationSeconds: 5,
        sourceOffsetSeconds: 0,
        linkedTargetIds: [],
      }],
    }];
    snapshot.project.narrativeBlocks = [{
      id: 'block-secret',
      clipId: 'clip-secret',
      kind: 'speech',
      text: 'private transcript',
      sourceStartSample16k: 0,
      sourceEndSample16k: 80_000,
      startSeconds: 0,
      durationSeconds: 5,
      linkedTargetIds: [],
    }];
    snapshot.view.selectedIds = Array.from({ length: 50 }, (_, index) => (
      index === 0 ? 'clip-secret' : `unknown-${index}`
    ));
    snapshot.jobs = Array.from({ length: 12 }, (_, index) => ({
      id: `job-${index}`,
      kind: 'export' as const,
      label: `Export to /private/${index}`,
      state: 'running' as const,
      progress: 0.5,
      message: 'signed-url?token=credential',
    }));
    snapshot.recentSemanticAction = 'A'.repeat(300);

    const context = buildEditorUiModelContext(snapshot);
    const serialized = JSON.stringify(context);
    expect(context.selection).toEqual([{ id: 'clip-secret', type: 'video' }]);
    expect(context.activeJobs).toHaveLength(8);
    expect(context.project.name.length).toBeLessThanOrEqual(120);
    expect(context.recentSemanticAction).toBeNull();
    expect(serialized.length).toBeLessThan(8_192);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('transcript');
    expect(serialized).not.toContain('api-key');
    expect(serialized).not.toContain('signed-url');
    expect(serialized).not.toContain('source-secret');
  });

  it('redacts suspicious labels and malformed opaque ids and normalizes numeric values', () => {
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.project.id = '/Users/private/project';
    snapshot.project.name = 'https://host/path?token=secret';
    snapshot.project.tracks = [{
      id: 'track-safe',
      kind: 'audio',
      name: 'Track',
      locked: false,
      height: 80,
      clips: [{
        id: 'clip/suspicious',
        trackId: 'track-safe',
        kind: 'audio',
        label: 'Clip',
        startSeconds: 0,
        durationSeconds: 1,
        sourceOffsetSeconds: 0,
        linkedTargetIds: [],
      }],
    }];
    snapshot.view.selectedIds = ['clip/suspicious'];
    snapshot.view.playheadSeconds = Number.NaN;
    snapshot.jobs = [{
      id: 'job-safe',
      kind: 'analysis',
      label: 'Analysis',
      state: 'running',
      progress: 9,
    }];
    snapshot.recentSemanticAction = 'video-clip.move';

    const context = buildEditorUiModelContext(snapshot);
    expect(context).toMatchObject({
      project: { id: 'redacted', name: 'Waptions project' },
      selection: [{ id: 'redacted', type: 'audio' }],
      timecodeSeconds: 0,
      activeJobs: [{ id: 'job-safe', progress: 1 }],
      recentSemanticAction: 'video-clip.move',
    });
    expect(JSON.stringify(context)).not.toContain('secret');
  });
});
