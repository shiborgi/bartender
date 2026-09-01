/**
 * Stub gateway provider — does nothing.
 *
 * Use when you want to run without OneCLI (no credential injection,
 * no extra env/mounts from gateway).
 *
 * Activate with:
 *   NANOCLAW_GATEWAY_PROVIDER=stub
 */

import { registerGatewayProvider } from './gateway-provider-registry.js';

registerGatewayProvider('stub', () => ({
  kind: 'stub',
  async contribute() {
    return {};
  },
}));
