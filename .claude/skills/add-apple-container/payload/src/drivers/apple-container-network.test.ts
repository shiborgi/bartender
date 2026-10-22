/**
 * Egress topology: install-scoped naming and fail-closed containment.
 *
 * The naming cases are the multi-clone contract — two checkouts of this project
 * must not land on one network. The containment cases are the safety contract:
 * anything that would leave a session with a direct route off the host refuses
 * the spawn instead of proceeding.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  AppleEgressError,
  egressNetworkArgs,
  egressNetworkName,
  ensureEgressNetwork,
  hostsFileContent,
  parseContainerAddress,
  parseNetworkGateway,
  parseNetworkIsolated,
  resolveEgressTarget,
  rewriteHostsFiles,
  writeHostsFile,
} from './apple-container-network.js';
import { FakeCli } from './fake-cli.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// `.env` is consulted for the override; this suite pins the file to absent so
// the derivation under test is the one being asserted.
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));

/** The shape the live runtime emits for `container network inspect`. */
function networkDoc(mode: string, gateway = '192.168.128.1'): string {
  return JSON.stringify([
    {
      configuration: { mode, name: 'n' },
      id: 'n',
      status: { ipv4Gateway: gateway, ipv4Subnet: '192.168.128.0/24' },
    },
  ]);
}

describe('network naming', () => {
  it('scopes the default name to the install so two clones cannot share one network', () => {
    const a = egressNetworkName({} as NodeJS.ProcessEnv, '/Users/x/bar-assistant');
    const b = egressNetworkName({} as NodeJS.ProcessEnv, '/Users/x/personal-assistant');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^nanoclaw-egress-v2-[0-9a-f]{8}$/);
  });

  it('is stable for one checkout across calls', () => {
    const root = '/Users/x/bar-assistant';
    expect(egressNetworkName({} as NodeJS.ProcessEnv, root)).toBe(egressNetworkName({} as NodeJS.ProcessEnv, root));
  });

  it('honors an explicit override, which is what joining two installs looks like', () => {
    const env = { NANOCLAW_EGRESS_NETWORK: 'shared-egress' } as NodeJS.ProcessEnv;
    expect(egressNetworkName(env, '/a')).toBe('shared-egress');
    expect(egressNetworkName(env, '/b')).toBe('shared-egress');
    expect(egressNetworkArgs(env)).toEqual(['--network', 'shared-egress']);
  });

  it('refuses a name that would be unsafe to interpolate into argv', () => {
    expect(() => egressNetworkName({ NANOCLAW_EGRESS_NETWORK: '--privileged' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => egressNetworkName({ NANOCLAW_EGRESS_NETWORK: 'a b' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('document parsing', () => {
  it('reads the gateway address the runtime reports', () => {
    expect(parseNetworkGateway(networkDoc('hostOnly'))).toBe('192.168.128.1');
    expect(parseNetworkGateway('')).toBeNull();
    expect(parseNetworkGateway('not json')).toBeNull();
  });

  it('recognizes host-only mode and nothing else', () => {
    expect(parseNetworkIsolated(networkDoc('hostOnly'))).toBe(true);
    expect(parseNetworkIsolated(networkDoc('nat'))).toBe(false);
    expect(parseNetworkIsolated('')).toBe(false);
  });
});

describe('ensureEgressNetwork', () => {
  const env = { NANOCLAW_EGRESS_NETWORK: 'test-egress' } as NodeJS.ProcessEnv;

  it('returns the host address when the network is already host-only', () => {
    const cli = new FakeCli('container');
    cli.responses = [{ match: /^network inspect/, output: networkDoc('hostOnly') }];
    expect(ensureEgressNetwork(cli, env)).toBe('192.168.128.1');
    expect(cli.joined().some((c) => c.startsWith('network create'))).toBe(false);
  });

  it('creates it host-only when absent, then reports the new gateway', () => {
    // Stateful: `inspect` fails until `create` has run. FakeCli matches its
    // scripted responses in order with no sequencing, so the state machine the
    // create-then-inspect path exercises has to live here.
    let exists = false;
    const calls: string[][] = [];
    const cli = {
      bin: 'container',
      run(args: string[]): string {
        calls.push(args);
        if (args[1] === 'create') {
          exists = true;
          return '';
        }
        if (args[1] === 'inspect') {
          if (!exists) throw new Error('network not found');
          return networkDoc('hostOnly');
        }
        return '';
      },
      start(): never {
        throw new Error('not used');
      },
    };

    expect(ensureEgressNetwork(cli as never, env)).toBe('192.168.128.1');
    expect(calls.some((c) => c.join(' ') === 'network create --internal test-egress')).toBe(true);
  });

  it('reports a create that leaves nothing inspectable instead of proceeding', () => {
    const cli = new FakeCli('container');
    cli.responses = [
      { match: /^network inspect/, throws: new Error('not found') },
      { match: /^network create/, output: '' },
    ];
    expect(() => ensureEgressNetwork(cli, env)).toThrow(AppleEgressError);
    expect(cli.callMatching(/^network create/)?.args).toEqual(['network', 'create', '--internal', 'test-egress']);
  });

  it('refuses a NAT network rather than silently spawning with open egress', () => {
    const cli = new FakeCli('container');
    cli.responses = [{ match: /^network inspect/, output: networkDoc('nat') }];
    expect(() => ensureEgressNetwork(cli, env)).toThrow(/not host-only/);
  });

  it('refuses a host-only network that reports no gateway address', () => {
    const cli = new FakeCli('container');
    cli.responses = [
      { match: /^network inspect/, output: JSON.stringify([{ configuration: { mode: 'hostOnly' }, status: {} }]) },
    ];
    expect(() => ensureEgressNetwork(cli, env)).toThrow(/no IPv4 gateway/);
  });
});

/** The shape the live runtime emits for `container inspect` (container 1.3). */
function containerDoc(legs: Array<[string, string]>): string {
  return JSON.stringify([
    {
      id: 'nanoclaw-gateway-v2-abc',
      status: { state: 'running', networks: legs.map(([network, ipv4Address]) => ({ network, ipv4Address })) },
    },
  ]);
}

describe('reaching a gateway on the egress network', () => {
  const env = { NANOCLAW_EGRESS_NETWORK: 'egress-x' } as NodeJS.ProcessEnv;

  it("reads a container's own address on the named network, not on another leg", () => {
    const doc = containerDoc([
      ['default', '192.168.64.121/24'],
      ['egress-x', '192.168.131.150/24'],
    ]);
    expect(parseContainerAddress(doc, 'egress-x')).toBe('192.168.131.150');
    expect(parseContainerAddress(doc, 'other')).toBeNull();
    expect(parseContainerAddress('not json', 'egress-x')).toBeNull();
  });

  it('resolves a runtime target to its address on the egress network', () => {
    const cli = new FakeCli();
    cli.responses = [
      { match: /^network inspect/, output: networkDoc('hostOnly') },
      { match: /^inspect nanoclaw-gateway-v2-abc/, output: containerDoc([['egress-x', '192.168.131.150/24']]) },
    ];
    expect(resolveEgressTarget({ kind: 'runtime', identity: 'nanoclaw-gateway-v2-abc' }, cli, env)).toBe(
      '192.168.131.150',
    );
  });

  it("resolves the host to the network's gateway address", () => {
    const cli = new FakeCli();
    cli.responses = [{ match: /^network inspect/, output: networkDoc('hostOnly', '192.168.131.1') }];
    expect(resolveEgressTarget({ kind: 'host' }, cli, env)).toBe('192.168.131.1');
  });

  /*
   * A gateway not attached to the egress network is unreachable from every
   * session; spawning anyway would only fail later, inside the agent.
   */
  it('refuses a runtime target that is not on the egress network', () => {
    const cli = new FakeCli();
    cli.responses = [
      { match: /^network inspect/, output: networkDoc('hostOnly') },
      { match: /^inspect /, output: containerDoc([['default', '192.168.64.121/24']]) },
    ];
    expect(() => resolveEgressTarget({ kind: 'runtime', identity: 'nanoclaw-gateway-v2-abc' }, cli, env)).toThrow(
      AppleEgressError,
    );
  });

  it('refuses a target name unsafe to put in argv', () => {
    const cli = new FakeCli();
    cli.responses = [{ match: /^network inspect/, output: networkDoc('hostOnly') }];
    expect(() => resolveEgressTarget({ kind: 'runtime', identity: 'x; rm -rf /' }, cli, env)).toThrow();
  });
});

describe('per-session hosts files', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'apple-hosts-'));

  it('maps localhost, the session to itself, and the endpoint to the gateway', () => {
    expect(hostsFileContent('nanoclaw-agent-1', 'host.docker.internal', '192.168.131.150')).toBe(
      '127.0.0.1 localhost\n127.0.1.1 nanoclaw-agent-1\n192.168.131.150 host.docker.internal\n',
    );
  });

  /*
   * In place, never by rename: a running session's bind mount follows the same
   * file, so a rename would leave it reading the old gateway address.
   */
  it('rewrites every session file in place when the gateway moves', () => {
    const dir = tmp();
    const a = writeHostsFile(dir, 'nanoclaw-agent-a', 'host.docker.internal', '192.168.131.150');
    writeHostsFile(dir, 'nanoclaw-agent-b', 'host.docker.internal', '192.168.131.150');
    const inode = fs.statSync(a).ino;

    expect(rewriteHostsFiles(dir, 'host.docker.internal', '192.168.131.151')).toBe(2);
    expect(fs.statSync(a).ino).toBe(inode);
    expect(fs.readFileSync(a, 'utf8')).toContain('192.168.131.151 host.docker.internal');
    expect(fs.readFileSync(path.join(dir, 'nanoclaw-agent-b'), 'utf8')).toContain('127.0.1.1 nanoclaw-agent-b');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites nothing when no session has a file yet', () => {
    expect(rewriteHostsFiles(path.join(os.tmpdir(), 'absent-apple-hosts-dir'), 'h', '1.2.3.4')).toBe(0);
  });
});
