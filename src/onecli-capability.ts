import fs from 'fs';
import path from 'path';

/**
 * OneCLI private-DNS-route capability gate.
 *
 * The capability (custom DNS, plaintext HTTP proxying, vault-backed Bearer
 * injection, destination restrictions) is advertised by the OneCLI SDK and
 * daemon at or above a pinned minimum version. The SDK has no runtime
 * capability probe, so the gate is version-based against the sanctioned
 * manifest (versions.json): both the SDK and the daemon must be pinned at or
 * above the minimum, and the manifest must carry a single private-DNS-route
 * capability version that both agree on. Any absence or mismatch fails closed.
 */

export interface OneCliVersionManifest {
  'onecli-gateway': string;
  'onecli-cli': string;
  'private-dns-route'?: string;
}

/** Minimum product versions that advertise the private-DNS-route capability. */
export const PRIVATE_DNS_ROUTE_MIN = {
  gateway: '1.41.0',
  cli: '2.2.5',
} as const;

/** The single capability version both SDK and daemon must advertise. */
export const PRIVATE_DNS_ROUTE_CAPABILITY_VERSION = '1';

export class OneCliCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneCliCapabilityError';
  }
}

/** Compare two dotted numeric versions; returns negative/zero/positive. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((n) => Number.parseInt(n, 10));
  const b = right.split('.').map((n) => Number.parseInt(n, 10));
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Detect the private-DNS-route capability from the pinned manifest. Returns
 * true when both the SDK and daemon advertise the capability and their
 * capability versions agree; throws (fails closed) when either is absent or
 * below the minimum, or when the capability version is missing or mismatched.
 */
export function detectPrivateDnsRouteCapability(manifest: OneCliVersionManifest): boolean {
  const gateway = manifest['onecli-gateway'];
  const cli = manifest['onecli-cli'];
  if (!gateway || !cli) {
    throw new OneCliCapabilityError('OneCLI version manifest is missing a pinned SDK or daemon version');
  }
  if (compareVersions(gateway, PRIVATE_DNS_ROUTE_MIN.gateway) < 0) {
    throw new OneCliCapabilityError(
      `OneCLI daemon ${gateway} does not advertise the private-DNS-route capability (minimum ${PRIVATE_DNS_ROUTE_MIN.gateway})`,
    );
  }
  if (compareVersions(cli, PRIVATE_DNS_ROUTE_MIN.cli) < 0) {
    throw new OneCliCapabilityError(
      `OneCLI SDK ${cli} does not advertise the private-DNS-route capability (minimum ${PRIVATE_DNS_ROUTE_MIN.cli})`,
    );
  }
  const capability = manifest['private-dns-route'];
  if (capability !== PRIVATE_DNS_ROUTE_CAPABILITY_VERSION) {
    throw new OneCliCapabilityError(
      `OneCLI private-DNS-route capability version is missing or mismatched (expected ${PRIVATE_DNS_ROUTE_CAPABILITY_VERSION})`,
    );
  }
  return true;
}

/** Load the sanctioned version manifest from versions.json. */
export function loadOneCliVersionManifest(root = process.cwd()): OneCliVersionManifest {
  const raw = fs.readFileSync(path.join(root, 'versions.json'), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    'onecli-gateway': String(parsed['onecli-gateway'] ?? ''),
    'onecli-cli': String(parsed['onecli-cli'] ?? ''),
    'private-dns-route': parsed['private-dns-route'] === undefined ? undefined : String(parsed['private-dns-route']),
  };
}
