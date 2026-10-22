import fs from 'node:fs';
import path from 'node:path';

/**
 * Installed means configured: the install secret is in `.env` and the policy
 * file exists. Container uptime is not identity — a stopped gateway is still
 * this install's gateway, and the provider restarts it on the next session.
 * Standalone on purpose: it runs before the payload is in the tree.
 */
export function detectInstalledCustomGateway(root = process.cwd()): boolean {
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const secret = /^\s*NANOCLAW_GATEWAY_SECRET\s*=\s*(\S+)/m.exec(env)?.[1];
    return Boolean(secret) && fs.existsSync(path.join(root, 'data', 'custom-gateway', 'config', 'gateway.json'));
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log(detectInstalledCustomGateway() ? 'installed' : 'absent');
}
