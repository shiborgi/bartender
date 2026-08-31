import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppleContainerSessionDriver,
  appleStatePhase,
  parseContainerRecords,
  recordLabels,
  recordName,
} from './apple-container-driver.js';
import { FakeCli } from './fake-cli.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import { DNS_GENERATION_LABEL, LABELS, type SessionEvent } from './types.js';
import { appleNetworkGateway, appleNetworkIsInternal } from '../egress-lockdown.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

import fs from 'fs';

import { log } from '../log.js';

let cli: FakeCli;

function driver(): AppleContainerSessionDriver {
  return new AppleContainerSessionDriver({ ...FIXTURE_POLICY, cli });
}

function networkDriver(): AppleContainerSessionDriver {
  return new AppleContainerSessionDriver({
    ...FIXTURE_POLICY,
    cli,
    networkArgsFor: () => [
      '--network',
      'nanoclaw-egress',
      '--mount',
      'type=bind,source=/tmp/hosts,target=/etc/hosts,readonly',
    ],
  });
}

function createArgs(): string[] {
  const call = cli.callMatching(/^create /);
  expect(call, 'expected a `container create` call').toBeDefined();
  return call!.args;
}

beforeEach(() => {
  vi.clearAllMocks();
  cli = new FakeCli('container');
  cli.responses = [{ match: /^inspect /, output: '[]' }];
});

describe('Apple Container argv', () => {
  it('emits bind mounts, standard hardening, and runAs without faking pidsLimit', async () => {
    await driver().prepare(fixtureSpec());
    const args = createArgs();
    const joined = args.join(' ');

    expect(args.slice(0, 4)).toEqual(['create', '--rm', '--name', 'ncl-spike-s1']);
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--init');
    expect(joined).not.toContain('--pids-limit');
    expect(joined).not.toContain('security-opt');
    expect(joined).toContain('--user 501:1000');
    expect(joined).toContain('--uid 501');
    expect(joined).toContain('--gid 1000');
    expect(joined).toContain('--shm-size 1024m');
    expect(args).toContain('type=bind,source=/install/data/v2-sessions/g1/s1,target=/workspace');
    expect(args).toContain('type=bind,source=/install/container/CLAUDE.md,target=/app/CLAUDE.md,readonly');
    expect(cli.bin).toBe('container');
  });

  it('uses the injected network seam without invoking Docker', async () => {
    await networkDriver().prepare(fixtureSpec());
    const args = createArgs();
    expect(args).toContain('--network');
    expect(args).toContain('nanoclaw-egress');
    expect(args).toContain('type=bind,source=/tmp/hosts,target=/etc/hosts,readonly');
    expect(cli.calls.some((call) => call.args[0] === 'network' && cli.bin === 'docker')).toBe(false);
  });

  it('refuses a missing mount source before create', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'spec-invalid', retryable: false });
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });
});

describe('runtime-unavailable', () => {
  it('maps a missing CLI to runtime-unavailable during prepare', async () => {
    cli.responses = [
      { match: /^inspect /, throws: Object.assign(new Error('spawnSync container ENOENT'), { code: 'ENOENT' }) },
    ];
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({
      kind: 'runtime-unavailable',
      retryable: true,
    });
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });

  it('maps a stopped container system in ensureReady to runtime-unavailable', async () => {
    cli.responses = [
      { match: /^system status/, throws: new Error('apiserver is not running and not registered with launchd') },
    ];
    await expect(driver().ensureReady()).rejects.toMatchObject({
      kind: 'runtime-unavailable',
      retryable: true,
    });
  });
});

describe('JSON parse', () => {
  it('extracts the IPv4 gateway from Apple network inspect JSON', () => {
    expect(
      appleNetworkGateway(JSON.stringify({ configuration: { ipv4Gateway: '192.168.64.1', subnet: '192.168.64.0/24' } })),
    ).toBe('192.168.64.1');
    expect(appleNetworkGateway('{"gateway":"not-an-ip"}')).toBeNull();
  });
  it('requires an explicit internal or host-only marker in Apple network inspect JSON', () => {
    expect(appleNetworkIsInternal(JSON.stringify({ configuration: { ipv4Gateway: '192.168.64.1' } }))).toBe(false);
    expect(appleNetworkIsInternal(JSON.stringify({ configuration: { internal: true } }))).toBe(true);
    expect(appleNetworkIsInternal(JSON.stringify({ configuration: { mode: 'host-only' } }))).toBe(true);
    expect(appleNetworkIsInternal(JSON.stringify({ configuration: { internal: 'true' } }))).toBe(false);
  });
  it('reads labels and name from configuration-shaped inspect/list documents', () => {
    const records = parseContainerRecords(
      JSON.stringify([
        {
          status: 'running',
          configuration: {
            id: 'ncl-spike-s1',
            labels: {
              [LABELS.install]: 'spike',
              [LABELS.group]: 'g1',
              [LABELS.session]: 's1',
              [LABELS.role]: 'agent',
            },
          },
        },
      ]),
    );
    expect(recordName(records[0])).toBe('ncl-spike-s1');
    expect(recordLabels(records[0])[LABELS.session]).toBe('s1');
    expect(appleStatePhase('created')).toBe('starting');
    expect(appleStatePhase('exited')).toBe('terminal');
  });

  it('adopts listed agent sessions from labels and ignores other installs', async () => {
    cli.responses = [
      {
        match: /^list /,
        output: JSON.stringify([
          {
            name: 'ncl-spike-s1',
            status: 'running',
            labels: {
              [LABELS.install]: 'spike',
              [LABELS.group]: 'g1',
              [LABELS.session]: 's1',
              [LABELS.role]: 'agent',
            },
          },
          {
            name: 'ncl-other-s9',
            status: 'running',
            labels: {
              [LABELS.install]: 'other',
              [LABELS.group]: 'g9',
              [LABELS.session]: 's9',
              [LABELS.role]: 'agent',
            },
          },
        ]),
      },
    ];
    const snapshots = await driver().listSessions('spike');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].handle.key).toEqual({ installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' });
    expect(snapshots[0].phase).toBe('running');
    expect(cli.callMatching(/^list /)?.args).toEqual(['list', '--all', '--format', 'json']);
  });

  it('refuses a name collision with a container that is not this session', async () => {
    cli.responses = [
      {
        match: /^inspect /,
        output: JSON.stringify({
          labels: { [LABELS.install]: 'other-install', [LABELS.group]: 'g9', [LABELS.session]: 's1' },
        }),
      },
    ];
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'unknown', retryable: false });
    expect(cli.callMatching(/^create /)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Container name collision: existing container is not this session',
      expect.objectContaining({ containerName: 'ncl-spike-s1' }),
    );
  });
});

describe('watchSessions', () => {
  it('polls list --all --format json and emits a terminal hint when a listed session vanishes', async () => {
    vi.useFakeTimers();
    try {
      const d = driver();
      cli.responses = [
        {
          match: /^list /,
          output: JSON.stringify([
            {
              name: 'ncl-spike-s1',
              status: 'running',
              labels: {
                [LABELS.install]: 'spike',
                [LABELS.group]: 'g1',
                [LABELS.session]: 's1',
                [LABELS.role]: 'agent',
              },
            },
          ]),
        },
      ];
      const seen: SessionEvent[] = [];
      const watch = d.watchSessions('spike', (event) => seen.push(event));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([{ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'phase' }]);

      cli.responses = [{ match: /^list /, output: '[]' }];
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toContainEqual({
        key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
        kind: 'terminal',
      });
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DNS generation stamping and adoption', () => {
  it('stamps the dns-generation label on the create argv', async () => {
    const spec = fixtureSpec({ labels: { ...fixtureSpec().labels, [DNS_GENERATION_LABEL]: 'generation-1' } });
    await driver().prepare(spec);
    const args = createArgs();
    expect(args).toContain(`--label`);
    expect(args).toContain(`${DNS_GENERATION_LABEL}=generation-1`);
  });

  it('does not adopt a session whose stamped generation differs from the current document', async () => {
    cli.responses = [
      {
        match: /^inspect /,
        output: JSON.stringify({
          labels: {
            [LABELS.install]: 'spike',
            [LABELS.group]: 'g1',
            [LABELS.session]: 's1',
            [DNS_GENERATION_LABEL]: 'generation-old',
          },
        }),
      },
    ];
    const spec = fixtureSpec({ labels: { ...fixtureSpec().labels, [DNS_GENERATION_LABEL]: 'generation-new' } });
    await driver().prepare(spec);
    // A stale session is recycled (stop + rm) and recreated, not adopted.
    expect(cli.callMatching(/^stop /)).toBeDefined();
    expect(cli.callMatching(/^rm /)).toBeDefined();
    expect(cli.callMatching(/^create /)).toBeDefined();
  });

  it('adopts a session whose stamped generation matches the current document', async () => {
    cli.responses = [
      {
        match: /^inspect /,
        output: JSON.stringify({
          labels: {
            [LABELS.install]: 'spike',
            [LABELS.group]: 'g1',
            [LABELS.session]: 's1',
            [DNS_GENERATION_LABEL]: 'generation-1',
          },
        }),
      },
    ];
    const spec = fixtureSpec({ labels: { ...fixtureSpec().labels, [DNS_GENERATION_LABEL]: 'generation-1' } });
    await driver().prepare(spec);
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });
});
