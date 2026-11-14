#!/usr/bin/env bash
# Pull-based deploy of camera-ai (run by camera-ai-update.timer on the camera host).
# GitHub runners cannot reach the home LAN, and a self-hosted runner on a public repo could run
# code from fork PRs, so the host pulls master itself: when camera-ai/ changed, it syncs the code
# into ~/camera-ai (config, models, events, logs and .venv stay), updates packages when
# requirements.txt changed, runs the test and restarts the service. A failed test keeps the old code.
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/vzakusylo/victron.git}"
BRANCH="${BRANCH:-master}"
SRC="${SRC:-$HOME/.cache/camera-ai-src}"
APP="${APP:-$HOME/camera-ai}"
log() { echo "$(date -Is) $*"; }

if [ ! -d "$SRC/.git" ]; then
  git clone --quiet --filter=blob:none --sparse --branch "$BRANCH" "$REPO_URL" "$SRC"
  git -C "$SRC" sparse-checkout set camera-ai
fi
old=$(git -C "$SRC" rev-parse HEAD)
git -C "$SRC" fetch --quiet origin "$BRANCH"
new=$(git -C "$SRC" rev-parse FETCH_HEAD)
deployed=$(cat "$APP/.deployed" 2>/dev/null || true)
if [ "$deployed" = "$new" ]; then exit 0; fi
if [ -n "$deployed" ] && git -C "$SRC" cat-file -e "$deployed" 2>/dev/null \
   && git -C "$SRC" diff --quiet "$deployed" "$new" -- camera-ai; then
  echo "$new" > "$APP/.deployed"; exit 0   # master moved, camera-ai unchanged
fi
git -C "$SRC" reset --quiet --hard "$new"
if [ ! -d "$SRC/camera-ai" ]; then exit 0; fi   # not on this branch yet
log "deploying ${new:0:7} (was ${deployed:0:7})"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -a "$SRC/camera-ai/." "$stage/"
if ! cmp -s "$stage/requirements.txt" "$APP/requirements.txt"; then
  "$APP/.venv/bin/pip" install -q -r "$stage/requirements.txt"
fi
if ! (cd "$stage" && "$APP/.venv/bin/python" tests/test_events.py >/dev/null); then
  log "test failed, keeping the old code"; exit 1
fi
rsync -a --delete \
  --exclude .venv --exclude config --exclude models --exclude events --exclude snapshots \
  --exclude logs --exclude .deployed --exclude ollama-pull.log \
  "$stage/" "$APP/"
echo "$new" > "$APP/.deployed"
systemctl --user restart camera-ai.service
log "deployed ${new:0:7}, camera-ai restarted"
