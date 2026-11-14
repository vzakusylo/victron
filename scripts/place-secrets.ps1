# Requires PowerShell 7. Explicit mapping preserves exact original file names.
param(
    [string]$SecretsDir = (Join-Path $PSScriptRoot '..\.secrets'),
    [hashtable]$Files = @{
        SECRETFILE_TUYA_CLOUD_JSON = 'tuya-cloud.json'
        SECRETFILE_TUYA_DEVICES_JSON = 'tuya-devices.json'
    },
    [switch]$RawJson
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'secret-utils.ps1')
if ($Files.Count -eq 0) { throw 'Specify at least one file to restore.' }
$contents = @{}
foreach ($name in $Files.Keys) {
    $file = [string]$Files[$name]
    if ([string]::IsNullOrWhiteSpace($file) -or $file -match '[/\\:]' -or $file -in @('.', '..')) {
        throw "Invalid destination file name for $name."
    }
    if ($contents.ContainsKey($file)) { throw "Duplicate destination: $file." }
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Required secret environment variable missing: $name." }
    if ($RawJson) {
        Assert-JsonSecret -Value $value -Name $name
        $contents[$file] = [Text.Encoding]::UTF8.GetBytes($value)
    }
    else {
        $prefixed = $value.StartsWith('base64:', [StringComparison]::Ordinal)
        if ($prefixed) { $value = $value.Substring(7) }
        try { $contents[$file] = [Convert]::FromBase64String($value) }
        catch { throw "Invalid base64 for $name." }
        if (-not $prefixed -and $contents[$file].Length -eq 0) { throw "Empty decoded file for $name." }
    }
}
New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null
foreach ($file in $contents.Keys) {
    $path = Join-Path $SecretsDir $file
    [IO.File]::WriteAllBytes($path, $contents[$file])
    if (-not $IsWindows) {
        & chmod 600 -- $path
        if ($LASTEXITCODE -ne 0) { throw "Could not restrict file permissions: $file." }
    }
    Write-Host "Placed $file"
}
