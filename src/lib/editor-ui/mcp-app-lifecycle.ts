import type { EditorUiRpcBridge } from './rpc-bridge';
import type { McpUiDisplayMode } from './mcp-app-transport';

export const MCP_APP_PROTOCOL_VERSION = '2026-01-26' as const;

export interface McpUiHostContext {
  displayMode?: McpUiDisplayMode;
  availableDisplayModes?: McpUiDisplayMode[];
}

export interface McpUiInitializeResult {
  protocolVersion?: string;
  hostContext?: McpUiHostContext;
}

const initializationByBridge = new WeakMap<
  EditorUiRpcBridge,
  Promise<McpUiInitializeResult>
>();

export const initializeMcpAppBridge = (
  bridge: EditorUiRpcBridge,
): Promise<McpUiInitializeResult> => {
  const active = initializationByBridge.get(bridge);
  if (active) return active;
  const initialization = bridge.request<McpUiInitializeResult>('ui/initialize', {
    protocolVersion: MCP_APP_PROTOCOL_VERSION,
    appInfo: {
      name: 'waptions-editor',
      version: '1.0.0',
    },
    appCapabilities: {
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    },
  }).then((result) => {
    bridge.notify('ui/notifications/initialized');
    return result;
  }).catch((error) => {
    initializationByBridge.delete(bridge);
    throw error;
  });
  initializationByBridge.set(bridge, initialization);
  return initialization;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const readMcpUiHostContext = (value: unknown): McpUiHostContext | null => {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.hostContext) ? value.hostContext : value;
  const displayMode = candidate.displayMode;
  const available = candidate.availableDisplayModes;
  return {
    ...(displayMode === 'inline' || displayMode === 'fullscreen' || displayMode === 'pip'
      ? { displayMode }
      : {}),
    ...(Array.isArray(available)
      ? {
          availableDisplayModes: available.filter(
            (mode): mode is McpUiDisplayMode => (
              mode === 'inline' || mode === 'fullscreen' || mode === 'pip'
            ),
          ),
        }
      : {}),
  };
};
