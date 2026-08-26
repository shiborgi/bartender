import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { getProviderContainerConfig } from './provider-container-registry.js';
import './index.js';

const HOST_OPENCODE_ENV = {
  OPENCODE_PROVIDER: 'openrouter',
  OPENCODE_MODEL: 'openrouter/anthropic/claude-sonnet-4',
  OPENCODE_SMALL_MODEL: 'openrouter/anthropic/claude-haiku-4.5',
  ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENCODE_MODEL_CONTEXT_LIMIT: '200000',
  OPENCODE_MODEL_OUTPUT_LIMIT: '8192',
  OPENCODE_MODEL_INPUT_MODALITIES: 'text,image,pdf',
};

describe('opencode host contribution', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('passes OPENCODE_* from hostEnv, mounts /opencode-xdg, and does not require Claude', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-contrib-'));
    dirs.push(sessionDir);

    const fn = getProviderContainerConfig('opencode');
    expect(fn).toBeTypeOf('function');

    const contribution = await fn!({
      sessionDir,
      agentGroupId: 'ag-test',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: { ...HOST_OPENCODE_ENV },
    });

    expect(contribution.env).toMatchObject(HOST_OPENCODE_ENV);
    expect(contribution.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(contribution.mounts).toEqual([
      {
        hostPath: path.join(sessionDir, 'opencode-xdg'),
        containerPath: '/opencode-xdg',
        readonly: false,
      },
    ]);
    expect(fs.existsSync(path.join(sessionDir, 'opencode-xdg'))).toBe(true);
  });
});
