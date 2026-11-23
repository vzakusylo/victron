# Requires PowerShell 7. The whole code deploy to the Cerbo GX as one fixed sequence of steps.
# Default is a DRY RUN that changes nothing on the GX; add -Apply to deploy. See docs/gx-handoff.md.
#
#   pwsh -NoProfile -File .\scripts\gx-deploy.ps1 -GxHost 'root@<gx-tailscale-host>' -SshKey "$HOME\.ssh\<gx-key-file>"
#   ... -Apply                      really deploy (after reading the dry-run output)
#   ... -Commit <sha>               another commit than origin/master (it must be pushed)
#   ... -WaitWindowMin 30           with -Apply: wait up to 30 min for a moment without DHW cycle / defrost
#   ... -AllowLiveOnlyLines         deploy although the GX has code lines that the commit does not have
#   ... -AllowReplaceDeployedLines  allow GX-only replacements only when live code matches its recorded deployment
#   ... -AllowNewNodes              plan and deploy reviewed additions from the commit (review the dry run first)
#   ... -AllowRemovedNodes 'a,b'    remove exactly these Git-verified nodes (review the dry run first)
#   ... -AllowNewWires 'a,b'        review wiring changes from these sources against the recorded commit
#   ... -UseWorkTreeScripts         development only: run the scripts of the work tree (the deployed files still come from the commit)
#   ... -Steps                      only print the steps
#
# Deterministic: every script that runs (on the PC and on the GX) and every deployed file is taken from
# the commit, never from the work tree, and the GX downloads the files by SHA and checks their SHA-256.
# All output is kept in a run folder under the system temp directory (printed at the start).
#
# Exit code: 0 done / nothing to do, 1 stopped by a check (nothing changed), 2 failed after a change started.
param(
    [string]$GxHost,
    [string]$SshKey,
    [string]$Commit = 'origin/master',
    [switch]$Apply,
    [int]$WaitWindowMin = 0,
    [switch]$AllowLiveOnlyLines,
    [switch]$AllowReplaceDeployedLines,
    [switch]$AllowNewNodes,
    [string]$AllowRemovedNodes,
    [string]$AllowNewWires,
    [switch]$UseWorkTreeScripts,
    [string]$RunDirectory,
    [switch]$Steps
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot

$stepList = @(
    '1 preflight   fetch, resolve the commit, check that it is pushed, extract the scripts of the commit'
    '2 snapshot    read the live flow from the GX (read-only)'
    '3 compare     live code vs the commit; stop on removals or unapproved additions / GX-only code lines'
    '4 plan        write the deploy plan: nodes, tool files, hashes, expected live revision'
    '5 window      no DHW cycle, no running rule sequence, no defrost (read-only)'
    '6 dry run     all checks of tools/gx/deploy.js on the GX, nothing changed'
    '7 deploy      only with -Apply: backup, tool files, POST, read back'
    '8 verify      label, log, automations; snapshot again: the live code must equal the commit'
)
if ($Steps) { $stepList | ForEach-Object { Write-Output $_ }; return }
if (-not $GxHost -or -not $SshKey) { throw 'GxHost and SshKey are required (see the header of this script).' }
if ($GxHost -notmatch '^[A-Za-z0-9_.-]+@[A-Za-z0-9._-]+$') { throw 'GxHost must look like root@<host>.' }

# Scripts that run on the GX and are kept there in /data/home/nodered/tools (a tool that is equal is skipped).
# The secret loader (victron-secrets.js, reload-victron-secrets.js) belongs to the secret workflow, not here.
$gxTools = @(
    'tools/gx/live-snapshot.js', 'tools/gx/deploy.js', 'tools/gx/node-additions.js', 'tools/gx/verify.js', 'tools/gx/monitor.js', 'tools/gx/window.js',
    'tools/send-mail.js', 'tools/camera-mail-gate.js', 'tools/tuya-cloud-sensors.js', 'tools/tuya-cloud-status.js', 'tools/tuya-devices-setup.js',
    'tools/tuya-local-poll.js', 'tools/tuya-local-sensors.js'
)
$ssh = @('-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')
$run = $RunDirectory ? [IO.Path]::GetFullPath($RunDirectory) :
    (Join-Path ([IO.Path]::GetTempPath()) ('gx-deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
New-Item -ItemType Directory $run | Out-Null
$changed = $false

function Step([string]$Text) { $script:stage = $Text; Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Stop-Run([string]$Text, [string]$PublicReason = "A dry-run check failed at '$stage'.",
    [string]$Next = 'Open the Deploy from master step, fix the STOPPED or ABORT cause, then rerun in dry-run mode.') {
    Write-Host "STOPPED: $Text" -ForegroundColor Yellow
    Write-Host "run folder: $run"
    if (-not $Apply -and $env:GITHUB_STEP_SUMMARY) {
        # Do not publish raw SSH output, live code, or node IDs.
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "### GX dry run stopped`n`n$PublicReason`n`nNext: $Next`n"
    }
    exit ($changed ? 2 : 1)
}
function Invoke-Git { $out = & git -C $root @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed." }; return $out }
function Save-GitBlob([string]$CommitSha, [string]$Path, [string]$Destination) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'git'
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.ArgumentList.Add('-C')
    $startInfo.ArgumentList.Add($root)
    $startInfo.ArgumentList.Add('cat-file')
    $startInfo.ArgumentList.Add('blob')
    $startInfo.ArgumentList.Add("${CommitSha}:$Path")
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Could not start git cat-file for $Path." }
    $stderr = $process.StandardError.ReadToEndAsync()
    $output = [IO.File]::Create($Destination)
    try { $process.StandardOutput.BaseStream.CopyTo($output) }
    finally { $output.Dispose() }
    $process.WaitForExit()
    $errorText = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        throw "git cat-file failed for ${CommitSha}:$Path. $errorText"
    }
}
# A script of the commit, piped to `node -` on the GX; tr removes the carriage returns PowerShell adds.
function Invoke-OnGx([string]$Script, [string]$Arguments) {
    $out = Get-Content -Raw (Join-Path $run $Script) | & ssh @ssh $GxHost "tr -d '\r' | node - $Arguments"
    return @{ Text = ($out -join "`n"); Code = $LASTEXITCODE }
}
function Save([string]$Name, [string]$Text) { [IO.File]::WriteAllText((Join-Path $run $Name), $Text + "`n") }

Write-Host "run folder: $run"
Write-Host ('mode: ' + ($Apply ? 'APPLY' : 'dry run (add -Apply to deploy)'))

Step '1/8 preflight'
Invoke-Git fetch --quiet origin | Out-Null
$sha = (Invoke-Git rev-parse --verify "$Commit^{commit}").Trim()
if (-not (Invoke-Git branch -r --contains $sha)) { Stop-Run "commit $sha is not on the remote; push it first." }
New-Item -ItemType Directory (Join-Path $run 'tools\gx') | Out-Null
$tools = @($gxTools | Where-Object { & git -C $root cat-file -e "${sha}:$_" 2>$null; $LASTEXITCODE -eq 0 })
$scripts = @('tools/gx/live-snapshot.js', 'tools/gx/compare.js', 'tools/gx/deploy.js', 'tools/gx/verify.js', 'tools/gx/window.js')
$helper = 'tools/gx/node-additions.js'
if ($UseWorkTreeScripts -or $tools -contains $helper) { $scripts += $helper }
elseif ($AllowNewNodes) { Stop-Run "commit $sha does not support -AllowNewNodes." }
foreach ($file in $scripts) {
    if ($UseWorkTreeScripts) { Copy-Item (Join-Path $root $file) (Join-Path $run $file); continue }
    try { Save-GitBlob $sha $file (Join-Path $run $file) }
    catch { Stop-Run "$file could not be read from commit $sha (merge the runner scripts first). $($_.Exception.Message)" }
}
Write-Host "commit $sha, $($tools.Count) tool file(s) to keep in step with it$($UseWorkTreeScripts ? ' (scripts from the WORK TREE)' : '')"

Step '2/8 snapshot of the live flow'
$live = Invoke-OnGx 'tools\gx\live-snapshot.js' (($AllowNewNodes -or $AllowRemovedNodes -or $AllowNewWires) ? '--topology' : '')
if ($live.Code -ne 0 -or -not $live.Text) { Stop-Run 'the live flow could not be read: SSH to the GX failed (is Tailscale connected on this PC?) or Node-RED is not running.' }
Save 'live-before.b64' $live.Text

Step '3/8 compare'
$report = & node (Join-Path $run 'tools\gx\compare.js') (Join-Path $run 'live-before.b64') --commit $sha --history 20 --summary (Join-Path $run 'summary-before.json') 2>&1
if ($LASTEXITCODE -ne 0) { Stop-Run "comparison failed: $report" }
Save 'compare-before.txt' ($report -join "`n")
$report | Select-Object -First 3 | ForEach-Object { Write-Host $_ }
$summary = Get-Content -Raw (Join-Path $run 'summary-before.json') | ConvertFrom-Json
Write-Host ("code differs: $($summary.code.Count), trailing only: $($summary.trailing.Count), config: $($summary.config.Count), only on the GX: $($summary.onlyLive.Count), only in the commit: $($summary.onlyRepo.Count)")
$summary.code | ForEach-Object { Write-Host "  $_" }
if ($summary.onlyLive.Count -and -not $AllowRemovedNodes) {
    Stop-Run 'GX nodes would be removed; list every reviewed ID with -AllowRemovedNodes. See compare-before.txt and docs/gx-deploy.md.' `
        'The target would remove GX nodes.' 'Reconcile the node removals in Git, then rerun the dry run.'
}
if ($summary.onlyRepo.Count -and -not $AllowNewNodes) {
    Stop-Run 'nodes were added. Review the commit, then dry run with -AllowNewNodes. See docs/gx-deploy.md.' `
        'The target adds nodes without the manual opt-in.' 'Review the additions, then rerun dry-run with allow_new_nodes enabled if intended.'
}
if ($summary.liveOnlyLines.Count -and -not ($AllowLiveOnlyLines -or $AllowReplaceDeployedLines)) {
    Stop-Run ("the GX has code lines the commit does not have: $($summary.liveOnlyLines -join ', '). Look at them (compare.js --show <id>), " +
        'copy wanted lines into the numbered source, or pass -AllowLiveOnlyLines when the commit is meant to remove them.') `
        'The target would remove unverified GX-only code lines.' 'Review the GX-only lines; preserve wanted edits in Git or rerun dry-run with allow_live_only_lines enabled only if their removal is intended.'
}

Step '4/8 plan'
$planFlags = @()
if ($AllowNewNodes) { $planFlags += '--allow-new-nodes' }
if ($AllowRemovedNodes) { $planFlags += @('--allow-removed-nodes', $AllowRemovedNodes) }
if ($AllowNewWires) { $planFlags += @('--allow-new-wires', $AllowNewWires) }
if ($AllowReplaceDeployedLines) { $planFlags += '--allow-replace-deployed-lines' }
$planOutput = & node (Join-Path $run 'tools\gx\compare.js') (Join-Path $run 'live-before.b64') --commit $sha --plan (Join-Path $run 'plan.json') --tools ($tools -join ',') @planFlags 2>&1
$planCode = $LASTEXITCODE
Save 'plan-output.txt' ($planOutput -join "`n")
if ($planCode -ne 0) {
    if ($AllowReplaceDeployedLines -and $summary.liveOnlyLines.Count -and
        ($planOutput -join "`n") -match 'replacement of GX-only code lines refused:') {
        $reason = 'The GX-only code lines could not be verified against the recorded deployment.'
        $detail = ($planOutput | Select-String 'replacement of GX-only code lines refused:' | Select-Object -First 1).Line
        if ($detail -match 'refused: (the live nodes or code differ from the recorded deployment [0-9a-f]{12}|the deployment record is missing or ambiguous|an identical Git deployment SHA for dashboard and automations is not recorded|the recorded deployment is not a readable ancestor of the target commit)') {
            $reason += " Reason: $($Matches[1])."
        }
        Stop-Run "the plan could not be written: $detail" $reason `
            'Read the verification reason in Deploy from master and review the GX-only lines. Preserve wanted edits in Git, or rerun dry-run with allow_live_only_lines enabled only if removal is intended.'
    }
    Stop-Run "the plan could not be written: $($planOutput | Select-Object -Last 1)"
}
$plan = Get-Content -Raw (Join-Path $run 'plan.json') | ConvertFrom-Json
if ($plan.replacedFrom -match '^[0-9a-f]{40}$') {
    Write-Host "GX-only code is replaced lines of $($plan.replacedFrom), verified against the deployment record."
    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "GX-only code: replaced lines of $($plan.replacedFrom), verified against the deployment record.`n"
    }
}
if ($plan.add.Count -ne $summary.onlyRepo.Count) { Stop-Run 'new node count in the plan does not match the comparison.' }
if ($plan.remove.Count -ne $summary.onlyLive.Count -or ($AllowRemovedNodes -and -not $plan.remove.Count)) { Stop-Run 'removal plan does not match the comparison and opt-in.' }
if (($plan.allowNewWires -join ',') -cne ((($AllowNewWires -split ',') | ForEach-Object { $_.Trim() }) -join ',')) {
    Stop-Run 'reviewed wire plan does not match -AllowNewWires (the pinned planner must support it).'
}
Write-Host ("plan: $(@($plan.patch.PSObject.Properties).Count) code patch(es), $($plan.wire.Count) wire patch(es), $($plan.add.Count) addition(s), $($plan.remove.Count) removal(s), $(@($plan.tools.PSObject.Properties).Count) tool file(s), live revision $($plan.expectRev.Substring(0, 12))")
$planOutput | Where-Object { $_ -match '^(node to add|node to remove|wire patch|removal wiring|group patch|reviewed wiring)' } | ForEach-Object { Write-Host $_ }

Step '5/8 window'
$deadline = (Get-Date).AddMinutes($WaitWindowMin)
do {
    $window = Invoke-OnGx 'tools\gx\window.js' '--for deploy'
    Write-Host $window.Text
    if ($window.Code -eq 0 -or -not $Apply -or (Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 60
} while ($true)
Save 'window.txt' $window.Text
if ($window.Code -gt 1) { Stop-Run 'the state of the automations could not be read.' }
if ($window.Code -ne 0 -and $Apply) { Stop-Run 'not a safe moment (see above). Run again later or pass -WaitWindowMin <minutes>.' }

Step '6/8 dry run on the GX'
$remote = (& ssh @ssh $GxHost 'umask 077; mktemp -d /tmp/gx-deploy.XXXXXX').Trim()
if ($remote -notmatch '^/tmp/gx-deploy\.[A-Za-z0-9]+$') { Stop-Run 'unexpected remote temp folder.' }
try {
    $upload = @((Join-Path $run 'plan.json'), (Join-Path $run 'tools\gx\deploy.js'))
    if ($plan.remove.Count) { $upload += (Join-Path $run 'tools\gx\live-snapshot.js') }
    if ($scripts -contains $helper) { $upload += (Join-Path $run $helper) }
    & scp @ssh @upload "${GxHost}:$remote/" | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Run 'the plan could not be copied to the GX.' }
    $dry = & ssh @ssh $GxHost "node $remote/deploy.js $remote/plan.json 2>&1"
    $dryCode = $LASTEXITCODE
    Save 'dry-run.txt' ($dry -join "`n")
    $dry | ForEach-Object { Write-Host $_ }
    if ($dryCode -ne 0) { Stop-Run 'the dry run was refused (ABORT line above). Nothing changed.' }

    $toolsToReplace = @($dry | Where-Object { $_ -match '^tool to replace' }).Count
    $deployed = $summary.live.source -and $summary.live.source.dashboard -eq $sha -and $summary.live.source.automations -eq $sha
    if ($summary.code.Count -eq 0 -and $plan.add.Count -eq 0 -and $plan.remove.Count -eq 0 -and $toolsToReplace -eq 0 -and $deployed) {
        Write-Host ''; Write-Host "NOTHING TO DO: the GX already runs $($sha.Substring(0, 12))." -ForegroundColor Green
        Write-Host "run folder: $run"; exit 0
    }

    Step '7/8 deploy'
    if (-not $Apply) {
        Write-Host 'skipped (dry run). Read the output above, then run again with -Apply.'
        Write-Host "run folder: $run"; exit 0
    }
    $changed = $true
    $out = & ssh @ssh $GxHost "DRY=0 node $remote/deploy.js $remote/plan.json 2>&1"
    $code = $LASTEXITCODE
    Save 'deploy.txt' ($out -join "`n")
    $out | Where-Object { $_ -match '^(backup|tool replaced|tool restored|DEPLOYED|ABORT|TOOL NOT RESTORED|Flow state)' } | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) { Stop-Run 'the deploy failed (ABORT line above). Read deploy.txt; the backup folder is named there.' }
}
finally { & ssh @ssh $GxHost "rm -f $remote/plan.json $remote/deploy.js $remote/node-additions.js $remote/live-snapshot.js; rmdir $remote" 2>$null | Out-Null }

Step '8/8 verify'
Start-Sleep -Seconds 20
$verify = Invoke-OnGx 'tools\gx\verify.js' ''
Save 'verify.txt' $verify.Text
Write-Host $verify.Text
$after = Invoke-OnGx 'tools\gx\live-snapshot.js' ''
Save 'live-after.b64' $after.Text
$null = & node (Join-Path $run 'tools\gx\compare.js') (Join-Path $run 'live-after.b64') --commit $sha --summary (Join-Path $run 'summary-after.json') 2>&1
$end = Get-Content -Raw (Join-Path $run 'summary-after.json') | ConvertFrom-Json
$ok = $end.code.Count -eq 0 -and $end.onlyLive.Count -eq 0 -and $end.onlyRepo.Count -eq 0 -and
    $end.live.source.dashboard -eq $sha -and $end.live.source.automations -eq $sha
if (-not $ok) { Stop-Run "after the deploy the live flow does not equal the commit (code differs: $($end.code -join ', ')). See summary-after.json." }
Write-Host ''
Write-Host "DONE: the GX runs $($end.live.label); the live code equals $($sha.Substring(0, 12))." -ForegroundColor Green
Write-Host 'Run scripts\gx-monitor.ps1 again in 15-20 minutes, and add a row to docs/heat-pump-work-log.md.'
Write-Host "run folder: $run"
exit 0
