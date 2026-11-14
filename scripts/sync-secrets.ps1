# Requires PowerShell 7. Local Victron files -> GitHub; no deployment or download.
param(
    [string]$SecretsDir = (Join-Path $PSScriptRoot '..\.secrets')
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'push-secrets.ps1') `
    -Repo 'vzakusylo/victron' -SecretsDir $SecretsDir
