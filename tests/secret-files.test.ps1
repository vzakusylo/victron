# Run with: pwsh -NoProfile -File .\tests\secret-files.test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$scripts = Join-Path $root 'scripts'
$temp = Join-Path $root ('.secrets\script-test-' + [guid]::NewGuid())
$source = Join-Path $temp 'source'
$destination = Join-Path $temp 'restored'
New-Item -ItemType Directory -Path $source, $destination -Force | Out-Null
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-Fails([scriptblock]$Action) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert $failed 'Expected an error.'
}
$old = [Environment]::GetEnvironmentVariable('SECRETFILE_TEST_JSON')
$savedToken = $env:GH_TOKEN
$savedHost = $env:GH_HOST
try {
    $bytes = [byte[]]@(0, 1, 127, 128, 255)
    $env:SECRETFILE_TEST_JSON = [Convert]::ToBase64String($bytes)
    & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_TEST_JSON = 'exact_Name.json' }
    $restored = [IO.File]::ReadAllBytes("$destination\exact_Name.json")
    Assert ([Convert]::ToBase64String($restored) -eq $env:SECRETFILE_TEST_JSON) 'Byte round trip failed.'
    Assert-Fails { & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_TEST_JSON = '..\escape.json' } }
    $env:SECRETFILE_TEST_JSON = ''
    Assert-Fails { & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_TEST_JSON = 'exact_Name.json' } }
    $env:SECRETFILE_TEST_JSON = 'not-base64'
    Assert-Fails { & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_TEST_JSON = 'exact_Name.json' } }
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes("$destination\exact_Name.json")) `
        -eq [Convert]::ToBase64String($bytes)) 'Invalid input overwrote an existing file.'
    $env:SECRETFILE_TEST_JSON = '{"synthetic":true}'
    & "$scripts\place-secrets.ps1" -SecretsDir $destination -RawJson `
        -Files @{ SECRETFILE_TEST_JSON = 'settings.json' }
    Assert ([IO.File]::ReadAllText("$destination\settings.json") -eq $env:SECRETFILE_TEST_JSON) 'JSON changed.'
    $env:SECRETFILE_TEST_JSON = 'base64:'
    & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_TEST_JSON = 'disabled-token.txt' }
    Assert ((Get-Item "$destination\disabled-token.txt").Length -eq 0) 'Disabled token was not preserved.'
    $env:SECRETFILE_TEST_JSON = '{invalid'
    Assert-Fails { & "$scripts\place-secrets.ps1" -SecretsDir $destination -RawJson `
        -Files @{ SECRETFILE_TEST_JSON = 'settings.json' } }

    # Mock uploads so tests never touch GitHub or use real secrets.
    $global:uploadCount = 0
    $global:uploadedValues = @{}
    function global:gh {
        $global:uploadedValues[$args[2]] = $input -join ''
        Assert ($env:GH_HOST -eq 'github.com' -and -not $env:GH_TOKEN) 'Incorrect authentication host.'
        $global:uploadCount++
        $global:LASTEXITCODE = 0
    }
    $env:GH_TOKEN = 'synthetic-enterprise-token'
    $env:GH_HOST = 'example.invalid'
    [IO.File]::WriteAllBytes("$source\test.json", $bytes)
    [IO.File]::WriteAllText("$source\test.json.bak", 'synthetic')
    & "$scripts\push-secrets.ps1" -SecretsDir $source
    Assert ($global:uploadCount -eq 1) 'Backup was uploaded.'
    Assert ($env:GH_TOKEN -eq 'synthetic-enterprise-token' -and $env:GH_HOST -eq 'example.invalid') 'Environment not restored.'
    [IO.File]::WriteAllBytes("$source\test-json", $bytes)
    Assert-Fails { & "$scripts\push-secrets.ps1" -SecretsDir $source }
    Assert ($global:uploadCount -eq 1) 'Name collision uploaded partial data.'
    Remove-Item -LiteralPath "$source\test-json"
    $large = [byte[]]::new(50000)
    for ($i = 0; $i -lt $large.Length; $i++) { $large[$i] = $i % 256 }
    [IO.File]::WriteAllBytes("$source\large.bin", $large)
    & "$scripts\push-secrets.ps1" -SecretsDir $source
    foreach ($name in $global:uploadedValues.Keys) {
        Assert ($global:uploadedValues[$name].Length -le 32000) 'Upload exceeded verified API size.'
        [Environment]::SetEnvironmentVariable($name, $global:uploadedValues[$name], 'Process')
    }
    & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_LARGE_BIN = 'large.bin' }
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes("$destination\large.bin")) `
        -eq [Convert]::ToBase64String($large)) 'Chunked byte round trip failed.'
    $env:SECRETFILE_LARGE_BIN_PART_001 = 'AAAA'
    Assert-Fails { & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_LARGE_BIN = 'large.bin' } }
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes("$destination\large.bin")) `
        -eq [Convert]::ToBase64String($large)) 'Corrupt chunks overwrote existing file.'
    Remove-Item Env:SECRETFILE_LARGE_BIN_PART_002
    Assert-Fails { & "$scripts\place-secrets.ps1" -SecretsDir $destination `
        -Files @{ SECRETFILE_LARGE_BIN = 'large.bin' } }
    function global:gh { $null = $input | Out-Null; $global:LASTEXITCODE = 1 }
    Assert-Fails { & "$scripts\push-secrets.ps1" -SecretsDir $source }
    Assert ($env:GH_TOKEN -eq 'synthetic-enterprise-token') 'Failure did not restore environment.'
    Write-Host 'Secret file tests passed.'
}
finally {
    [Environment]::SetEnvironmentVariable('SECRETFILE_TEST_JSON', $old, 'Process')
    [Environment]::SetEnvironmentVariable('GH_TOKEN', $savedToken, 'Process')
    [Environment]::SetEnvironmentVariable('GH_HOST', $savedHost, 'Process')
    Remove-Item Function:\gh -ErrorAction SilentlyContinue
    foreach ($name in @('SECRETFILE_LARGE_BIN', 'SECRETFILE_LARGE_BIN_PART_001', 'SECRETFILE_LARGE_BIN_PART_002',
        'SECRETFILE_LARGE_BIN_PART_003')) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $temp -Recurse -Force
}
