#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_BRANCH="bkmain"
SERVER_BUNDLE="$REPO_DIR/apps/server/dist/bin.mjs"

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: bkt3 may only start from branch '$EXPECTED_BRANCH' (found '${CURRENT_BRANCH:-detached HEAD}')." >&2
  exit 1
fi

if [[ ! -f "$SERVER_BUNDLE" ]]; then
  echo "ERROR: T3 server bundle is missing: $SERVER_BUNDLE" >&2
  echo "Run deploy/bkt3/deploy.sh to install dependencies and build it." >&2
  exit 1
fi

export HOME="/home/ubuntu"
export NODE_ENV="production"
export PATH="/home/ubuntu/.nvm/versions/node/v24.16.0/bin:/home/ubuntu/.local/bin:/home/ubuntu/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

exec node "$SERVER_BUNDLE" serve \
  --mode web \
  --host "10.31.39.131" \
  --port "18083" \
  --base-dir "/home/ubuntu/.t3/bkt3-dev" \
  --no-browser \
  "/home/ubuntu/repos"
