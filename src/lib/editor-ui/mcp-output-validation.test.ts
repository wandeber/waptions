import { describe, expect, it } from 'vitest';

import {
  mcpJobListDataSchema,
  mcpTimelineQueryDataSchema,
} from './mcp-output-validation';

describe('MCP output validation', () => {
  it('accepts the closed source-range and link projection used by the managed timeline', () => {
    expect(mcpTimelineQueryDataSchema.parse({
      entityKind: 'video-clips',
      items: [{
        id: 'clip-1',
        kind: 'video-clip',
        trackId: 'video-track-1',
        startFrame: 24,
        endFrame: 72,
        sourceId: 'source-1',
        sourceKind: 'video-source',
        sourceStartSeconds: 1,
        sourceEndSeconds: 3,
        sourceStartFrame: 24,
        sourceEndFrame: 72,
        audioLinkState: 'linked',
        audioGainDb: -3,
        anchorBlockId: 'block-1',
        targetKind: 'subtitle',
        targetTrackId: 'subtitle-track-1',
        targetId: 'subtitle-1',
        associationKind: 'transcript-bound',
        followPolicy: 'follow',
        relativeStartOutputSample: 0,
        relativeEndOutputSample: 96_000,
        revision: 4,
      }],
      page: { hasMore: false },
    }).items[0]).toMatchObject({
      sourceId: 'source-1',
      audioLinkState: 'linked',
      targetId: 'subtitle-1',
    });
  });

  it('accepts every concrete managed export job kind', () => {
    const base = {
      schemaVersion: 1 as const,
      projectId: 'project-1',
      inputDigest: `sha256:${'1'.repeat(64)}`,
      capturedState: {
        sessionId: 'session-1',
        projectId: 'project-1',
        sessionEpoch: 'epoch-1',
        sessionRevision: 1,
        documentRevision: 1,
        audioGraphRevision: 1,
        eventCursor: 'cursor-1',
      },
      jobSequence: 1,
      state: 'queued' as const,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      stage: 'queued',
      cancellationRequested: false,
      resultArtifactIds: [],
    };
    const kinds = [
      'export:mp4-h264-aac',
      'export:webm',
      'export:portable-bundle',
      'export:reference-snapshot',
      'export:proof-record',
    ] as const;

    const parsed = mcpJobListDataSchema.parse({
      items: kinds.map((kind, index) => ({
        ...base,
        jobId: `job-${index}`,
        kind,
      })),
      page: { hasMore: false },
    });

    expect(parsed.items.map((job) => job.kind)).toEqual(kinds);
  });
});
