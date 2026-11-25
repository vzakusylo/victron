<#
.SYNOPSIS
  Minimal Herdr harness: one git worktree + one Copilot worker per task.
  The orchestrator (Claude Code on master) calls this; it never edits the worktree itself.

.EXAMPLES
  herdr-task.ps1 new   gx-docker -Repo C:\learn\victron -Tier standard   # tiers in models.json: small, standard, code, hard, review
  herdr-task.ps1 send  gx-docker "Read .copilot-brief-gx-docker.md and implement it."   # waits until idle/blocked
  herdr-task.ps1 read  gx-docker -Lines 150
  herdr-task.ps1 wait  gx-docker
  herdr-task.ps1 list
  herdr-task.ps1 close gx-docker            # removes worktree (refuses on uncommitted changes)
#>
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('new', 'send', 'read', 'wait', 'list', 'close')][string]$Action,
  [Parameter(Position = 1)][string]$Task,
  [Parameter(Position = 2)][string]$Text,
  [string]$Repo = 'C:\learn\victron',
  [string]$Base = 'master',
  [string]$Tier = '',
  [string]$Model = '',
  [ValidateSet('', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')][string]$Effort = '',
  [int]$Lines = 120,
  [int]$TimeoutMin = 30,
  [switch]$Json,
  [switch]$IfPresent
)
$ErrorActionPreference = 'Stop'

# model + effort per task tier (models.json next to this script); -Model / -Effort override the tier
$cfg = Get-Content (Join-Path $PSScriptRoot 'models.json') -Raw | ConvertFrom-Json
if (-not $Tier) { $Tier = $cfg.default }
$tc = $cfg.tiers.$Tier
if (-not $tc) { throw "Unknown tier '$Tier'. Tiers: $(($cfg.tiers.PSObject.Properties.Name) -join ', ')" }
if (-not $Model) { $Model = $tc.model }
if (-not $Effort) { $Effort = $tc.effort }

function Invoke-Herdr {
  $out = & herdr @args 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "herdr $($args -join ' ') failed:`n$out" }
  $out
}
function Get-AgentName([string]$t) {
  $n = ('w-' + $t.ToLower() -replace '[^a-z0-9_-]', '-')
  $n.Substring(0, [Math]::Min(32, $n.Length))
}
function Get-TaskWorkspace([string]$t, [switch]$AllowMissing) {
  $ws = (Invoke-Herdr workspace list | ConvertFrom-Json).result.workspaces |
    Where-Object { $_.label -eq $t -and $_.worktree }
  if (-not $ws -and -not $AllowMissing) { throw "No Herdr worktree workspace labelled '$t'. Run: new $t" }
  $ws | Select-Object -First 1
}

if ($Action -ne 'list' -and -not $Task) { throw "Task name required." }
$agent = if ($Task) { Get-AgentName $Task }
$timeoutMs = $TimeoutMin * 60000

switch ($Action) {
  'new' {
    $r = Invoke-Herdr worktree create --cwd $Repo --branch $Task --base $Base --no-focus | ConvertFrom-Json
    $pane = $r.result.root_pane.pane_id
    $path = $r.result.worktree.path
    # owner's rule: Copilot workers run with --allow-all (no per-command prompts that block the worker)
    $agentArgs = @('--', '--allow-all')
    if ($Model) { $agentArgs += @('--model', $Model) }
    if ($Effort) { $agentArgs += @('--reasoning-effort', $Effort) }
    Invoke-Herdr agent start $agent --kind copilot --pane $pane --timeout 120000 @agentArgs | Out-Null
    $result = [pscustomobject]@{ task = $Task; agent = $agent; pane = $pane; worktree = $path; branch = $Task; tier = $Tier; model = $Model; effort = $Effort }
    if ($Json) { $result | ConvertTo-Json -Compress } else { $result }
  }
  'send' {
    if (-not $Text) { throw "Prompt text required." }
    Invoke-Herdr agent prompt $agent $Text --wait --until idle --until blocked --until done --timeout $timeoutMs
    Invoke-Herdr agent read $agent --source recent-unwrapped --lines $Lines
  }
  'read' { Invoke-Herdr agent read $agent --source recent-unwrapped --lines $Lines }
  'wait' {
    Invoke-Herdr agent wait $agent --until idle --until blocked --until done --timeout $timeoutMs
    Invoke-Herdr agent read $agent --source recent-unwrapped --lines $Lines
  }
  'list' { Invoke-Herdr agent list }
  'close' {
    $ws = Get-TaskWorkspace $Task -AllowMissing:$IfPresent
    if ($ws) { Invoke-Herdr worktree remove --workspace $ws.workspace_id }
  }
}
