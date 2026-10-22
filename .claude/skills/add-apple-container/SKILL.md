---
name: add-apple-container
description: Run agent sessions on Apple Container (the macOS `container` CLI) instead of Docker. Adds the `apple-container` session driver, confines sessions to a host-only network, and routes the gateway endpoint by name. macOS on Apple silicon only.
---

# Apple Container session driver

Agent sessions run as Apple Container VMs, one per session, through the
`container` CLI (version 1.3 or later). Each session is attached only to this
install's host-only network, so its single way off the host is the gateway the
install selected. Apple's `container run` has no `--add-host`, so the driver
reaches the gateway endpoint by name through a per-session hosts file mounted
read-only over `/etc/hosts`; when the gateway is recreated under a new address,
running sessions follow it.

The driver passes the same conformance floor as the Docker driver. What the
runtime cannot express is declared rather than faked: there is no per-session
pid limit, and it does not run auxiliary containers beside the agent, so a
gateway that needs a session-container is refused at spawn.

## Prerequisites

Apple Container must be installed and its system service running. Check it:

```nc:run effect:check
container system status
```

If that fails, install Apple Container from
https://github.com/apple/container/releases and run `container system start`.

## Install

Copy the driver and its tests into the tree:

```nc:copy
payload/src/drivers/apple-container.ts -> src/drivers/apple-container.ts
payload/src/drivers/apple-container-driver.ts -> src/drivers/apple-container-driver.ts
payload/src/drivers/apple-container-driver.test.ts -> src/drivers/apple-container-driver.test.ts
payload/src/drivers/apple-container-network.ts -> src/drivers/apple-container-network.ts
payload/src/drivers/apple-container-network.test.ts -> src/drivers/apple-container-network.test.ts
payload/src/drivers/apple-container-conformance.ts -> src/drivers/apple-container-conformance.ts
payload/src/drivers/apple-container-registration.test.ts -> src/drivers/apple-container-registration.test.ts
```

Register the driver, and put it on the shared conformance floor:

```nc:append to:src/drivers/installed.ts
import './apple-container.js';
```

```nc:append to:src/drivers/conformance-installed.ts
import './apple-container-conformance.js';
```

Select it for this install. `CONTAINER_RUNTIME` makes image builds and pulls
use the `container` binary as well. `CONTAINER_BUILD_OPTIONS` sizes the builder
VM: `container build` resizes it to the system default (2 GB) on every build
that does not pass `--cpus` and `--memory`, and the agent image runs out of
memory at 2 GB.

```nc:env-set
NANOCLAW_RUNTIME_DRIVER=apple-container
CONTAINER_RUNTIME=container
CONTAINER_BUILD_OPTIONS=--cpus 4 --memory 8192mb
```

The session network defaults to `nanoclaw-egress-v2-<install slug>`. Set
`NANOCLAW_EGRESS_NETWORK` only to share one network between installs.

## Build and verify

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/drivers
```

Then build the agent image (`./container/build.sh build`) and restart the
service so it selects the new driver. The startup log names it:
`Session runtime driver selected` with `kind: apple-container`.

## Troubleshooting

- **`Session runtime driver selected` is missing and the service restarts in a
  loop** — `NANOCLAW_RUNTIME_DRIVER` names a kind this build did not register.
  Check that `src/drivers/installed.ts` still imports `./apple-container.js`.
- **`the network "…" exists but is not host-only`** — a network with this
  install's name was created by hand without `--internal`. Remove it
  (`container network rm <name>`); the driver recreates it host-only.
- **`the runtime target "…" has no address on the network`** — the gateway
  container is not attached to the egress network. Restart the service so the
  gateway provider recreates it.
- **Build hangs at `bun install` for five minutes, then fails with
  `IntegrityCheckFailed extracting tarball`** — Apple Container 1.3's builder
  intermittently stalls large downloads (the agent SDK's 115 MB binaries); the
  same install succeeds in a plain container. Run the build again; it succeeds
  on a later attempt.
- **Build context arrives empty** (`COPY` copies nothing, the image fails with
  `Module not found`) — the builder cannot read contexts under `/tmp` or
  `/private/tmp`. Keep the install under your home directory.
- **Build fails with `cannot allocate memory`** — `CONTAINER_BUILD_OPTIONS` is
  missing from `.env`, so the build ran in a 2 GB builder.
- **Update and uninstall tooling** (`scripts/update/service.ts` container
  drain, `setup/uninstall/scan.ts`) still speak Docker's CLI dialect; on this
  runtime, stop the service before an update instead of relying on the drain.
