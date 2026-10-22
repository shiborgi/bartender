/**
 * The hand-off from the poller to the durable queue.
 *
 * The poller runs inside the group's container and drops one JSON batch per
 * poll into `plugin-data/gmail-relay/outbox/` of the group folder. The host
 * reads each batch, queues it, and deletes the file. The agent group is the
 * folder the file sits in, so a container can only ever relay for its own
 * group, and nothing in the batch can name another.
 *
 * The folder is container-writable, so it is read through AnchoredDir: every
 * segment is opened by descriptor and a symlink anywhere below the group root
 * is refused, never followed.
 */
import { AnchoredDir } from '../../anchored-dir.js';
import { GROUPS_DIR } from '../../config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { log } from '../../log.js';
import { enqueueGmailRelay, type RelayMessage } from './queue.js';

const OUTBOX = ['plugin-data', 'gmail-relay', 'outbox'] as const;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 100;
const MAX_TEXT = 16_000;

export interface RelayBatch {
  groupsOnly: boolean;
  messages: RelayMessage[];
}

/** Validate one batch file. Throws with a reason the operator can act on. */
export function parseRelayBatch(raw: string): RelayBatch {
  const doc = JSON.parse(raw) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('batch must be an object');
  if (doc.groupsOnly !== undefined && typeof doc.groupsOnly !== 'boolean') {
    throw new Error('"groupsOnly" must be a boolean');
  }
  if (!Array.isArray(doc.messages) || doc.messages.length === 0 || doc.messages.length > MAX_MESSAGES) {
    throw new Error(`"messages" must contain between 1 and ${MAX_MESSAGES} items`);
  }
  const messages = doc.messages.map((item: unknown, index: number): RelayMessage => {
    const value = (item ?? {}) as Record<string, unknown>;
    const id = value.source_message_id;
    if (typeof id !== 'string' || !id.trim() || id.length > 512) {
      throw new Error(`messages[${index}].source_message_id must be a non-empty string`);
    }
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_TEXT) {
      throw new Error(`messages[${index}].text must contain 1 to ${MAX_TEXT} characters`);
    }
    const ruleId = value.rule_id;
    if (ruleId !== undefined && (typeof ruleId !== 'string' || ruleId.length > 256)) {
      throw new Error(`messages[${index}].rule_id must be a short string`);
    }
    return { sourceMessageId: id.trim(), text: value.text.trim(), ruleId: ruleId || undefined };
  });
  return { groupsOnly: doc.groupsOnly !== false, messages };
}

function openOutbox(groupsDir: string, folder: string): AnchoredDir | null {
  try {
    return AnchoredDir.open(groupsDir, [folder, ...OUTBOX]);
  } catch (err) {
    log.warn('Gmail relay outbox is not a plain directory; skipping it', { folder, err });
    return null;
  }
}

/**
 * Queue every complete batch in every group's outbox. A batch that does not
 * parse is renamed aside (dot-prefixed, so it is not read again) rather than
 * deleted, so the operator can see what the poller wrote.
 */
export async function ingestGmailRelayOutboxes(groupsDir = GROUPS_DIR, db: DbDriver = getDb()): Promise<number> {
  let batches = 0;
  for (const group of await getAllAgentGroups()) {
    const outbox = openOutbox(groupsDir, group.folder);
    if (!outbox) continue;
    try {
      // Dot-names are the poller's in-flight writes and rejected batches.
      const names = outbox
        .entries()
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .sort();
      for (const name of names) {
        let raw: Buffer | undefined;
        let batch: RelayBatch;
        try {
          if (outbox.lstat(name).size > MAX_BATCH_BYTES) throw new Error('batch is too large');
          raw = outbox.readFile(name);
          batch = parseRelayBatch(raw.toString('utf8'));
        } catch (err) {
          log.warn('Gmail relay rejected an outbox batch', { agentGroupId: group.id, name, err });
          if (raw) outbox.replaceFile(`.rejected-${name}`, raw);
          outbox.unlink(name);
          continue;
        }
        // Queue first, delete after: a crash between the two replays the
        // batch, which the queue deduplicates on Gmail message id.
        await enqueueGmailRelay(group.id, batch.messages, batch.groupsOnly, db);
        outbox.unlink(name);
        batches += 1;
      }
    } finally {
      outbox.close();
    }
  }
  return batches;
}
