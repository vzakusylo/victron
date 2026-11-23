# Step 2: store the token as the GitHub secret used by the Claude PR review workflow.
# Copy the whole token (it may wrap over several lines in the console), then run this script.
# It reads the clipboard and removes line breaks/spaces, so a wrapped token is joined correctly.
param([string]$Repo = 'vzakusylo/victron', [string]$Name = 'CLAUDE_CODE_OAUTH_TOKEN')

$ErrorActionPreference = 'Stop'
try {
    $token = ([string](Get-Clipboard -Raw)) -replace '\s', ''
    if ($token -cnotmatch '^sk-ant-oat01-[A-Za-z0-9_-]+$') {
        throw 'Clipboard does not contain a Claude Code OAuth token. Copy the whole token and run again.'
    }

    # Pass via stdin so the token never appears on the command line or in history.
    $token | gh secret set $Name --repo $Repo
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI failed to update secret $Name in $Repo." }
} finally {
    $token = $null
    Set-Clipboard -Value ' '
}
Write-Host "Secret $Name updated in $Repo."
