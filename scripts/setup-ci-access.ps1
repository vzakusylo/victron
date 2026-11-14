# Requires PowerShell 7. Run by the repository owner, not by an agent: it creates credentials.
#
# One-time setup (and later rotation) of the five access secrets that the "Deploy Victron secrets"
# workflow needs to reach the Cerbo GX: GX_SSH_HOST, GX_SSH_KEY, GX_SSH_KNOWN_HOSTS,
# TS_OAUTH_CLIENT_ID, TS_OAUTH_SECRET. No value is printed: each one goes through a pipe or the
# hidden prompt of `gh secret set`. See scripts/SECRETS.md.
#
#   pwsh -NoProfile -File .\scripts\setup-ci-access.ps1 -GxHost 'root@<gx-tailscale-host>' -SshKey "$HOME\.ssh\<gx-key-file>"
#
#   -DryRun    print the steps, change nothing
#   -Rotate    make a new CI key even if one exists, and remove the old one from the GX
#   -SkipTailscale   only the three SSH secrets
param(
    [Parameter(Mandatory)][string]$GxHost,
    [Parameter(Mandatory)][string]$SshKey,
    [string]$Repo = 'vzakusylo/victron',
    [string]$CiKey = (Join-Path $HOME '.ssh\victron_ci_ed25519'),
    [string]$KnownHosts = (Join-Path $HOME '.ssh\known_hosts'),
    [switch]$Rotate,
    [switch]$SkipTailscale,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$comment = 'victron-ci-github-actions'
$names = @('GX_SSH_HOST', 'GX_SSH_KEY', 'GX_SSH_KNOWN_HOSTS', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET')

if ($GxHost -notmatch '^root@[A-Za-z0-9._-]+$') { throw 'GxHost must look like root@<host>; the workflow requires the root account.' }
$hostName = $GxHost.Substring(5)

function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Invoke-Ssh([string]$Key, [string]$Command) {
    $out = & ssh -i $Key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes `
        -o "UserKnownHostsFile=$KnownHosts" -o ConnectTimeout=15 $GxHost $Command
    if ($LASTEXITCODE -ne 0) { throw "SSH to the GX failed (exit $LASTEXITCODE)." }
    return $out
}
function Set-Secret([string]$Name, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "Empty value for $Name; not uploaded." }
    $null = $Value | & gh secret set $Name --repo $Repo 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh secret set $Name failed. Check: gh auth status --hostname github.com" }
    Write-Host "set $Name"
}

if ($DryRun) {
    Write-Host 'DRY RUN - nothing is created, changed or uploaded.'
    Write-Host "1. Check the existing SSH access to $GxHost with the pinned host key."
    Write-Host "2. Create the CI key $CiKey (ed25519, no passphrase, comment $comment) unless it exists; -Rotate replaces it."
    Write-Host '3. Add its public key to /root/.ssh/authorized_keys on the GX (one line with that comment) and log in with it.'
    Write-Host "4. gh secret set GX_SSH_KEY, GX_SSH_HOST, GX_SSH_KNOWN_HOSTS --repo $Repo (piped, not printed)."
    if (-not $SkipTailscale) { Write-Host '5. Ask you to create the Tailscale OAuth client; gh secret set TS_OAUTH_CLIENT_ID and TS_OAUTH_SECRET with hidden prompts.' }
    Write-Host "6. gh secret list --repo $Repo (names only)."
    Write-Host ('Secrets: ' + ($names -join ', '))
    return
}

foreach ($tool in 'ssh', 'ssh-keygen', 'gh') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH." }
}
if (-not (Test-Path $SshKey)) { throw "SSH key not found: $SshKey" }
Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
$env:GH_HOST = 'github.com'

Step "1/6 Existing access to $GxHost"
# StrictHostKeyChecking=yes: the host key must already be in known_hosts from a connection you trust.
$null = Invoke-Ssh $SshKey 'true'
$hostLines = @(& ssh-keygen -F $hostName -f $KnownHosts | Where-Object { $_ -and $_ -notmatch '^#' })
if (-not $hostLines.Count) { throw "No known_hosts entry for $hostName in $KnownHosts." }
Write-Host "ok, $($hostLines.Count) pinned host key line(s)"

Step '2/6 Dedicated CI key'
$oldPublic = $null
if ((Test-Path $CiKey) -and $Rotate) {
    $oldPublic = ((Get-Content "$CiKey.pub" -Raw).Trim() -split '\s+')[1]
    Move-Item $CiKey "$CiKey.old" -Force
    Move-Item "$CiKey.pub" "$CiKey.pub.old" -Force
}
if (-not (Test-Path $CiKey)) {
    & ssh-keygen -q -t ed25519 -N '' -C $comment -f $CiKey
    if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed.' }
    Write-Host "created $CiKey"
} else { Write-Host "kept the existing $CiKey (use -Rotate for a new one)" }
$public = (Get-Content "$CiKey.pub" -Raw).Trim()
if ($public -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+( \S+)?$') { throw 'Unexpected public key format.' }
$publicBody = ($public -split '\s+')[1]

Step '3/6 Authorize the CI key on the GX'
# The public key is not a secret. Idempotent: the line is added only if its key is not there yet.
$add = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qF '$publicBody' ~/.ssh/authorized_keys || echo '$public' >> ~/.ssh/authorized_keys"
$null = Invoke-Ssh $SshKey $add
$null = Invoke-Ssh $CiKey 'true'
Write-Host 'ok, the CI key logs in'
if ($oldPublic -and $oldPublic -ne $publicBody) {
    $drop = "grep -vF '$oldPublic' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.new && cat ~/.ssh/authorized_keys.new > ~/.ssh/authorized_keys; rm -f ~/.ssh/authorized_keys.new"
    $null = Invoke-Ssh $CiKey $drop
    Remove-Item "$CiKey.old", "$CiKey.pub.old" -Force
    Write-Host 'removed the previous CI key from the GX'
}

Step "4/6 SSH secrets -> $Repo"
Set-Secret 'GX_SSH_KEY' (Get-Content $CiKey -Raw)
Set-Secret 'GX_SSH_HOST' $GxHost
Set-Secret 'GX_SSH_KNOWN_HOSTS' ($hostLines -join "`n")

if (-not $SkipTailscale) {
    Step '5/6 Tailscale OAuth client (you create it)'
    Write-Host 'In https://login.tailscale.com/admin/settings/oauth :'
    Write-Host '  - Generate OAuth client, scope "Auth Keys" with write access, tag: tag:ci'
    Write-Host 'In the tailnet policy (Access controls) there must be:'
    Write-Host '  - "tagOwners": { "tag:ci": ["autogroup:admin"] }'
    Write-Host "  - a rule that lets tag:ci reach the GX ($hostName) on tcp:22"
    Write-Host 'Then paste the two values below. The prompts are hidden; nothing is echoed or stored on disk.'
    foreach ($name in 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET') {
        & gh secret set $name --repo $Repo
        if ($LASTEXITCODE -ne 0) { throw "gh secret set $name failed." }
    }
} else { Step '5/6 Tailscale skipped (-SkipTailscale)' }

Step '6/6 Secret names now in the repository (values are never shown)'
$listed = @(& gh secret list --repo $Repo --json name --jq '.[].name')
foreach ($name in $names) {
    Write-Host ($(if ($listed -contains $name) { '  ok       ' } else { '  MISSING  ' }) + $name)
}
Write-Host ''
Write-Host 'Next: run the workflow in check mode, then follow scripts/SECRETS.md for the first install.'
Write-Host "  gh workflow run deploy-victron.yml --repo $Repo --ref master -f action=check"
