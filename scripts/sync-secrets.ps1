# Requires PowerShell 7. Local Victron files -> GitHub; no deployment or download.
param(
    [string]$SecretsDir = (Join-Path $PSScriptRoot '..\.secrets'),
    [switch]$FromGx,
    [string]$GxHost = 'root@venus.local',
    [string]$SshKey
)
$ErrorActionPreference = 'Stop'
if ($FromGx) {
    & (Join-Path $PSScriptRoot 'collect-gx-secrets.ps1') `
        -GxHost $GxHost -SshKey $SshKey -SecretsDir $SecretsDir -IncludeNodeSettings
}
& (Join-Path $PSScriptRoot 'push-secrets.ps1') `
    -Repo 'vzakusylo/victron' -SecretsDir $SecretsDir
