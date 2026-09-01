import { describe, expect, it, vi } from 'vitest';
import { BarbackProbeError, probeBarback } from './barback-probe.js';
import type { BarbackClientConfig } from './barback-client-config.js';

const config: BarbackClientConfig = {
  schemaVersion: 1,
  stackId: 'barback-local',
  network: 'barback',
  hostGateway: '192.0.2.1',
  dnsServers: ['192.0.2.10'],
  dnsSearch: ['barback.internal'],
  dnsGeneration: 'generation-1',
  gatewayAddress: '192.0.2.20',
  egressGeneration: 'egress-generation-1',
  generatedAt: '2026-08-31T00:00:00.000Z',
  validUntil: '2026-08-31T01:00:00.000Z',
  apiBaseUrl: 'http://barback.internal:8080/v1',
  mcpUrl: 'http://barback.internal:8080/mcp',
  hostProbeUrl: 'http://192.0.2.20:8080/health/live',
  credentialMode: 'onecli-proxy',
};

describe('probeBarback', () => {
  it('verifies host-side liveness without resolving private guest DNS', async () => {
    const probeImpl = vi.fn().mockResolvedValue(undefined);
    await expect(probeBarback(config, { probeImpl })).resolves.toBeUndefined();
    expect(probeImpl).toHaveBeenCalledWith('http://192.0.2.20:8080/health/live', 5000);
  });

  it('fails closed when reachability returns non-2xx', async () => {
    const probeImpl = vi.fn().mockRejectedValue(new Error('curl: (22) HTTP 503'));
    await expect(probeBarback(config, { probeImpl })).rejects.toBeInstanceOf(BarbackProbeError);
  });

  it('fails closed on timeout', async () => {
    const probeImpl = vi.fn().mockRejectedValue(new Error('curl: (28) Operation timed out'));
    await expect(probeBarback(config, { probeImpl, timeoutMs: 20 })).rejects.toBeInstanceOf(BarbackProbeError);
  });
});
