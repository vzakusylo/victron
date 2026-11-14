# Requires PowerShell 7. Uploads files as base64, without printing their content.
param(
    [string]$Repo = 'vzakusylo/victron',
    [string]$SecretsDir = (Join-Path $PSScriptRoot '..\.secrets')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'secret-utils.ps1')
if (-not (Test-Path -LiteralPath $SecretsDir -PathType Container)) {
    throw "Secrets directory not found: $SecretsDir"
}
if (@(Get-ChildItem -LiteralPath $SecretsDir -Directory -Force).Count -gt 0) {
    throw 'Secret directory must contain files only. Flatten names and specify an explicit restore mapping.'
}
$files = @(Get-ChildItem -LiteralPath $SecretsDir -File -Force |
    Where-Object { $_.Name -notmatch '\.bak' })
if ($files.Count -eq 0) { throw "No secret files found in $SecretsDir." }
$values = @{}
foreach ($file in $files) {
    $name = 'SECRETFILE_' + ($file.Name.ToUpperInvariant() -replace '[^A-Z0-9]', '_')
    if ($values.ContainsKey($name)) { throw "Secret name collision: $name." }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    # The prefix allows backing up an intentionally empty file (disabled MCP).
    $value = 'base64:' + [Convert]::ToBase64String($bytes)
    if ($value.Length -gt 48KB) { throw "File too large for a secret: $($file.Name)." }
    $values[$name] = $value
}
foreach ($name in $values.Keys) {
    Set-FileSecret -Repo $Repo -Name $name -Value $values[$name]
}
