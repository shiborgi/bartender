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
  generatedAt: '2026-08-31T00:00:00.000Z',
  validUntil: '2026-08-31T01:00:00.000Z',
  apiBaseUrl: 'http://barback.internal:8080/v1',
  mcpUrl: 'http://barback.internal:8080/mcp',
  credentialMode: 'onecli-proxy',
};

describe('probeBarback', () => {
  it('resolves against dnsServers and verifies reachability', async () => {
    const resolve4 = vi.fn().mockResolvedValue(['192.0.2.20']);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await expect(probeBarback(config, { resolve4, fetchImpl })).resolves.toBeUndefined();
    expect(resolve4).toHaveBeenCalledWith('barback.internal');
    expect(fetchImpl).toHaveBeenCalledWith('http://barback.internal:8080/v1', { method: 'GET' });
  });

  it('fails closed when DNS resolution fails', async () => {
    const resolve4 = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(probeBarback(config, { resolve4 })).rejects.toBeInstanceOf(BarbackProbeError);
  });

  it('fails closed when reachability returns non-2xx', async () => {
    const resolve4 = vi.fn().mockResolvedValue(['192.0.2.20']);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('err', { status: 503 }));
    await expect(probeBarback(config, { resolve4, fetchImpl })).rejects.toBeInstanceOf(
      BarbackProbeError,
    );
  });

  it('fails closed on timeout', async () => {
    const resolve4 = vi.fn().mockResolvedValue(['192.0.2.20']);
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(probeBarback(config, { resolve4, fetchImpl, timeoutMs: 20 })).rejects.toBeInstanceOf(
      BarbackProbeError,
    );
  });
});
