# Step 1: generate a new long-lived Claude Code OAuth token (opens the browser to sign in).
# Copy the printed token, then run set-claude-review-token.ps1 without pasting it.
claude setup-token
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
