import dns from 'dns/promises';
import type { BarbackClientConfig } from './barback-client-config.js';

export class BarbackProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarbackProbeError';
  }
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve4?: (hostname: string) => Promise<string[]>;
}

/**
 * Bounded probe run before session creation. Resolves barback.internal against
 * the declared dnsServers (never the host system resolver) and verifies Barback
 * reachability at apiBaseUrl. Fails closed on timeout or failure; never falls
 * back to host publishing or a remembered Barback IP, and never emits or
 * persists a resolved IP as an application URL.
 */
export async function probeBarback(
  config: BarbackClientConfig,
  options: ProbeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const hostname = new URL(config.apiBaseUrl).hostname;
  const resolve4 =
    options.resolve4 ??
    (() => {
      const resolver = new dns.Resolver();
      resolver.setServers(config.dnsServers);
      return resolver.resolve4(hostname);
    });

  let resolved: string[];
  try {
    resolved = await withTimeout(resolve4(hostname), timeoutMs, 'DNS resolution timed out');
  } catch (err) {
    throw new BarbackProbeError(
      `Barback DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (resolved.length === 0) {
    throw new BarbackProbeError('Barback DNS resolution returned no addresses');
  }

  let response: Response;
  try {
    response = await withTimeout(
      fetchImpl(config.apiBaseUrl, { method: 'GET' }),
      timeoutMs,
      'Barback reachability probe timed out',
    );
  } catch (err) {
    throw new BarbackProbeError(
      `Barback reachability failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new BarbackProbeError(`Barback reachability returned HTTP ${response.status}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
