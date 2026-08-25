/**
 * Driver selection, the registry it resolves through, and the settings it reads.
 *
 * The host service has no `EnvironmentFile=`; it parses `.env` in-process. A
 * setting that consulted only `process.env` would be silently ignored in the
 * file where every other NanoClaw setting lives — and for the driver selection,
 * being ignored means silently running the wrong runtime.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  configuredDriverKind,
  createSessionDriver,
  getSessionDriver,
  mountPolicy,
  readSetting,
  resetSessionDriver,
  runtimeBin,
} from './index.js';
// Imported from the registry module, not the barrel that re-exports it: this is
// the entry point an overlay reaches for, and it has to work without the
// selection module having been evaluated first.
import { listSessionDriverKinds, registerSessionDriver } from './driver-registry.js';
import { log } from '../log.js';
import type { MountPolicy, SessionDriver } from './types.js';

let cwd: string;
let previous: string;
let uniqueKind = 0;

function writeEnv(contents: string): void {
  fs.writeFileSync(path.join(cwd, '.env'), contents);
}

/**
 * Registration is permanent by design (a duplicate is a wiring bug, so there is
 * no unregister to reach for). Each case therefore claims a kind of its own.
 */
function registerFake(seen: MountPolicy[] = []): { kind: string; seen: MountPolicy[] } {
  const kind = `fake-${++uniqueKind}`;
  registerSessionDriver(kind, (policy) => {
    seen.push(policy);
    return {
      kind,
      capabilities: () => ({
        isolationTiers: ['container'],
        admissionEnforced: false,
        networkPolicy: 'topology',
        encryptedVolumes: false,
        unrealized: [],
        sharedNetworkNamespace: false,
        auxiliaryContainers: false,
        imageBuild: false,
      }),
      prepare: () => Promise.reject(new Error('not under test')),
      listSessions: () => Promise.resolve([]),
      watchSessions: () => ({ stop: () => {} }),
    } satisfies SessionDriver;
  });
  return { kind, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  previous = process.cwd();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-driver-env-'));
  process.chdir(cwd);
});

afterEach(() => {
  resetSessionDriver(null);
  process.chdir(previous);
});

describe('configuredDriverKind', () => {
  it('defaults to apple-container on Apple Silicon macOS', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(os, 'arch').mockReturnValue('arm64');
    expect(configuredDriverKind({})).toBe('apple-container');
  });

  it('defaults to docker outside Apple Silicon macOS', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(os, 'arch').mockReturnValue('x64');
    expect(configuredDriverKind({})).toBe('docker');
  });

  it('reads the selection from .env, not only from the process environment', () => {
    writeEnv('NANOCLAW_RUNTIME_DRIVER=vm\n');
    expect(configuredDriverKind({})).toBe('vm');
  });

  it('lets the process environment win over .env', () => {
    writeEnv('NANOCLAW_RUNTIME_DRIVER=vm\n');
    expect(configuredDriverKind({ NANOCLAW_RUNTIME_DRIVER: 'docker' })).toBe('docker');
  });

  it('reports the configured value verbatim instead of correcting it', () => {
    // Selection does not decide what is legitimate; the registry does. Anything
    // that "corrects" a value here is a silent fallback wearing a hat.
    expect(configuredDriverKind({ NANOCLAW_RUNTIME_DRIVER: 'firecracker' })).toBe('firecracker');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('runtimeBin', () => {
  it('maps apple-container to container and docker to docker', () => {
    expect(runtimeBin({ NANOCLAW_RUNTIME_DRIVER: 'apple-container' })).toBe('container');
    expect(runtimeBin({ NANOCLAW_RUNTIME_DRIVER: 'docker' })).toBe('docker');
  });

  it('follows the configured driver default', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(os, 'arch').mockReturnValue('arm64');
    expect(runtimeBin({})).toBe('container');
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(os, 'arch').mockReturnValue('x64');
    expect(runtimeBin({})).toBe('docker');
  });

  it('points leftover shells at the same mapping and is not a session selector', async () => {
    const { CONTAINER_RUNTIME_BIN } = await import('../container-runtime.js');
    expect(CONTAINER_RUNTIME_BIN({ NANOCLAW_RUNTIME_DRIVER: 'apple-container' })).toBe('container');
    expect(CONTAINER_RUNTIME_BIN({ NANOCLAW_RUNTIME_DRIVER: 'docker' })).toBe('docker');
    const src = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/CONTAINER_RUNTIME_BIN/);
    expect(src).not.toMatch(/container-runtime/);
  });
});

describe('createSessionDriver', () => {
  it('builds the docker driver by default, and it is pre-registered', () => {
    expect(listSessionDriverKinds()).toContain('docker');
    expect(createSessionDriver('docker').kind).toBe('docker');
  });

  it('builds the registered Apple Container driver and preserves the Docker override', () => {
    expect(listSessionDriverKinds()).toContain('apple-container');
    expect(createSessionDriver('apple-container').kind).toBe('apple-container');
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(os, 'arch').mockReturnValue('arm64');
    expect(configuredDriverKind({ NANOCLAW_RUNTIME_DRIVER: 'docker' })).toBe('docker');
    expect(createSessionDriver('docker').kind).toBe('docker');
  });

  it('refuses a kind no driver is registered for, naming the setting, the value and what is installed', () => {
    // The message is the entire remediation an operator gets. Asserting its
    // shape — not just that something threw — is what keeps it actionable. The
    // `[^\n]*` anchoring is the point: all three facts must be in the FIRST
    // line, because that is the line a log aggregator shows.
    const selecting = (): unknown => createSessionDriver('vm');
    expect(selecting).toThrow(/^[^\n]*NANOCLAW_RUNTIME_DRIVER[^\n]*'vm'[^\n]*installed: /);
    // The list is what the registry actually holds, not a literal: an overlay
    // adds kinds, and a test that hard-coded `docker` would fail on a tree
    // where the message is doing its job.
    expect(selecting).toThrow(`installed: ${listSessionDriverKinds().join(', ')}`);
    expect(selecting).toThrow(/install the driver skill or unset the variable/);
  });

  it('refuses a typo exactly as it refuses an uninstalled driver', () => {
    // `=dcoker` silently running docker is the same failure as `=vm` silently
    // running docker: a host configured for one runtime running another.
    const selecting = (): unknown => createSessionDriver('dcoker');
    expect(selecting).toThrow(/^[^\n]*NANOCLAW_RUNTIME_DRIVER[^\n]*'dcoker'[^\n]*installed: /);
    expect(selecting).toThrow(`installed: ${listSessionDriverKinds().join(', ')}`);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('resolves a kind once a driver registers it, and hands it the resolved policy', () => {
    const { kind, seen } = registerFake();
    const driver = createSessionDriver(kind, { materialsRoot: '/srv/override' });
    expect(driver.kind).toBe(kind);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.materialsRoot).toBe('/srv/override');
    expect(seen[0]?.surfaceRoots).toHaveLength(3);
  });

  it('resolves a driver registered through the registry module alone', () => {
    // What an overlay does: import the registry, register at module scope, and
    // never touch selection. If that only worked when `index.js` had already
    // been evaluated, the appended-import install shape would be a startup
    // crash on the one path nobody exercises until an overlay exists.
    const { kind } = registerFake();
    expect(listSessionDriverKinds()).toContain(kind);
    expect(createSessionDriver(kind).kind).toBe(kind);
  });

  it('refuses to let two registrations claim one kind', () => {
    const { kind } = registerFake();
    expect(() => registerSessionDriver(kind, () => createSessionDriver('docker'))).toThrow(/already registered/);
  });

  it('logs the boot marker an operator uses to tell a crash loop from a healthy start', () => {
    // Under `Restart=always`, `systemctl is-active` says `active` all through a
    // crash loop. Absent marker + active unit = selection is throwing.
    createSessionDriver('docker');
    expect(log.info).toHaveBeenCalledWith(
      'Session runtime driver selected',
      expect.objectContaining({ driver: 'docker' }),
    );
  });
});

describe('getSessionDriver', () => {
  it('builds the configured kind through the registry and memoizes it', () => {
    const { kind } = registerFake();
    process.env.NANOCLAW_RUNTIME_DRIVER = kind;
    try {
      resetSessionDriver(null);
      const first = getSessionDriver();
      expect(first.kind).toBe(kind);
      expect(getSessionDriver()).toBe(first);
    } finally {
      delete process.env.NANOCLAW_RUNTIME_DRIVER;
    }
  });

  it('returns the apple-container realization on darwin/arm64 when unset', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(os, 'arch').mockReturnValue('arm64');
    delete process.env.NANOCLAW_RUNTIME_DRIVER;
    resetSessionDriver(null);
    expect(getSessionDriver().kind).toBe('apple-container');
  });

  it('honours the reset seam so a suite can install its own driver', () => {
    const { kind } = registerFake();
    const standIn = createSessionDriver(kind);
    resetSessionDriver(standIn);
    expect(getSessionDriver()).toBe(standIn);
    resetSessionDriver(null);
    expect(getSessionDriver().kind).toBe(configuredDriverKind());
  });

  it('does not import container-runtime for kind selection', () => {
    const src = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/container-runtime/);
  });
});

describe('mountPolicy', () => {
  it('pins materialsRoot to the .env value the provisioner also reads', () => {
    // The provisioner reads this key from .env. If the two resolve differently,
    // every identity-material mount is denied by a policy naming a path that
    // looks correct.
    writeEnv('NANOCLAW_SESSION_MATERIAL_ROOT=/srv/materials\n');
    expect(mountPolicy({}).materialsRoot).toBe('/srv/materials');
  });

  it('enumerates surface roots instead of trusting an install-root prefix', () => {
    // The state roots nest inside the project root, so a prefix check would
    // admit the central DB as a mountable "surface".
    const policy = mountPolicy({});
    expect(policy.surfaceRoots).toHaveLength(3);
    expect(policy.surfaceRoots.every((root) => root.includes(`${path.sep}container${path.sep}`))).toBe(true);
    expect(policy.surfaceRoots.some((root) => root === policy.dataRoot)).toBe(false);
  });
});

describe('readSetting', () => {
  it('trims and treats blank as unset', () => {
    writeEnv('NANOCLAW_SESSION_MATERIAL_ROOT=   \n');
    expect(readSetting('NANOCLAW_SESSION_MATERIAL_ROOT', {})).toBe('');
  });
});
