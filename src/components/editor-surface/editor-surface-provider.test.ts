import { createElement, StrictMode, useEffect } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createEmptyEditorUiSnapshot,
  ExternalEditorUiController,
  type EditorUiSnapshot,
  type EditorUiTransport,
} from '@/lib/editor-ui';
import {
  EditorSurfaceProvider,
  useEditorUiSnapshot,
} from './EditorSurfaceProvider';

describe('EditorSurfaceProvider', () => {
  it('updates an external revision without remounting descendants', async () => {
    const initial = createEmptyEditorUiSnapshot({
      sessionId: 'session',
      sessionEpoch: 'epoch',
      eventCursor: 'cursor-1',
    });
    initial.connection = 'connected';
    let current: EditorUiSnapshot = initial;
    const transport: EditorUiTransport = {
      async readSnapshot() {
        return current;
      },
      async execute(request) {
        return {
          ok: true,
          commandId: request.commandId,
          stateToken: current.stateToken,
          snapshot: current,
        };
      },
    };
    const controller = new ExternalEditorUiController({
      viewId: 'view',
      initialSnapshot: initial,
      transport,
    });
    let mounts = 0;
    let unmounts = 0;
    const observed: number[] = [];
    function Probe() {
      const snapshot = useEditorUiSnapshot();
      observed.push(snapshot.stateToken.documentRevision);
      useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return createElement('span', null, snapshot.project.name);
    }

    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(
        EditorSurfaceProvider,
        { controller },
        createElement(Probe),
      ));
    });
    const external = {
      ...initial,
      stateToken: {
        ...initial.stateToken,
        sessionRevision: 2,
        documentRevision: 2,
        eventCursor: 'cursor-2',
      },
      project: { ...initial.project, name: 'External project edit' },
    };
    current = external;
    await act(async () => {
      controller.acceptEvent({
        eventId: 'event-2',
        previousCursor: 'cursor-1',
        cursor: 'cursor-2',
        stateToken: external.stateToken,
        kind: 'project',
        snapshot: external,
      });
    });

    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(observed).toContain(2);
    expect(renderer!.root.findByType('span').children).toEqual(['External project edit']);
    await act(async () => renderer!.unmount());
    expect(unmounts).toBe(1);
  });

  it('does not terminally close a controller during the Strict Mode effect replay', async () => {
    const initial = createEmptyEditorUiSnapshot({ sessionId: 'strict-session' });
    let closeCalls = 0;
    const transport: EditorUiTransport = {
      async readSnapshot() {
        return initial;
      },
      async execute(request) {
        return {
          ok: true,
          commandId: request.commandId,
          stateToken: initial.stateToken,
          snapshot: initial,
        };
      },
      close() {
        closeCalls += 1;
      },
    };
    const controller = new ExternalEditorUiController({
      viewId: 'strict-view',
      initialSnapshot: initial,
      transport,
    });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(
        StrictMode,
        null,
        createElement(EditorSurfaceProvider, { controller }),
      ));
      await Promise.resolve();
    });
    expect(closeCalls).toBe(0);

    await act(async () => {
      renderer!.unmount();
      await Promise.resolve();
    });
    expect(closeCalls).toBe(1);
  });
});
