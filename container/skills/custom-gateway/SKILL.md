---
name: custom-gateway
description: >-
  The install's gateway: your only route off this machine. Models and every
  MCP tool you have (Google Drive and Sheets, Calendar, Tasks, Gmail, and any
  business system the operator connected) reach their services through it,
  with credentials attached by the gateway. Use this skill when a tool fails
  with 401, 403 or 404, or when the user asks for a service you have no tool for.
metadata:
  author: nanoclaw
---

# The custom gateway

You have no direct internet access. Everything you reach goes through the
gateway at `$NANOCLAW_GATEWAY_URL`, which already identifies your agent group;
never print that URL, since it carries your group's key.

## What you can reach

- **Models**: already configured; you never handle a model credential.
- **MCP tools**: the servers listed in your tool set. Each is a route the
  operator allowed for your agent group in the gateway's policy.
- **Nothing else.** Direct HTTP calls to other hosts fail by design.

## When a call fails

- `401` — your group's key was not accepted. The operator may have rotated the
  install secret; tell them the gateway rejected this agent group's key.
- `403` — the route exists but is not allowed for your agent group. Tell the
  user which tool or model was refused and that the operator can allow it in
  the gateway policy.
- `404 No route` — the service is not configured on this gateway. Say so; do
  not try to reach it another way.
- `502` — the gateway reached the service and it failed, or could not reach
  it. Retry once; if it persists, report which service failed.

Never ask the user for API keys, tokens or passwords: credentials live only in
the gateway, and pasting them into chat would put them somewhere they must not be.
