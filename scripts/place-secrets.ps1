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
        if ($value.StartsWith('{', [StringComparison]::Ordinal)) {
            try { $manifest = ConvertFrom-Json -InputObject $value -ErrorAction Stop }
            catch { throw "Invalid chunk manifest for $name." }
            if ($manifest.format -ne 'victron-chunks-v1' -or ($manifest.parts -isnot [long] -and $manifest.parts -isnot [int]) -or
                $manifest.parts -lt 1 -or $manifest.parts -gt 999 -or $manifest.sha256 -notmatch '^[0-9a-f]{64}$') {
                throw "Invalid chunk manifest for $name."
            }
            $builder = [Text.StringBuilder]::new()
            for ($i = 1; $i -le $manifest.parts; $i++) {
                $partName = '{0}_PART_{1:000}' -f $name, $i
                $part = [Environment]::GetEnvironmentVariable($partName)
                if ([string]::IsNullOrWhiteSpace($part)) { throw "Required chunk missing: $partName." }
                $null = $builder.Append($part)
            }
            try { $decoded = [Convert]::FromBase64String($builder.ToString()) }
            catch { throw "Invalid chunk encoding for $name." }
            $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($decoded)).ToLowerInvariant()
            if ($hash -ne $manifest.sha256) { throw "Chunk checksum mismatch for $name." }
            $contents[$file] = $decoded
            continue
        }
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
