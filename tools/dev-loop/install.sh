#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${HOME}/victron-loop"
SRC="${SCRIPT_DIR}"
ENABLE_MARKER="${TARGET}/.enabled-once"

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

mkdir -p "${TARGET}"
rsync -a --delete \
  --exclude "tests" \
  --exclude "__pycache__" \
  --exclude ".pytest_cache" \
  --exclude "*.egg-info" \
  --exclude "venv" \
  --exclude "config.toml" \
  --exclude "token" \
  --exclude "logs" \
  --exclude "worktrees" \
  --exclude "repo" \
  --exclude ".enabled-once" \
  "${SRC}/" "${TARGET}/"

if [[ ! -d "${TARGET}/venv" ]]; then
  python3 -m venv "${TARGET}/venv"
fi
"${TARGET}/venv/bin/pip" install --upgrade pip
"${TARGET}/venv/bin/pip" install -r "${TARGET}/requirements.txt"

if [[ ! -f "${TARGET}/config.toml" ]]; then
  cp "${TARGET}/config.example.toml" "${TARGET}/config.toml"
fi
if [[ ! -d "${TARGET}/repo/.git" ]]; then
  git clone "https://github.com/vzakusylo/victron.git" "${TARGET}/repo"
else
  git -C "${TARGET}/repo" fetch origin
fi

mkdir -p "${HOME}/.config/systemd/user"
install -m 0644 "${TARGET}/systemd/victron-loop.service" "${HOME}/.config/systemd/user/victron-loop.service"
install -m 0644 "${TARGET}/systemd/victron-loop.timer" "${HOME}/.config/systemd/user/victron-loop.timer"
install -m 0644 "${TARGET}/systemd/victron-loop-web.service" "${HOME}/.config/systemd/user/victron-loop-web.service"
systemctl --user daemon-reload
if [[ ! -f "${ENABLE_MARKER}" ]]; then
  systemctl --user enable --now victron-loop.timer
  systemctl --user enable --now victron-loop-web.service
  touch "${ENABLE_MARKER}"
fi

