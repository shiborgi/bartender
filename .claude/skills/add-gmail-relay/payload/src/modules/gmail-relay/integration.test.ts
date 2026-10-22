import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The production barrel is the feature's only integration point. Importing it
// proves the module migration self-registers.
import '../index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  setMessagingGroupDetachedAt,
} from '../../db/messaging-groups.js';
import { getRegisteredMigrations } from '../../db/migrations/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { ingestGmailRelayOutboxes } from './outbox.js';
import { drainGmailRelayDeliveries } from './queue.js';

const now = (): string => new Date().toISOString();
let groupsDir: string;

async function seedGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

async function wire(
  agentGroupId: string,
  id: string,
  channelType: string,
  platformId: string,
  options: { instance?: string; isGroup?: boolean; detached?: boolean } = {},
): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    instance: options.instance,
    name: id,
    is_group: options.isGroup === false ? 0 : 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: `wire-${id}`,
    messaging_group_id: id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  if (options.detached) await setMessagingGroupDetachedAt(id, now());
}

function outboxOf(folder: string): string {
  return path.join(groupsDir, folder, 'plugin-data', 'gmail-relay', 'outbox');
}

/** What the poller does: one complete batch file per poll. */
function drop(folder: string, name: string, batch: unknown): void {
  fs.mkdirSync(outboxOf(folder), { recursive: true });
  fs.writeFileSync(path.join(outboxOf(folder), name), typeof batch === 'string' ? batch : JSON.stringify(batch));
}

beforeEach(async () => {
  groupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-relay-groups-'));
  const db = await initTestDb();
  await runMigrations(db);
  await seedGroup('ag-relay');
  await seedGroup('ag-other');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(groupsDir, { recursive: true, force: true });
});

describe('gmail relay composition', () => {
  it('registers its migration through the module barrel', async () => {
    expect(getRegisteredMigrations().some((migration) => migration.name === 'module:gmail-relay:queue-v1')).toBe(true);
    expect(await getDb().hasTable('gmail_relay_deliveries')).toBe(true);
  });

  it('delivers once to every active WhatsApp group wired to the outbox owner, preserving instances', async () => {
    await wire('ag-relay', 'wa-a', 'whatsapp', '12001@g.us', { instance: 'sales' });
    await wire('ag-relay', 'wa-b', 'whatsapp', '12002@g.us', { instance: 'support' });
    await wire('ag-relay', 'wa-dm', 'whatsapp', '55119999@s.whatsapp.net', { isGroup: false });
    await wire('ag-relay', 'telegram', 'telegram', 'tg-1');
    await wire('ag-relay', 'detached', 'whatsapp', '12003@g.us', { detached: true });
    await wire('ag-other', 'other', 'whatsapp', '12004@g.us');

    const deliveries: Array<{ platformId: string; instance?: string; content: string }> = [];
    setDeliveryAdapter({
      async deliver(_channel, platformId, _thread, _kind, content, _files, instance) {
        deliveries.push({ platformId, instance, content });
        return `sent-${platformId}`;
      },
    });

    const batch = {
      groupsOnly: true,
      messages: [{ source_message_id: 'gmail-1', rule_id: 'orders', text: 'Pedido 42' }],
    };
    drop('ag-relay', '1-a.json', batch);
    expect(await ingestGmailRelayOutboxes(groupsDir)).toBe(1);
    expect(fs.readdirSync(outboxOf('ag-relay'))).toEqual([]);
    await drainGmailRelayDeliveries();

    expect(deliveries.sort((a, b) => a.platformId.localeCompare(b.platformId))).toEqual([
      { platformId: '12001@g.us', instance: 'sales', content: JSON.stringify({ text: 'Pedido 42' }) },
      { platformId: '12002@g.us', instance: 'support', content: JSON.stringify({ text: 'Pedido 42' }) },
    ]);

    // A replayed batch (poller crashed before advancing its cursor) is a no-op.
    drop('ag-relay', '2-b.json', batch);
    await ingestGmailRelayOutboxes(groupsDir);
    await drainGmailRelayDeliveries();
    expect(deliveries).toHaveLength(2);
  });

  it('ignores in-flight dot-files and sets a malformed batch aside without blocking the next', async () => {
    await wire('ag-relay', 'wa-a', 'whatsapp', '12001@g.us');
    const deliver = vi.fn().mockResolvedValue('sent');
    setDeliveryAdapter({ deliver });
    drop('ag-relay', '.3-c.json', { messages: [{ source_message_id: 'half', text: 'x' }] });
    drop('ag-relay', '1-a.json', '{"messages": [');
    drop('ag-relay', '2-b.json', { messages: [{ source_message_id: 'gmail-2', text: 'ok' }] });

    expect(await ingestGmailRelayOutboxes(groupsDir)).toBe(1);
    await drainGmailRelayDeliveries();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(outboxOf('ag-relay')).sort()).toEqual(['.3-c.json', '.rejected-1-a.json']);
    expect(fs.readFileSync(path.join(outboxOf('ag-relay'), '.rejected-1-a.json'), 'utf8')).toBe('{"messages": [');
  });

  it('never follows a symlinked outbox out of the group folder', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-relay-elsewhere-'));
    fs.writeFileSync(
      path.join(elsewhere, 'victim.json'),
      JSON.stringify({ messages: [{ source_message_id: 'x', text: 'x' }] }),
    );
    fs.mkdirSync(path.join(groupsDir, 'ag-relay', 'plugin-data', 'gmail-relay'), { recursive: true });
    fs.symlinkSync(elsewhere, outboxOf('ag-relay'));

    expect(await ingestGmailRelayOutboxes(groupsDir)).toBe(0);
    expect(fs.existsSync(path.join(elsewhere, 'victim.json'))).toBe(true);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('retries an adapter failure and never advances it as delivered', async () => {
    await wire('ag-relay', 'wa-a', 'whatsapp', '12001@g.us');
    const deliver = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('sent-1');
    setDeliveryAdapter({ deliver });
    drop('ag-relay', '1-a.json', { messages: [{ source_message_id: 'gmail-retry', text: 'Retry me' }] });
    await ingestGmailRelayOutboxes(groupsDir);
    await drainGmailRelayDeliveries();
    const retry = await getDb().get<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM gmail_relay_deliveries',
    );
    expect(retry).toEqual({ status: 'retry', attempts: 1 });

    await getDb().run("UPDATE gmail_relay_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    await drainGmailRelayDeliveries();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await getDb().get<{ status: string }>('SELECT status FROM gmail_relay_deliveries'))?.status).toBe(
      'delivered',
    );
  });
});
