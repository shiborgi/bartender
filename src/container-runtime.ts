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
 * Docker for something that is not a session: per-group image builds and the
 * egress lockdown network.
 */

import { readEnvFile } from './env.js';

/**
 * The container runtime binary: `CONTAINER_RUNTIME` from the environment, then
 * from `.env`, else Docker. The service manager starts the host without `.env`
 * in its environment, so an install on another runtime (Apple `container`,
 * added by its driver skill) records the choice in `.env`, and image builds
 * follow it instead of shelling a Docker binary that may not be there.
 */
export function containerRuntimeBin(env: NodeJS.ProcessEnv = process.env, projectRoot?: string): string {
  return (
    env.CONTAINER_RUNTIME?.trim() ||
    readEnvFile(['CONTAINER_RUNTIME'], projectRoot).CONTAINER_RUNTIME?.trim() ||
    'docker'
  );
}

/** The container runtime binary name, resolved once at startup. */
export const CONTAINER_RUNTIME_BIN = containerRuntimeBin();
