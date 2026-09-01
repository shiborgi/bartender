import type { BarbackClientConfig } from './barback-client-config.js';
import type { McpServerConfig } from './container-config.js';

/** Raised when a provider cannot be configured to route through Barback. */
export class BarbackProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarbackProviderError';
  }
}

/**
 * Providers whose client can target an OpenAI-compatible API (Barback's
 * surface). An Anthropic-only provider (e.g. `claude`) is not compatible and
 * must fail configuration rather than silently bypass Barback.
 */
const OPENAI_COMPATIBLE_PROVIDERS = new Set(['opencode']);

/**
 * Build the OpenCode environment that routes model traffic through Barback's
 * OpenAI-compatible API. These values contain no credential: host-relay
 * authentication is derived from the isolated Barback network.
 */
export function barbackProviderEnv(config: BarbackClientConfig, providerName: string): Record<string, string> {
  if (!OPENAI_COMPATIBLE_PROVIDERS.has(providerName)) {
    throw new BarbackProviderError(
      `provider "${providerName}" is not OpenAI-compatible and cannot route through Barback`,
    );
  }
  return {
    OPENCODE_PROVIDER: 'openai',
    OPENCODE_MODEL: 'openai/code-default',
    ANTHROPIC_BASE_URL: `http://${config.gatewayAddress}:8080/v1`,
    NANOCLAW_BARBACK_MCP_URL: `http://${config.gatewayAddress}:8080/mcp`,
    // These are non-secret bootstrap inputs. Apple Container grants network
    // administration only to the short-lived entrypoint that consumes them.
    NANOCLAW_EGRESS_LOCKDOWN: 'barback-v1',
    NANOCLAW_EGRESS_HOST: config.gatewayAddress,
    NANOCLAW_EGRESS_PORT: '8080',
  };
}

/**
 * Synthesize the realized MCP server set: the client-config mcpUrl is the only
 * remote network MCP endpoint, every persisted direct HTTP MCP entry other than
 * the synthesized Barback endpoint is dropped, and permitted local stdio MCPs
 * are retained. Never configures valkey.barback.internal or any
 * *.mcp.barback.internal directly.
 */
export function synthesizeBarbackMcp(
  config: BarbackClientConfig,
  mcpServers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const realized: Record<string, McpServerConfig> = {
    barback: { type: 'http', url: config.mcpUrl },
  };
  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === 'http') continue; // suppress direct remote HTTP MCPs
    realized[name] = server; // retain permitted local stdio MCPs
  }
  return realized;
}
