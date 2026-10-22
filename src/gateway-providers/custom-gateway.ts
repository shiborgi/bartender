/**
 * The `custom-gateway` provider: an install-owned gateway service that the
 * agent calls by URL, rather than a proxy that intercepts its traffic.
 *
 * - Models are routed by alias to the upstreams in `gateway.json`, with the
 *   upstream credential attached by the gateway.
 * - MCP servers are routes on the same gateway: remote ones with their own
 *   credential, and built-in Google ones (Drive and Sheets, Calendar, Tasks,
 *   read-only Gmail) over the install's OAuth profile.
 * - Each agent group is identified by a client key derived from
 *   `NANOCLAW_GATEWAY_SECRET`, carried as a path prefix (`/g/<key>/...`)
 *   because OpenCode sends its own placeholder credential and an MCP entry is
 *   only a URL.
 *
 * Sessions reach the gateway as `host.docker.internal:8080` on the install's
 * host-only network; the session driver maps that name to the gateway
 * container's address there. Nothing in a session holds an upstream
 * credential, and nothing in it can reach anything else.
 *
 * The gateway raises no approvals: what an agent may reach is decided in
 * `gateway.json`, ahead of time, by the operator.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  GATEWAY_PORT,
  ensureGatewayRunning,
  gatewayRuntime,
  probeGatewayHealth,
  type GatewayRuntime,
} from './custom-gateway-container.js';
import { GATEWAY_SECRET_ENV, deriveClientKey } from './custom-gateway-identity.js';
import {
  registerGatewayProvider,
  type GatewayContribution,
  type GatewayProviderDefinition,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';

export const CUSTOM_GATEWAY_KIND = 'custom-gateway';

/** The name sessions use for the gateway; the session driver resolves it. */
export const GATEWAY_ENDPOINT = 'host.docker.internal';

const HEALTH_INTERVAL_MS = 15_000;

/** The env a session gets: every gateway URL already carries its group's key. */
export function sessionEnv(clientKey: string): Record<string, string> {
  const base = `http://${GATEWAY_ENDPOINT}:${GATEWAY_PORT}/g/${clientKey}`;
  return {
    // Model providers: OpenCode reads OPENCODE_BASE_URL first; Claude and
    // OpenAI-compatible clients read their own.
    OPENCODE_BASE_URL: `${base}/v1`,
    ANTHROPIC_BASE_URL: base,
    OPENAI_BASE_URL: `${base}/v1`,
    // Agent-side helpers (MCP routes, the Gmail relay poller) build on this.
    NANOCLAW_GATEWAY_URL: base,
    NO_PROXY: `127.0.0.1,localhost,${GATEWAY_ENDPOINT}`,
  };
}

export function contributionFor(rt: GatewayRuntime, clientKey: string): GatewayContribution {
  return {
    env: sessionEnv(clientKey),
    networkAccess: { endpoint: GATEWAY_ENDPOINT, target: { kind: 'runtime', identity: rt.name } },
  };
}

export interface CustomGatewayDeps {
  runtime?: () => GatewayRuntime;
  secret?: () => string | undefined;
  ensureRunning?: (rt: GatewayRuntime, secret: string) => Promise<string>;
  probe?: (rt: GatewayRuntime) => Promise<boolean>;
  /** Pause between start-up probes; a fresh container needs a moment to listen. */
  settleMs?: number;
  intervalMs?: number;
}

interface LiveLease {
  notify?: (reason: string) => void;
}

export function defineCustomGatewayProvider(deps: CustomGatewayDeps = {}): GatewayProviderDefinition {
  const runtime = deps.runtime ?? (() => gatewayRuntime());
  const secret = deps.secret ?? (() => readEnvFile([GATEWAY_SECRET_ENV])[GATEWAY_SECRET_ENV]);
  const ensureRunning = deps.ensureRunning ?? ensureGatewayRunning;
  const probe = deps.probe ?? probeGatewayHealth;
  const intervalMs = deps.intervalMs ?? HEALTH_INTERVAL_MS;
  const settleMs = deps.settleMs ?? 500;

  const leases = new Map<string, LiveLease>();
  let monitor: NodeJS.Timeout | null = null;
  let address: string | null = null;
  let current: GatewayRuntime | null = null;
  let unavailable: string | null = null;

  /*
   * One health monitor for all live sessions. A gateway that stops answering
   * makes every lease unavailable at once: core stops those sessions, and the
   * next message re-runs `ensure`, which recreates the container.
   */
  const check = async (): Promise<void> => {
    if (!current) return;
    const healthy = await probe(current);
    if (healthy) {
      unavailable = null;
      return;
    }
    unavailable = `the custom gateway at ${address}:${GATEWAY_PORT} stopped answering /health/live`;
    for (const lease of leases.values()) lease.notify?.(unavailable);
  };

  // A container that has just started is not listening yet: give it a few
  // probes before refusing the session.
  const settled = async (rt: GatewayRuntime): Promise<boolean> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await probe(rt)) return true;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    return false;
  };

  const startMonitor = (): void => {
    if (monitor) return;
    monitor = setInterval(() => void check(), intervalMs);
    monitor.unref();
  };

  const ensure = async (input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease> => {
    const installSecret = secret();
    if (!installSecret) {
      throw new Error(`${GATEWAY_SECRET_ENV} is not set in .env; the custom gateway cannot identify agent groups`);
    }
    const rt = runtime();
    address = await ensureRunning(rt, installSecret);
    current = rt;
    if (!(await settled(rt))) {
      throw new Error(
        `the custom gateway at ${address}:${GATEWAY_PORT} is not answering /health/live — refusing to start a ` +
          `session that would have no route to a model or an MCP server. See \`${rt.bin} logs ${rt.name}\`.`,
      );
    }
    unavailable = null;

    const lease: LiveLease = {};
    leases.set(input.runtimeIdentity, lease);
    startMonitor();
    const close = (): void => {
      if (leases.get(input.runtimeIdentity) !== lease) return;
      leases.delete(input.runtimeIdentity);
      if (leases.size === 0 && monitor) {
        clearInterval(monitor);
        monitor = null;
      }
    };
    if (signal.aborted) close();
    else signal.addEventListener('abort', close, { once: true });

    log.info('Custom gateway lease', { agentGroupId: input.key.agentGroupId, sessionId: input.key.sessionId, address });
    return {
      contribution: contributionFor(rt, deriveClientKey(installSecret, input.key.agentGroupId)),
      onUnavailable(report) {
        lease.notify = report;
        if (unavailable) report(unavailable);
      },
    };
  };

  return {
    kind: CUSTOM_GATEWAY_KIND,
    agentSkills: ['custom-gateway'],
    connections: {
      async connect({ host }) {
        return {
          status: 'unsupported' as const,
          message:
            `The custom gateway grants access in gateway.json, not per account. Ask the operator to add ${host} ` +
            'as an upstream or MCP route and allow it for this agent group.',
        };
      },
    },
    // The gateway is install-owned, not a per-session resource: session abort
    // only drops the lease.
    sessions: { ensure },
    approvals: {
      // No approvals are ever raised. The subscription must stay open until
      // the host stops — a subscription that ends tells core the gateway is
      // unavailable.
      subscribe: (_decide, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    },
  };
}

registerGatewayProvider(defineCustomGatewayProvider());
