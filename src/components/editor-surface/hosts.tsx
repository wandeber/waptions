'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  createEmptyEditorUiSnapshot,
  createManagedWebTransport,
  createMcpAppTransport,
  ExternalEditorUiController,
  type EditorUiMediaResolver,
  type EditorUiPresentationMode,
  type EditorUiRpcBridge,
  type EditorUiServices,
  type EditorUiSnapshot,
} from '@/lib/editor-ui';
import { EditorSurface } from './EditorSurface';
import { EditorSurfaceProvider } from './EditorSurfaceProvider';

export interface ManagedWebEditorHostProps {
  sessionId: string;
  viewId: string;
  pairingCapability: string;
  coordinatorOrigin?: string;
  bridge?: EditorUiRpcBridge;
  mediaResolver?: EditorUiMediaResolver;
  services?: Partial<EditorUiServices>;
}

export function ManagedWebEditorHost(props: ManagedWebEditorHostProps) {
  const controller = useMemo(() => new ExternalEditorUiController({
    viewId: props.viewId,
    initialSnapshot: createEmptyEditorUiSnapshot({ sessionId: props.sessionId }),
    transport: createManagedWebTransport({
      sessionId: props.sessionId,
      viewId: props.viewId,
      pairingCapability: props.pairingCapability,
      coordinatorOrigin: props.coordinatorOrigin,
      bridge: props.bridge,
    }),
  }), [
    props.bridge,
    props.coordinatorOrigin,
    props.pairingCapability,
    props.sessionId,
    props.viewId,
  ]);
  return (
    <EditorSurfaceProvider
      controller={controller}
      mediaResolver={props.mediaResolver}
      services={props.services}
    >
      <EditorSurface />
    </EditorSurfaceProvider>
  );
}

export interface McpAppEditorHostProps {
  sessionId: string;
  viewId: string;
  initialSnapshot?: EditorUiSnapshot;
  mediaResolver?: EditorUiMediaResolver;
  services?: Partial<EditorUiServices>;
  bridge?: EditorUiRpcBridge;
  availableDisplayModes?: readonly ('inline' | 'fullscreen' | 'pip')[];
  hostPresentation?: EditorUiPresentationMode;
}

export function McpAppEditorHost(props: McpAppEditorHostProps) {
  const initialDisplayModes = useRef(props.availableDisplayModes);
  const controller = useMemo(() => new ExternalEditorUiController({
    viewId: props.viewId,
    initialSnapshot: props.initialSnapshot ?? createEmptyEditorUiSnapshot({
      sessionId: props.sessionId,
    }),
    transport: createMcpAppTransport({
      sessionId: props.sessionId,
      viewId: props.viewId,
      bridge: props.bridge,
      initialSnapshot: props.initialSnapshot,
      availableDisplayModes: initialDisplayModes.current,
    }),
  }), [
    props.bridge,
    props.initialSnapshot,
    props.sessionId,
    props.viewId,
  ]);
  useEffect(() => {
    if (props.hostPresentation) {
      controller.updateView({ presentation: props.hostPresentation });
    }
  }, [controller, props.hostPresentation]);
  return (
    <EditorSurfaceProvider
      controller={controller}
      mediaResolver={props.mediaResolver}
      services={props.services}
    >
      <EditorSurface />
    </EditorSurfaceProvider>
  );
}
