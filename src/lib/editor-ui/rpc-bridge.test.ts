import { describe, expect, it } from 'vitest';
import { createWindowRpcBridge } from './rpc-bridge';

class FakeWindow extends EventTarget {
  posted: unknown[] = [];

  postMessage(message: unknown) {
    this.posted.push(message);
  }
}

const messageEvent = (source: FakeWindow, data: unknown): MessageEvent => {
  const event = new Event('message') as MessageEvent;
  Object.defineProperties(event, {
    data: { value: data },
    source: { value: source },
  });
  return event;
};

describe('createWindowRpcBridge', () => {
  it('handles inbound JSON-RPC requests and returns a response with the same id', async () => {
    const target = new FakeWindow();
    const receiver = new FakeWindow();
    const bridge = createWindowRpcBridge({
      targetWindow: target as unknown as Window,
      receiveWindow: receiver as unknown as Window,
    });
    bridge.handleRequest('ui/resource-teardown', async () => ({ acknowledged: true }));

    receiver.dispatchEvent(messageEvent(target, {
      jsonrpc: '2.0',
      id: 42,
      method: 'ui/resource-teardown',
      params: {},
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(target.posted).toContainEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { acknowledged: true },
    });
    bridge.close();
  });

  it('returns method-not-found for unsupported host requests', async () => {
    const target = new FakeWindow();
    const receiver = new FakeWindow();
    const bridge = createWindowRpcBridge({
      targetWindow: target as unknown as Window,
      receiveWindow: receiver as unknown as Window,
    });
    receiver.dispatchEvent(messageEvent(target, {
      jsonrpc: '2.0',
      id: 'teardown',
      method: 'unknown/request',
    }));

    expect(target.posted).toContainEqual({
      jsonrpc: '2.0',
      id: 'teardown',
      error: { code: -32601, message: 'Unsupported app request: unknown/request' },
    });
    bridge.close();
  });
});
