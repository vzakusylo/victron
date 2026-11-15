# Requires PowerShell 7. Run by the repository owner. The whole install of the private files on the
# Cerbo GX through the "Deploy Victron secrets" workflow, as one fixed sequence of steps: exactly what was
# done by hand on 15 Nov 2026. Node-RED is stopped for about two minutes. See docs/gx-handoff.md.
#
#   pwsh -NoProfile -File .\scripts\gx-secrets-install.ps1 -GxHost 'root@<gx-tailscale-host>' -SshKey "$HOME\.ssh\<gx-key-file>" -DryRun
#   ... (without -DryRun)           the real run; you approve two workflow runs in GitHub when it asks
#   ... -SkipSync                   do not refresh the GitHub copies from the GX first
#   ... -WaitWindowMin 45           wait up to 45 min for a moment without DHW cycle / defrost (default 0: stop if not safe)
#   ... -ApprovalTimeoutMin 10      how long Node-RED may stay stopped while the install run waits for approval
#   ... -MaxBackupAgeHours 24       the newest dashboard backup on the GX must be younger than this
#   ... -Steps                      only print the steps
#
# Safety: Node-RED is started again in every case in which this script stopped it (failure, timeout, Ctrl+C
# reaches the `finally`). The installer on the GX keeps the previous files and restores them on a failure.
#
# Exit code: 0 installed and healthy, 1 stopped by a check before anything changed, 2 failed after Node-RED was stopped.
param(
    [string]$GxHost,
    [string]$SshKey,
    [string]$Repo = 'vzakusylo/victron',
    [switch]$SkipSync,
    [int]$WaitWindowMin = 0,
    [int]$ApprovalTimeoutMin = 10,
    [int]$MaxBackupAgeHours = 24,
    [switch]$DryRun,
    [switch]$Steps
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$service = '/service/node-red-venus'
$workflow = 'deploy-victron.yml'
$required = @('GX_SSH_HOST', 'GX_SSH_KEY', 'GX_SSH_KNOWN_HOSTS', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET',
    'SECRETFILE_TUYA_CLOUD_JSON', 'SECRETFILE_TUYA_DEVICES_JSON', 'SECRETFILE_TUYA_LOCAL_SENSORS_JSON', 'SECRETFILE_TUYA_NODES_JSON',
    'SECRETFILE_EMAIL_JSON', 'SECRETFILE_MCP_TOKEN_TXT', 'SECRETFILE_SETTINGS_USER_JS', 'SECRETFILE_FLOWS_CRED_JSON',
    'SECRETFILE__CONFIG_RUNTIME_JSON', 'SECRETFILE__CONFIG_USERS_JSON', 'SECRETFILE_VENUS_SETTINGS_JS')

$stepList = @(
    '1 preflight   gh login, all secret names present, SSH to the GX, Node-RED up, a recent dashboard backup exists'
    '2 sync        copy the 11 private files from the GX to the GitHub secrets (skipped with -SkipSync)'
    '3 check       run the workflow in check mode; YOU approve it; it must succeed'
    '4 window      no DHW cycle, no rule sequence, no defrost due (tools/gx/window.js --for stop)'
    '5 dispatch    start the workflow in install mode, then stop Node-RED and confirm it is down'
    '6 approve     YOU approve the run; wait for it; on timeout or failure start Node-RED again'
    '7 compare     installed files vs the copies the installer kept; local check of the secret mappings'
    '8 start       start Node-RED, wait until the automations tick, print the monitor'
)
if ($Steps) { $stepList | ForEach-Object { Write-Output $_ }; return }
if (-not $GxHost -or -not $SshKey) { throw 'GxHost and SshKey are required (see the header of this script).' }
if ($GxHost -notmatch '^root@[A-Za-z0-9._-]+$') { throw 'GxHost must look like root@<host>.' }

$ssh = @('-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')
$stopped = $false
$started = $false

function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Stop-Run([string]$Text) { Write-Host "STOPPED: $Text" -ForegroundColor Yellow; exit ($stopped ? 2 : 1) }
function Invoke-Gx([string]$Command) { $out = & ssh @ssh $GxHost $Command; return @{ Text = ($out -join "`n"); Code = $LASTEXITCODE } }
function Invoke-OnGx([string]$Script, [string]$Arguments) {
    $out = Get-Content -Raw (Join-Path $root $Script) | & ssh @ssh $GxHost "tr -d '\r' | node - $Arguments"
    return @{ Text = ($out -join "`n"); Code = $LASTEXITCODE }
}
# Starts a run and returns its id: gh prints the run URL; older versions print nothing, then the newest run is taken.
function Start-Workflow([string[]]$Fields) {
    $before = Get-Date
    $out = & gh workflow run $workflow --repo $Repo --ref master @Fields 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh workflow run failed: $out" }
    if ("$out" -match '/actions/runs/(\d+)') { return $Matches[1] }
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 3
        $run = & gh run list --repo $Repo --workflow $workflow --limit 1 --json databaseId,createdAt | ConvertFrom-Json
        if ($run -and ([datetime]$run[0].createdAt).ToUniversalTime() -ge $before.ToUniversalTime().AddSeconds(-30)) { return "$($run[0].databaseId)" }
    }
    throw 'The new workflow run was not found.'
}
function Wait-Run([string]$Id, [int]$Minutes) {
    Write-Host "APPROVE NOW: https://github.com/$Repo/actions/runs/$Id  (Review deployments -> victron-gx -> Approve and deploy)" -ForegroundColor Magenta
    $deadline = (Get-Date).AddMinutes($Minutes); $last = ''
    while ((Get-Date) -lt $deadline) {
        $state = & gh run view $Id --repo $Repo --json status,conclusion --jq '"\(.status)/\(.conclusion)"' 2>$null
        if ("$state" -ne $last) { Write-Host ("  " + (Get-Date -Format 'HH:mm:ss') + " $state"); $last = "$state" }
        if ("$state" -like 'completed/*') { return ("$state" -replace '^completed/', '') }
        Start-Sleep -Seconds 10
    }
    return 'timeout'
}

if ($DryRun) { Write-Host 'DRY RUN - only the read-only preflight (step 1) and the window check (step 4) are executed.' }

try {
    Step '1/8 preflight'
    Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
    $env:GH_HOST = 'github.com'
    $names = @(& gh secret list --repo $Repo --json name --jq '.[].name')
    if ($LASTEXITCODE -ne 0) { Stop-Run 'gh cannot list the secrets; run: gh auth login --hostname github.com' }
    $missing = @($required | Where-Object { $names -notcontains $_ })
    if ($missing.Count) { Stop-Run "secrets missing in GitHub: $($missing -join ', '). See scripts/SECRETS.md." }
    $state = Invoke-Gx "svstat $service; ls -t /data/home/nodered/grid-control-backups/grid-backup-*.tar.gz 2>/dev/null | head -n 1 | while read f; do echo BACKUP `$(( (`$(date +%s) - `$(date -r `"`$f`" +%s)) / 3600 )) `$f; done"
    if ($state.Code -ne 0) { Stop-Run 'SSH to the GX failed.' }
    if ($state.Text -notmatch ': up \(pid') { Stop-Run 'Node-RED is not running on the GX; start and check it first.' }
    if ($state.Text -notmatch 'BACKUP (\d+) (\S+)') { Stop-Run 'no dashboard backup on the GX; create one on the Backup page first.' }
    $backupAge = [int]$Matches[1]
    Write-Host "secret names ok ($($required.Count)), Node-RED up, newest backup $backupAge h old: $($Matches[2])"
    if ($backupAge -gt $MaxBackupAgeHours) { Stop-Run "the newest backup is older than $MaxBackupAgeHours h; create a new one on the Backup page." }

    Step '2/8 sync the GitHub copies from the GX'
    if ($SkipSync) { Write-Host 'skipped (-SkipSync)' }
    elseif ($DryRun) { Write-Host 'would run scripts\sync-secrets.ps1 -FromGx (reads 11 files from the GX, uploads 14 secrets)' }
    else {
        & (Join-Path $PSScriptRoot 'sync-secrets.ps1') -FromGx -GxHost $GxHost -SshKey $SshKey | Where-Object { $_ -match '^(Collected|Updated)' } | Measure-Object | ForEach-Object { Write-Host "$($_.Count) lines: files collected and secrets updated" }
    }

    Step '3/8 workflow in check mode'
    if ($DryRun) { Write-Host 'would dispatch action=check and wait for your approval and its success' }
    else {
        $check = Start-Workflow @('-f', 'action=check')
        $result = Wait-Run $check 30
        if ($result -ne 'success') { Stop-Run "the check run ended with '$result'. Nothing on the GX was changed." }
    }

    Step '4/8 window'
    $deadline = (Get-Date).AddMinutes($WaitWindowMin)
    do {
        $window = Invoke-OnGx 'tools\gx\window.js' '--for stop'
        Write-Host $window.Text
        if ($window.Code -eq 0 -or $DryRun -or (Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 60
    } while ($true)
    if ($window.Code -gt 1) { Stop-Run 'the state of the automations could not be read.' }
    if ($DryRun) { Write-Host ''; Write-Host 'DRY RUN finished; steps 5-8 were not executed:'; $stepList | Select-Object -Skip 4 | ForEach-Object { Write-Host "  $_" }; exit 0 }
    if ($window.Code -ne 0) { Stop-Run 'not a safe moment to stop Node-RED (see above). Run again later or pass -WaitWindowMin <minutes>.' }

    Step '5/8 dispatch the install and stop Node-RED'
    $install = Start-Workflow @('-f', 'action=install', '-f', 'confirm=overwrite-gx-private-files')
    $down = Invoke-Gx "svc -d $service; i=0; while [ `$i -lt 20 ]; do case `"`$(svstat $service)`" in *': down '*) break;; esac; i=`$((i+1)); sleep 1; done; svstat $service"
    $stopped = $true
    if ($down.Text -notmatch ': down ') { Stop-Run 'Node-RED did not stop.' }
    Write-Host ("Node-RED stopped at " + (Get-Date -Format 'HH:mm:ss'))

    Step '6/8 your approval, then the install'
    $result = Wait-Run $install $ApprovalTimeoutMin
    if ($result -ne 'success') {
        if ($result -eq 'timeout') { & gh run cancel $install --repo $Repo 2>$null | Out-Null }
        Stop-Run "the install run ended with '$result'. The installer restores the previous files on a failure; Node-RED is started again now."
    }
    $log = & gh run view $install --repo $Repo --log 2>$null
    $kept = ($log | Select-String -Pattern 'previous copies: (/data/home/nodered/\.node-red/backup-pre-secret-deploy-[A-Za-z0-9]+)' | Select-Object -Last 1)
    if (-not $kept) { Stop-Run 'the install log does not name the folder with the previous copies.' }
    $keptDir = $kept.Matches[0].Groups[1].Value
    Write-Host "installed; previous copies: $keptDir"

    Step '7/8 installed files vs the previous copies'
    $compare = Invoke-Gx @"
cd /data/home/nodered || exit 1; B=$keptDir; bad=0
for f in tuya-cloud.json tuya-devices.json tuya-local-sensors.json tuya-nodes.json email.json mcp-token.txt; do
  if [ ! -e `$B/config/`$f ]; then echo "new    `$f"; elif cmp -s grid-control-config/`$f `$B/config/`$f; then echo "same   `$f"; else echo "CHANGED `$f"; fi
done
if cmp -s .node-red/settings-user.js `$B/node-red/settings-user.js; then echo "same   settings-user.js"; else echo "CHANGED settings-user.js"; fi
for f in victron-secrets.js reload-victron-secrets.js; do
  if [ -e `$B/tools/`$f ] && tr -d '\r' < `$B/tools/`$f | cmp -s - tools/`$f; then echo "same   `$f"; else echo "CHANGED `$f"; fi
done
node tools/reload-victron-secrets.js check || bad=1
exit `$bad
"@
    Write-Host $compare.Text
    if ($compare.Code -ne 0) { Stop-Run 'the installed secret files do not pass the local check; Node-RED is started again now with what is installed. Restore from the folder above if devices do not connect.' }
    if ($compare.Text -match 'CHANGED') { Write-Host 'Files marked CHANGED differ from what the GX had: expected only if you changed them on purpose.' -ForegroundColor Yellow }
}
finally {
    if ($stopped) {
        Step '8/8 start Node-RED'
        $up = Invoke-Gx "svc -u $service; sleep 3; svstat $service"
        $started = $up.Text -match ': up \(pid'
        Write-Host $up.Text
        if (-not $started) { Write-Host "NODE-RED DID NOT START. On the GX: svc -u $service ; tail /var/log/node-red-venus/current" -ForegroundColor Red }
    }
}
if (-not $started) { exit 2 }

# The flows need about a minute; the automations publish their view on the first tick.
$monitor = $null
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 15
    $monitor = Invoke-OnGx 'tools\gx\monitor.js' ''
    if ($monitor.Text -match 'OK\s+automations\s+ticking' -and $monitor.Text -notmatch 'FAIL\s+device') { break }
}
Write-Host $monitor.Text
if ($monitor.Code -ge 2) { Write-Host 'The monitor reports FAIL: look at the Heat Pump page and the Node-RED log now.' -ForegroundColor Red; exit 2 }
Write-Host ''
Write-Host 'DONE: the private files are installed from GitHub and Node-RED is running.' -ForegroundColor Green
Write-Host 'DHW may say "no outdoor value yet" for a while after the restart. Add a row to docs/heat-pump-work-log.md.'
exit 0
