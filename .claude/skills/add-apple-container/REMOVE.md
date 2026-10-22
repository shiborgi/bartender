# Remove the Apple Container driver

Switch the install back to Docker first, so the host never starts with a driver
kind that is no longer registered: in `.env`, delete `NANOCLAW_RUNTIME_DRIVER`
and `CONTAINER_RUNTIME` (or set them to `docker`) and `CONTAINER_BUILD_OPTIONS`,
and stop the service.

Stop every session this install started on Apple Container:

```bash
container ls --all | awk 'NR>1 && /nanoclaw/ {print $1}' | xargs -r container rm -f
```

Remove the two barrel lines:

- `import './apple-container.js';` from `src/drivers/installed.ts`
- `import './apple-container-conformance.js';` from `src/drivers/conformance-installed.ts`

Delete the copied files:

```bash
rm -f src/drivers/apple-container.ts \
  src/drivers/apple-container-driver.ts src/drivers/apple-container-driver.test.ts \
  src/drivers/apple-container-network.ts src/drivers/apple-container-network.test.ts \
  src/drivers/apple-container-conformance.ts src/drivers/apple-container-registration.test.ts
```

Delete the per-session hosts files and, if nothing else uses it, the host-only
network:

```bash
rm -rf data/apple-container
container network rm "nanoclaw-egress-v2-$(pnpm exec tsx -e "import('./src/install-slug.ts').then(m=>console.log(m.getInstallSlug()))")"
```

Rebuild (`pnpm run build`), build the agent image for Docker
(`./container/build.sh build`) and start the service.
