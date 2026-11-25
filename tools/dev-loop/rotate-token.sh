#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
unset GH_DEBUG

repo=vzakusylo/victron
home="$HOME/victron-loop"
file="$home/token"
meta="$home/token.meta"
expires=""

usage() { echo "Usage: bash rotate-token.sh [--check | --rollback | --ensure]"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "${1:-}" in
  ""|--check|--rollback|--ensure) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

validate() {
  local candidate="$1" response header repositories
  if [[ "$candidate" != github_pat_* ]]; then
    echo "Warning: token does not have the fine-grained github_pat_ prefix." >&2
  fi
  response="$(GH_TOKEN="$candidate" gh api --hostname github.com --include "repos/$repo" 2>/dev/null)" || {
    echo "GitHub token validation failed: cannot read $repo." >&2
    return 1
  }
  GH_TOKEN="$candidate" gh api --hostname github.com --silent "repos/$repo/pulls?state=open&per_page=1" >/dev/null 2>&1 || {
    echo "GitHub token validation failed: cannot read pull requests." >&2
    return 1
  }
  GH_TOKEN="$candidate" gh api --hostname github.com --silent "repos/$repo/actions/runs?per_page=1" >/dev/null 2>&1 || {
    echo "GitHub token validation failed: cannot read Actions runs." >&2
    return 1
  }
  expires=""
  header="$(awk 'tolower($0) ~ /^github-authentication-token-expiration:/ {
    sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit
  }' <<< "$response")"
  if [[ -n "$header" ]]; then
    expires="$(date -u -d "$header" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || {
      echo "Warning: GitHub's token expiration header could not be parsed." >&2
      expires=""
    }
  fi
  if repositories="$(GH_TOKEN="$candidate" gh api --hostname github.com 'user/repos?per_page=2' --jq length 2>/dev/null)"; then
    if [[ "$repositories" =~ ^[0-9]+$ ]] && (( repositories > 1 )); then
      echo "Warning: this token can list more than one repository; verify its scope." >&2
    fi
  else
    echo "Warning: could not verify the token's repository count; check the selected repository in GitHub." >&2
  fi
}

report_expiry() {
  local remaining
  if [[ -z "$expires" ]]; then
    echo "Expiry unavailable: GitHub did not report an expiration."
    return
  fi
  remaining=$(( $(date -u -d "$expires" +%s) - $(date -u +%s) ))
  if (( remaining <= 0 )); then
    printf 'Expires: %s (expired)\n' "$expires"
  else
    printf 'Expires: %s (%d days remaining)\n' "$expires" "$(( (remaining + 86399) / 86400 ))"
  fi
}

if [[ "${1:-}" == --check ]]; then
  [[ -s "$file" ]] || fail "No loop token is installed. Run rotate-token.sh on Omarchy."
  validate "$(cat "$file")" || exit 1
  echo "Loop token validated."
  report_expiry
  exit 0
fi

mkdir -p "$home"
exec 9>"$home/.token-rotation.lock"
flock -n 9 || fail "Another token rotation is in progress."
if [[ "${1:-}" == --ensure && -s "$file" ]] && validate "$(cat "$file")"; then
  if [[ ! -s "$meta" && -n "$expires" ]]; then
    metadata="$(mktemp "$home/.token-rotation.meta.XXXXXX")"
    trap 'rm -f -- "$metadata"' EXIT
    printf '{"token_rotated_at":null,"expires_at":"%s"}\n' "$expires" > "$metadata"
    mv -fT -- "$metadata" "$meta"
  fi
  echo "Existing loop token validated."
  report_expiry
  exit 0
fi

if [[ "${1:-}" == --rollback ]]; then
  [[ -s "$file.prev" ]] || fail "No previous loop token to restore."
  token="$(cat "$file.prev")"
  validate "$token" || exit 1
else
  suffix="$(date -u +%Y%m%d)"
  cat <<EOF
Open GitHub's fine-grained token form:
  https://github.com/settings/personal-access-tokens/new?name=victron-dev-loop-$suffix&target_name=vzakusylo&expires_in=90&contents=write&pull_requests=write&actions=read&workflows=write
Before Generate, verify:
  - Resource owner: vzakusylo; Only select repositories: victron only.
  - Expiration: 90 days.
  - Repository permissions: Contents Read and write; Pull requests Read and write;
    Actions Read; Workflows Read and write; Metadata Read (automatic).
EOF
  if ! read -r -s -p "Paste the new token (hidden): " token </dev/tty; then
    fail "An interactive terminal is required to enter the token. Use ssh -t and run the copied script."
  fi
  echo
  [[ -n "$token" ]] || fail "No token entered; nothing changed."
  validate "$token" || exit 1
fi

stage="$(mktemp -d "$home/.token-rotation.XXXXXX")"
trap 'rm -f -- "$stage/token.new" "$stage/token.prev" "$stage/token.meta"; rmdir -- "$stage"' EXIT
printf '%s\n' "$token" > "$stage/token.new"
chmod 600 "$stage/token.new"
unset token
rotated="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ -n "$expires" ]]; then
  printf '{"token_rotated_at":"%s","expires_at":"%s"}\n' "$rotated" "$expires" > "$stage/token.meta"
else
  printf '{"token_rotated_at":"%s","expires_at":null}\n' "$rotated" > "$stage/token.meta"
fi
if [[ -s "$file" ]]; then
  cat "$file" > "$stage/token.prev"
  chmod 600 "$stage/token.prev"
  mv -fT -- "$stage/token.prev" "$file.prev"
fi
mv -fT -- "$stage/token.new" "$file"
mv -fT -- "$stage/token.meta" "$meta"
echo "Loop token installed."
report_expiry

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [[ -x "$home/venv/bin/python" && -f "$home/config.toml" ]]; then
  if systemctl --user is-active --quiet victron-loop-web.service; then
    systemctl --user restart victron-loop-web.service || fail "Token installed, but restarting the dashboard failed."
  fi
  status=0
  result="$(cd "$home" && ./venv/bin/python -m victron_loop.main --config config.toml run-once --dry-run 2>&1)" || status=$?
  if [[ "$status" == 2 && "$result" == *"another run is in progress"* ]]; then
    fail "Token installed, but the smoke test was blocked by an active loop run. Run a dry tick after it finishes."
  elif (( status != 0 )); then
    fail "Token installed, but the loop dry run failed. See the loop's run log."
  fi
  if [[ "$result" =~ token-missing|token-invalid|gh-observation-error ]]; then
    fail "Token installed, but the loop reported a GitHub access error. See the dashboard."
  fi
  echo "Loop dry run passed."
else
  echo "Loop is not installed yet; run the deploy workflow before the smoke test."
fi
echo "Revoke the previous token in GitHub → Settings → Fine-grained tokens after verifying the new token."
