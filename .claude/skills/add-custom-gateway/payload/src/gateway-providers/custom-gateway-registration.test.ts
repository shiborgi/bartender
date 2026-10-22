/**
 * The skill's reach-in is one import appended to `installed.ts`; this goes
 * through the real selection module, so a lost barrel line or a provider
 * registered under another kind fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { configuredGatewayProviderKind, getGatewayProvider, resetGatewayProvider } from './index.js';
import { listGatewayProviderKinds } from './gateway-provider-registry.js';

describe('custom-gateway registration', () => {
  afterEach(() => {
    delete process.env.NANOCLAW_GATEWAY_PROVIDER;
    resetGatewayProvider();
  });

  it('registers through the installed barrel', () => {
    expect(listGatewayProviderKinds()).toContain('custom-gateway');
  });

  it('is selected by NANOCLAW_GATEWAY_PROVIDER', () => {
    process.env.NANOCLAW_GATEWAY_PROVIDER = 'custom-gateway';
    // The suite setup injects a test gateway; drop it so selection runs for real.
    resetGatewayProvider();
    expect(configuredGatewayProviderKind()).toBe('custom-gateway');
    expect(getGatewayProvider().kind).toBe('custom-gateway');
  });
});
