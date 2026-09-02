/**
 * Apple Container driver — SessionDriver realization over the local `container` CLI.
 *
 * Same seam as DockerSessionDriver: Cli injection, validateSpec, withSessionEvents.
 * Network topology for shared-private is WAVE-1.3; this driver realizes the session object.
 */
import fs from 'fs';

import { realCli, validateRuntimeName, type Cli, type SupervisedProcess } from './cli.js';
import { agentContainerName, assertMountSourcesExist, envArgs, labelArgs } from './docker-driver.js';
import { log } from '../log.js';
import {
  EGRESS_GENERATION_LABEL,
  LABELS,
  asFailureError,
  labelsForKey,
  specInvalid,
  validateSpec,
  type ContainerSpec,
  type DriverCapabilities,
  type MountPolicy,
  type MountSpec,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

const WATCH_INTERVAL_MS = 1_000;
const WATCH_MAX_BACKOFF_MS = 30_000;

export interface AppleContainerDriverOptions extends MountPolicy {
  cli?: Cli;
  /** Apple network topology, resolved by the runtime registration. */
  networkArgsFor?: (spec: SessionSpec) => string[];
}

interface AppleWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
  stopped: boolean;
}

interface ContainerRecord {
  name?: string;
  id?: string;
  status?: string;
  state?: string | { status?: string; exitCode?: number };
  labels?: Record<string, string>;
  configuration?: { id?: string; labels?: Record<string, string> };
  config?: { labels?: Record<string, string> };
}

export class AppleContainerSessionDriver implements SessionDriver {
  readonly kind = 'apple-container' as const;
  readonly #cli: Cli;
  readonly #policy: MountPolicy;
  readonly #networkArgs: ((spec: SessionSpec) => string[]) | undefined;
  readonly #watches = new Map<string, AppleWatch>();
  readonly #knownKeys = new Map<string, Map<string, SessionKey>>();
  readonly #listed = new Map<string, Set<string>>();

  constructor(opts: AppleContainerDriverOptions) {
    this.#cli = opts.cli ?? realCli('container');
    this.#policy = opts;
    this.#networkArgs = opts.networkArgsFor;
  }

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: ['pidsLimit'],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: true,
    };
  }

  async ensureReady(): Promise<void> {
    try {
      this.#cli.run(['system', 'status'], { timeoutMs: 10_000 });
    } catch (error) {
      throw normalizeAppleContainerError(error);
    }
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());
    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) {
      throw specInvalid(
        `apple-container driver does not manage container role '${extra[0].role}'; ` +
          `auxiliary containers require a driver with capabilities().auxiliaryContainers`,
      );
    }
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const name = validateRuntimeName(agentContainerName(spec), 'container');
    this.#remember(spec.key);

    if (this.#existingSession(name, spec)) {
      return new AppleContainerHandle(spec.key, name, this.#cli, null, this.#emit);
    }

    assertMountSourcesExist(agent.mounts);

    const args = ['create', '--rm', '--name', name];
    args.push(...labelArgs(labelsForKey(spec.key, 'agent', { ...spec.labels, ...(agent.labels ?? {}) })));
    args.push(...resourceArgs(spec));
    args.push(...hardeningArgs(agent));
    args.push(...(requiresEgressBootstrap(agent) ? ['--user', '0:0', '--uid', '0', '--gid', '0'] : userArgs(spec)));
    args.push(...envArgs(agent.env));
    args.push(...envArgs(agent.contributedEnv ?? {}));
    args.push(...mountArgs(agent.mounts));
    args.push(...(this.#networkArgsFor(spec) ?? []));
    if (agent.command && agent.command.length > 0) {
      args.push('--entrypoint', agent.command[0], agent.image, ...agent.command.slice(1), ...(agent.args ?? []));
    } else {
      args.push(agent.image, ...(agent.args ?? []));
    }

    try {
      this.#cli.run(args);
    } catch (error) {
      try {
        this.#cli.run(['rm', '--force', name]);
      } catch {
        /* prepare is atomic: allocate all or leave nothing */
      }
      throw normalizeAppleContainerError(error);
    }
    return new AppleContainerHandle(spec.key, name, this.#cli, spec, this.#emit);
  }

  #recycle(name: string): void {
    try {
      this.#cli.run(['stop', name]);
    } catch {
      /* already stopped */
    }
    try {
      this.#cli.run(['rm', '--force', name]);
    } catch {
      /* already gone */
    }
  }

  #networkArgsFor(spec: SessionSpec): string[] {
    if (spec.network === 'none') return ['--network', 'none'];
    return this.#networkArgs?.(spec) ?? [];
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    let output: string;
    try {
      output = this.#cli.run(['list', '--all', '--format', 'json']);
    } catch (error) {
      throw normalizeAppleContainerError(error);
    }
    const snapshots: SessionSnapshot[] = [];
    for (const record of parseContainerRecords(output)) {
      const labels = recordLabels(record);
      if (labels[LABELS.install] !== installSlug || labels[LABELS.role] !== 'agent') continue;
      const agentGroupId = labels[LABELS.group];
      const sessionId = labels[LABELS.session];
      if (!agentGroupId || !sessionId) continue;
      const name = recordName(record);
      if (!name) continue;
      const key: SessionKey = { installSlug, agentGroupId, sessionId };
      this.#remember(key);
      snapshots.push({
        handle: new AppleContainerHandle(key, validateRuntimeName(name, 'container'), this.#cli, null, this.#emit),
        phase: appleStatePhase(recordState(record)),
      });
    }
    return snapshots;
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      watch = { subscribers: new Set(), failures: 0, stopped: false };
      this.#watches.set(installSlug, watch);
      this.#schedulePoll(installSlug, watch, 0);
    }
    watch.subscribers.add(onEvent);
    return {
      stop: () => {
        watch.subscribers.delete(onEvent);
        if (watch.subscribers.size === 0) {
          watch.stopped = true;
          if (watch.timer) clearTimeout(watch.timer);
          if (this.#watches.get(installSlug) === watch) this.#watches.delete(installSlug);
        }
      },
    };
  }

  #schedulePoll(installSlug: string, watch: AppleWatch, delay: number): void {
    if (watch.stopped) return;
    watch.timer = setTimeout(() => void this.#poll(installSlug, watch), delay);
    watch.timer.unref?.();
  }

  async #poll(installSlug: string, watch: AppleWatch): Promise<void> {
    if (watch.stopped || this.#watches.get(installSlug) !== watch) return;
    try {
      const snapshots = await this.listSessions(installSlug);
      watch.failures = 0;
      const listed = new Set(snapshots.map((s) => keyId(s.handle.key)));
      const previous = this.#listed.get(installSlug) ?? new Set();
      this.#listed.set(installSlug, listed);
      for (const snapshot of snapshots) {
        this.#emit({
          key: snapshot.handle.key,
          kind:
            snapshot.phase === 'terminal' ? 'terminal' : previous.has(keyId(snapshot.handle.key)) ? 'hint' : 'phase',
        });
      }
      for (const [id, key] of this.#knownKeys.get(installSlug) ?? []) {
        if (!listed.has(id) && previous.has(id)) this.#emit({ key, kind: 'terminal' });
      }
    } catch {
      watch.failures += 1;
    }
    const delay = Math.min(WATCH_INTERVAL_MS * 2 ** watch.failures, WATCH_MAX_BACKOFF_MS);
    this.#schedulePoll(installSlug, watch, delay);
  }

  readonly #emit = (event: SessionEvent): void => {
    const watch = this.#watches.get(event.key.installSlug);
    if (!watch) return;
    for (const subscriber of watch.subscribers) subscriber(event);
  };

  #remember(key: SessionKey): void {
    let known = this.#knownKeys.get(key.installSlug);
    if (!known) {
      known = new Map();
      this.#knownKeys.set(key.installSlug, known);
    }
    known.set(keyId(key), key);
  }

  #existingSession(name: string, spec: SessionSpec): boolean {
    const key = spec.key;
    let record: ContainerRecord | null;
    try {
      record = inspectRecord(this.#cli, name);
    } catch (error) {
      if (isRuntimeUnavailable(error)) throw normalizeAppleContainerError(error);
      return false;
    }
    if (!record) return false;
    const labels = recordLabels(record);
    if (
      labels[LABELS.install] === key.installSlug &&
      labels[LABELS.group] === key.agentGroupId &&
      labels[LABELS.session] === key.sessionId
    ) {
      // A stale session (stamped generation differs from the current document)
      // must not be adopted; it is recycled instead.
      const currentGeneration = spec.labels[EGRESS_GENERATION_LABEL];
      if (currentGeneration && labels[EGRESS_GENERATION_LABEL] !== currentGeneration) {
        log.info('Session egress generation is stale; recycling', {
          containerName: name,
          stamped: labels[EGRESS_GENERATION_LABEL],
          current: currentGeneration,
        });
        this.#recycle(name);
        return false;
      }
      return true;
    }
    log.warn('Container name collision: existing container is not this session', {
      containerName: name,
      wanted: key,
      found: {
        install: labels[LABELS.install],
        group: labels[LABELS.group],
        session: labels[LABELS.session],
      },
    });
    throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
  }
}

class AppleContainerHandle implements SessionHandle {
  #proc: SupervisedProcess | null = null;
  #stopping = false;
  #attachExitCode: number | null | undefined;
  readonly #stderrTail: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly cli: Cli,
    private readonly pendingSpec: SessionSpec | null,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    if (this.#proc) return;
    const proc = this.cli.start(['start', '--attach', this.name]);
    this.#proc = proc;
    proc.onStderr((line) => {
      log.debug(line, { container: this.name });
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
    proc.onExit((code) => {
      this.#attachExitCode = code;
      if (!this.#stopping && code !== 0 && code !== null && this.#stderrTail.length > 0) {
        log.warn('Container exited non-zero', { containerName: this.name, code, stderrTail: this.#stderrTail });
      }
      this.emit({ key: this.key, kind: 'terminal' });
    });
  }

  async status(): Promise<SessionStatus> {
    let record: ContainerRecord | null;
    try {
      record = inspectRecord(this.cli, this.name);
    } catch (error) {
      if (isRuntimeUnavailable(error)) throw normalizeAppleContainerError(error);
      record = null;
    }
    if (!record) {
      if (!this.#stopping && typeof this.#attachExitCode === 'number' && this.#attachExitCode !== 0) {
        return {
          phase: 'failed',
          failure: { kind: 'started-then-died', retryable: false, exitCode: this.#attachExitCode },
        };
      }
      if (!this.#stopping && this.#proc && this.#attachExitCode === undefined) {
        return { phase: 'running' };
      }
      return this.pendingSpec && !this.#proc ? { phase: 'ready' } : { phase: 'stopped' };
    }
    const state = recordState(record);
    if (state === 'running') return { phase: 'running' };
    if (state === 'created') return { phase: 'ready' };
    const exit = recordStateExitCode(record);
    if (state === 'exited' && exit !== 0) {
      return { phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode: exit } };
    }
    return { phase: 'stopped' };
  }

  async stop(reason: string): Promise<void> {
    this.#stopping = true;
    log.info('Stopping session container', { containerName: this.name, reason });
    const grace = String(this.pendingSpec?.stopGraceSeconds ?? 1);
    try {
      this.cli.run(['stop', '-t', grace, this.name]);
    } catch {
      this.#proc?.kill();
    }
    try {
      this.cli.run(['rm', '--force', this.name]);
    } catch {
      /* `--rm` usually got there first */
    }
  }

  execSpec(command: string[]): SessionExecSpec {
    const runAs = this.pendingSpec?.runAs ?? { uid: 1000, gid: 1000 };
    const identity = `${runAs.uid}:${runAs.gid}`;
    return {
      bin: 'container',
      // Apple exec otherwise defaults to root. The session init process has
      // already dropped privileges, but diagnostics must not reintroduce them.
      argsTty: ['exec', '-it', '--user', identity, this.name, ...command],
      argsPlain: ['exec', '-i', '--user', identity, this.name, ...command],
    };
  }
}

function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

function inspectRecord(cli: Cli, name: string): ContainerRecord | null {
  const output = cli.run(['inspect', name]);
  return parseContainerRecords(output)[0] ?? null;
}

export function parseContainerRecords(output: string): ContainerRecord[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as ContainerRecord[]) : [parsed as ContainerRecord];
  } catch {
    return trimmed
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ContainerRecord];
        } catch {
          return [];
        }
      });
  }
}

export function recordLabels(record: ContainerRecord): Record<string, string> {
  return record.labels ?? record.configuration?.labels ?? record.config?.labels ?? {};
}

export function recordName(record: ContainerRecord): string {
  return record.name ?? record.id ?? record.configuration?.id ?? '';
}

export function recordState(record: ContainerRecord): string {
  const state = typeof record.state === 'object' ? record.state?.status : record.state;
  return String(record.status ?? state ?? '').toLowerCase();
}

function recordStateExitCode(record: ContainerRecord): number {
  return typeof record.state === 'object' && typeof record.state?.exitCode === 'number' ? record.state.exitCode : 0;
}

export function appleStatePhase(state: string): SessionPhase {
  if (state === 'running' || state === 'paused' || state === 'restarting') return 'running';
  if (state === 'created' || state === 'starting') return 'starting';
  return 'terminal';
}

export function requiresEgressBootstrap(agent: ContainerSpec): boolean {
  return agent.contributedEnv?.NANOCLAW_EGRESS_LOCKDOWN === 'barback-v1';
}

export function hardeningArgs(agent?: ContainerSpec): string[] {
  if (agent && requiresEgressBootstrap(agent)) {
    return ['--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--init'];
  }
  return ['--cap-drop', 'ALL', '--init'];
}

export function resourceArgs(spec: SessionSpec): string[] {
  const args: string[] = [];
  if (spec.resources.cpus) args.push('--cpus', spec.resources.cpus);
  if (spec.resources.memoryMb) args.push('--memory', `${spec.resources.memoryMb}m`);
  if (spec.resources.shmSizeMb) args.push('--shm-size', `${spec.resources.shmSizeMb}m`);
  return args;
}

export function userArgs(spec: SessionSpec): string[] {
  if (!spec.runAs) return [];
  return [
    '--user',
    `${spec.runAs.uid}:${spec.runAs.gid}`,
    '--uid',
    String(spec.runAs.uid),
    '--gid',
    String(spec.runAs.gid),
  ];
}

function isDirectoryMount(hostPath: string): boolean {
  try {
    return fs.statSync(hostPath).isDirectory();
  } catch {
    return false;
  }
}

function coveredByDirectoryMount(containerPath: string, directoryMounts: readonly MountSpec[]): boolean {
  return directoryMounts.some((parent) => {
    const prefix = parent.containerPath.endsWith('/') ? parent.containerPath : `${parent.containerPath}/`;
    return containerPath.startsWith(prefix);
  });
}

export function mountArgs(mounts: readonly MountSpec[]): string[] {
  const directoryMounts = mounts.filter((m) => isDirectoryMount(m.hostPath));
  const args: string[] = [];
  for (const m of directoryMounts) {
    args.push(
      '--mount',
      `type=bind,source=${m.hostPath},target=${m.containerPath}${m.mode === 'ro' ? ',readonly' : ''}`,
    );
  }
  for (const m of mounts) {
    if (isDirectoryMount(m.hostPath)) continue;
    // Apple virtiofs bind-mounts directories only. A file already visible
    // through a parent directory mount can still be marked read-only.
    if (m.mode === 'ro' && coveredByDirectoryMount(m.containerPath, directoryMounts)) {
      args.push('--read-only-path', m.containerPath);
      continue;
    }
    log.warn('Skipping Apple file bind; virtiofs requires a directory', {
      hostPath: m.hostPath,
      containerPath: m.containerPath,
    });
  }
  return args;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
  return '';
}

export function isRuntimeUnavailable(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    errorCode(error) === 'ENOENT' ||
    /ENOENT|no such file|container system.*(not running|stopped)|system is not running|apiserver is not running|Ensure container system service has been started|daemon is not running|XPC connection error/i.test(
      message,
    )
  );
}

export function normalizeAppleContainerError(error: unknown): Error & SessionFailure {
  const message = errorMessage(error);
  if (isRuntimeUnavailable(error)) {
    return asFailureError({ kind: 'runtime-unavailable', retryable: true });
  }
  if (/manifest unknown|pull access denied|not found: manifest|No such image|image.*not found/i.test(message)) {
    return asFailureError({ kind: 'image-unavailable', retryable: true });
  }
  if (/no space left|cannot allocate memory/i.test(message)) {
    return asFailureError({ kind: 'resources-exhausted', retryable: true });
  }
  // Preserve the CLI's stderr in the error message. The opaque reference alone
  // makes Apple Container realization failures impossible to diagnose.
  const failure = asFailureError({
    kind: 'unknown',
    retryable: false,
    opaqueRef: `apple-container-${Date.now()}`,
  });
  failure.message = `${failure.message}: ${message}`;
  return failure;
}
