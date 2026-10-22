import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { containerRuntimeBin } from './container-runtime.js';

describe('containerRuntimeBin', () => {
  const dirs: string[] = [];
  const project = (envFile?: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-'));
    dirs.push(dir);
    if (envFile !== undefined) fs.writeFileSync(path.join(dir, '.env'), envFile);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to docker', () => {
    expect(containerRuntimeBin({}, project())).toBe('docker');
  });

  it('follows .env when the environment says nothing', () => {
    expect(containerRuntimeBin({}, project('CONTAINER_RUNTIME=container\n'))).toBe('container');
  });

  it('lets the environment win over .env', () => {
    expect(containerRuntimeBin({ CONTAINER_RUNTIME: 'podman' }, project('CONTAINER_RUNTIME=container\n'))).toBe(
      'podman',
    );
  });
});
