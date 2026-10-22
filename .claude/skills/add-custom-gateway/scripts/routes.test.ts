import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { plannedRoutes } from './routes.js';

const SECRET = 'a'.repeat(64);
const policy = {
  schemaVersion: 1,
  mcpServers: { yooga: {}, 'google-drive': {}, 'google-tasks': {} },
  agents: {
    '*': { models: ['*'], mcpServers: ['*'] },
    'ag-bartender': { models: ['*'], mcpServers: ['yooga', 'google-drive', 'not-configured'] },
    'ag-all': { models: ['*'], mcpServers: ['*'] },
  },
};

describe('MCP route sync', () => {
  it('writes one entry per allowed, configured route, keyed by the group', () => {
    const routes = plannedRoutes(policy, SECRET, 'ag-bartender');
    expect(routes).toEqual([
      {
        group: 'ag-bartender',
        name: 'yooga',
        url: 'http://host.docker.internal:8080/g/ncl.ag-bartender.f60e30a544a792b4e779a476c7266912/mcp/yooga',
      },
      {
        group: 'ag-bartender',
        name: 'google-drive',
        url: 'http://host.docker.internal:8080/g/ncl.ag-bartender.f60e30a544a792b4e779a476c7266912/mcp/google-drive',
      },
    ]);
  });

  it('expands a wildcard and never treats the fallback policy as a group', () => {
    const routes = plannedRoutes(policy, SECRET);
    expect(routes.some((route) => route.group === '*')).toBe(false);
    expect(routes.filter((route) => route.group === 'ag-all').map((route) => route.name)).toEqual([
      'yooga',
      'google-drive',
      'google-tasks',
    ]);
  });
});
