/**
 * The skill's one reach-in is an appended import in `installed.ts`; this
 * exercises it through the real selection module, so a barrel that lost the
 * line, or a registration under another kind, fails here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { configuredDriverKind, createSessionDriver } from './index.js';
import { listSessionDriverKinds } from './driver-registry.js';

describe('apple-container registration', () => {
  it('registers through the installed barrel', () => {
    expect(listSessionDriverKinds()).toContain('apple-container');
  });

  it('is selected by NANOCLAW_RUNTIME_DRIVER', () => {
    const kind = configuredDriverKind({ NANOCLAW_RUNTIME_DRIVER: 'apple-container' } as NodeJS.ProcessEnv);
    expect(kind).toBe('apple-container');
    const driver = createSessionDriver(kind);
    expect(driver.kind).toBe('apple-container');
    expect(driver.capabilities().auxiliaryContainers).toBe(false);
  });
});
