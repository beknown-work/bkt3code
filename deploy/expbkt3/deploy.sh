#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_BRANCH="t3code/exp-t3-mcp-plannator"
EXPECTED_SHA="${1:-${EXPECTED_SHA:-}}"
SERVICE_NAME="t3-expbkt3.service"
HEALTH_URL="http://10.31.39.131:18085/"
DEPLOYED_SHA_FILE="/home/ubuntu/.t3/expbkt3-dev/deployed-sha"

exec 9>"/tmp/expbkt3-deploy.lock"
if ! flock -n 9; then
  echo "ERROR: another expbkt3 deployment is already running." >&2
  exit 1
fi

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: refusing to deploy from '${CURRENT_BRANCH:-detached HEAD}'; expected '$EXPECTED_BRANCH'." >&2
  exit 1
fi

if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  echo "ERROR: refusing to overwrite uncommitted changes in $REPO_DIR." >&2
  git -C "$REPO_DIR" status --short >&2
  exit 1
fi

echo "==> Fetching origin/$EXPECTED_BRANCH"
git -C "$REPO_DIR" fetch --prune origin "$EXPECTED_BRANCH"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse "origin/$EXPECTED_BRANCH")"

if [[ -n "$EXPECTED_SHA" && "$REMOTE_SHA" != "$EXPECTED_SHA" ]]; then
  echo "ERROR: refusing stale deploy; requested $EXPECTED_SHA but origin/$EXPECTED_BRANCH is $REMOTE_SHA." >&2
  exit 1
fi

echo "==> Fast-forwarding $EXPECTED_BRANCH to $REMOTE_SHA"
git -C "$REPO_DIR" merge --ff-only "origin/$EXPECTED_BRANCH"

export PATH="/home/ubuntu/.nvm/versions/node/v24.16.0/bin:/home/ubuntu/.local/bin:/home/ubuntu/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo "==> Installing locked dependencies"
pnpm --dir "$REPO_DIR" install --frozen-lockfile

echo "==> Building the experimental web client"
VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true \
  pnpm --dir "$REPO_DIR" exec vp run --filter @t3tools/web build

echo "==> Building the T3 server bundle"
pnpm --dir "$REPO_DIR" exec vp run --filter t3 build:bundle

echo "==> Restarting $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo -n "==> Waiting for expbkt3"
for _ in $(seq 1 60); do
  if curl --connect-timeout 1 --max-time 3 -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" >/dev/null; then
  echo " FAILED" >&2
  sudo systemctl --no-pager --lines=50 status "$SERVICE_NAME" >&2 || true
  exit 1
fi

DEPLOYED_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
if [[ "$DEPLOYED_SHA" != "$REMOTE_SHA" ]]; then
  echo "ERROR: deployed checkout $DEPLOYED_SHA does not match origin/$EXPECTED_BRANCH $REMOTE_SHA." >&2
  exit 1
fi

install -d -m 0700 "$(dirname "$DEPLOYED_SHA_FILE")"
umask 077
printf '%s\n' "$DEPLOYED_SHA" >"$DEPLOYED_SHA_FILE"
echo "==> expbkt3 deployed at $DEPLOYED_SHA"
