import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BarbackClientConfigError,
  loadBarbackClientConfig,
} from './barback-client-config.js';

const dirs: string[] = [];

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
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
    validUntil: '2099-01-01T00:00:00.000Z',
    apiBaseUrl: 'http://barback.internal:8080/v1',
    mcpUrl: 'http://barback.internal:8080/mcp',
    hostProbeUrl: 'http://192.0.2.20:8080/health/live',
    credentialMode: 'onecli-proxy',
    ...overrides,
  };
}

function writeConfig(content: unknown, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barback-client-config-'));
  dirs.push(dir);
  const file = path.join(dir, 'client-config.json');
  fs.writeFileSync(file, JSON.stringify(content));
  fs.chmodSync(file, mode);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadBarbackClientConfig', () => {
  it('reads only BARBACK_CLIENT_CONFIG_PATH and exposes typed fields', () => {
    const file = writeConfig(makeConfig());
    const config = loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file });
    expect(config.schemaVersion).toBe(1);
    expect(config.stackId).toBe('barback-local');
    expect(config.network).toBe('barback');
    expect(config.hostGateway).toBe('192.0.2.1');
    expect(config.dnsServers).toEqual(['192.0.2.10']);
    expect(config.dnsSearch).toEqual(['barback.internal']);
    expect(config.dnsGeneration).toBe('generation-1');
    expect(config.gatewayAddress).toBe('192.0.2.20');
    expect(config.egressGeneration).toBe('egress-generation-1');
    expect(config.generatedAt).toBe('2026-08-31T00:00:00.000Z');
    expect(config.validUntil).toBe('2099-01-01T00:00:00.000Z');
    expect(config.apiBaseUrl).toBe('http://barback.internal:8080/v1');
    expect(config.mcpUrl).toBe('http://barback.internal:8080/mcp');
    expect(config.credentialMode).toBe('onecli-proxy');
  });

  it('fails closed when BARBACK_CLIENT_CONFIG_PATH is unset', () => {
    expect(() => loadBarbackClientConfig({})).toThrow(BarbackClientConfigError);
  });

  it('fails closed when the path is not absolute', () => {
    expect(() =>
      loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: 'relative/client-config.json' }),
    ).toThrow(/absolute/);
  });

  it('fails closed when the file is absent', () => {
    expect(() =>
      loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: '/nonexistent/client-config.json' }),
    ).toThrow(BarbackClientConfigError);
  });

  it('fails closed when the document is malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barback-client-config-'));
    dirs.push(dir);
    const file = path.join(dir, 'client-config.json');
    fs.writeFileSync(file, '{ not json');
    fs.chmodSync(file, 0o600);
    expect(() => loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file })).toThrow(
      /not valid JSON/,
    );
  });

  it('fails closed when the document is expired', () => {
    const file = writeConfig(makeConfig({ validUntil: '2026-08-31T00:30:00.000Z' }));
    expect(() =>
      loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file }, new Date('2026-08-31T00:40:00.000Z')),
    ).toThrow(/expired/);
  });

  it('rejects a group- or world-writable file', () => {
    const file = writeConfig(makeConfig(), 0o666);
    expect(() => loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file })).toThrow(
      /group- or world-writable/,
    );
  });

  it('rejects a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barback-client-config-'));
    dirs.push(dir);
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify(makeConfig()));
    fs.chmodSync(target, 0o600);
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(target, link);
    expect(() => loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: link })).toThrow(/symlink/);
  });

  it('rejects an IP-literal apiBaseUrl', () => {
    const file = writeConfig(makeConfig({ apiBaseUrl: 'http://192.0.2.10:8080/v1' }));
    expect(() => loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file })).toThrow(
      /apiBaseUrl must not contain an IP literal/,
    );
  });

  it('rejects an IP-literal mcpUrl', () => {
    const file = writeConfig(makeConfig({ mcpUrl: 'http://192.0.2.10:8080/mcp' }));
    expect(() => loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file })).toThrow(
      /mcpUrl must not contain an IP literal/,
    );
  });

  it('rejects a non-IPv4 firewall destination', () => {
    const file = writeConfig(makeConfig({ gatewayAddress: 'not-an-ip' }));
    expect(() => loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file })).toThrow(/gatewayAddress/);
  });

  it('never reads or emits a credential', () => {
    const file = writeConfig(
      makeConfig({ token: 'secret', bearerKey: 'secret', oauthToken: 'secret' }),
    );
    const config = loadBarbackClientConfig({ BARBACK_CLIENT_CONFIG_PATH: file });
    expect(JSON.stringify(config)).not.toContain('secret');
  });
});
