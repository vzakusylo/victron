# Execute the actual Actions reconstruction step with synthetic secrets only.
# Run with: pwsh -NoProfile -File .\tests\deploy-secrets.test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$workflow = Get-Content (Join-Path $root '.github\workflows\deploy-victron.yml') -Raw
$step = [regex]::Match($workflow, '(?ms)^      - name: Rebuild private files from GitHub secrets\r?\n(.*?)(?=^      - name:)')
if (-not $step.Success) { throw 'Cannot locate the Actions reconstruction step.' }
$run = [regex]::Match($step.Value, '(?ms)^        run: \|\r?\n(.*)$')
if (-not $run.Success) { throw 'Cannot locate the reconstruction command.' }
$code = [scriptblock]::Create([regex]::Replace($run.Groups[1].Value, '(?m)^          ', ''))
$files = @{
    SECRETFILE_TUYA_CLOUD_JSON = 'tuya-cloud.json'
    SECRETFILE_TUYA_DEVICES_JSON = 'tuya-devices.json'
    SECRETFILE_TUYA_LOCAL_SENSORS_JSON = 'tuya-local-sensors.json'
    SECRETFILE_TUYA_NODES_JSON = 'tuya-nodes.json'
    SECRETFILE_EMAIL_JSON = 'email.json'
    SECRETFILE_MCP_TOKEN_TXT = 'mcp-token.txt'
    SECRETFILE_FLOWS_CRED_JSON = 'flows_cred.json'
    SECRETFILE__CONFIG_RUNTIME_JSON = '.config.runtime.json'
    SECRETFILE__CONFIG_USERS_JSON = '.config.users.json'
    SECRETFILE_SETTINGS_USER_JS = 'settings-user.js'
    SECRETFILE_VENUS_SETTINGS_JS = 'venus-settings.js'
}
$parts = 1..3 | ForEach-Object { 'SECRETFILE_TUYA_DEVICES_JSON_PART_{0:000}' -f $_ }
$names = @($files.Keys) + $parts + 'RUNNER_TEMP'
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
$temp = Join-Path $root ('.secrets\workflow-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force $temp | Out-Null
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-FailingStep {
    $failed = $false
    try { & $code | Out-Null } catch { $failed = $true }
    Assert $failed 'Invalid deployment input was accepted.'
    Assert (-not (Test-Path (Join-Path $env:RUNNER_TEMP 'bundle.tar'))) 'Invalid input produced a deployment archive.'
}
# Linux CI uses real chmod; Windows tests substitute only the unavailable permission tool.
if ($IsWindows) { function chmod { $global:LASTEXITCODE = 0 } }
Push-Location $root
try {
    foreach ($name in $files.Keys) {
        $file = $files[$name]
        $value = if ($file.EndsWith('.js')) { 'module.exports = {};' }
            elseif ($file.EndsWith('.txt')) { '' } else { '{"synthetic":true}' }
        [Environment]::SetEnvironmentVariable($name, 'base64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))
    }
    $deviceBytes = [Text.Encoding]::UTF8.GetBytes('{"synthetic":"chunked-device-file"}')
    $encoded = [Convert]::ToBase64String($deviceBytes)
    $env:SECRETFILE_TUYA_DEVICES_JSON = @{
        format = 'victron-chunks-v1'
        parts = 3
        sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($deviceBytes)).ToLowerInvariant()
    } | ConvertTo-Json -Compress
    $split = [int][math]::Ceiling($encoded.Length / 3)
    for ($i = 0; $i -lt 3; $i++) {
        $offset = $i * $split
        [Environment]::SetEnvironmentVariable($parts[$i], $encoded.Substring($offset, [math]::Min($split, $encoded.Length - $offset)))
    }

    $env:RUNNER_TEMP = Join-Path $temp 'valid'
    & $code
    $private = Join-Path $env:RUNNER_TEMP 'bundle\secrets'
    Assert ((Get-ChildItem $private -Force -File).Count -eq 11) 'Actions did not restore all eleven private files.'
    Assert ((Get-Item (Join-Path $private 'mcp-token.txt')).Length -eq 0) 'Disabled MCP token was not preserved.'
    Assert ([IO.File]::ReadAllText((Join-Path $private 'tuya-devices.json')) -eq [Text.Encoding]::UTF8.GetString($deviceBytes)) 'Chunked device file changed.'
    $members = & tar -tf (Join-Path $env:RUNNER_TEMP 'bundle.tar')
    Assert ($LASTEXITCODE -eq 0) 'Archive cannot be read.'
    $expected = @('secrets/tuya-cloud.json', 'secrets/tuya-devices.json', 'secrets/tuya-local-sensors.json',
        'secrets/tuya-nodes.json', 'secrets/email.json', 'secrets/mcp-token.txt', 'secrets/settings-user.js',
        'tools/victron-secrets.js', 'tools/reload-victron-secrets.js')
    Assert (-not (Compare-Object ($members | Sort-Object) ($expected | Sort-Object))) 'Archive includes recovery credentials or omits active files.'

    $goodCloud = $env:SECRETFILE_TUYA_CLOUD_JSON
    $env:SECRETFILE_TUYA_CLOUD_JSON = ''
    $env:RUNNER_TEMP = Join-Path $temp 'missing'
    Invoke-FailingStep
    $env:SECRETFILE_TUYA_CLOUD_JSON = $goodCloud

    $goodPart = [Environment]::GetEnvironmentVariable($parts[0])
    [Environment]::SetEnvironmentVariable($parts[0], 'AAAA')
    $env:RUNNER_TEMP = Join-Path $temp 'corrupt'
    Invoke-FailingStep
    [Environment]::SetEnvironmentVariable($parts[0], $goodPart)

    $env:SECRETFILE_EMAIL_JSON = 'base64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{invalid-private-marker'))
    $env:RUNNER_TEMP = Join-Path $temp 'invalid-json'
    Invoke-FailingStep
    Write-Output 'Actions reconstruction tests passed: full restore, active-only bundle, empty token, missing secret, corrupt chunks and invalid JSON.'
}
finally {
    Pop-Location
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    Remove-Item -LiteralPath $temp -Recurse -Force
}
