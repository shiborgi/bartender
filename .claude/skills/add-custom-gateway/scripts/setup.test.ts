import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { configPaths } from './config-files.js';
import { detectInstalledCustomGateway } from './detect.js';
import { ensureInstallSecret, scaffoldConfig } from './setup.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-gateway-setup-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, '.env'), 'TZ=UTC\n');
  return root;
}

const skillDir = path.resolve(import.meta.dirname, '..');

describe('custom gateway setup', () => {
  it('creates the install secret once and keeps it after', () => {
    const root = project();
    expect(ensureInstallSecret(root)).toBe('created');
    const first = fs.readFileSync(path.join(root, '.env'), 'utf8');
    expect(first).toMatch(/^NANOCLAW_GATEWAY_SECRET=[0-9a-f]{64}$/m);
    expect(ensureInstallSecret(root)).toBe('kept');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(first);
  });

  it('scaffolds the policy and an owner-only secrets file, and never overwrites them', () => {
    const root = project();
    expect(scaffoldConfig(root, skillDir)).toHaveLength(2);
    const { policy, secrets } = configPaths(root);
    expect(fs.statSync(secrets).mode & 0o777).toBe(0o600);
    fs.writeFileSync(policy, '{"schemaVersion":1}');
    expect(scaffoldConfig(root, skillDir)).toEqual([]);
    expect(fs.readFileSync(policy, 'utf8')).toBe('{"schemaVersion":1}');
  });

  it('is detected only once both the secret and the policy exist', () => {
    const root = project();
    expect(detectInstalledCustomGateway(root)).toBe(false);
    ensureInstallSecret(root);
    expect(detectInstalledCustomGateway(root)).toBe(false);
    scaffoldConfig(root, skillDir);
    expect(detectInstalledCustomGateway(root)).toBe(true);
  });
});
