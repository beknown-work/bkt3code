#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_BRANCH="bkmain"
SERVER_BUNDLE="$REPO_DIR/apps/server/dist/bin.mjs"
BASE_DIR="/home/ubuntu/.t3/bkt3-dev"
BIND_HOST="10.31.39.131"
PORT="18083"

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: bkt3 may only start from branch '$EXPECTED_BRANCH' (found '${CURRENT_BRANCH:-detached HEAD}')." >&2
  exit 1
fi

if [[ ! -f "$SERVER_BUNDLE" ]]; then
  echo "ERROR: T3 server bundle is missing: $SERVER_BUNDLE" >&2
  echo "Run deploy/bkt3/deploy.sh to install the GitHub-built artifact." >&2
  exit 1
fi

export HOME="/home/ubuntu"
export NODE_ENV="production"
export PATH="/home/ubuntu/.nvm/versions/node/v24.16.0/bin:/home/ubuntu/.local/bin:/home/ubuntu/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# /tmp is a RAM-backed tmpfs (50% of RAM) carrying systemd's default 80% per-user
# quota. Agent sessions inherit TMPDIR from this process, so scratch files landing
# there exhaust the quota and make every subsequent command fail with a bare
# EDQUOT. Keep temp files on disk, beside this deployment's own state.
export TMPDIR="$BASE_DIR/tmp"
mkdir -p "$TMPDIR"

# Give tailnet peers a path to this port. The server binds the VPC address, which
# no tailnet route reaches; publishing it here keeps the documented
# dev-server-1.tailab6257.ts.net URL working without widening the bind. Best
# effort on purpose: a T3 reachable only on the VPC beats a T3 that never starts.
"$SCRIPT_DIR/../tailnet-serve.sh" --best-effort "$PORT" "$BIND_HOST"

exec node "$SERVER_BUNDLE" serve \
  --mode web \
  --host "$BIND_HOST" \
  --port "$PORT" \
  --base-dir "$BASE_DIR" \
  --no-browser \
  "/home/ubuntu/repos"
