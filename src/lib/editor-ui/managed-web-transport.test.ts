import { describe, expect, it } from 'vitest';
import type { EditorUiRpcBridge } from './rpc-bridge';
import { createEmptyEditorUiSnapshot } from './contracts';
import { createManagedWebTransport } from './managed-web-transport';

class DeferredPairBridge implements EditorUiRpcBridge {
  requests: Array<{ method: string; params: unknown }> = [];
  notifications: Array<{ method: string; params: unknown }> = [];
  closed = false;
  private resolvePair?: (value: { viewToken: string }) => void;

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    this.requests.push({ method, params });
    if (method === 'waptions/editor/pair') {
      return new Promise<{ viewToken: string }>((resolve) => {
        this.resolvePair = resolve;
      }) as Promise<Result>;
    }
    if (method === 'waptions/editor/snapshot') {
      return createEmptyEditorUiSnapshot({ sessionId: 'session' }) as Result;
    }
    return {} as Result;
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
  close() {
    this.closed = true;
  }
  pair(viewToken = 'view-token') {
    this.resolvePair?.({ viewToken });
  }
}

describe('createManagedWebTransport', () => {
  it('deduplicates one-shot pairing and does not close an injected bridge', async () => {
    const bridge = new DeferredPairBridge();
    const transport = createManagedWebTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      pairingCapability: 'one-shot',
    });
    const first = transport.readSnapshot();
    const second = transport.readSnapshot();

    expect(bridge.requests.filter((request) => request.method === 'waptions/editor/pair')).toHaveLength(1);
    bridge.pair();
    await Promise.all([first, second]);
    expect(
      bridge.requests.filter((request) => request.method === 'waptions/editor/snapshot'),
    ).toHaveLength(2);

    transport.close?.();
    expect(bridge.notifications).toContainEqual({
      method: 'waptions/editor/detach',
      params: { viewId: 'view', viewToken: 'view-token' },
    });
    expect(bridge.closed).toBe(false);
  });

  it('detaches a pairing response that arrives after close', async () => {
    const bridge = new DeferredPairBridge();
    const transport = createManagedWebTransport({
      bridge,
      sessionId: 'session',
      viewId: 'view',
      pairingCapability: 'one-shot',
    });
    const read = transport.readSnapshot();
    transport.close?.();
    bridge.pair('late-token');
    await expect(read).rejects.toThrow(/closed during pairing/);
    expect(bridge.notifications).toContainEqual({
      method: 'waptions/editor/detach',
      params: { viewId: 'view', viewToken: 'late-token' },
    });
  });
});
