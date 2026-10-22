/**
 * Give each agent group the gateway's MCP servers its policy allows.
 *
 *   pnpm exec tsx .claude/skills/add-custom-gateway/scripts/routes.ts sync [--group <id>] [--dry-run]
 *
 * `gateway.json` is the source of truth; this writes ordinary HTTP MCP entries
 * through `ncl`, one per allowed route, at
 * `http://host.docker.internal:8080/g/<client key>/mcp/<route>`. The key in the
 * path is the group's own identity, the same one its model traffic carries;
 * it lets the gateway apply that group's policy without a header the MCP
 * client would have to be configured to send. Run it with the service up,
 * after any change to a group's `mcpServers`, then restart that group.
 */
import { execFileSync } from 'node:child_process';

import { envValue } from '../../../../src/env.js';
import { GATEWAY_ENDPOINT } from '../../../../src/gateway-providers/custom-gateway.js';
import { GATEWAY_PORT } from '../../../../src/gateway-providers/custom-gateway-container.js';
import { GATEWAY_SECRET_ENV, deriveClientKey } from '../../../../src/gateway-providers/custom-gateway-identity.js';
import { readPolicy, type Policy } from './config-files.js';

export interface McpRouteEntry {
  group: string;
  name: string;
  url: string;
}

/** Pure: the entries the policy implies. A `*` group policy is a fallback, not a group, so it gets none. */
export function plannedRoutes(policy: Policy, secret: string, onlyGroup?: string): McpRouteEntry[] {
  const servers = Object.keys(policy.mcpServers ?? {});
  return Object.entries(policy.agents ?? {})
    .filter(([group]) => group !== '*' && (!onlyGroup || group === onlyGroup))
    .flatMap(([group, entry]) => {
      const allowed = entry.mcpServers ?? [];
      const names = allowed.includes('*') ? servers : allowed.filter((name) => servers.includes(name));
      const key = encodeURIComponent(deriveClientKey(secret, group));
      return names.map((name) => ({
        group,
        name,
        url: `http://${GATEWAY_ENDPOINT}:${GATEWAY_PORT}/g/${key}/mcp/${name}`,
      }));
    });
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args: string[]): void {
  if (args[0] !== 'sync') throw new Error('Usage: routes.ts sync [--group <id>] [--dry-run]');
  const secret = envValue(GATEWAY_SECRET_ENV)?.trim();
  if (!secret) throw new Error(`${GATEWAY_SECRET_ENV} is not set in .env; run the add-custom-gateway setup first`);
  const routes = plannedRoutes(readPolicy(), secret, option(args, '--group'));
  if (routes.length === 0) console.log('No agent group in gateway.json allows an MCP server.');
  for (const route of routes) {
    // The URL carries the group's key: say which route, never print the URL.
    console.log(`${route.group}: ${route.name}`);
    if (args.includes('--dry-run')) continue;
    execFileSync(
      'pnpm',
      [
        '--silent',
        'run',
        'ncl',
        'groups',
        'config',
        'add-mcp-server',
        '--id',
        route.group,
        '--name',
        route.name,
        '--url',
        route.url,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  }
  const groups = [...new Set(routes.map((route) => route.group))];
  if (groups.length && !args.includes('--dry-run')) {
    console.log(`Restart to apply: ${groups.map((group) => `ncl groups restart --id ${group}`).join('; ')}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
