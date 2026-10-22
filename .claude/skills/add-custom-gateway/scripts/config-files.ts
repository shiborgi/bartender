/**
 * The two operator files the gateway reads, as the host-side scripts see them.
 *
 * `gateway.json` is policy and names secrets only by key; `secrets.env` holds
 * the values and is owner-only. Both live under `data/`, so they ride along
 * with the install's snapshots and rollback and never enter git.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ConfigPaths {
  dir: string;
  policy: string;
  secrets: string;
}

export function configPaths(root = process.cwd()): ConfigPaths {
  const dir = path.join(root, 'data', 'custom-gateway', 'config');
  return { dir, policy: path.join(dir, 'gateway.json'), secrets: path.join(dir, 'secrets.env') };
}

export interface PolicyUpstream {
  baseUrl: string;
  auth?: { header: string; format: string; secret: string };
}

export interface Policy {
  schemaVersion: number;
  upstreams?: Record<string, PolicyUpstream>;
  models?: Record<string, { upstream: string; model?: string }>;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, { models?: string[]; mcpServers?: string[] }>;
  [key: string]: unknown;
}

export function readPolicy(root = process.cwd()): Policy {
  const file = configPaths(root).policy;
  if (!fs.existsSync(file)) throw new Error(`No gateway policy at ${file}; run the add-custom-gateway setup first`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Policy;
}

function readSecrets(root: string): Map<string, string> {
  const file = configPaths(root).secrets;
  const values = new Map<string, string>();
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const value = match?.[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (match && value) values.set(match[1], value);
  }
  return values;
}

/** Keys set to a non-empty value, for checks that must not load the values themselves. */
export function secretKeys(root = process.cwd()): Set<string> {
  return new Set(readSecrets(root).keys());
}

/** One value, for the OAuth connect flow that has to present the client credentials. */
export function readSecret(key: string, root = process.cwd()): string | undefined {
  return readSecrets(root).get(key);
}

/** Set one key in `secrets.env`, keeping every other line (comments included) as it was. */
export function upsertSecret(key: string, value: string, root = process.cwd()): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid secret name: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error(`The value for ${key} spans more than one line`);
  const { dir, secrets } = configPaths(root);
  fs.mkdirSync(dir, { recursive: true });
  const lines = fs.existsSync(secrets) ? fs.readFileSync(secrets, 'utf8').split('\n') : [];
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else {
    if (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  // Write then rename, so the gateway never reads a half-written file.
  const temporary = `${secrets}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(temporary, secrets);
}

/** The upstream whose base URL is on `host`, by exact DNS name. */
export function upstreamForHost(policy: Policy, host: string): [string, PolicyUpstream] | undefined {
  const wanted = host.toLowerCase();
  return Object.entries(policy.upstreams ?? {}).find(([, upstream]) => {
    try {
      return new URL(upstream.baseUrl).hostname.toLowerCase() === wanted;
    } catch {
      return false;
    }
  });
}
