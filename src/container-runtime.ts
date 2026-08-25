/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell
 * the runtime for something that is not a session: per-group image builds and
 * the egress lockdown network. Not a session selector.
 */
import { runtimeBin } from './drivers/index.js';

/** The leftover-shell CLI. Resolved from the selected driver; not a session selector. */
export function CONTAINER_RUNTIME_BIN(env?: NodeJS.ProcessEnv): string {
  return runtimeBin(env);
}
