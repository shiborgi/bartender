/**
 * Install or refresh the custom gateway for this copy.
 *
 * 1. Ensure the install secret the client keys are derived from.
 * 2. Scaffold the policy and secrets files from the examples, once.
 * 3. Build the gateway image from this skill's `service/`.
 * 4. Remove the running gateway, so the next session starts it on the new image.
 *
 * The image is built here and never on the spawn path: a session that would
 * have to wait for an image build is a session that times out.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { upsertEnvVar } from '../../../../setup/set-env.js';
import { envValue } from '../../../../src/env.js';
import { gatewayRuntime, removeGateway } from '../../../../src/gateway-providers/custom-gateway-container.js';
import {
  GATEWAY_SECRET_ENV,
  generateGatewaySecret,
} from '../../../../src/gateway-providers/custom-gateway-identity.js';
import { configPaths } from './config-files.js';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function ensureInstallSecret(root = process.cwd()): 'kept' | 'created' {
  if (envValue(GATEWAY_SECRET_ENV, root)?.trim()) return 'kept';
  upsertEnvVar(GATEWAY_SECRET_ENV, generateGatewaySecret(), root);
  return 'created';
}

/** Never overwrites: these files are the operator's once they exist. */
export function scaffoldConfig(root = process.cwd(), skillDir = SKILL_DIR): string[] {
  const { dir, policy, secrets } = configPaths(root);
  fs.mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  const examples = path.join(skillDir, 'service', 'config');
  if (!fs.existsSync(policy)) {
    fs.copyFileSync(path.join(examples, 'gateway.example.json'), policy);
    created.push(policy);
  }
  if (!fs.existsSync(secrets)) {
    fs.copyFileSync(path.join(examples, 'secrets.example.env'), secrets);
    created.push(secrets);
  }
  fs.chmodSync(secrets, 0o600);
  return created;
}

async function main(): Promise<void> {
  const root = process.cwd();
  console.log(`install secret: ${ensureInstallSecret(root)}`);
  for (const file of scaffoldConfig(root)) console.log(`created ${path.relative(root, file)}`);

  const rt = gatewayRuntime(root);
  console.log(`building ${rt.image} with ${rt.bin}`);
  // The same runtime flags as the agent image build: on Apple Container a
  // build without them resizes, and so recreates, the shared builder VM.
  const options = envValue('CONTAINER_BUILD_OPTIONS', root)?.split(/\s+/).filter(Boolean) ?? [];
  execFileSync(rt.bin, ['build', ...options, '-t', rt.image, path.join(SKILL_DIR, 'service')], { stdio: 'inherit' });
  await removeGateway(rt);
  console.log(`${rt.name} will start on the new image with the next session.`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
