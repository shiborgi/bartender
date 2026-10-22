import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { isSecretShaped, looksLikeCredential } from '../drivers/types.js';

import { GATEWAY_ENDPOINT, contributionFor, defineCustomGatewayProvider, sessionEnv } from './custom-gateway.js';
import { gatewayRunArgs, parseGatewayState, type GatewayRuntime } from './custom-gateway-container.js';
import { deriveClientKey } from './custom-gateway-identity.js';
import type { GatewaySessionInput } from './gateway-provider-registry.js';

const RT: GatewayRuntime = {
  bin: 'container',
  slug: 'abc12345',
  name: 'nanoclaw-gateway-v2-abc12345',
  image: 'nanoclaw-custom-gateway-abc12345:latest',
  egressNetwork: 'nanoclaw-egress-v2-abc12345',
  configDir: '/srv/nanoclaw/data/custom-gateway/config',
};

const INPUT: GatewaySessionInput = {
  key: { installSlug: 'abc12345', agentGroupId: 'ag-bartender', sessionId: 'sess-1' },
  runtimeIdentity: 'nanoclaw-agent-1',
  groupName: 'Bartender',
} as GatewaySessionInput;

describe('client keys', () => {
  // The same literal is pinned in service/src/gateway.test.ts; the two
  // derivations share no module, so this pair is what keeps them in step.
  it('derives the pinned vector', () => {
    expect(deriveClientKey('a'.repeat(64), 'ag-bartender')).toBe('ncl.ag-bartender.f60e30a544a792b4e779a476c7266912');
  });

  it('refuses a group id that would make the key ambiguous', () => {
    expect(() => deriveClientKey('a'.repeat(64), 'ag.x')).toThrow(/dot/);
  });
});

describe('session contribution', () => {
  const key = deriveClientKey('a'.repeat(64), 'ag-bartender');

  it('points every client at the gateway by name, with the group key in the path', () => {
    const env = sessionEnv(key);
    expect(env.OPENCODE_BASE_URL).toBe(`http://${GATEWAY_ENDPOINT}:8080/g/${key}/v1`);
    expect(env.NANOCLAW_GATEWAY_URL).toBe(`http://${GATEWAY_ENDPOINT}:8080/g/${key}`);
  });

  /*
   * Core denies a session whose contributed env carries a credential value.
   * The client key is an identity, not an upstream credential, and must not
   * trip that guard — or every session would be refused at spawn.
   */
  it('passes the core credential guard', () => {
    for (const [name, value] of Object.entries(sessionEnv(key))) {
      expect(looksLikeCredential(value), name).toBe(false);
      expect(isSecretShaped(name, value), name).toBe(false);
    }
  });

  it('targets the gateway container on the runtime', () => {
    expect(contributionFor(RT, key).networkAccess).toEqual({
      endpoint: GATEWAY_ENDPOINT,
      target: { kind: 'runtime', identity: RT.name },
    });
  });
});

describe('gateway container', () => {
  it('puts the default network first so upstream DNS works, then the egress network', () => {
    const args = gatewayRunArgs(RT, 'secret');
    const networks = args.flatMap((a, i) => (a === '--network' ? [args[i + 1]] : []));
    expect(networks).toEqual(['default', RT.egressNetwork]);
    expect(args).toContain(`${RT.configDir}:/app/config:ro`);
    expect(args).toContain('nanoclaw-role=gateway');
    expect(args.at(-1)).toBe(RT.image);
  });

  it('reads Apple and Docker inspect output alike', () => {
    const apple = JSON.stringify([
      {
        status: {
          state: 'running',
          networks: [
            { network: 'default', ipv4Address: '192.168.64.2/24' },
            { network: RT.egressNetwork, ipv4Address: '192.168.131.150/24' },
          ],
        },
      },
    ]);
    expect(parseGatewayState(apple, RT.egressNetwork)).toEqual({ running: true, address: '192.168.131.150' });

    const docker = JSON.stringify([
      { State: { Running: true }, NetworkSettings: { Networks: { [RT.egressNetwork]: { IPAddress: '172.20.0.2' } } } },
    ]);
    expect(parseGatewayState(docker, RT.egressNetwork)).toEqual({ running: true, address: '172.20.0.2' });
    expect(parseGatewayState('garbage', RT.egressNetwork)).toEqual({ running: false, address: null });
  });
});

describe('provider', () => {
  const healthy = () =>
    defineCustomGatewayProvider({
      runtime: () => RT,
      secret: () => 'a'.repeat(64),
      ensureRunning: async () => '192.168.131.150',
      probe: async () => true,
    });

  it('leases a session with its own key and the gateway as destination', async () => {
    const lease = await healthy().sessions.ensure(INPUT, new AbortController().signal);
    expect(lease.contribution.env?.OPENCODE_BASE_URL).toContain('/g/ncl.ag-bartender.');
    expect(lease.contribution.networkAccess.target).toEqual({ kind: 'runtime', identity: RT.name });
  });

  it('fails closed without the install secret', async () => {
    const provider = defineCustomGatewayProvider({
      runtime: () => RT,
      secret: () => undefined,
      ensureRunning: async () => '192.168.131.150',
      probe: async () => true,
    });
    await expect(provider.sessions.ensure(INPUT, new AbortController().signal)).rejects.toThrow(
      /NANOCLAW_GATEWAY_SECRET/,
    );
  });

  it('refuses a session when the gateway does not answer', async () => {
    const provider = defineCustomGatewayProvider({
      runtime: () => RT,
      secret: () => 'a'.repeat(64),
      ensureRunning: async () => '192.168.131.150',
      probe: async () => false,
    });
    await expect(provider.sessions.ensure(INPUT, new AbortController().signal)).rejects.toThrow(/health\/live/);
  });

  it('reports a live lease unavailable when the gateway stops answering', async () => {
    let up = true;
    const provider = defineCustomGatewayProvider({
      runtime: () => RT,
      secret: () => 'a'.repeat(64),
      ensureRunning: async () => '192.168.131.150',
      probe: async () => up,
      intervalMs: 5,
    });
    const abort = new AbortController();
    const lease = await provider.sessions.ensure(INPUT, abort.signal);
    const reasons: string[] = [];
    lease.onUnavailable?.((reason) => reasons.push(reason));
    up = false;
    await vi.waitFor(() => expect(reasons.length).toBeGreaterThan(0));
    expect(reasons[0]).toMatch(/stopped answering/);
    abort.abort();
  });

  /*
   * Core reads an ended approval subscription as the gateway becoming
   * unavailable, so a gateway with nothing to approve must still hold it open.
   */
  it('holds the approval subscription open until the host stops', async () => {
    const abort = new AbortController();
    let settled = false;
    const subscription = healthy()
      .approvals.subscribe(async () => 'deny', abort.signal)
      .then(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    abort.abort();
    await subscription;
    expect(settled).toBe(true);
  });

  it('declines account connections, pointing at the gateway policy', async () => {
    const result = await healthy().connections!.connect({ agentGroupId: 'ag-bartender', host: 'api.example.com' });
    expect(result.status).toBe('unsupported');
  });
});
