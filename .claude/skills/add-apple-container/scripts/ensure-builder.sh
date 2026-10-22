#!/usr/bin/env bash
# Apple Container builds images inside a builder VM whose default allocation is
# 2 GB. The agent image installs Chromium and several Node CLIs, and at 2 GB the
# build is OOM-killed partway through with `cannot allocate memory` — a failure
# that reads like a broken Dockerfile rather than an under-provisioned builder.
# Raise it once, before building. Idempotent: a builder already at the floor is
# left running.
set -euo pipefail

BUILDER_MIN_MB="${BUILDER_MIN_MB:-8192}"
BUILDER_CPUS="${BUILDER_CPUS:-4}"

# `container builder status` prints `... CPUS MEMORY` with MEMORY as "8192 MB".
current="$(container builder status 2>/dev/null | awk 'NR==2 {print $(NF-1)}')"
case "$current" in
    ''|*[!0-9]*) current=0 ;;
esac

if [ "$current" -ge "$BUILDER_MIN_MB" ]; then
    echo "Builder has ${current} MB; no change."
    exit 0
fi

echo "Builder has ${current} MB; restarting it with ${BUILDER_MIN_MB} MB."
container builder stop >/dev/null 2>&1 || true
container builder start --cpus "$BUILDER_CPUS" --memory "${BUILDER_MIN_MB}MB"
