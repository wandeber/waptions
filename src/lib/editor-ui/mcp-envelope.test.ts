import { describe, expect, it } from 'vitest';
import { createEmptyEditorUiSnapshot } from './contracts';
import {
  normalizeMcpEvent,
  normalizeMcpEvents,
  normalizeMcpJobState,
  type McpJobState,
} from './mcp-envelope';
import type { McpEventRecord } from './mcp-projection-contract';

describe('MCP editor envelope normalization', () => {
  it.each([
    ['queued', 'queued'],
    ['running', 'running'],
    ['succeeded', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['stale', 'failed'],
    ['interrupted', 'failed'],
  ] satisfies Array<[McpJobState, ReturnType<typeof normalizeMcpJobState>]>)(
    'normalizes canonical job state %s to %s',
    (source, expected) => {
      expect(normalizeMcpJobState(source)).toBe(expected);
    },
  );

  it.each([
    ['session.recovered', 'snapshot'],
    ['project.snapshot', 'snapshot'],
    ['project.mutated', 'project'],
    ['history.changed', 'history'],
    ['job.changed', 'job'],
    ['artifact.created', 'job'],
    ['diagnostics.changed', 'job'],
    ['presence.changed', 'presence'],
    ['view.changed', 'view'],
    ['source.invalidated', 'project'],
  ] satisfies Array<[McpEventRecord['type'], ReturnType<typeof normalizeMcpEvent>['kind']]>)(
    'normalizes event %s to %s',
    (type, expectedKind) => {
      const state = createEmptyEditorUiSnapshot({ sessionId: 'session' }).stateToken;
      expect(normalizeMcpEvent({
        schemaVersion: 1,
        cursor: 'after',
        type,
        occurredAt: '2026-07-25T12:00:00.000Z',
        state,
        sequence: 1,
        data: {},
      }, 'before').kind).toBe(expectedKind);
    },
  );

  it('derives previous cursors from the canonical event page order', () => {
    const state = createEmptyEditorUiSnapshot({ sessionId: 'session' }).stateToken;
    const event = (cursor: string, sequence: number): McpEventRecord => ({
      schemaVersion: 1,
      cursor,
      type: 'project.mutated',
      occurredAt: '2026-07-25T12:00:00.000Z',
      state: { ...state, eventCursor: cursor },
      sequence,
      data: {
        commandId: `command-${sequence}`,
        operationIds: [],
        affectedIds: [],
      },
    });
    expect(normalizeMcpEvents({
      events: [event('cursor-1', 1), event('cursor-2', 2)],
      nextCursor: 'cursor-2',
      hasMore: false,
    }, 'cursor-0')).toMatchObject([
      { previousCursor: 'cursor-0', cursor: 'cursor-1' },
      { previousCursor: 'cursor-1', cursor: 'cursor-2' },
    ]);
  });
});
