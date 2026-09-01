import { describe, expect, it } from 'vitest';
import { BarbackProviderError, barbackProviderEnv, synthesizeBarbackMcp } from './barback-provider.js';
import type { BarbackClientConfig } from './barback-client-config.js';
import type { McpServerConfig } from './container-config.js';

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
  validUntil: '2099-01-01T00:00:00.000Z',
  apiBaseUrl: 'http://barback.internal:8080/v1',
  mcpUrl: 'http://barback.internal:8080/mcp',
  hostProbeUrl: 'http://192.0.2.20:8080/health/live',
  credentialMode: 'onecli-proxy',
};

describe('barbackProviderEnv', () => {
  it('injects apiBaseUrl into an OpenAI-compatible provider', () => {
    const env = barbackProviderEnv(config, 'opencode');
    expect(env).toMatchObject({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_MODEL: 'openai/code-default',
      ANTHROPIC_BASE_URL: 'http://192.0.2.20:8080/v1',
      NANOCLAW_BARBACK_MCP_URL: 'http://192.0.2.20:8080/mcp',
      NANOCLAW_EGRESS_HOST: '192.0.2.20',
    });
  });

  it('fails configuration for an unsupported (Anthropic-only) provider', () => {
    expect(() => barbackProviderEnv(config, 'claude')).toThrow(BarbackProviderError);
  });

  it('never injects a credential', () => {
    const env = barbackProviderEnv(config, 'opencode');
    expect(JSON.stringify(env)).not.toContain('secret');
  });
});

describe('synthesizeBarbackMcp', () => {
  it('synthesizes mcpUrl as the only remote endpoint and suppresses direct HTTP MCPs', () => {
    const persisted: Record<string, McpServerConfig> = {
      direct: { type: 'http', url: 'http://somewhere.example/mcp' },
      local: { type: 'stdio', command: 'npx', args: ['-y', 'local-tool'] },
    };
    const realized = synthesizeBarbackMcp(config, persisted);
    expect(realized.barback).toEqual({ type: 'http', url: 'http://barback.internal:8080/mcp' });
    expect(realized.direct).toBeUndefined();
    expect(realized.local).toEqual(persisted.local);
  });

  it('never configures valkey.barback.internal or *.mcp.barback.internal directly', () => {
    const persisted: Record<string, McpServerConfig> = {
      valkey: { type: 'http', url: 'http://valkey.barback.internal:6379' },
      google: { type: 'http', url: 'http://google.mcp.barback.internal:8090/mcp' },
    };
    const realized = synthesizeBarbackMcp(config, persisted);
    expect(realized.valkey).toBeUndefined();
    expect(realized.google).toBeUndefined();
    expect(realized.barback).toEqual({ type: 'http', url: 'http://barback.internal:8080/mcp' });
  });
});
