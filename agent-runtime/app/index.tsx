'use client';

import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { McpAppEditorHost } from '../../src/components/editor-surface';
import {
  createWindowRpcBridge,
  createLocalBridgeMediaResolver,
  fromMcpDisplayMode,
  initializeMcpAppBridge,
  readMcpUiHostContext,
  type EditorUiPresentationMode,
  type EditorUiRpcBridge,
  type EditorUiSnapshot,
  type McpUiHostContext,
} from '../../src/lib/editor-ui';

interface AppLaunchInput {
  sessionId: string;
  viewId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readLaunchInput = (value: unknown): AppLaunchInput | null => {
  if (!isRecord(value) || !isRecord(value.arguments)) return null;
  const sessionId = value.arguments.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const suppliedViewId = value.arguments.viewId;
  return {
    sessionId,
    viewId: typeof suppliedViewId === 'string' && suppliedViewId.length > 0
      ? suppliedViewId
      : crypto.randomUUID(),
  };
};

const readInitialSnapshot = (value: unknown): EditorUiSnapshot | null => {
  if (!isRecord(value)) return null;
  const structured = isRecord(value.structuredContent) ? value.structuredContent : value;
  if (structured.ok !== true || !isRecord(structured.data)) return null;
  return isRecord(structured.data.editorUiSnapshot)
    ? structured.data.editorUiSnapshot as unknown as EditorUiSnapshot
    : null;
};

const readMediaPairingCapability = (value: unknown): string | null => {
  if (!isRecord(value) || !isRecord(value._meta) || !isRecord(value._meta.bridge)) return null;
  const capability = value._meta.bridge.capabilityToken;
  return typeof capability === 'string' && capability.length > 0 ? capability : null;
};

function WaptionsMcpApp({ bridge }: { bridge: EditorUiRpcBridge }) {
  const [launchInput, setLaunchInput] = useState<AppLaunchInput | null>(null);
  const [initialSnapshot, setInitialSnapshot] = useState<EditorUiSnapshot | null>(null);
  const [mediaPairingCapability, setMediaPairingCapability] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext>({
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
  });
  const [initialized, setInitialized] = useState(false);
  const [tornDown, setTornDown] = useState(false);

  useEffect(() => {
    const unsubscribeInput = bridge.subscribe('ui/notifications/tool-input', (payload) => {
      const next = readLaunchInput(payload);
      if (next) {
        // Launch identity is immutable. Mutation tool results must never replace this controller.
        setLaunchInput((current) => current ?? next);
        setLaunchError(null);
      }
    });
    const unsubscribeResult = bridge.subscribe('ui/notifications/tool-result', (payload) => {
      const snapshot = readInitialSnapshot(payload);
      if (snapshot) setInitialSnapshot((current) => current ?? snapshot);
      const mediaCapability = readMediaPairingCapability(payload);
      if (mediaCapability) {
        setMediaPairingCapability((current) => current ?? mediaCapability);
      }
    });
    const unsubscribeCancelled = bridge.subscribe('ui/notifications/tool-cancelled', () => {
      setLaunchError('The editor launch was cancelled.');
    });
    const unsubscribeHostContext = bridge.subscribe(
      'ui/notifications/host-context-changed',
      (payload) => {
        const context = readMcpUiHostContext(payload);
        if (context) setHostContext((current) => ({ ...current, ...context }));
      },
    );
    const unsubscribeTeardown = bridge.handleRequest('ui/resource-teardown', async () => {
      setTornDown(true);
      // The JSON-RPC response is posted in a promise continuation after this handler resolves.
      // Closing in a later task guarantees the host receives that required acknowledgement first.
      setTimeout(() => bridge.close(), 0);
      return {};
    });

    void initializeMcpAppBridge(bridge).then(
      (result) => {
        const context = readMcpUiHostContext(result.hostContext ?? result);
        if (context) setHostContext((current) => ({ ...current, ...context }));
        setInitialized(true);
      },
      (error) => {
        setLaunchError(
          error instanceof Error ? error.message : 'The MCP host could not initialize the editor.',
        );
      },
    );

    return () => {
      unsubscribeInput();
      unsubscribeResult();
      unsubscribeCancelled();
      unsubscribeHostContext();
      unsubscribeTeardown();
    };
  }, [bridge]);

  const launch = useMemo(() => (
    initialized && launchInput && initialSnapshot
      ? { ...launchInput, initialSnapshot }
      : null
  ), [initialSnapshot, initialized, launchInput]);
  const mediaResolver = useMemo(() => (
    mediaPairingCapability
      ? createLocalBridgeMediaResolver({ pairingCapability: mediaPairingCapability })
      : undefined
  ), [mediaPairingCapability]);

  if (tornDown) return null;
  if (!launch) {
    return (
      <main className="flex h-screen min-h-[260px] items-center justify-center bg-slate-950 p-6 text-slate-300">
        <section role={launchError ? 'alert' : 'status'} className="max-w-sm text-center">
          <h1 className="text-sm font-semibold">Waptions editor</h1>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {launchError ?? 'Waiting for a managed Waptions session…'}
          </p>
        </section>
      </main>
    );
  }

  const presentation: EditorUiPresentationMode = hostContext.displayMode
    ? fromMcpDisplayMode(hostContext.displayMode)
    : 'inline';

  return (
    <main className="h-screen min-h-0 overflow-hidden bg-slate-950">
      <McpAppEditorHost
        sessionId={launch.sessionId}
        viewId={launch.viewId}
        initialSnapshot={launch.initialSnapshot}
        bridge={bridge}
        availableDisplayModes={hostContext.availableDisplayModes}
        hostPresentation={presentation}
        mediaResolver={mediaResolver}
      />
    </main>
  );
}

const bridge = createWindowRpcBridge({
  targetWindow: window.parent,
  requestIdPrefix: 'waptions-mcp-app',
});
const container = document.getElementById('root');
if (!container) throw new Error('The Waptions MCP App root element is missing.');
createRoot(container).render(<WaptionsMcpApp bridge={bridge} />);
