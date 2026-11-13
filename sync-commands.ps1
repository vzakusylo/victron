# =============================================================================
# Victron Node-RED - sync commands (wrappers around tools/flows.js, needs Node.js)
# =============================================================================
#   . .\sync-commands.ps1      # dot-source to load the functions
#   Sync-All                   # sync every numbered source into flows.json
#   Sync-01                    # sync one source (Sync-01 ... Sync-43, one per file number)
#   Test-Flows                 # check flows.json (sync, syntax, wiring, secrets) and run the tests
#   Get-FlowVersion            # show the tab label d#<n>
#
# A sync that changes flows.json bumps d#<n> by 1 (once per call); nothing changed = no bump.
# The source -> node mapping comes from the file names, see the header of tools/flows.js.
# Works from any checkout or worktree: paths are relative to this script.
# =============================================================================

$FlowsTool = Join-Path $PSScriptRoot 'tools\flows.js'

function Sync-All        { node $FlowsTool sync }
function Get-FlowVersion { node $FlowsTool version }
function Test-Flows {
    node $FlowsTool check
    if ($LASTEXITCODE -eq 0) { node --test (Join-Path $PSScriptRoot 'tests\*.test.js') }
}

# Sync-NN for every "NN Name.js" / "NN Name.html" in the repository root.
Get-ChildItem -LiteralPath $PSScriptRoot -File |
    Where-Object { $_.Name -match '^(\d\d) .+\.(js|html)$' } |
    ForEach-Object { $Matches[1] } | Sort-Object -Unique |
    ForEach-Object {
        $number = $_
        Set-Item -Path "function:global:Sync-$number" -Value { node $FlowsTool sync $number }.GetNewClosure()
    }
