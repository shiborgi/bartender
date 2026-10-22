---
name: add-gmail-relay
description: Relay matching Gmail messages to the WhatsApp groups wired to an agent group, deterministically and without waking the model. A scheduled poller filters mail read through the custom gateway; the host queues and delivers each message once, with retries.
---

# Gmail relay

A one-minute scheduled task runs a poller inside the agent group's container.
It reads Gmail through the gateway, filters each new message against the
group's rules, and hands matches to the host by writing one batch file into the
group's `plugin-data/gmail-relay/outbox/`. A host module takes the batch into a
durable queue keyed on the Gmail message id and delivers it to every active
WhatsApp group wired to that agent group. The task always reports
`wakeAgent:false`, so polling costs no model tokens.

The group is whatever folder the batch sits in: a container can only relay for
its own group. The host reads the outbox through anchored descriptors and never
follows a symlink placed there.

## Prerequisites

`/add-custom-gateway` is the selected gateway, with a `google-gmail` MCP route
(`builtin: google-gmail`, an OAuth profile with `gmail.readonly`) allowed for
the agent group. The poller calls it at `$NANOCLAW_GATEWAY_URL/mcp/google-gmail`
with the group's own client key; it holds no Google credential.

```nc:run effect:check
grep -q "^import './custom-gateway.js';" src/gateway-providers/installed.ts
```

`/add-whatsapp` is installed and the agent group is wired to its WhatsApp groups.

## Install

```nc:copy
payload/src/modules/gmail-relay/index.ts -> src/modules/gmail-relay/index.ts
payload/src/modules/gmail-relay/migration.ts -> src/modules/gmail-relay/migration.ts
payload/src/modules/gmail-relay/queue.ts -> src/modules/gmail-relay/queue.ts
payload/src/modules/gmail-relay/outbox.ts -> src/modules/gmail-relay/outbox.ts
payload/src/modules/gmail-relay/integration.test.ts -> src/modules/gmail-relay/integration.test.ts
payload/container/agent-runner/src/gmail-relay/poll.ts -> container/agent-runner/src/gmail-relay/poll.ts
payload/container/agent-runner/src/gmail-relay/poll.test.ts -> container/agent-runner/src/gmail-relay/poll.test.ts
payload/container/agent-runner/src/gmail-relay/gmail-relay.example.json -> container/agent-runner/src/gmail-relay/gmail-relay.example.json
```

```nc:append to:src/modules/index.ts
import './gmail-relay/index.js';
```

The module owns two tables, created by the migration
`module:gmail-relay:queue-v1`: `gmail_relay_events` (one row per Gmail message
per group — the idempotency key) and `gmail_relay_deliveries` (one row per
target WhatsApp group, with attempts and the last error).

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/modules/gmail-relay
```

```nc:run effect:test
cd container/agent-runner && bun test src/gmail-relay/poll.test.ts
```

Restart the service so the module loads. The poller is under
`container/agent-runner/src`, which is mounted at `/app/src`; no image rebuild
is needed.

## Configure a mailbox filter

Copy `container/agent-runner/src/gmail-relay/gmail-relay.example.json` to
`groups/<folder>/gmail-relay.json` and replace the sender, expressions, fields
and template. Keep `enabled: false` until the rule is tested.

Every enabled rule needs at least one positive criterion (sender address or
domain, subject or body regex, or Gmail label), a non-empty template, and
`required: true` on every field the forwarded text depends on. Criteria from
different categories are ANDed; values in the sender and label lists are ORed;
exclusions always win. The first rule whose filters and required fields pass is
used. `source` is `text`, `textPlain` or `htmlText` — normalized text from the
gateway, never raw HTML.

`groupsOnly` (default true) limits delivery to WhatsApp groups; set it false to
include wired DMs. `initialLookbackMinutes` (default 0) sets a cursor on first
run without replaying old mail.

## Schedule polling

List the group's tasks first and do not create a second series named
`gmail-relay`:

```bash
ncl tasks list --group <agent-group-id>
ncl tasks create --group <agent-group-id> --name gmail-relay \
  --recurrence "*/1 * * * *" \
  --prompt "Gmail relay poll completed deterministically." \
  --script "bun /app/src/gmail-relay/poll.ts /workspace/agent/gmail-relay.json"
```

A poller error goes through the scheduler's backoff and never advances the
Gmail cursor.

## Verify

With `enabled: false`, a run reports `status:"disabled"`. Enable the rule and
send one matching test email: the task's run log shows one queued message, and
each wired WhatsApp group receives it once. The batch file disappears from
`outbox/` within five seconds.

## Troubleshooting

- **`NANOCLAW_GATEWAY_URL is not set`** — the custom gateway is not the
  selected gateway, or the session predates it; restart the group.
- **`historyExpired`** — expected after a long pause; the poller does a bounded
  search from the last successful time and resumes history polling.
- **Gateway `403`** — the group's policy does not allow `google-gmail`.
- **Filter matches nothing** — inspect one message with the `get_message` tool
  and write expressions against `text`, `textPlain` or `htmlText`.
- **A `.rejected-*.json` in `outbox/`** — the host could not parse that batch;
  the host log names the reason. Delete it once read.
- **No WhatsApp delivery** — check `gmail_relay_deliveries.last_error`, that
  the group is wired to an active WhatsApp group, and that the adapter instance
  is connected.
