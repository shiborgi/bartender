/**
 * Connect a configured Google OAuth profile without ever printing its token.
 *
 *   pnpm exec tsx .claude/skills/add-custom-gateway/scripts/google-oauth-connect.ts <profile>
 *
 * Headless hosts are the normal deployment, and Google's loopback flow needs a
 * browser that can reach 127.0.0.1 on THIS host. So the callback port is
 * settable (`GOOGLE_OAUTH_PORT`) — a random one cannot be forwarded before the
 * script runs — and the URL is printed before any attempt to open it. Opening
 * a browser is best-effort: on a machine with none, the printed URL and an
 * `ssh -L` tunnel are the whole procedure.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';

import { readPolicy, readSecret, upsertSecret } from './config-files.js';

interface GoogleProfile {
  expectedEmail: string;
  clientIdSecret: string;
  clientSecretSecret: string;
  refreshTokenSecret: string;
  scopes: string[];
}

function profileNamed(name: string, root: string): GoogleProfile {
  const profiles = (readPolicy(root).oauthProfiles ?? {}) as Record<string, Partial<GoogleProfile>>;
  const profile = profiles[name];
  if (!profile) throw new Error(`OAuth profile "${name}" is not configured in gateway.json`);
  for (const key of ['expectedEmail', 'clientIdSecret', 'clientSecretSecret', 'refreshTokenSecret'] as const) {
    if (typeof profile[key] !== 'string' || !profile[key]) throw new Error(`oauthProfiles.${name}.${key} is required`);
  }
  return { ...(profile as GoogleProfile), scopes: (profile.scopes ?? []).filter((s) => typeof s === 'string') };
}

function callbackPort(): number {
  // 0 is an ephemeral port, fine on a desktop; a fixed one is what makes
  // `ssh -L` possible, since the tunnel must exist before Google redirects.
  const port = Number(process.env.GOOGLE_OAUTH_PORT ?? '0');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`GOOGLE_OAUTH_PORT must be a port number (got ${String(process.env.GOOGLE_OAUTH_PORT)})`);
  }
  return port;
}

async function connect(profileName: string, root = process.cwd()): Promise<void> {
  const profile = profileNamed(profileName, root);
  const clientId = readSecret(profile.clientIdSecret, root);
  const clientSecret = readSecret(profile.clientSecretSecret, root);
  if (!clientId || !clientSecret) {
    throw new Error(`Set ${profile.clientIdSecret} and ${profile.clientSecretSecret} in secrets.env first`);
  }

  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(callbackPort(), '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: profile.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  console.log(`\nSign in as ${profile.expectedEmail} at:\n\n${authUrl.toString()}\n`);
  console.log(`Google will redirect to ${redirectUri}, which is served by THIS host.`);
  console.log(
    `From a machine with a browser, forward the port first:\n  ssh -L ${port}:127.0.0.1:${port} <this-host>\n`,
  );
  console.log('Waiting up to 5 minutes for the callback…');
  // No browser on this host is normal; the printed URL is the instruction.
  await promisify(execFile)(process.platform === 'darwin' ? 'open' : 'xdg-open', [authUrl.toString()]).catch(
    () => undefined,
  );

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth timed out after 5 minutes')), 300_000);
    server.once('request', (req, res) => {
      clearTimeout(timer);
      const url = new URL(req.url ?? '/', redirectUri);
      const received = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state || !received) {
        res.end('Authorization failed. You may close this tab.');
        reject(new Error('Google OAuth state or code is invalid'));
        return;
      }
      res.end('Google account connected. You may close this tab.');
      resolve(received);
    });
  }).finally(() => server.close());

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const token = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string };
  if (!tokenResponse.ok || !token.access_token || !token.refresh_token) {
    throw new Error('Google did not issue an offline refresh token');
  }
  const info = (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${token.access_token}` },
  }).then((r) => r.json())) as { email?: string; email_verified?: boolean };
  if (info.email !== profile.expectedEmail || info.email_verified !== true) {
    throw new Error(`Authenticated account does not match configured expectedEmail (${String(info.email)})`);
  }
  upsertSecret(profile.refreshTokenSecret, token.refresh_token, root);
  console.log(`Connected ${info.email} to gateway OAuth profile "${profileName}".`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const profile = process.argv[2];
  if (!profile) {
    console.error('Usage: google-oauth-connect.ts <profile>');
    process.exit(1);
  }
  connect(profile).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
