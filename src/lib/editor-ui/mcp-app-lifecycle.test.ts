import { describe, expect, it } from 'vitest';
import type { EditorUiRpcBridge } from './rpc-bridge';
import { initializeMcpAppBridge, readMcpUiHostContext } from './mcp-app-lifecycle';

class LifecycleBridge implements EditorUiRpcBridge {
  requests: Array<{ method: string; params: unknown }> = [];
  notifications: Array<{ method: string; params: unknown }> = [];

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    this.requests.push({ method, params });
    return {
      protocolVersion: '2026-01-26',
      hostContext: {
        displayMode: 'pip',
        availableDisplayModes: ['inline', 'pip'],
      },
    } as Result;
  }
  notify(method: string, params?: unknown) {
    this.notifications.push({ method, params });
  }
  subscribe() {
    return () => {};
  }
  handleRequest() {
    return () => {};
  }
  close() {}
}

describe('MCP App lifecycle', () => {
  it('performs the mandatory handshake once per bridge before initialized', async () => {
    const bridge = new LifecycleBridge();
    const first = initializeMcpAppBridge(bridge);
    const second = initializeMcpAppBridge(bridge);
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(bridge.requests).toEqual([{
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'waptions-editor', version: '1.0.0' },
        appCapabilities: {
          availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        },
      },
    }]);
    expect(bridge.notifications).toEqual([{
      method: 'ui/notifications/initialized',
      params: undefined,
    }]);
  });

  it('normalizes negotiated host context and ignores unknown display modes', () => {
    expect(readMcpUiHostContext({
      hostContext: {
        displayMode: 'pip',
        availableDisplayModes: ['inline', 'floating', 'fullscreen'],
      },
    })).toEqual({
      displayMode: 'pip',
      availableDisplayModes: ['inline', 'fullscreen'],
    });
  });
});
