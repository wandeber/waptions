import type { EditorUiMediaResolver } from './contracts';

const DEFAULT_LOCAL_BRIDGE_ORIGIN = 'http://localhost:59941';

interface PairingResponse {
  ok?: boolean;
  data?: {
    capabilityToken?: string;
    expiresAt?: string;
  };
}

export interface CreateLocalBridgeMediaResolverOptions {
  pairingCapability: string;
  bridgeOrigin?: string;
  fetchImplementation?: typeof fetch;
}

/**
 * Exchanges host-only MCP metadata for a resource-scoped local bridge capability.
 *
 * The one-shot pairing value and resulting signed URLs remain inside the App. They are never
 * copied into snapshots, events, tool structuredContent, project state, or model context.
 */
export function createLocalBridgeMediaResolver(
  options: CreateLocalBridgeMediaResolverOptions,
): EditorUiMediaResolver {
  const bridgeOrigin = new URL(options.bridgeOrigin ?? DEFAULT_LOCAL_BRIDGE_ORIGIN).origin;
  if (bridgeOrigin !== DEFAULT_LOCAL_BRIDGE_ORIGIN) {
    throw new Error('The media bridge origin is not CSP-approved for this editor build.');
  }
  const request = options.fetchImplementation ?? fetch;
  let resourceCapabilityPromise: Promise<string> | null = null;

  const pair = (): Promise<string> => {
    if (resourceCapabilityPromise) return resourceCapabilityPromise;
    resourceCapabilityPromise = request(`${bridgeOrigin}/v1/pair/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCapability: options.pairingCapability }),
      cache: 'no-store',
      credentials: 'omit',
    }).then(async (response) => {
      const body = await response.json() as PairingResponse;
      const token = body.ok === true ? body.data?.capabilityToken : undefined;
      if (!response.ok || !token) {
        throw new Error('The local media bridge rejected the editor pairing capability.');
      }
      return token;
    }).catch((error) => {
      resourceCapabilityPromise = null;
      throw error;
    });
    return resourceCapabilityPromise;
  };

  const resolve = async (
    collection: 'media' | 'artifacts',
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (signal?.aborted) throw new DOMException('Media URL resolution was cancelled.', 'AbortError');
    const capability = await pair();
    if (signal?.aborted) throw new DOMException('Media URL resolution was cancelled.', 'AbortError');
    const url = new URL(`/v1/${collection}/${encodeURIComponent(resourceId)}`, bridgeOrigin);
    url.searchParams.set('capability', capability);
    return url.toString();
  };

  return {
    resolveSourceUrl: (sourceId, signal) => resolve('media', sourceId, signal),
    resolveArtifactUrl: (artifactId, signal) => resolve('artifacts', artifactId, signal),
    releaseUrl() {
      // Signed HTTP range URLs do not own browser Blob/ObjectURL resources.
    },
  };
}
