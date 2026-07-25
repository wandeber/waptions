export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface EditorUiRpcBridge {
  request<Result>(method: string, params?: unknown, signal?: AbortSignal): Promise<Result>;
  notify(method: string, params?: unknown): void;
  subscribe(method: string, listener: (params: unknown) => void): () => void;
  handleRequest(
    method: string,
    handler: (params: unknown) => unknown | Promise<unknown>,
  ): () => void;
  close(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const isJsonRpcMessage = (value: unknown): value is JsonRpcMessage => (
  isRecord(value)
  && value.jsonrpc === '2.0'
  && (
    (typeof value.method === 'string')
    || (
      (typeof value.id === 'string' || typeof value.id === 'number')
      && ('result' in value || 'error' in value)
    )
  )
);

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

export interface CreateWindowRpcBridgeOptions {
  targetWindow: Window;
  receiveWindow?: Window;
  targetOrigin?: string;
  acceptMessage?: (event: MessageEvent) => boolean;
  requestIdPrefix?: string;
}

/**
 * Minimal JSON-RPC 2.0 postMessage client shared by the MCP App and managed web adapters.
 *
 * Sandboxed MCP App frames may have an opaque origin, so source-window identity is the mandatory
 * trust boundary. A managed web host should additionally provide an exact origin predicate.
 */
export function createWindowRpcBridge(
  options: CreateWindowRpcBridgeOptions,
): EditorUiRpcBridge {
  const receiveWindow = options.receiveWindow ?? window;
  const targetOrigin = options.targetOrigin ?? '*';
  const prefix = options.requestIdPrefix ?? 'waptions-ui';
  const pending = new Map<string, PendingRequest>();
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const requestHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >();
  let sequence = 0;
  let closed = false;

  const post = (message: JsonRpcMessage): void => {
    if (closed) throw new Error('The editor bridge is closed.');
    options.targetWindow.postMessage(message, targetOrigin);
  };

  const handleMessage = (event: MessageEvent): void => {
    if (closed || event.source !== options.targetWindow || options.acceptMessage?.(event) === false) {
      return;
    }
    const message = event.data;
    if (!isJsonRpcMessage(message)) return;
    if ('id' in message && !('method' in message)) {
      const request = pending.get(String(message.id));
      if (!request) return;
      pending.delete(String(message.id));
      request.removeAbortListener();
      if (message.error) {
        request.reject(new Error(message.error.message));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if ('method' in message) {
      if ('id' in message) {
        const requestId = message.id as JsonRpcId;
        const handler = requestHandlers.get(message.method);
        if (!handler) {
          post({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: -32601, message: `Unsupported app request: ${message.method}` },
          });
          return;
        }
        void Promise.resolve(handler(message.params)).then(
          (result) => post({ jsonrpc: '2.0', id: requestId, result }),
          (error) => post({
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : 'The app request failed.',
            },
          }),
        );
        return;
      }
      listeners.get(message.method)?.forEach((listener) => listener(message.params));
    }
  };
  receiveWindow.addEventListener('message', handleMessage);

  return {
    request<Result>(method: string, params?: unknown, signal?: AbortSignal): Promise<Result> {
      if (closed) return Promise.reject(new Error('The editor bridge is closed.'));
      const id = `${prefix}-${++sequence}`;
      return new Promise<Result>((resolve, reject) => {
        const handleAbort = () => {
          pending.delete(id);
          reject(new DOMException('The editor bridge request was cancelled.', 'AbortError'));
        };
        if (signal?.aborted) {
          handleAbort();
          return;
        }
        signal?.addEventListener('abort', handleAbort, { once: true });
        pending.set(id, {
          resolve: (value) => resolve(value as Result),
          reject,
          removeAbortListener: () => signal?.removeEventListener('abort', handleAbort),
        });
        try {
          post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
        } catch (error) {
          pending.delete(id);
          signal?.removeEventListener('abort', handleAbort);
          reject(error);
        }
      });
    },
    notify(method: string, params?: unknown): void {
      post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    subscribe(method: string, listener: (params: unknown) => void): () => void {
      const methodListeners = listeners.get(method) ?? new Set();
      methodListeners.add(listener);
      listeners.set(method, methodListeners);
      return () => {
        methodListeners.delete(listener);
        if (methodListeners.size === 0) listeners.delete(method);
      };
    },
    handleRequest(method, handler) {
      requestHandlers.set(method, handler);
      return () => {
        if (requestHandlers.get(method) === handler) requestHandlers.delete(method);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      receiveWindow.removeEventListener('message', handleMessage);
      pending.forEach((request) => {
        request.removeAbortListener();
        request.reject(new Error('The editor bridge closed before the host responded.'));
      });
      pending.clear();
      listeners.clear();
      requestHandlers.clear();
    },
  };
}
