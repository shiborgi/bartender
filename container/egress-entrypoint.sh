#!/bin/bash
# One-shot Barback network bootstrap. The runtime grants its capabilities only
# to this root process; setpriv clears them before the agent starts.
set -euo pipefail

: "${NANOCLAW_EGRESS_LOCKDOWN:?missing egress lockdown mode}"
: "${NANOCLAW_EGRESS_HOST:?missing Barback gateway address}"
: "${NANOCLAW_EGRESS_PORT:?missing Barback gateway port}"
: "${NANOCLAW_EGRESS_UID:?missing target uid}"
: "${NANOCLAW_EGRESS_GID:?missing target gid}"

if [[ "$NANOCLAW_EGRESS_LOCKDOWN" != "barback-v1" ]] ||
  [[ ! "$NANOCLAW_EGRESS_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
  [[ "$NANOCLAW_EGRESS_PORT" != "8080" ]] ||
  [[ ! "$NANOCLAW_EGRESS_UID" =~ ^[1-9][0-9]*$ ]] ||
  [[ ! "$NANOCLAW_EGRESS_GID" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' 'invalid Barback egress bootstrap configuration' >&2
  exit 64
fi

# Install default-deny rules before making any network request. IPv6 is denied
# outright because Barback publishes only an IPv4 endpoint today.
iptables -w -P INPUT DROP
iptables -w -P FORWARD DROP
iptables -w -P OUTPUT DROP
iptables -w -A INPUT -i lo -j ACCEPT
iptables -w -A OUTPUT -o lo -j ACCEPT
iptables -w -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w -A OUTPUT -p tcp -d "$NANOCLAW_EGRESS_HOST" --dport "$NANOCLAW_EGRESS_PORT" \
  -m conntrack --ctstate NEW -j ACCEPT
ip6tables -w -P INPUT DROP
ip6tables -w -P FORWARD DROP
ip6tables -w -P OUTPUT DROP

# This confirms the exact route the agent will use, not the host's published
# loopback port. Proxies are explicitly disabled so environment cannot widen it.
curl --fail --silent --show-error --max-time 5 --noproxy '*' \
  "http://${NANOCLAW_EGRESS_HOST}:${NANOCLAW_EGRESS_PORT}/health/live" >/dev/null

exec setpriv \
  --reuid "$NANOCLAW_EGRESS_UID" \
  --regid "$NANOCLAW_EGRESS_GID" \
  --clear-groups \
  --nnp \
  bun run /app/src/index.ts
