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
$manifests = @{}
foreach ($file in $files) {
    $name = 'SECRETFILE_' + ($file.Name.ToUpperInvariant() -replace '[^A-Z0-9]', '_')
    if ($values.ContainsKey($name)) { throw "Secret name collision: $name." }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    # The prefix allows backing up an intentionally empty file (disabled MCP).
    $value = 'base64:' + [Convert]::ToBase64String($bytes)
    # Leave room for sealed-box/base64 API overhead; verified against GitHub.
    if ($value.Length -le 32000) {
        $values[$name] = $value
    }
    else {
        $base64 = $value.Substring(7)
        $parts = [int][Math]::Ceiling($base64.Length / 32000.0)
        if ($parts -gt 999) { throw "Too many chunks for $($file.Name)." }
        for ($i = 0; $i -lt $parts; $i++) {
            $partName = '{0}_PART_{1:000}' -f $name, ($i + 1)
            if ($values.ContainsKey($partName)) { throw "Secret name collision: $partName." }
            $values[$partName] = $base64.Substring($i * 32000, [Math]::Min(32000, $base64.Length - $i * 32000))
        }
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        $values[$name] = $null
        $manifests[$name] = @{ format = 'victron-chunks-v1'; parts = $parts; sha256 = $hash } | ConvertTo-Json -Compress
    }
}
foreach ($name in @($values.Keys | Where-Object { -not $manifests.ContainsKey($_) })) {
    Set-FileSecret -Repo $Repo -Name $name -Value $values[$name]
}
foreach ($name in $manifests.Keys) {
    Set-FileSecret -Repo $Repo -Name $name -Value $manifests[$name]
}
