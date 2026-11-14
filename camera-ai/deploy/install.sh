#!/usr/bin/env bash
# One-time setup on the camera host (no sudo): user services for Ollama, camera-ai and the
# 5-minute update timer. Needs `loginctl enable-linger $USER` to run without a login.
set -euo pipefail
D="$HOME/.config/systemd/user"
mkdir -p "$D"
cp "$(dirname "$0")"/systemd/*.service "$(dirname "$0")"/systemd/*.timer "$D/"
systemctl --user daemon-reload
systemctl --user enable --now ollama.service camera-ai.service camera-ai-update.timer
systemctl --user list-timers camera-ai-update.timer --no-pager
