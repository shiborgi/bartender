# Remove Gmail relay

Cancel each group's `gmail-relay` task series:

```bash
ncl tasks list --group <agent-group-id>
ncl tasks cancel <gmail-relay-series-id> --group <agent-group-id>
```

Delete `groups/<folder>/gmail-relay.json`, and `groups/<folder>/plugin-data/gmail-relay/`
unless the cursor should survive a reinstall.

Remove `import './gmail-relay/index.js';` from `src/modules/index.ts`, then:

```bash
rm -rf src/modules/gmail-relay container/agent-runner/src/gmail-relay
```

`gmail_relay_events` and `gmail_relay_deliveries` stay: they are delivery
history, inert once the module is gone. Drop them only with the operator's
explicit consent and a current database backup — deliveries first, then events.

Rebuild (`pnpm run build`) and restart the service. The gateway's Gmail route
is independent; remove it from `gateway.json` only if Gmail access itself
should go.
