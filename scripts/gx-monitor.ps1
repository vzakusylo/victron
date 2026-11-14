# Requires PowerShell 7. Read-only: health of the heat pump automations on the GX and, with -Drift,
# the difference between the live flow and a commit. Changes nothing on the GX. See docs/gx-deploy.md.
#
#   pwsh -NoProfile -File .\scripts\gx-monitor.ps1 -GxHost 'root@<gx-tailscale-host>' -SshKey "$HOME\.ssh\<gx-key-file>"
#   ... -Drift                    also compare the live flow with origin/master (fetch first)
#   ... -Drift -Commit <sha>      compare with another commit
#   ... -Json                     the collected data and the findings as JSON (no drift)
#   ... -Watch 300                repeat every 300 s until Ctrl+C; prints only when the status changes
#
# Exit code: 0 OK, 1 WARN, 2 FAIL, 3 the GX could not be read.
param(
    [Parameter(Mandatory)][string]$GxHost,
    [Parameter(Mandatory)][string]$SshKey,
    [switch]$Drift,
    [string]$Commit = 'origin/master',
    [switch]$Json,
    [int]$Watch = 0
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$ssh = @('-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', $GxHost)

function Invoke-Remote([string]$Script, [string]$Arguments) {
    # tr removes the carriage returns PowerShell adds; `node -` reads the script from stdin.
    $out = Get-Content -Raw (Join-Path $root $Script) | & ssh @ssh "tr -d '\r' | node - $Arguments"
    return @{ Text = ($out -join "`n"); Code = $LASTEXITCODE }
}

function Get-Status {
    $run = Invoke-Remote 'tools\gx\monitor.js' ($Json ? '--json' : '')
    if ($run.Code -gt 2 -or -not $run.Text) { return @{ Text = "MONITOR ERROR: the GX could not be read (exit $($run.Code))."; Code = 3 } }
    if ($Json -or -not $Drift) { return $run }

    $snapshot = New-TemporaryFile
    try {
        $live = Invoke-Remote 'tools\gx\live-snapshot.js' ''
        if ($live.Code -ne 0 -or -not $live.Text) { return @{ Text = $run.Text + "`nWARN drift           the live flow could not be read"; Code = [Math]::Max($run.Code, 1) } }
        [IO.File]::WriteAllText($snapshot, $live.Text)
        $report = & node (Join-Path $root 'tools\gx\compare.js') $snapshot --commit $Commit 2>&1
        if ($LASTEXITCODE -ne 0) { return @{ Text = $run.Text + "`nWARN drift           comparison failed: $report"; Code = [Math]::Max($run.Code, 1) } }
        $count = { param($title) $m = $report | Select-String -Pattern "^$title.*\((\d+)\)$" | Select-Object -First 1; if ($m) { [int]$m.Matches[0].Groups[1].Value } else { -1 } }
        $code = & $count 'code differs'; $onlyLive = & $count 'only on the GX'; $onlyRepo = & $count 'only in the repository'
        $bad = $code + $onlyLive + $onlyRepo
        $line = if ($bad -eq 0) { "OK   drift           the live code equals $Commit" }
                else { "WARN drift           $code node(s) differ in code, $onlyLive only on the GX, $onlyRepo only in the repository (vs $Commit); run tools/gx/compare.js" }
        $text = ($run.Text -replace "`nSTATUS: \w+$", '') + "`n" + $line
        $worst = [Math]::Max($run.Code, [int]($bad -ne 0))
        return @{ Text = $text + "`nSTATUS: " + @('OK', 'WARN', 'FAIL')[$worst]; Code = $worst }
    }
    finally { Remove-Item $snapshot -Force -ErrorAction SilentlyContinue }
}

if ($Watch -le 0) {
    $status = Get-Status
    Write-Output $status.Text
    exit $status.Code
}
$last = $null
while ($true) {
    $status = Get-Status
    # Compare without the minute counters, so an unchanged state is not printed again.
    $key = ($status.Text -replace '\d+ min', 'N min' -replace '\d+(\.\d+)? °C', 'N °C' -replace '\d+ Hz', 'N Hz' -replace 'lag -?\d+(\.\d+)?', 'lag N')
    if ($key -ne $last) { Write-Output ('--- ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')); Write-Output $status.Text; $last = $key }
    Start-Sleep -Seconds $Watch
}
