#!/usr/bin/env bash
# One-time owner setup of the AUTO1 dev loop on the Omarchy box.
# Run ON Omarchy in an interactive terminal (it asks for the token; it is never echoed or logged):
#   scp tools/dev-loop/setup-omarchy.sh tools/dev-loop/rotate-token.sh omarchy:~/
#   ssh -t omarchy 'bash ~/setup-omarchy.sh'         # checks + token
#   ssh -t omarchy 'bash ~/setup-omarchy.sh --live'  # also switch dry_run off
# Steps: 1 runner service, 2 fine-grained token, 3 Copilot CLI login, 4 loop install / timer, 5 optional --live.
# Safe to re-run. Never prints the token. Changes only ~/victron-loop/{token,config.toml}.
set -euo pipefail

HOME_DIR="${HOME}/victron-loop"
CONFIG="${HOME_DIR}/config.toml"
LIVE=0
RUNNER_UNIT="actions-runner-victron.service"
[[ "${1:-}" == "--live" ]] && LIVE=1
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

echo "1. GitHub Actions runner (label omarchy)"
if systemctl --user is-active --quiet "${RUNNER_UNIT}"; then
  ok "${RUNNER_UNIT} is active"
else
  warn "${RUNNER_UNIT} is not active; starting it"
  systemctl --user start "${RUNNER_UNIT}" && ok "started" || fail "could not start; check: journalctl --user -u ${RUNNER_UNIT} -n 50"
fi
if command -v loginctl >/dev/null && [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  warn "linger is off: user units stop when you log out. Enable with: sudo loginctl enable-linger $USER"
fi

echo "2. Fine-grained GitHub token for the loop (vzakusylo/victron only)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rotate="$script_dir/rotate-token.sh"
if [[ ! -f "$rotate" ]]; then rotate="$HOME/rotate-token.sh"; fi
if [[ ! -f "$rotate" ]]; then
  fail "rotate-token.sh is missing; copy both setup-omarchy.sh and rotate-token.sh to Omarchy."
  exit 1
fi
bash "$rotate" --ensure

echo "3. Copilot CLI (workers run 'copilot' here)"
if command -v copilot >/dev/null; then
  if timeout 120 nice -n 19 copilot -p "Reply with the single word: ready" </dev/null 2>&1 | grep -qi ready; then
    ok "copilot answers"
  else
    fail "copilot did not answer; run 'copilot' once interactively and log in (/login)"
  fi
else
  fail "copilot not on PATH"
fi

echo "4. Loop install and timer"
if [[ -x "${HOME_DIR}/venv/bin/python" && -f "${CONFIG}" ]]; then
  ok "installed in ${HOME_DIR}"
else
  fail "not installed yet: dispatch victron-langchain-dev-dashboard with dry_run_only off (needs the runner from step 1)"
fi
systemctl --user is-enabled --quiet victron-loop.timer 2>/dev/null && ok "victron-loop.timer enabled" || warn "victron-loop.timer not enabled (the deploy enables it on first install)"
systemctl --user list-timers victron-loop.timer --no-pager 2>/dev/null | sed -n '1,2p' || true

echo "5. Mode"
if [[ -f "${CONFIG}" ]]; then
  if [[ ${LIVE} -eq 1 ]]; then
    sed -i 's/^dry_run *= *true/dry_run = false/' "${CONFIG}"
    ok "dry_run = false (live). Undo: sed -i 's/^dry_run = false/dry_run = true/' ${CONFIG}"
  else
    grep -q '^dry_run *= *false' "${CONFIG}" && ok "live (dry_run = false)" || ok "dry run (re-run with --live after the dry-run log looks right)"
  fi
  echo "   Last decisions:"; tail -n 5 "${XDG_STATE_HOME:-$HOME/.local/state}/victron-loop/decisions.jsonl" 2>/dev/null || echo "   (none yet)"
fi
