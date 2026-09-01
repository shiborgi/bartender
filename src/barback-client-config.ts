import fs from 'fs';
import path from 'path';
import { isIP } from 'net';

/**
 * Typed view of the Barback client-config document. Only these fields are
 * exposed; no credential, Bearer key, MCP credential, or OAuth token is ever
 * read or emitted.
 */
export interface BarbackClientConfig {
  schemaVersion: number;
  stackId: string;
  network: string;
  hostGateway: string;
  dnsServers: string[];
  dnsSearch: string[];
  dnsGeneration: string;
  /** Private IPv4 of the Barback HTTP gateway, for the guest egress allowlist. */
  gatewayAddress: string;
  /** Changes whenever the firewall destination can change. */
  egressGeneration: string;
  generatedAt: string;
  validUntil: string;
  apiBaseUrl: string;
  mcpUrl: string;
  hostProbeUrl: string;
  credentialMode: string;
}

export class BarbackClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarbackClientConfigError';
  }
}

function isIpLiteralUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '');
    return isIP(hostname) !== 0;
  } catch {
    return false;
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BarbackClientConfigError(`client-config ${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) {
    throw new BarbackClientConfigError(`client-config ${field} must be a non-empty string array`);
  }
  return value as string[];
}

/**
 * Load and validate the Barback client-config document from the absolute path
 * in BARBACK_CLIENT_CONFIG_PATH. Fails closed when the variable is unset, the
 * path is not absolute, the file is absent/unreadable/malformed/expired, the
 * file is a symlink or group/world-writable, or an application URL contains an
 * IP literal. Never locates Barback by scanning sibling repositories or
 * invoking an unconfigured shell command.
 */
export function loadBarbackClientConfig(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): BarbackClientConfig {
  const rawPath = env.BARBACK_CLIENT_CONFIG_PATH;
  if (!rawPath) {
    throw new BarbackClientConfigError('BARBACK_CLIENT_CONFIG_PATH is not set');
  }
  if (!path.isAbsolute(rawPath)) {
    throw new BarbackClientConfigError('BARBACK_CLIENT_CONFIG_PATH must be an absolute path');
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(rawPath);
  } catch (err) {
    throw new BarbackClientConfigError(
      `client-config is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new BarbackClientConfigError('client-config path must not be a symlink');
  }
  if (!stat.isFile()) {
    throw new BarbackClientConfigError('client-config path is not a regular file');
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new BarbackClientConfigError('client-config file must not be group- or world-writable');
  }

  let raw: string;
  try {
    raw = fs.readFileSync(rawPath, 'utf8');
  } catch (err) {
    throw new BarbackClientConfigError(
      `client-config is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BarbackClientConfigError('client-config is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BarbackClientConfigError('client-config must be a JSON object');
  }
  const doc = parsed as Record<string, unknown>;

  if (typeof doc.schemaVersion !== 'number') {
    throw new BarbackClientConfigError('client-config schemaVersion must be a number');
  }

  const config: BarbackClientConfig = {
    schemaVersion: doc.schemaVersion,
    stackId: requireString(doc.stackId, 'stackId'),
    network: requireString(doc.network, 'network'),
    hostGateway: requireString(doc.hostGateway, 'hostGateway'),
    dnsServers: requireStringArray(doc.dnsServers, 'dnsServers'),
    dnsSearch: requireStringArray(doc.dnsSearch, 'dnsSearch'),
    dnsGeneration: requireString(doc.dnsGeneration, 'dnsGeneration'),
    gatewayAddress: requireString(doc.gatewayAddress, 'gatewayAddress'),
    egressGeneration: requireString(doc.egressGeneration, 'egressGeneration'),
    generatedAt: requireString(doc.generatedAt, 'generatedAt'),
    validUntil: requireString(doc.validUntil, 'validUntil'),
    apiBaseUrl: requireString(doc.apiBaseUrl, 'apiBaseUrl'),
    mcpUrl: requireString(doc.mcpUrl, 'mcpUrl'),
    hostProbeUrl: requireString(doc.hostProbeUrl, 'hostProbeUrl'),
    credentialMode: requireString(doc.credentialMode, 'credentialMode'),
  };

  const validUntil = Date.parse(config.validUntil);
  if (Number.isNaN(validUntil)) {
    throw new BarbackClientConfigError('client-config validUntil must be an ISO-8601 timestamp');
  }
  if (validUntil <= now.getTime()) {
    throw new BarbackClientConfigError('client-config is expired');
  }

  if (isIpLiteralUrl(config.apiBaseUrl)) {
    throw new BarbackClientConfigError('client-config apiBaseUrl must not contain an IP literal');
  }
  if (isIpLiteralUrl(config.mcpUrl)) {
    throw new BarbackClientConfigError('client-config mcpUrl must not contain an IP literal');
  }
  if (isIP(config.gatewayAddress) !== 4) {
    throw new BarbackClientConfigError('client-config gatewayAddress must be an IPv4 address');
  }
  const api = new URL(config.apiBaseUrl);
  const mcp = new URL(config.mcpUrl);
  if (api.hostname !== 'barback.internal' || api.port !== '8080' || api.pathname !== '/v1') {
    throw new BarbackClientConfigError('client-config apiBaseUrl must be http://barback.internal:8080/v1');
  }
  if (mcp.hostname !== 'barback.internal' || mcp.port !== '8080' || mcp.pathname !== '/mcp') {
    throw new BarbackClientConfigError('client-config mcpUrl must be http://barback.internal:8080/mcp');
  }
  const probe = new URL(config.hostProbeUrl);
  if (probe.hostname !== config.gatewayAddress || probe.port !== '8080' || probe.pathname !== '/health/live') {
    throw new BarbackClientConfigError(
      'client-config hostProbeUrl must target gatewayAddress on http port 8080 /health/live',
    );
  }

  return config;
}
