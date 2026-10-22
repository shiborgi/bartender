import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];
const absent = new Set<string>();

vi.mock('child_process', () => ({
  execFile: (
    _bin: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push(args);
    const key = args.join(' ');
    if ([...absent].some((prefix) => key.startsWith(prefix))) cb(new Error('not found'));
    else cb(null, { stdout: key.startsWith('inspect') ? '[{"status":"stopped"}]' : '', stderr: '' });
  },
}));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  GatewayImageMissingError,
  ensureGatewayRunning,
  probeGatewayHealth,
  type GatewayRuntime,
} from './custom-gateway-container.js';

const RT: GatewayRuntime = {
  bin: 'container',
  slug: 'abc12345',
  name: 'nanoclaw-gateway-v2-abc12345',
  image: 'nanoclaw-custom-gateway-abc12345:latest',
  egressNetwork: 'nanoclaw-egress-v2-abc12345',
  configDir: '/srv/config',
};

beforeEach(() => {
  calls.length = 0;
  absent.clear();
});

describe('ensureGatewayRunning', () => {
  /*
   * Apple Container's bare `inspect` looks up containers only, so asking it
   * about an image reports a built image as missing and every session fails.
   */
  it('looks the image up with `image inspect`, the spelling both runtimes share', async () => {
    absent.add('image inspect');
    await expect(ensureGatewayRunning(RT, 'secret')).rejects.toBeInstanceOf(GatewayImageMissingError);
    expect(calls).toContainEqual(['image', 'inspect', RT.image]);
    expect(calls.some((args) => args[0] === 'inspect' && args[1] === RT.image)).toBe(false);
  });

  it('replaces a stopped gateway once the image is there', async () => {
    await ensureGatewayRunning(RT, 'secret').catch(() => undefined);
    expect(calls).toContainEqual(['rm', '--force', RT.name]);
    expect(calls.some((args) => args[0] === 'run' && args.includes(RT.image))).toBe(true);
  });
});

describe('probeGatewayHealth', () => {
  /*
   * From the host, a request to a container address is subject to macOS Local
   * Network privacy and fails EHOSTUNREACH from Node. The probe asks the
   * container about itself through the runtime instead.
   */
  it('asks the gateway about itself through the runtime, never over the network', async () => {
    await probeGatewayHealth(RT);
    expect(calls).toEqual([['exec', RT.name, 'wget', '-qO-', 'http://127.0.0.1:8080/health/live']]);
  });
});
