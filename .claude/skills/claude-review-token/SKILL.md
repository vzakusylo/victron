---
name: claude-review-token
description: Generate a new Claude Code OAuth token and store it as the CLAUDE_CODE_OAUTH_TOKEN GitHub Actions secret used by the Claude PR review workflow (claude-code-review.yml). Use when the owner says "update Claude review token", "use the token from this account", "rotate CLAUDE_CODE_OAUTH_TOKEN", or the `review` check fails to authenticate.
---

# Claude review token

The `review` check (`.github/workflows/claude-code-review.yml`) runs `anthropics/claude-code-action` with
`claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`. The token decides which Claude account pays for
the reviews. To switch accounts or rotate it, replace that repository secret; no workflow change is needed.

**The owner runs both scripts in a private terminal without transcription or screen sharing.** Agents never
ask for, read, print or paste the token. If any part is exposed in chat, a log or a command line, revoke and
replace the token.

1. Generate a token. A browser sign-in opens: sign in with the Claude account that should pay for the reviews.
   ```powershell
   & ".\.claude\skills\claude-review-token\new-claude-token.ps1"
   ```
2. Copy the whole printed `sk-ant-oat01-...` token (it may wrap over several console lines).
3. Store it from the clipboard. The script joins wrapped lines and sends the token to `gh` through stdin
   without displaying any part of it. It then clears the current clipboard; avoid clipboard history or sync
   when copying the token.
   ```powershell
   & ".\.claude\skills\claude-review-token\set-claude-review-token.ps1"
   ```
   Defaults: repo `vzakusylo/victron`, secret `CLAUDE_CODE_OAUTH_TOKEN`; override with `-Repo owner/name -Name SECRET`.

## Verify

- `gh secret list --repo vzakusylo/victron`: `CLAUDE_CODE_OAUTH_TOKEN` shows today's date (names only, never values).
- The next PR's `review` check runs; or comment `@claude review` on an open PR.
