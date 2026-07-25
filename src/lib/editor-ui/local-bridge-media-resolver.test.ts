import { describe, expect, it, vi } from 'vitest';
import { createLocalBridgeMediaResolver } from './local-bridge-media-resolver';

describe('createLocalBridgeMediaResolver', () => {
  it('pairs once and returns scoped encoded range URLs for media and artifacts', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { capabilityToken: 'resource-capability' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const resolver = createLocalBridgeMediaResolver({
      pairingCapability: 'one-shot-pairing',
      fetchImplementation,
    });

    await expect(resolver.resolveSourceUrl('source/one')).resolves.toBe(
      'http://localhost:59941/v1/media/source%2Fone?capability=resource-capability',
    );
    await expect(resolver.resolveArtifactUrl('artifact-1')).resolves.toBe(
      'http://localhost:59941/v1/artifacts/artifact-1?capability=resource-capability',
    );
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith(
      'http://localhost:59941/v1/pair/exchange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ pairingCapability: 'one-shot-pairing' }),
        credentials: 'omit',
      }),
    );
  });

  it('rejects bridge origins that are not covered by the immutable App CSP', () => {
    expect(() => createLocalBridgeMediaResolver({
      pairingCapability: 'capability',
      bridgeOrigin: 'http://localhost:60000',
    })).toThrow(/not CSP-approved/);
  });
});
