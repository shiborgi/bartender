import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configPaths, readSecret, secretKeys, upsertSecret } from './config-files.js';
import { createCredentialStore } from './credential-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(secrets = '# upstream keys\nOPENCODE_ZEN_API_KEY=\n'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-gateway-store-'));
  roots.push(root);
  const paths = configPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(
    paths.policy,
    JSON.stringify({
      schemaVersion: 1,
      upstreams: {
        'zen-go': {
          baseUrl: 'https://opencode.ai/zen/go/v1',
          auth: { header: 'Authorization', format: 'Bearer {value}', secret: 'OPENCODE_ZEN_API_KEY' },
        },
        local: { baseUrl: 'http://192.168.64.1:11434/v1' },
      },
    }),
  );
  fs.writeFileSync(paths.secrets, secrets, { mode: 0o600 });
  return root;
}

const target = {
  name: 'OpenCode Go',
  kind: 'api-key' as const,
  host: 'opencode.ai',
  proxyValue: 'nc-opencode-token-v1',
  injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
};

describe('secrets.env', () => {
  it('replaces one key in place, keeps comments, and stays owner-only', () => {
    const root = project('# keep me\nA=1\nB=2\n');
    upsertSecret('A', 'changed', root);
    upsertSecret('C', '3', root);
    const file = configPaths(root).secrets;
    expect(fs.readFileSync(file, 'utf8')).toBe('# keep me\nA=changed\nB=2\nC=3\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('counts only non-empty values as set', () => {
    const root = project('EMPTY=\nQUOTED=""\nSET="x"\n');
    expect([...secretKeys(root)]).toEqual(['SET']);
    expect(readSecret('SET', root)).toBe('x');
  });

  it('refuses a value that would inject another line', () => {
    expect(() => upsertSecret('A', 'x\nB=y', project())).toThrow(/more than one line/);
  });
});

describe('credential store', () => {
  it('finds the upstream on the target host and stores its key under the named secret', async () => {
    const root = project();
    const connection = createCredentialStore(root).connection!(target);
    expect(await connection.find()).toEqual({ reusable: false });
    await expect(connection.keep()).rejects.toThrow(/OPENCODE_ZEN_API_KEY is not set/);
    await connection.save('oc_sk_fixture');
    expect(await connection.find()).toEqual({ reusable: true });
    await connection.keep();
    expect(readSecret('OPENCODE_ZEN_API_KEY', root)).toBe('oc_sk_fixture');
  });

  it('reports no entry for a host the policy does not route, and refuses to invent one', async () => {
    const connection = createCredentialStore(project()).connection!({ ...target, host: 'api.example.com' });
    expect(await connection.find()).toBeNull();
    await expect(connection.save('x')).rejects.toThrow(/no upstream on api.example.com/);
  });

  it('refuses subscription logins', () => {
    expect(() =>
      createCredentialStore(project()).connection!({
        name: 'OpenCode ChatGPT',
        kind: 'oauth',
        host: 'chatgpt.com',
        proxyValue: 'x',
        oauth: { profile: 'chatgpt', clientId: 'c', tokenEndpoint: 'https://auth.openai.com/oauth/token' },
      }),
    ).toThrow(/API keys only/);
  });

  it('answers provider-named credentials through the upstream of that name', async () => {
    const root = project();
    const store = createCredentialStore(root);
    expect(await store.has('zen-go')).toBe(false);
    await store.save('zen-go', { kind: 'api-key', value: 'k' });
    expect(await store.has('zen-go')).toBe(true);
    await expect(store.has('missing')).rejects.toThrow(/no upstream named "missing"/);
  });

  it('accepts a model endpoint only on a routed upstream host', () => {
    const store = createCredentialStore(project());
    expect(() => store.modelEndpoint!('https://opencode.ai/zen/go/v1')).not.toThrow();
    expect(() => store.modelEndpoint!('https://api.example.com/v1')).toThrow(/no upstream on api.example.com/);
  });
});
