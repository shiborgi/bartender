import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BarbackNetworkError,
  barbackNetworkArgs,
  barbackNetworkArgsFor,
} from './barback-network.js';
import type { BarbackClientConfig } from './barback-client-config.js';

const config: BarbackClientConfig = {
  schemaVersion: 1,
  stackId: 'barback-local',
  network: 'barback',
  hostGateway: '192.0.2.1',
  dnsServers: ['192.0.2.10', '192.0.2.11'],
  dnsSearch: ['barback.internal'],
  dnsGeneration: 'generation-1',
  generatedAt: '2026-08-31T00:00:00.000Z',
  validUntil: '2099-01-01T00:00:00.000Z',
  apiBaseUrl: 'http://barback.internal:8080/v1',
  mcpUrl: 'http://barback.internal:8080/mcp',
  credentialMode: 'onecli-proxy',
};

const inspectOutput = JSON.stringify({ networks: [{ gateway: '192.0.2.1' }] });

const dirs: string[] = [];

function writeConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barback-network-'));
  dirs.push(dir);
  const file = path.join(dir, 'client-config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  fs.chmodSync(file, 0o600);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('barbackNetworkArgs', () => {
  it('uses the client-config network name and never creates or validates internal', () => {
    const args = barbackNetworkArgs(config, inspectOutput, undefined);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('barback');
    expect(args).not.toContain('--internal');
  });

  it('fails closed when NANOCLAW_EGRESS_NETWORK mismatches the client-config network', () => {
    expect(() => barbackNetworkArgs(config, inspectOutput, 'other-network')).toThrow(
      BarbackNetworkError,
    );
  });

  it('injects --dns for each dnsServers entry and --dns-search for the search domain', () => {
    const args = barbackNetworkArgs(config, inspectOutput, undefined);
    expect(args).toContain('--dns');
    expect(args).toContain('192.0.2.10');
    expect(args).toContain('192.0.2.11');
    expect(args).toContain('--dns-search');
    expect(args).toContain('barback.internal');
  });

  it('maps host.docker.internal and gateway.docker.internal to hostGateway without rewriting app URLs', () => {
    const args = barbackNetworkArgs(config, inspectOutput, undefined);
    const mount = args.find((a) => a.startsWith('type=bind,source='));
    expect(mount).toBeDefined();
    const source = mount!.match(/source=([^,]+)/)?.[1];
    expect(source).toBeDefined();
    const hosts = fs.readFileSync(source!, 'utf8');
    expect(hosts).toContain('192.0.2.1 host.docker.internal gateway.docker.internal');
    // No application URL is rewritten to an IP literal.
    expect(args.join(' ')).not.toContain('http://192.0.2.1');
  });
});

describe('barbackNetworkArgsFor', () => {
  it('returns null when BARBACK_CLIENT_CONFIG_PATH is unset', () => {
    expect(barbackNetworkArgsFor({}, () => inspectOutput)).toBeNull();
  });

  it('inspects the declared network and returns the Barback args', () => {
    const file = writeConfig();
    const inspected: string[] = [];
    const args = barbackNetworkArgsFor(
      { BARBACK_CLIENT_CONFIG_PATH: file },
      (network) => {
        inspected.push(network);
        return inspectOutput;
      },
    );
    expect(inspected).toEqual(['barback']);
    expect(args).toContain('--network');
    expect(args).toContain('barback');
    expect(args).toContain('--dns');
    expect(args).toContain('192.0.2.10');
  });
});
