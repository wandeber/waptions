import type {
  EditorUiCommandRequest,
  EditorUiCommandResult,
  EditorUiEvent,
  EditorUiModelContext,
  EditorUiPresentationMode,
  EditorUiSnapshot,
  EditorUiTransport,
} from './contracts';
import { createWindowRpcBridge, type EditorUiRpcBridge } from './rpc-bridge';

export interface CreateManagedWebTransportOptions {
  bridge?: EditorUiRpcBridge;
  pairingCapability: string;
  sessionId: string;
  viewId: string;
  coordinatorOrigin?: string;
}

/**
 * Managed web transport over a pairing window/iframe bridge.
 *
 * The one-time capability is sent only during pairing and must be removed from browser history by
 * the route before this transport is created. Subsequent calls use the opaque view token returned
 * by the coordinator and never place either token in URLs.
 */
export function createManagedWebTransport(
  options: CreateManagedWebTransportOptions,
): EditorUiTransport {
  const bridge = options.bridge ?? createWindowRpcBridge({
    targetWindow: window.parent === window ? window.opener : window.parent,
    targetOrigin: options.coordinatorOrigin,
    acceptMessage: options.coordinatorOrigin
      ? (event) => event.origin === options.coordinatorOrigin
      : undefined,
    requestIdPrefix: 'waptions-managed-web',
  });
  const ownsBridge = options.bridge === undefined;
  let viewToken: string | null = null;
  let pairingPromise: Promise<string> | null = null;
  let closed = false;

  const ensurePaired = async (): Promise<string> => {
    if (closed) throw new Error('The managed editor transport is closed.');
    if (viewToken) return viewToken;
    if (!pairingPromise) {
      // Pairing consumes a one-shot capability. It intentionally outlives an individual React
      // connect AbortSignal so StrictMode replay cannot spend the capability twice.
      pairingPromise = bridge.request<{ viewToken: string }>('waptions/editor/pair', {
        sessionId: options.sessionId,
        viewId: options.viewId,
        capability: options.pairingCapability,
      }).then((response) => {
        if (!response?.viewToken) {
          throw new Error('The managed editor pairing response was invalid.');
        }
        if (closed) {
          bridge.notify('waptions/editor/detach', {
            viewId: options.viewId,
            viewToken: response.viewToken,
          });
          throw new Error('The managed editor transport closed during pairing.');
        }
        viewToken = response.viewToken;
        return response.viewToken;
      }).catch((error) => {
        pairingPromise = null;
        throw error;
      });
    }
    return pairingPromise;
  };

  return {
    async readSnapshot(signal?: AbortSignal): Promise<EditorUiSnapshot> {
      const token = await ensurePaired();
      return bridge.request('waptions/editor/snapshot', {
        sessionId: options.sessionId,
        viewId: options.viewId,
        viewToken: token,
      }, signal);
    },
    async execute(
      request: EditorUiCommandRequest,
      signal?: AbortSignal,
    ): Promise<EditorUiCommandResult> {
      const token = await ensurePaired();
      return bridge.request('waptions/editor/command', {
        sessionId: options.sessionId,
        viewId: options.viewId,
        viewToken: token,
        request,
      }, signal);
    },
    async subscribe({ cursor, signal }, onEvent): Promise<void> {
      const token = await ensurePaired();
      const unsubscribe = bridge.subscribe('waptions/editor/event', (params) => {
        const envelope = params as { viewId?: string; event?: EditorUiEvent };
        if (envelope.viewId === options.viewId && envelope.event) onEvent(envelope.event);
      });
      signal.addEventListener('abort', unsubscribe, { once: true });
      await bridge.request('waptions/editor/subscribe', {
        sessionId: options.sessionId,
        viewId: options.viewId,
        viewToken: token,
        cursor,
      }, signal);
    },
    async readEvents({ cursor, limit, signal }) {
      const token = await ensurePaired();
      return bridge.request('waptions/editor/events', {
        sessionId: options.sessionId,
        viewId: options.viewId,
        viewToken: token,
        cursor,
        limit,
      }, signal);
    },
    async requestPresentation(mode: EditorUiPresentationMode) {
      const token = await ensurePaired();
      return bridge.request<EditorUiPresentationMode>('waptions/editor/presentation', {
        viewId: options.viewId,
        viewToken: token,
        mode,
      });
    },
    async updateModelContext(context: EditorUiModelContext) {
      const token = await ensurePaired();
      await bridge.request('waptions/editor/context', {
        viewId: options.viewId,
        viewToken: token,
        context,
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (viewToken) {
        bridge.notify('waptions/editor/detach', {
          viewId: options.viewId,
          viewToken,
        });
      }
      viewToken = null;
      if (ownsBridge) bridge.close();
    },
  };
}
