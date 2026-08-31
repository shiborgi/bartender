import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  BarbackClientConfigError,
  loadBarbackClientConfig,
  type BarbackClientConfig,
} from './barback-client-config.js';
import { appleNetworkGateway } from './egress-lockdown.js';

/** Raised when the Barback topology cannot be joined safely. */
export class BarbackNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarbackNetworkError';
  }
}

/**
 * Build the session create argv for the Barback-owned NAT network. Pure and
 * testable: it takes the validated client-config, the `container network
 * inspect` output, and the configured egress network name, and returns the
 * `--network`/`--dns`/`--dns-search`/hosts-mount args. It never invokes
 * `network create` and never applies the internal-network validation.
 */
export function barbackNetworkArgs(
  config: BarbackClientConfig,
  inspectOutput: string,
  egressNetwork: string | undefined,
): string[] {
  if (egressNetwork && egressNetwork !== config.network) {
    throw new BarbackNetworkError(
      `NANOCLAW_EGRESS_NETWORK "${egressNetwork}" does not match the client-config network "${config.network}"`,
    );
  }

  const args = ['--network', config.network];
  for (const server of config.dnsServers) args.push('--dns', server);
  for (const domain of config.dnsSearch) args.push('--dns-search', domain);

  const gateway = appleNetworkGateway(inspectOutput);
  if (gateway) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-barback-hosts-'));
    const hosts = path.join(dir, 'hosts');
    fs.writeFileSync(hosts, `127.0.0.1 localhost\n${gateway} host.docker.internal gateway.docker.internal\n`);
    args.push('--mount', `type=bind,source=${hosts},target=/etc/hosts,readonly`);
  }

  return args;
}

/**
 * Resolve the Barback network args for the apple-container driver. Returns
 * `null` when no Barback client-config is configured (so the caller falls back
 * to the egress-lockdown path), and throws when the config is present but
 * invalid or the network cannot be inspected.
 */
export function barbackNetworkArgsFor(
  env: NodeJS.ProcessEnv = process.env,
  inspect: (network: string) => string = (network) =>
    execFileSync('container', ['network', 'inspect', network], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }),
): string[] | null {
  let config: BarbackClientConfig;
  try {
    config = loadBarbackClientConfig(env);
  } catch (error) {
    if (error instanceof BarbackClientConfigError && error.message.includes('BARBACK_CLIENT_CONFIG_PATH is not set')) {
      return null;
    }
    throw error;
  }

  const inspectOutput = inspect(config.network);
  return barbackNetworkArgs(config, inspectOutput, env.NANOCLAW_EGRESS_NETWORK);
}
