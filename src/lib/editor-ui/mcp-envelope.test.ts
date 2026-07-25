import { describe, expect, it } from 'vitest';
import { createEmptyEditorUiSnapshot } from './contracts';
import {
  normalizeMcpEvent,
  normalizeMcpJobState,
  normalizeMcpSnapshot,
  type McpEditorEventType,
  type McpJobState,
} from './mcp-envelope';

describe('MCP editor envelope normalization', () => {
  it.each([
    ['pending', 'queued'],
    ['queued', 'queued'],
    ['active', 'running'],
    ['running', 'running'],
    ['recovering', 'running'],
    ['paused', 'running'],
    ['succeeded', 'completed'],
    ['completed', 'completed'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['stale', 'failed'],
    ['interrupted', 'failed'],
  ] satisfies Array<[McpJobState, ReturnType<typeof normalizeMcpJobState>]>)(
    'normalizes job state %s to %s',
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
  ] satisfies Array<[McpEditorEventType, ReturnType<typeof normalizeMcpEvent>['kind']]>)(
    'normalizes event %s to %s',
    (type, expectedKind) => {
      const state = createEmptyEditorUiSnapshot({ sessionId: 'session' }).stateToken;
      expect(normalizeMcpEvent({
        eventId: 'event',
        previousCursor: 'before',
        cursor: 'after',
        type,
        state,
      }).kind).toBe(expectedKind);
    },
  );

  it('uses the authoritative state and preserves narrativeRevision', () => {
    const snapshot = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    snapshot.jobs = [{
      id: 'job',
      kind: 'export',
      label: 'Export',
      state: 'completed',
      progress: 1,
    }];
    const state = {
      ...snapshot.stateToken,
      sessionRevision: 9,
      documentRevision: 8,
      narrativeRevision: 7,
      eventCursor: 'cursor-9',
    };
    const normalized = normalizeMcpSnapshot(snapshot, state);
    expect(normalized.stateToken).toMatchObject({
      sessionRevision: 9,
      documentRevision: 8,
      narrativeRevision: 7,
      eventCursor: 'cursor-9',
    });
    expect(normalized.jobs[0]?.state).toBe('completed');
  });

  it('rejects job states outside the normalized runtime and MCP vocabulary', () => {
    expect(() => normalizeMcpJobState('done' as McpJobState)).toThrow(/Unsupported/);
  });

  it('rejects unknown event vocabulary so the controller refreshes authoritatively', () => {
    const state = createEmptyEditorUiSnapshot({ sessionId: 'session' }).stateToken;
    expect(() => normalizeMcpEvent({
      eventId: 'event',
      previousCursor: 'before',
      cursor: 'after',
      type: 'project.magic',
      state,
    })).toThrow(/unsupported/);
  });
});
