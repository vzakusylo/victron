# One command for step A: backup -> sanitize -> rebuild the test GX -> compare with the backup (and with the live GX).
# Usage: .\test-gx-refresh.ps1 [-BackupFile x.tar.gz] [-GxHost root@host -SshKey key] [-Days 14] [-NoLogs]
#   -BackupFile  default: newest grid-backup-*.tar.gz in C:\learn\test-gx-data\raw
#   -GxHost      also download the newest backup from the real GX (scp, read-only) and compare the image with the live flow
# Real backups contain secrets: they stay in $DataDir, outside the repository.
param(
    [string]$BackupFile,
    [string]$GxHost,
    [string]$SshKey,
    [int]$Days = 14,
    [switch]$NoLogs,
    [string]$Sim = 'emu',
    [string]$DataDir = 'C:\learn\test-gx-data'
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = (git -C $here rev-parse --show-toplevel).Trim() -replace '/', '\'
$raw = Join-Path $DataDir 'raw'; $san = Join-Path $DataDir 'sanitized'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

# Guard first, before anything is downloaded or created: real backups hold secrets and must stay outside the repository.
Step '0. guard: secrets stay outside the repository'
foreach ($p in @($raw, $san, $BackupFile) | Where-Object { $_ }) {
    if ([IO.Path]::GetFullPath($p).StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw "$p is inside the repository $repo" }
}
New-Item -ItemType Directory -Force $raw, $san | Out-Null

Step '1. backup'
$sshArgs = @(); if ($SshKey) { $sshArgs = @('-i', $SshKey, '-o', 'StrictHostKeyChecking=yes') }
if ($GxHost) {
    $remote = (ssh @sshArgs $GxHost "ls -t /data/home/nodered/grid-control-backups/grid-backup-*.tar.gz 2>/dev/null | head -n 1").Trim()
    if (-not $remote) { throw "no grid-backup-*.tar.gz in /data/home/nodered/grid-control-backups on $GxHost" }
    scp @sshArgs "${GxHost}:$remote" $raw; Check 'scp'
    $BackupFile = Join-Path $raw (Split-Path $remote -Leaf)
}
if (-not $BackupFile) { $BackupFile = (Get-ChildItem $raw -Filter 'grid-backup-*.tar.gz' | Sort-Object Name | Select-Object -Last 1).FullName }
if (-not $BackupFile -or -not (Test-Path $BackupFile)) { throw "no backup: put grid-backup-*.tar.gz into $raw or pass -BackupFile" }
$BackupFile = (Resolve-Path $BackupFile).Path
$name = [IO.Path]::GetFileName($BackupFile) -replace '\.tar\.gz$', ''
Write-Host $BackupFile

Step '2. guard: the downloaded backup is outside the repository'
foreach ($p in @($BackupFile)) {
    if ((Resolve-Path $p).Path.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw "$p is inside the repository $repo" }
}

Step '3. sanitize'
$out = Join-Path $san $name
$extra = @('--days', $Days); if ($NoLogs) { $extra += '--no-logs' }
node (Join-Path $here 'sanitize-backup.js') $BackupFile $out @extra
if ($LASTEXITCODE -ne 0) { throw "sanitizer stopped (exit $LASTEXITCODE): a secret may be left in the output, do not use $out" }

Step '4. rebuild (the gx-data volume would hide the new image content, so it is removed first)'
& (Join-Path $here 'up.ps1') -Down
& (Join-Path $here 'up.ps1') -Backup $out -Sim $Sim
Check 'up.ps1'

Step '5. wait for "Started flows"'
$deadline = (Get-Date).AddSeconds(120); $started = $false
while ((Get-Date) -lt $deadline) {
    if ((docker compose -f (Join-Path $here 'docker-compose.yml') logs nodered --no-log-prefix 2>&1 | Out-String) -match 'Started flows') { $started = $true; break }
    Start-Sleep 3
}
if (-not $started) { throw 'Node-RED did not report "Started flows" within 120 s' }
Start-Sleep 15   # let the flow's first errors reach the log

Step '6. ssh host key (it changes with every image)'
Remove-Item (Join-Path $HOME '.ssh\known_hosts_test_gx') -ErrorAction SilentlyContinue
if ((ssh -G test-gx | Select-String '^port 2222$') -eq $null) { throw 'ssh alias test-gx (Port 2222) is missing in ~/.ssh/config, see docs/test-gx.md' }

Step '7/8. compare'
$runs = Join-Path $DataDir ('runs\' + (Get-Date -Format 'yyyyMMdd-HHmmss')); New-Item -ItemType Directory -Force $runs | Out-Null
$cmp = @((Join-Path $here 'compare-image.js'), '--backup', $out, '--compose', $here, '--report', (Join-Path $runs 'report.json'))
if ($GxHost) {
    $live = Join-Path $runs 'live.b64'
    Get-Content -Raw (Join-Path $repo 'tools\gx\live-snapshot.js') | ssh @sshArgs $GxHost "tr -d '\r' | node -" | Set-Content $live -Encoding ascii
    Check 'live snapshot'
    $cmp += @('--live', $live)
}
node @cmp | Tee-Object (Join-Path $runs 'report.txt')
$code = $LASTEXITCODE
Write-Host "`nreport: $runs"
exit $code
