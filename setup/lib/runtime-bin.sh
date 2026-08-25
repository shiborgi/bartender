# runtime-bin.sh — shell mirror of src/drivers/index.ts runtimeBin().
#
# Source this file after $PROJECT_ROOT is set:
#
#   source "$PROJECT_ROOT/setup/lib/runtime-bin.sh"
#   CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-$(runtime_bin)}"
#
# apple-container -> container, docker -> docker. Same default as
# configuredDriverKind: apple-container on Darwin/arm64, docker elsewhere.

_nanoclaw_configured_driver_kind() {
  local kind="${NANOCLAW_RUNTIME_DRIVER:-}"
  if [ -z "$kind" ] && [ -n "${PROJECT_ROOT:-}" ] && [ -f "$PROJECT_ROOT/.env" ]; then
    kind="$(grep '^NANOCLAW_RUNTIME_DRIVER=' "$PROJECT_ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
  fi
  kind="$(printf '%s' "$kind" | tr '[:upper:]' '[:lower:]')"
  if [ -n "$kind" ]; then
    printf '%s' "$kind"
    return
  fi
  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    printf 'apple-container'
  else
    printf 'docker'
  fi
}

runtime_bin() {
  if [ "$(_nanoclaw_configured_driver_kind)" = "apple-container" ]; then
    printf 'container'
  else
    printf 'docker'
  fi
}
