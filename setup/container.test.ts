import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { configuredDriverKind } from '../src/drivers/index.js';
import { isKnownSetupRuntime, parseRuntime } from './container.js';

describe('setup container runtime', () => {
  it('accepts apple-container and docker', () => {
    expect(isKnownSetupRuntime('apple-container')).toBe(true);
    expect(isKnownSetupRuntime('docker')).toBe(true);
  });

  it('rejects unknown kinds as unknown_runtime', () => {
    expect(isKnownSetupRuntime('vm')).toBe(false);
    expect(isKnownSetupRuntime('firecracker')).toBe(false);
    expect(isKnownSetupRuntime('container')).toBe(false);
  });

  it('defaults --runtime to the configured driver kind', () => {
    expect(parseRuntime([])).toBe(configuredDriverKind());
    expect(parseRuntime(['--runtime', 'apple-container'])).toBe('apple-container');
    expect(parseRuntime(['--runtime', 'docker'])).toBe('docker');
  });

  it('starts container system for apple-container instead of Docker Desktop', () => {
    const src = fs.readFileSync(new URL('./container.ts', import.meta.url), 'utf8');
    const start = src.indexOf("runtime === 'apple-container'");
    expect(start).toBeGreaterThan(-1);
    const appleBranch = src.slice(start, src.indexOf('} else {', start));
    expect(appleBranch).toContain('tryStartContainerSystem');
    expect(appleBranch).toContain('containerSystemStatus');
    expect(appleBranch).not.toMatch(/open -a Docker/);
    expect(appleBranch).not.toMatch(/docker\.sock/);
    expect(appleBranch).not.toMatch(/usermod -aG docker/);
    expect(src).toContain("['system', 'status']");
    expect(src).toContain('container system start');
  });
});

describe('shell runtimeBin mapping', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const helper = path.join(repoRoot, 'setup', 'lib', 'runtime-bin.sh');

  it('matches runtimeBin() for apple-container and docker', () => {
    const run = (kind: string): string =>
      execFileSync(
        'bash',
        [
          '-c',
          `PROJECT_ROOT=${JSON.stringify(repoRoot)}; source "$PROJECT_ROOT/setup/lib/runtime-bin.sh"; runtime_bin`,
        ],
        { encoding: 'utf-8', env: { ...process.env, NANOCLAW_RUNTIME_DRIVER: kind } },
      ).trim();

    expect(run('apple-container')).toBe('container');
    expect(run('docker')).toBe('docker');
  });

  it('is the default CONTAINER_RUNTIME in build.sh and pull.sh', () => {
    const build = fs.readFileSync(path.join(repoRoot, 'container', 'build.sh'), 'utf8');
    const pull = fs.readFileSync(path.join(repoRoot, 'container', 'pull.sh'), 'utf8');
    expect(build).toContain('setup/lib/runtime-bin.sh');
    expect(pull).toContain('setup/lib/runtime-bin.sh');
    expect(build).toMatch(/CONTAINER_RUNTIME="\$\{CONTAINER_RUNTIME:-\$\(runtime_bin\)\}"/);
    expect(pull).toMatch(/CONTAINER_RUNTIME="\$\{CONTAINER_RUNTIME:-\$\(runtime_bin\)\}"/);
    expect(fs.existsSync(helper)).toBe(true);
  });
});
