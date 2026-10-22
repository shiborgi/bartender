/**
 * Per-agent-group client keys for the custom gateway.
 *
 * `ncl.<agentGroupId>.<mac>`, where the mac is an HMAC of the group id under
 * the install secret. The gateway recomputes it, so it needs no per-group
 * state, and a group cannot forge a sibling's key. The same derivation lives in
 * the gateway service (`service/src/identity.ts`); both are pinned by one test
 * vector so the two cannot drift into an install that rejects every agent.
 */
import { createHmac, randomBytes } from 'crypto';

const MAC_HEX_CHARS = 32;

export const GATEWAY_SECRET_ENV = 'NANOCLAW_GATEWAY_SECRET';

export function generateGatewaySecret(): string {
  return randomBytes(32).toString('hex');
}

export function deriveClientKey(secret: string, agentGroupId: string): string {
  if (!secret) throw new Error(`${GATEWAY_SECRET_ENV} is not set; cannot derive a gateway client key`);
  if (agentGroupId.includes('.')) {
    // The separator has to stay unambiguous or the id could be split wrong on
    // the gateway side, which is an identity bug rather than a parse bug.
    throw new Error(`agent group id must not contain a dot: ${agentGroupId}`);
  }
  const mac = createHmac('sha256', secret).update(agentGroupId).digest('hex').slice(0, MAC_HEX_CHARS);
  return `ncl.${agentGroupId}.${mac}`;
}
