#!/usr/bin/env bash
# Publishes one T3 deployment's HTTP port on the tailnet.
#
# The T3 services deliberately bind the VPC address rather than 0.0.0.0: this
# host is reachable from the public internet and its firewall policy is ACCEPT,
# so a wildcard bind would expose an unauthenticated T3. Tailscale advertises no
# subnet route for 10.31.39.0/24, so a tailnet peer has no path to the VPC
# address at all. `tailscale serve` gives it one without widening the bind.
#
# Usage: tailnet-serve.sh [--best-effort] <port> <bind-host>
#
# Additive by construction. It only ever writes the handler for the single port
# it is given, and it must never grow a `tailscale serve reset` or `clear`:
# other work on this box owns unrelated serves (46261-46263), and those two
# commands drop every entry, not just ours.
#
# --best-effort exits 0 even when the serve call fails, so a systemd ExecStart
# script running under `set -e` still reaches its `exec`. A T3 that is reachable
# only on the VPC address beats a T3 that never starts; the failure is reported
# loudly on stderr either way.

set -uo pipefail

BEST_EFFORT=0
if [[ "${1:-}" == "--best-effort" ]]; then
  BEST_EFFORT=1
  shift
fi

PORT="${1:-}"
BIND_HOST="${2:-}"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "tailnet-serve: invalid port '${PORT}'" >&2
  echo "usage: tailnet-serve.sh [--best-effort] <port> <bind-host>" >&2
  exit 2
fi

if [[ -z "$BIND_HOST" ]]; then
  echo "tailnet-serve: missing bind host" >&2
  echo "usage: tailnet-serve.sh [--best-effort] <port> <bind-host>" >&2
  exit 2
fi

TARGET="http://${BIND_HOST}:${PORT}"

# Reported when the tailnet publish did not happen, so the operator learns from
# the service log instead of from a teammate who cannot open the URL.
fail() {
  echo "tailnet-serve: ERROR: port ${PORT} is NOT published on the tailnet." >&2
  echo "tailnet-serve: $1" >&2
  echo "tailnet-serve: T3 stays reachable at ${TARGET}; tailnet peers do not." >&2
  echo "tailnet-serve: repair with: sudo tailscale serve --bg --http=${PORT} ${TARGET}" >&2
  ((BEST_EFFORT)) && exit 0
  exit 1
}

# True when tailscaled already proxies this port to exactly our target, so a
# repeat run neither rewrites the config nor adds a second entry.
already_published() {
  tailscale serve status --json 2>/dev/null | jq -e \
    --arg port "$PORT" --arg target "$TARGET" '
      ((.TCP // {})[$port].HTTP == true)
      and ([ (.Web // {}) | to_entries[]
             | select(.key | endswith(":" + $port))
             | .value.Handlers["/"].Proxy ]
           | (length > 0) and all(. == $target))
    ' >/dev/null 2>&1
}

command -v tailscale >/dev/null 2>&1 || fail "the 'tailscale' binary is not on PATH."
command -v jq >/dev/null 2>&1 || fail "the 'jq' binary is not on PATH."

if already_published; then
  echo "tailnet-serve: port ${PORT} already proxies to ${TARGET}; nothing to do."
  exit 0
fi

# Writing serve config needs root. The units run as `ubuntu`, which is the
# tailscale operator but is still refused with 401 on a bare `tailscale serve`.
if ((EUID == 0)); then
  tailscale_cmd=(tailscale)
elif sudo -n true >/dev/null 2>&1; then
  tailscale_cmd=(sudo -n tailscale)
else
  fail "writing serve config needs root, and passwordless sudo is unavailable for $(id -un)."
fi

if ! output="$("${tailscale_cmd[@]}" serve --bg "--http=${PORT}" "$TARGET" 2>&1)"; then
  echo "$output" >&2
  fail "'tailscale serve' failed."
fi

# tailscale reports success before tailscaled has necessarily accepted the
# config, so trust the read-back rather than the exit code.
already_published || fail "'tailscale serve' reported success but the config did not take."

echo "tailnet-serve: published port ${PORT} on the tailnet -> ${TARGET}"
