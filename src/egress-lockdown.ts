/**
 * Egress lockdown — force ALL agent traffic through the OneCLI gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached as host.docker.internal, so the injected proxy is the only
 * reachable hop. Non-root, no NET_ADMIN — the agent can't undo it.
 *
 * Fail-fast: when the flag is on but the network/gateway can't be set up, throw
 * rather than silently spawn an agent with open egress.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { EGRESS_LOCKDOWN, EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

// Perimeter knobs (locked-down network, gateway container, on/off flag) are read
// via config.ts so they honor .env under the shipped service, not just process.env.
export { EGRESS_NETWORK };

/** Raised when lockdown is requested but can't be established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress. Start the OneCLI gateway container ` +
        `"${ONECLI_GATEWAY_CONTAINER}", or set NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
    this.name = 'EgressLockdownError';
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN(), args, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function appleOk(args: string[]): boolean {
  try {
    execFileSync('container', args, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Return the IPv4 gateway advertised by `container network inspect`. */
export function appleNetworkGateway(output: string): string | null {
  try {
    const value: unknown = JSON.parse(output);
    const visit = (node: unknown): string | null => {
      if (!node || typeof node !== 'object') return null;
      for (const [key, child] of Object.entries(node)) {
        if (/(?:gateway|gatewayipv4|ipv4gateway)$/i.test(key) && typeof child === 'string') {
          const match = child.match(/^\d{1,3}(?:\.\d{1,3}){3}$/);
          if (match) return match[0];
        }
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(value);
  } catch {
    return null;
  }
}

/** Require the inspect document to explicitly identify an internal/host-only network. */
export function appleNetworkIsInternal(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false;
      for (const [key, child] of Object.entries(node)) {
        const normalizedKey = key.replace(/[_-]/g, '').toLowerCase();
        if ((normalizedKey === 'internal' || normalizedKey === 'hostonly') && child === true) return true;
        if (
          (normalizedKey === 'mode' || normalizedKey === 'networkmode' || normalizedKey === 'type') &&
          typeof child === 'string' &&
          /^(?:internal|host[-_ ]?only)$/i.test(child.trim())
        ) {
          return true;
        }
        if (visit(child)) return true;
      }
      return false;
    };
    return visit(value);
  } catch {
    return false;
  }
}

/** Ensure Apple's host-only network and return argv for a session create. */
export function appleNetworkArgs(): string[] {
  let inspect = '';
  try {
    inspect = execFileSync('container', ['network', 'inspect', EGRESS_NETWORK], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
  } catch {
    if (!appleOk(['network', 'create', '--internal', EGRESS_NETWORK])) {
      throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal Apple Container network could not be created`);
    }
    try {
      inspect = execFileSync('container', ['network', 'inspect', EGRESS_NETWORK], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch {
      throw new EgressLockdownError(`the "${EGRESS_NETWORK}" Apple Container network could not be inspected`);
    }
  }

  if (!appleNetworkIsInternal(inspect)) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" network is not explicitly marked internal/host-only`);
  }

  const gateway = appleNetworkGateway(inspect);
  if (!gateway) throw new EgressLockdownError(`the "${EGRESS_NETWORK}" network has no IPv4 gateway`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hosts-'));
  const hosts = path.join(dir, 'hosts');
  fs.writeFileSync(hosts, `127.0.0.1 localhost\n${gateway} host.docker.internal gateway.docker.internal\n`);
  return ['--network', EGRESS_NETWORK, '--mount', `type=bind,source=${hosts},target=/etc/hosts,readonly`];
}

/** Is the OneCLI gateway currently attached to the egress network? */
function gatewayAttached(): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN(),
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split(/\s+/).includes(ONECLI_GATEWAY_CONTAINER);
  } catch {
    return false;
  }
}

/**
 * Ensure the egress network exists with the OneCLI gateway attached (aliased
 * host.docker.internal). Idempotent + self-healing. Returns false when lockdown
 * is disabled (caller uses the host gateway), true when it's active. Throws
 * EgressLockdownError when enabled but unestablishable — fail fast rather than
 * spawn an agent with open egress.
 */
export function ensureEgressNetwork(): boolean {
  if (!EGRESS_LOCKDOWN) return false;

  if (CONTAINER_RUNTIME_BIN() === 'container') {
    appleNetworkArgs();
    return true;
  }

  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  ) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal network could not be created`);
  }

  if (gatewayAttached()) return true;

  if (
    dockerOk(['network', 'connect', '--alias', 'host.docker.internal', EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER]) &&
    gatewayAttached()
  ) {
    log.info('Egress lockdown: OneCLI gateway attached', {
      network: EGRESS_NETWORK,
      gateway: ONECLI_GATEWAY_CONTAINER,
    });
    return true;
  }

  throw new EgressLockdownError(
    `the OneCLI gateway "${ONECLI_GATEWAY_CONTAINER}" could not be attached to "${EGRESS_NETWORK}"`,
  );
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}
