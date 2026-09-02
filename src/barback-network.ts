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
import { readEnvFile } from './env.js';

/** Raised when the Barback topology cannot be joined safely. */
export class BarbackNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarbackNetworkError';
  }
}

/** Barback topology is non-secret configuration, so a service may source it from .env. */
export function barbackClientEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  if (env !== process.env) return env;
  const file = readEnvFile(['BARBACK_CLIENT_CONFIG_PATH', 'NANOCLAW_EGRESS_NETWORK']);
  return { ...file, ...env };
}

/**
 * Build the session create argv for the Barback-owned NAT network. Pure and
 * testable: it takes the validated client-config, the `container network
 * inspect` output, and the configured egress network name, and returns the
 * `--network`/`--no-dns`/hosts-mount args. It never invokes
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

  const args = ['--network', config.network, '--no-dns'];

  const gateway = appleNetworkGateway(inspectOutput);
  if (!gateway || gateway !== config.hostGateway) {
    throw new BarbackNetworkError('Barback network gateway does not match the client-config');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-barback-hosts-'));
  const hosts = path.join(dir, 'hosts');
  // DNS is deliberately absent from the guest. Only the canonical gateway
  // name resolves, and the firewall independently pins its private address.
  fs.writeFileSync(hosts, `127.0.0.1 localhost\n${config.gatewayAddress} barback.internal\n`);
  args.push('--mount', `type=bind,source=${dir},target=/etc/barback-hosts,readonly`);

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
  env = barbackClientEnvironment(env) as NodeJS.ProcessEnv;
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

/**
 * Return the generation for the guest egress policy, or null when no client
 * config is configured. Legacy name retained for callers that only use it
 * to detect Barback presence (egressGeneration value is returned).
 */
export function barbackDnsGeneration(env: NodeJS.ProcessEnv = process.env): string | null {
  env = barbackClientEnvironment(env) as NodeJS.ProcessEnv;
  try {
    return loadBarbackClientConfig(env).egressGeneration;
  } catch (error) {
    if (error instanceof BarbackClientConfigError && error.message.includes('BARBACK_CLIENT_CONFIG_PATH is not set')) {
      return null;
    }
    throw error;
  }
}
