import { loadBarbackClientConfig } from '../barback-client-config.js';
import { barbackClientEnvironment } from '../barback-network.js';
import { barbackProviderEnv } from '../barback-provider.js';
import { probeBarback } from '../barback-probe.js';
import { EGRESS_GENERATION_LABEL } from '../drivers/types.js';

import { registerGatewayProvider } from './gateway-provider-registry.js';

registerGatewayProvider('barback', () => ({
  kind: 'barback',
  async contribute() {
    const config = loadBarbackClientConfig(barbackClientEnvironment());
    if (config.credentialMode !== 'host-relay') {
      throw new Error(`Barback client-config credentialMode must be "host-relay", got "${config.credentialMode}"`);
    }
    await probeBarback(config);
    return {
      env: barbackProviderEnv(config, 'opencode'),
      labels: { [EGRESS_GENERATION_LABEL]: config.egressGeneration },
    };
  },
}));
