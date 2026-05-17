# =============================================================================
# Victron Node-RED — Sync commands
# =============================================================================
# Usage: run any individual function below, or call Sync-Node directly.
#
#   . .\sync-commands.ps1          # dot-source to load all functions
#   Sync-All                       # sync every JS file at once + bump version
#   Sync-Node "Battery + Grid Controller" "01 Battery + Grid Controller.js"
#
# Rule: every sync that changes flows.json must bump d#<n> by 1.
# =============================================================================

$FlowsJson = 'c:\learn\victron\flows.json'
$Root      = 'c:\learn\victron'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# Core helper
# ---------------------------------------------------------------------------
function Sync-Node {
    param(
        [string]$NodeName,
        [string]$JsFile,
        [switch]$BumpVersion
    )

    $j   = [System.IO.File]::ReadAllText($FlowsJson) | ConvertFrom-Json
    $src = [System.IO.File]::ReadAllText((Join-Path $Root $JsFile))
    $c   = 0

    foreach ($n in $j) {
        if ($n.type -eq 'function' -and $n.name -eq $NodeName) {
            $n.func = $src
            $c++
        }
    }

    if ($BumpVersion) {
        foreach ($n in $j) {
            if ($n.type -eq 'tab' -and $n.label -match 'd#(\d+)') {
                $x      = [int]$Matches[1] + 1
                $n.label = $n.label -replace "d#$($Matches[1])", "d#$x"
                Write-Host "Tab -> $($n.label)"
            }
        }
    }

    [System.IO.File]::WriteAllText($FlowsJson, ($j | ConvertTo-Json -Depth 20), $Utf8NoBom)
    Write-Host "SYNCED $c node(s)  [$NodeName <- $JsFile]"
}

# ---------------------------------------------------------------------------
# Individual sync functions  (one per JS source file)
# ---------------------------------------------------------------------------

# 01 — Main battery/grid controller
function Sync-01 { Sync-Node 'Battery + Grid Controller'     '01 Battery + Grid Controller.js'          -BumpVersion }

# 02 — Analytics tab model builder
function Sync-02 { Sync-Node 'Build analytics tab model'     '02 Build analytics tab model.js'          -BumpVersion }

# 03 — GX notification formatter
function Sync-03 { Sync-Node 'Format GX notification'        '03 Format GX notification.js'             -BumpVersion }

# 04 — Root files dashboard manager
function Sync-04 { Sync-Node 'Manage root files dashboard'   '04 Manage root files dashboard.js'        -BumpVersion }

# 05 — Save HV settings from dashboard
function Sync-05 { Sync-Node 'Save HV settings from dashboard' '05 Save HV settings from dashboard.js' -BumpVersion }

# 06 — Apply HV settings (reload from disk into flow context)
function Sync-06 { Sync-Node 'Apply HV settings'             '06 Apply HV settings.js'                 -BumpVersion }

# 07 — Build HV dashboard state payload
function Sync-07 { Sync-Node 'Build HV dashboard state'      '07 Build HV dashboard state.js'          -BumpVersion }

# 08 — Adjust solar forecast for shade
function Sync-08 { Sync-Node 'Adjust solar forecast for shade' '08 Adjust solar forecast for shade.js' -BumpVersion }

# 09 — Store solar prediction into flow context
function Sync-09 { Sync-Node 'Store solar prediction'        '09 Store solar prediction.js'             -BumpVersion }

# 10 — Build forecast.solar API URL
function Sync-10 { Sync-Node 'create forecast.solar url'     '10 create forecast.solar url.js'          -BumpVersion }

# 11 — Process raw forecast.solar API response
function Sync-11 { Sync-Node 'Processed info'                '11 Processed info.js'                    -BumpVersion }

# 12 — Update rate limiter
function Sync-12 { Sync-Node 'update ratelimit'              '12 update ratelimit.js'                   -BumpVersion }

# 13 — Update status display
function Sync-13 { Sync-Node 'update status'                 '13 update status.js'                     -BumpVersion }

# 14 — Build dashboard hourly widgets
function Sync-14 { Sync-Node 'Build dashboard hourly widgets' '14 Build dashboard hourly widgets.js'   -BumpVersion }

# 15 — Load root files UI state on dashboard connect
function Sync-15 { Sync-Node 'Load root files UI state on connect' '15 Load root files UI state on connect.js' -BumpVersion }

# 16 — Refresh dashboard hourly stats
function Sync-16 { Sync-Node 'Refresh dashboard hourly stats' '16 Refresh dashboard hourly stats.js'   -BumpVersion }

# 17 — Write/update daily summary log
function Sync-17 { Sync-Node 'Update daily summary'          '17 Update daily summary.js'              -BumpVersion }

# 18 — Resolve which summary day is selected
function Sync-18 { Sync-Node 'Resolve selected summary day'  '18 Resolve selected summary day.js'      -BumpVersion }

# 19 — Format one hourly energy log line
function Sync-19 { Sync-Node 'Format hourly energy line'     '19 Format hourly energy line.js'         -BumpVersion }

# 20 — Format notification for log file
function Sync-20 { Sync-Node 'Format notification for log'   '20 Format notification for log.js'       -BumpVersion }

# 21 — Create chart output from forecast data
function Sync-21 { Sync-Node 'Create graph output'           '21 Create graph output.js'               -BumpVersion }

# 22 — Filter graph data
function Sync-22 { Sync-Node 'Filter graph'                  '22 Filter graph.js'                      -BumpVersion }

# 23 — Set error status on node
function Sync-23 { Sync-Node 'Set error status'              '23 Set error status.js'                  -BumpVersion }

# 24 — Build controller constants state
function Sync-24 { Sync-Node 'Build controller constants state' '24 Build controller constants state.js' -BumpVersion }

# 25 — Save controller constants
function Sync-25 { Sync-Node 'Save controller constants'        '25 Save controller constants.js'               -BumpVersion }

# ---------------------------------------------------------------------------
# Sync ALL nodes in one pass (single version bump)
# ---------------------------------------------------------------------------
function Sync-All {
    $j = [System.IO.File]::ReadAllText($FlowsJson) | ConvertFrom-Json

    $map = @(
        @{ Name = 'Battery + Grid Controller';          File = '01 Battery + Grid Controller.js' }
        @{ Name = 'Build analytics tab model';          File = '02 Build analytics tab model.js' }
        @{ Name = 'Format GX notification';             File = '03 Format GX notification.js' }
        @{ Name = 'Manage root files dashboard';        File = '04 Manage root files dashboard.js' }
        @{ Name = 'Save HV settings from dashboard';    File = '05 Save HV settings from dashboard.js' }
        @{ Name = 'Apply HV settings';                  File = '06 Apply HV settings.js' }
        @{ Name = 'Build HV dashboard state';           File = '07 Build HV dashboard state.js' }
        @{ Name = 'Adjust solar forecast for shade';    File = '08 Adjust solar forecast for shade.js' }
        @{ Name = 'Store solar prediction';             File = '09 Store solar prediction.js' }
        @{ Name = 'create forecast.solar url';          File = '10 create forecast.solar url.js' }
        @{ Name = 'Processed info';                     File = '11 Processed info.js' }
        @{ Name = 'update ratelimit';                   File = '12 update ratelimit.js' }
        @{ Name = 'update status';                      File = '13 update status.js' }
        @{ Name = 'Build dashboard hourly widgets';     File = '14 Build dashboard hourly widgets.js' }
        @{ Name = 'Load root files UI state on connect'; File = '15 Load root files UI state on connect.js' }
        @{ Name = 'Refresh dashboard hourly stats';     File = '16 Refresh dashboard hourly stats.js' }
        @{ Name = 'Update daily summary';               File = '17 Update daily summary.js' }
        @{ Name = 'Resolve selected summary day';       File = '18 Resolve selected summary day.js' }
        @{ Name = 'Format hourly energy line';          File = '19 Format hourly energy line.js' }
        @{ Name = 'Format notification for log';        File = '20 Format notification for log.js' }
        @{ Name = 'Create graph output';                File = '21 Create graph output.js' }
        @{ Name = 'Filter graph';                       File = '22 Filter graph.js' }
        @{ Name = 'Set error status';                   File = '23 Set error status.js' }
        @{ Name = 'Build controller constants state';    File = '24 Build controller constants state.js' }
        @{ Name = 'Save controller constants';           File = '25 Save controller constants.js' }
    )

    $totalSynced = 0
    foreach ($entry in $map) {
        $src = [System.IO.File]::ReadAllText((Join-Path $Root $entry.File))
        foreach ($n in $j) {
            if ($n.type -eq 'function' -and $n.name -eq $entry.Name) {
                $n.func = $src
                $totalSynced++
                Write-Host "  SYNCED  $($entry.Name)"
            }
        }
    }

    # Bump tab version once
    foreach ($n in $j) {
        if ($n.type -eq 'tab' -and $n.label -match 'd#(\d+)') {
            $x       = [int]$Matches[1] + 1
            $n.label = $n.label -replace "d#$($Matches[1])", "d#$x"
            Write-Host "Tab -> $($n.label)"
        }
    }

    [System.IO.File]::WriteAllText($FlowsJson, ($j | ConvertTo-Json -Depth 20), $Utf8NoBom)
    Write-Host "DONE — $totalSynced node(s) synced."
}

# ---------------------------------------------------------------------------
# Show current tab (flow) version
# ---------------------------------------------------------------------------
function Get-FlowVersion {
    $j = [System.IO.File]::ReadAllText($FlowsJson) | ConvertFrom-Json
    $j | Where-Object { $_.type -eq 'tab' } | ForEach-Object { Write-Host "$($_.label)" }
}
