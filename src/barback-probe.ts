import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BarbackClientConfig } from './barback-client-config.js';

const execFileAsync = promisify(execFile);

export class BarbackProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarbackProbeError';
  }
}

export interface ProbeOptions {
  timeoutMs?: number;
  probeImpl?: (url: string, timeoutMs: number) => Promise<void>;
}

/**
 * Bounded host-side liveness probe before session creation. The Barback DNS
 * server exists only on the private network and is not reliably reachable from
 * macOS; guest-path reachability is separately verified after the firewall is
 * installed by egress-entrypoint.sh.
 */
export async function probeBarback(
  config: BarbackClientConfig,
  options: ProbeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const probeImpl = options.probeImpl ?? probeWithCurl;

  try {
    await probeImpl(config.hostProbeUrl, timeoutMs);
  } catch (err) {
    throw new BarbackProbeError(
      `Barback reachability failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function probeWithCurl(url: string, timeoutMs: number): Promise<void> {
  // Undici receives EHOSTUNREACH for Apple Container private NAT addresses
  // even though the macOS socket path works. curl is the portable host probe.
  await execFileAsync('curl', [
    '--fail',
    '--silent',
    '--show-error',
    '--noproxy',
    '*',
    '--max-time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    url,
  ]);
}
