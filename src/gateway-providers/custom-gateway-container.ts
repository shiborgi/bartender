/**
 * The custom gateway's container: one per install, owned by the install rather
 * than by any session.
 *
 * It sits on two networks. The runtime's default network gives it the internet
 * (model upstreams, Google, remote MCP servers); the install's host-only egress
 * network is where sessions live, and the gateway's address there is the only
 * destination they can reach. Order matters: the runtime takes the default
 * route and the nameserver from the FIRST network, so the default network goes
 * first — the other way round, every upstream call fails DNS while the health
 * check keeps answering.
 *
 * The image is built by the skill's setup script, never on the spawn path; a
 * missing image is reported with the command that fixes it.
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from '../config.js';
import { containerRuntimeBin } from '../container-runtime.js';
import { readEnvFile } from '../env.js';
import { getInstallSlug } from '../install-slug.js';
import { log } from '../log.js';
import { GATEWAY_ROLE } from '../drivers/types.js';

export const GATEWAY_PORT = 8080;

export interface GatewayRuntime {
  /** `container` (Apple) or `docker`. */
  bin: string;
  slug: string;
  /** Container name, also the runtime identity sessions target. */
  name: string;
  image: string;
  /** The host-only network sessions are confined to. */
  egressNetwork: string;
  /** Mounted read-only at `/app/config`: gateway.json and secrets.env. */
  configDir: string;
}

export function gatewayConfigDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'custom-gateway', 'config');
}

/**
 * The install's egress network. Derived exactly as the session driver derives
 * it — `NANOCLAW_EGRESS_NETWORK`, else `nanoclaw-egress-v2-<slug>` — because
 * the gateway has to be on the network the sessions are put on.
 */
export function egressNetworkFor(slug: string, env: NodeJS.ProcessEnv = process.env, projectRoot?: string): string {
  return (
    env.NANOCLAW_EGRESS_NETWORK?.trim() ||
    readEnvFile(['NANOCLAW_EGRESS_NETWORK'], projectRoot).NANOCLAW_EGRESS_NETWORK?.trim() ||
    `nanoclaw-egress-v2-${slug}`
  );
}

export function gatewayRuntime(
  projectRoot: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  dataDir: string = DATA_DIR,
): GatewayRuntime {
  const slug = getInstallSlug(projectRoot);
  return {
    bin: containerRuntimeBin(env, projectRoot),
    slug,
    name: `nanoclaw-gateway-v2-${slug}`,
    image: `nanoclaw-custom-gateway-${slug}:latest`,
    egressNetwork: egressNetworkFor(slug, env, projectRoot),
    configDir: gatewayConfigDir(dataDir),
  };
}

/** `run` argv for the gateway container. Pure, so both runtimes' dialects are testable. */
export function gatewayRunArgs(rt: GatewayRuntime, secret: string): string[] {
  const networks =
    rt.bin === 'container'
      ? ['--network', 'default', '--network', rt.egressNetwork]
      : ['--network', 'bridge', '--network', rt.egressNetwork];
  return [
    'run',
    '--detach',
    '--name',
    rt.name,
    ...networks,
    '--label',
    `nanoclaw-install=${rt.slug}`,
    '--label',
    `nanoclaw-role=${GATEWAY_ROLE}`,
    '-e',
    `NANOCLAW_GATEWAY_SECRET=${secret}`,
    '-e',
    `GATEWAY_PORT=${GATEWAY_PORT}`,
    '-v',
    `${rt.configDir}:/app/config:ro`,
    rt.image,
  ];
}

interface InspectedContainer {
  // Apple `container inspect`
  status?: string | { state?: string; networks?: Array<{ network?: string; ipv4Address?: string }> };
  // Docker `inspect`
  State?: { Running?: boolean };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

export interface GatewayState {
  running: boolean;
  /** Address on the egress network, when attached. */
  address: string | null;
}

/** Read running state and the egress address from either runtime's inspect JSON. */
export function parseGatewayState(output: string, egressNetwork: string): GatewayState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return { running: false, address: null };
  }
  const record = (Array.isArray(parsed) ? parsed[0] : parsed) as InspectedContainer | undefined;
  if (!record) return { running: false, address: null };

  if (record.State || record.NetworkSettings) {
    const ip = record.NetworkSettings?.Networks?.[egressNetwork]?.IPAddress;
    return { running: record.State?.Running === true, address: ip || null };
  }
  const status = typeof record.status === 'object' ? record.status : undefined;
  const state = typeof record.status === 'string' ? record.status : status?.state;
  const leg = status?.networks?.find((n) => n.network === egressNetwork)?.ipv4Address;
  return { running: state === 'running', address: leg ? leg.split('/')[0]! : null };
}

async function run(bin: string, args: string[], timeoutMs = 60_000): Promise<string> {
  // Promisified per call, not at import: this module loads with the gateway
  // barrel, and suites that mock child_process must not trip over it.
  const { stdout } = await promisify(execFile)(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function inspect(rt: GatewayRuntime, container: string): Promise<string | null> {
  try {
    return await run(rt.bin, ['inspect', container], 15_000);
  } catch {
    return null;
  }
}

// `inspect` alone finds containers only on Apple Container; `image inspect`
// is the spelling both runtimes share for images.
async function imageExists(rt: GatewayRuntime): Promise<boolean> {
  try {
    await run(rt.bin, ['image', 'inspect', rt.image], 15_000);
    return true;
  } catch {
    return false;
  }
}

/** The host-only network sessions live on; created `--internal` when absent. */
async function ensureEgressNetwork(rt: GatewayRuntime): Promise<void> {
  try {
    await run(rt.bin, ['network', 'inspect', rt.egressNetwork], 15_000);
    return;
  } catch {
    // absent — create it below
  }
  await run(rt.bin, ['network', 'create', '--internal', rt.egressNetwork], 30_000);
  log.info('Created host-only egress network for the custom gateway', { network: rt.egressNetwork });
}

export class GatewayImageMissingError extends Error {
  constructor(image: string) {
    super(
      `the custom gateway image ${image} does not exist; build it with ` +
        '`pnpm exec tsx .claude/skills/add-custom-gateway/scripts/setup.ts`',
    );
    this.name = 'GatewayImageMissingError';
  }
}

/**
 * Bring the gateway up if it is not, and return its address on the egress
 * network. Idempotent: a running, attached gateway is returned as is. A
 * container that exists but is stopped, or lost its egress leg, is removed and
 * recreated, because its networks are decided at create time.
 */
export async function ensureGatewayRunning(rt: GatewayRuntime, secret: string): Promise<string> {
  const current = await inspect(rt, rt.name);
  const state = current ? parseGatewayState(current, rt.egressNetwork) : { running: false, address: null };
  if (state.running && state.address) return state.address;

  if (!(await imageExists(rt))) throw new GatewayImageMissingError(rt.image);
  await ensureEgressNetwork(rt);
  if (current) {
    await run(rt.bin, ['rm', '--force', rt.name], 30_000).catch(() => undefined);
  }
  await run(rt.bin, gatewayRunArgs(rt, secret), 120_000);

  const started = await inspect(rt, rt.name);
  const now = started ? parseGatewayState(started, rt.egressNetwork) : { running: false, address: null };
  if (!now.address) throw new Error(`the custom gateway started but has no address on "${rt.egressNetwork}"`);
  log.info('Custom gateway container running', { container: rt.name, address: now.address });
  return now.address;
}

/** Remove the gateway container so the next session recreates it, e.g. after an image rebuild. */
export async function removeGateway(rt: GatewayRuntime): Promise<void> {
  await run(rt.bin, ['rm', '--force', rt.name], 30_000).catch(() => undefined);
}

/**
 * Liveness, asked from inside the gateway container.
 *
 * Not an HTTP call from the host, though the host holds an address on the
 * egress network: on macOS a host process reaching a container address is
 * subject to Local Network privacy, and the service is not an app anyone has
 * granted it to — `curl` from a permitted terminal succeeds while the same
 * request from Node fails EHOSTUNREACH. Going through the runtime needs no
 * such permission and asks the question that matters: is the service inside
 * listening.
 */
export async function probeGatewayHealth(rt: GatewayRuntime, timeoutMs = 10_000): Promise<boolean> {
  try {
    const out = await run(
      rt.bin,
      ['exec', rt.name, 'wget', '-qO-', `http://127.0.0.1:${GATEWAY_PORT}/health/live`],
      timeoutMs,
    );
    return out.includes('ok');
  } catch {
    return false;
  }
}
