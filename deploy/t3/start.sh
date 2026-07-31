#!/usr/bin/env bash
# Starts the upstream-style t3.dev deployment.
#
# This script lives in the bkmain worktree (fork-owned tooling) but operates on
# the t3code worktree, whose branch `t3main` is upstream `main` plus only
# .github/workflows/deploy-t3.yml.
set -euo pipefail

REPO_DIR="${T3_REPO_DIR:-/home/ubuntu/repos/t3code}"
EXPECTED_BRANCH="t3main"
SERVER_BUNDLE="$REPO_DIR/apps/server/dist/bin.mjs"

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: t3 may only start from branch '$EXPECTED_BRANCH' (found '${CURRENT_BRANCH:-detached HEAD}')." >&2
  exit 1
fi

if [[ ! -f "$SERVER_BUNDLE" ]]; then
  echo "ERROR: T3 server bundle is missing: $SERVER_BUNDLE" >&2
  echo "Run deploy/t3/deploy.sh to install the GitHub-built artifact." >&2
  exit 1
fi

export HOME="/home/ubuntu"
export NODE_ENV="production"
export PATH="/home/ubuntu/.nvm/versions/node/v24.16.0/bin:/home/ubuntu/.local/bin:/home/ubuntu/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

exec node "$SERVER_BUNDLE" serve \
  --mode web \
  --host "10.31.39.131" \
  --port "18082" \
  --base-dir "/home/ubuntu/.t3/beknown-dev" \
  --no-browser \
  "/home/ubuntu/repos"
