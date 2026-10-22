# Remove the custom gateway

Select another installed gateway first, so the host never starts with a
provider kind that is no longer registered: set `NANOCLAW_GATEWAY_PROVIDER` in
`.env` to it, or delete the line, and stop the service.

Remove the gateway container and image (use `docker` instead of `container` on
Docker):

```bash
slug=$(pnpm exec tsx -e "import('./src/install-slug.ts').then(m=>console.log(m.getInstallSlug()))")
container rm -f "nanoclaw-gateway-v2-$slug"
container image rm "nanoclaw-custom-gateway-$slug:latest"
```

Remove `import './custom-gateway.js';` from `src/gateway-providers/installed.ts`
and delete the copied files:

```bash
rm -f src/gateway-providers/custom-gateway.ts src/gateway-providers/custom-gateway.test.ts \
  src/gateway-providers/custom-gateway-container.ts src/gateway-providers/custom-gateway-identity.ts \
  src/gateway-providers/custom-gateway-registration.test.ts
rm -rf container/skills/custom-gateway
```

Each group's MCP entries pointing at `host.docker.internal:8080/g/…` stop
working; remove them with `ncl groups config remove-mcp-server`.

`data/custom-gateway/config/` holds every upstream key and Google refresh token.
Move the keys to the next gateway, then delete the directory, and remove
`NANOCLAW_GATEWAY_SECRET` from `.env`.

Rebuild (`pnpm run build`) and start the service.
