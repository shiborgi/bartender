/**
 * Gmail relay host module: a durable queue that fans filtered Gmail text out
 * to the WhatsApp groups wired to an agent group, without waking its model.
 *
 * One loop every five seconds: take complete batches out of each group's
 * outbox, recover deliveries a crashed host left claimed, and deliver what is
 * due. Nothing here is reachable from a container except the outbox folder.
 */
import { getDb } from '../../db/connection.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import './migration.js';
import { ingestGmailRelayOutboxes } from './outbox.js';
import { drainGmailRelayDeliveries, recoverStaleGmailRelayDeliveries } from './queue.js';

const INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export async function runGmailRelayCycle(): Promise<void> {
  await ingestGmailRelayOutboxes();
  await recoverStaleGmailRelayDeliveries(getDb());
  await drainGmailRelayDeliveries();
}

function schedule(delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runGmailRelayCycle()
      .catch((err) => log.error('Gmail relay cycle failed', { err }))
      .finally(() => schedule(INTERVAL_MS));
  }, delayMs);
  timer.unref?.();
}

onHostStart(() => {
  stopped = false;
  schedule(0);
});

onHostShutdown(() => {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
});
