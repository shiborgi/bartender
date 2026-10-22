/**
 * Setup's custody adapter for the custom gateway.
 *
 * Upstream keys live in `secrets.env`, referenced by name from an upstream in
 * `gateway.json`. A provider's credential is matched to the upstream on its
 * host; the policy file stays the single place that says where a model is,
 * so this adapter never invents an upstream — it asks the operator to add one.
 */
import type {
  GatewayCredentialConnection,
  GatewayCredentialTarget,
  ProviderCredentialStore,
} from '../../../../setup/gateways/credential-store.js';
import { readPolicy, secretKeys, upsertSecret, upstreamForHost, type Policy } from './config-files.js';

function missingUpstream(host: string): Error {
  return new Error(
    `The custom gateway has no upstream on ${host}. Add one to data/custom-gateway/config/gateway.json ` +
      '(baseUrl, auth.header, auth.format, auth.secret), then run setup again.',
  );
}

function secretFor(policy: Policy, host: string): string {
  const match = upstreamForHost(policy, host);
  if (!match) throw missingUpstream(host);
  const [name, upstream] = match;
  if (!upstream.auth) throw new Error(`Upstream "${name}" on ${host} takes no credential; nothing to store.`);
  return upstream.auth.secret;
}

export function createCredentialStore(root = process.cwd()): ProviderCredentialStore {
  const hostOf = (provider: string): string => {
    const upstream = readPolicy(root).upstreams?.[provider];
    if (!upstream) throw new Error(`The custom gateway has no upstream named "${provider}" in gateway.json.`);
    return new URL(upstream.baseUrl).hostname;
  };

  return {
    async has(provider) {
      const policy = readPolicy(root);
      return secretKeys(root).has(secretFor(policy, hostOf(provider)));
    },
    async save(provider, credential) {
      if (credential.kind !== 'api-key') {
        throw new Error('The custom gateway stores API keys only; subscription logins are not supported.');
      }
      upsertSecret(secretFor(readPolicy(root), hostOf(provider)), credential.value, root);
    },
    connection(target: GatewayCredentialTarget): GatewayCredentialConnection {
      if (target.kind !== 'api-key') {
        throw new Error('The custom gateway stores API keys only; subscription logins are not supported.');
      }
      return {
        async find() {
          const policy = readPolicy(root);
          if (!upstreamForHost(policy, target.host)) return null;
          return { reusable: secretKeys(root).has(secretFor(policy, target.host)) };
        },
        async save(value) {
          if (typeof value !== 'string') throw new Error('The custom gateway stores API keys only.');
          upsertSecret(secretFor(readPolicy(root), target.host), value, root);
        },
        async keep() {
          const key = secretFor(readPolicy(root), target.host);
          if (!secretKeys(root).has(key)) throw new Error(`${key} is not set in secrets.env; enter a key.`);
        },
      };
    },
    /*
     * The agent always reaches models through the gateway; the endpoint the
     * operator types only has to name an upstream the policy already routes.
     */
    modelEndpoint(url) {
      const host = new URL(url).hostname;
      if (!upstreamForHost(readPolicy(root), host)) throw missingUpstream(host);
      return { configure: async () => {} };
    },
  };
}
