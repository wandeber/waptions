'use client';

import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ManagedWebEditorHost } from '@/components/editor-surface';
import type { EditorUiMediaResolver, EditorUiRpcBridge } from '@/lib/editor-ui';

const LOCAL_COORDINATOR_ORIGIN = 'http://localhost:59941';

declare global {
  interface Window {
    /** Optional direct bridge installed by a trusted managed-editor container. */
    __WAPTIONS_MANAGED_EDITOR_BRIDGE__?: EditorUiRpcBridge;
    /** Resource resolver installed alongside the bridge; capability URLs never enter route state. */
    __WAPTIONS_MANAGED_EDITOR_MEDIA_RESOLVER__?: EditorUiMediaResolver;
  }
}

interface ManagedEditorRouteProps {
  sessionId: string;
}

interface PairingState {
  capability: string;
  viewId: string;
}

export function ManagedEditorRoute({ sessionId }: ManagedEditorRouteProps) {
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [missingCapability, setMissingCapability] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const url = new URL(window.location.href);
    const capability = url.searchParams.get('capability');
    if (!capability) {
      setMissingCapability(true);
      return;
    }
    // The pairing secret is one-shot. Remove it before opening a bridge or rendering the editor so
    // reloads, copied URLs, browser history, and diagnostics cannot retain the capability.
    url.searchParams.delete('capability');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    setPairing({ capability, viewId: crypto.randomUUID() });
  }, []);

  if (missingCapability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <section role="alert" className="max-w-md rounded border border-amber-500/30 bg-slate-900 p-5">
          <div className="flex items-center gap-2 text-amber-300">
            <AlertTriangle className="h-5 w-5" />
            <h1 className="font-semibold">Managed editor pairing required</h1>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Open this editor from an active Waptions managed session. Pairing links are single-use
            and are removed from browser history after exchange.
          </p>
        </section>
      </main>
    );
  }

  if (!pairing) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
        Pairing managed editor…
      </main>
    );
  }

  return (
    <main className="h-screen min-h-0 overflow-hidden bg-slate-950">
      <ManagedWebEditorHost
        sessionId={sessionId}
        viewId={pairing.viewId}
        pairingCapability={pairing.capability}
        coordinatorOrigin={LOCAL_COORDINATOR_ORIGIN}
        bridge={window.__WAPTIONS_MANAGED_EDITOR_BRIDGE__}
        mediaResolver={window.__WAPTIONS_MANAGED_EDITOR_MEDIA_RESOLVER__}
      />
    </main>
  );
}
