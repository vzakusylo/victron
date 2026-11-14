# Run with: pwsh -NoProfile -File .\tests\setup-ci-access.test.ps1
# The access setup creates credentials, so only its parsing, validation and dry run are tested.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$script = Join-Path $root 'scripts\setup-ci-access.ps1'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

$errors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$errors)
Assert (-not $errors) "Parse errors: $errors"

$temp = Join-Path ([IO.Path]::GetTempPath()) ('ci-access-' + [guid]::NewGuid())
New-Item -ItemType Directory $temp | Out-Null
try {
    $key = Join-Path $temp 'ci_key'
    $out = & $script -GxHost 'root@gx.example.test' -SshKey (Join-Path $temp 'missing') -CiKey $key -DryRun 6>&1 | Out-String
    Assert ($out -match 'DRY RUN') 'Dry run must say so.'
    foreach ($name in 'GX_SSH_HOST', 'GX_SSH_KEY', 'GX_SSH_KNOWN_HOSTS', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET') {
        Assert ($out -match $name) "Dry run must name $name."
    }
    Assert (-not (Test-Path $key)) 'Dry run must not create a key.'
    Assert (-not (Get-ChildItem $temp)) 'Dry run must not write files.'

    foreach ($bad in 'gx.example.test', 'admin@gx.example.test', 'root@gx.example.test; rm -rf /', "root@gx'x") {
        $failed = $false
        try { & $script -GxHost $bad -SshKey $key -CiKey $key -DryRun 6>&1 | Out-Null } catch { $failed = $true }
        Assert $failed "Host '$bad' must be rejected."
    }
    Assert (-not (Get-ChildItem $temp)) 'Rejected input must not write files.'
    # An unfinished rotation must not be rotated again: the first key would never be revoked.
    $ciKey = Join-Path $temp 'rotating_key'
    Set-Content $key 'k'; Set-Content $ciKey 'new'; Set-Content "$ciKey.old" 'old'; Set-Content "$ciKey.pub.old" 'ssh-ed25519 AAAA old'
    $message = ''
    try { & $script -GxHost 'root@gx.example.test' -SshKey $key -CiKey $ciKey -Rotate -SkipTailscale 6>&1 | Out-Null } catch { $message = "$_" }
    Assert ($message -match 'unfinished rotation') "Expected a refusal before any SSH, got: $message"
    Assert ((Get-Content $ciKey -Raw).Trim() -eq 'new' -and (Get-Content "$ciKey.old" -Raw).Trim() -eq 'old') 'Keys must be left untouched.'
}
finally { Remove-Item $temp -Recurse -Force }
Write-Output 'CI access setup tests passed: parse, dry run without side effects, host validation, unfinished rotation.'
