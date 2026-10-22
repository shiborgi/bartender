---
name: add-lastro
description: Give one or more agent groups access to a self-hosted Lastro financial ledger through the custom gateway. Use for bookkeeping, expense, revenue, settlement, or cash-flow automation over Lastro's MCP.
---

# Add Lastro

Lastro is a self-hosted double-entry ledger whose write surface is an MCP
server. This skill routes that server through the custom gateway, so the agent
holds no Lastro address and no Lastro credential: it sees one MCP server,
`lastro`, at its own gateway URL.

It changes no code. It needs `/add-custom-gateway` as the selected gateway; on
Apple Container, `/add-apple-container` is what keeps the agent itself off the
host network.

## 1. Choose scope

Ask for the Lastro checkout path, the Book the agents act on, and the agent
groups that may reach it. Mint **one credential per agent group** so Lastro's
`audit_events` name the group behind each write. Never allow `lastro` under the
`*` fallback policy.

## 2. Give the gateway a route to the MCP

The gateway container is on the runtime's default network and on the install's
host-only egress network; sessions are on the egress network only. So the
gateway can reach a port the host publishes on the default network's bridge
address, and an agent cannot.

A Lastro stack published on loopback is unreachable from every container.
Publish the **MCP container alone** on the bridge address, leaving the
dashboard, API and database on loopback:

```bash
container network inspect default   # Apple Container: read ipv4Gateway, typically 192.168.64.1
```

On Docker, use the `docker0` address. In the Lastro checkout, reinstall with an
extra publish on its own port — Apple Container refuses two publish specs that
share a host port, even on different addresses:

```bash
LASTRO_MCP_EXTRA_PUBLISH=192.168.64.1:3013 bun run apple-container install
curl -sS http://192.168.64.1:3013/health   # {"status":"ok",...}
curl -sS http://192.168.64.1:3010/         # refused: the dashboard stays on loopback
```

## 3. Mint a credential

From the Lastro checkout, once per agent group:

```bash
DATABASE_URL=postgres://lastro:<password>@127.0.0.1:<pg-port>/lastro \
  bun run bootstrap --email <owner-email> --password '<owner-passphrase>' \
  --agent agent:<group-id>
```

It prints `<credentialId>.<secret>` once. Have the operator write it straight
into `data/custom-gateway/config/secrets.env` — never paste it into chat:

```
LASTRO_MCP_TOKEN_<GROUP>=<credentialId>.<secret>
```

## 4. Configure the gateway

In `data/custom-gateway/config/gateway.json`, one route per credential:

```json
"mcpServers": {
  "lastro": {
    "url": "http://192.168.64.1:3013/mcp",
    "auth": { "header": "Authorization", "format": "Bearer {value}", "secret": "LASTRO_MCP_TOKEN_<GROUP>" }
  }
}
```

and add `lastro` to the `mcpServers` of each permitted group's exact `agents`
entry. Plain HTTP is right here: the address is a host-only bridge the LAN
cannot reach, and the URL never leaves the gateway. The gateway re-reads both
files per request; it keeps running.

## 5. Register the route with each group

```bash
pnpm exec tsx .claude/skills/add-custom-gateway/scripts/routes.ts sync --group <group-id>
ncl groups restart --id <group-id>
```

## 6. Verify

```bash
# The gateway reaches the MCP.
container exec nanoclaw-gateway-v2-<slug> bun -e 'console.log((await fetch("http://192.168.64.1:3013/health")).status)'

# A container on the egress network does not.
container run --rm --network nanoclaw-egress-v2-<slug> oven/bun:1-alpine \
  bun -e 'fetch("http://192.168.64.1:3013/health",{signal:AbortSignal.timeout(5000)}).then(()=>console.log("REACHED")).catch(()=>console.log("no route"))'
```

Then ask an agent in a permitted group to list its Lastro tools and read one
Book summary, and confirm the call lands in `audit_events` under that group's
principal. A group whose policy lacks `lastro` gets 403 from the gateway.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `host ports for different publish port specs may not overlap` | The extra publish reuses the loopback port; give it its own. |
| The agent has no `lastro` tool | `routes.ts sync` was not run for the group, or the group was not restarted. |
| Gateway 403 for `lastro` | The group's `agents` entry does not list `lastro`. |
| Gateway 502 or timeout | The MCP is published on loopback only. Re-check step 2 from the host. |
| Lastro 401 | The token is revoked, truncated, or missing the `<credentialId>.<secret>` join. |

## Removal

See [REMOVE.md](REMOVE.md).
