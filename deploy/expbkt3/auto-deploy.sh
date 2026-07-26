#!/usr/bin/env bash
# T3-CUSTOM(expbkt3): Polls for a successful branch workflow before deployment.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_BRANCH="t3code/exp-t3-mcp-plannator"
DEPLOYED_SHA_FILE="/home/ubuntu/.t3/expbkt3-dev/deployed-sha"
WORKFLOW_RUNS_URL="https://api.github.com/repos/beknown-work/t3code/actions/workflows/deploy-expbkt3.yml/runs?branch=t3code%2Fexp-t3-mcp-plannator&event=push&per_page=20"

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: automatic expbkt3 deployment requires branch '$EXPECTED_BRANCH' (found '${CURRENT_BRANCH:-detached HEAD}')." >&2
  exit 1
fi

git -C "$REPO_DIR" fetch --quiet --prune origin "$EXPECTED_BRANCH"
LOCAL_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse "origin/$EXPECTED_BRANCH")"
DEPLOYED_SHA="$(sed -n '1p' "$DEPLOYED_SHA_FILE" 2>/dev/null || true)"

if [[ "$DEPLOYED_SHA" == "$REMOTE_SHA" ]]; then
  exit 0
fi

if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]] && \
  git -C "$REPO_DIR" merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA"; then
  echo "Local experimental branch is ahead of origin; deployment deferred until it is pushed."
  exit 0
fi

RUNS_JSON="$(curl --connect-timeout 5 --max-time 20 -fsS \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$WORKFLOW_RUNS_URL")"
RUN_CONCLUSION="$(jq -r --arg sha "$REMOTE_SHA" \
  '[.workflow_runs[] | select(.head_sha == $sha)][0].conclusion // empty' \
  <<<"$RUNS_JSON")"

if [[ -z "$RUN_CONCLUSION" ]]; then
  echo "GitHub validation for $REMOTE_SHA is not finished yet; deployment deferred."
  exit 0
fi

if [[ "$RUN_CONCLUSION" != "success" ]]; then
  echo "GitHub validation for $REMOTE_SHA concluded '$RUN_CONCLUSION'; deployment blocked."
  exit 0
fi

echo "GitHub validation succeeded for $REMOTE_SHA; starting expbkt3 deployment."
exec "$REPO_DIR/deploy/expbkt3/deploy.sh" "$REMOTE_SHA"
