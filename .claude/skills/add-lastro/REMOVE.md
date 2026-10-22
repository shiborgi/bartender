# Remove Lastro

For each group that carries the route:

```bash
ncl groups config remove-mcp-server --id <group-id> --name lastro
ncl groups restart --id <group-id>
```

Remove `mcpServers.lastro` from `data/custom-gateway/config/gateway.json`, drop
`lastro` from every group's `agents` entry, and remove the `LASTRO_MCP_TOKEN_*`
keys from `secrets.env`, keeping every other credential.

Deleting the key leaves the credential valid in Lastro. Revoke it there:

```bash
container exec <lastro-postgres> psql -U lastro -d lastro \
  -c "UPDATE agent_credentials SET revoked_at = now() WHERE principal = 'agent:<group-id>'"
```

Return the Lastro stack to loopback-only publishing with
`bun run apple-container install` in its checkout.
