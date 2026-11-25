[CmdletBinding()]
param(
  [Alias('-check')][switch]$Check,
  [Alias('-rollback')][switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (!$IsWindows) { throw 'Use this token rotation script on Windows.' }
if ($Check -and $Rollback) { throw 'Select only one of -Check and -Rollback.' }

$repo = 'vzakusylo/victron'
$loopHome = Join-Path $env:USERPROFILE 'victron-loop'
$file = Join-Path $loopHome 'token'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Protect-Stage([string]$Path) {
  & icacls $Path /inheritance:r /grant:r "*${sid}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the token file ACL.' }
}

function Test-Token([string]$Candidate) {
  if (!$Candidate.Trim()) { throw 'No token supplied.' }
  if (!$Candidate.StartsWith('github_pat_')) { Write-Warning 'Expected a fine-grained github_pat_ token.' }
  $oldToken = $env:GH_TOKEN
  $oldDebug = $env:GH_DEBUG
  try {
    $env:GH_TOKEN = $Candidate.Trim()
    $env:GH_DEBUG = $null
    $response = & gh api --hostname github.com --include "repos/$repo" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "GitHub token validation failed: cannot read $repo." }
    & gh api --hostname github.com --silent "repos/$repo/pulls?state=open&per_page=1" 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub token validation failed: cannot read pull requests.' }
    & gh api --hostname github.com --silent "repos/$repo/actions/runs?per_page=1" 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub token validation failed: cannot read Actions runs.' }
    $repositories = & gh api --hostname github.com 'user/repos?per_page=2' --jq length 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Could not verify repository count; check the selected repository in GitHub.' }
    elseif ($repositories -match '^\d+$' -and [int]$repositories -gt 1) {
      Write-Warning 'This token can list more than one repository; verify its scope.'
    }
    foreach ($line in $response) {
      if ($line -match '^github-authentication-token-expiration:\s*(.+)$') {
        $expires = [DateTimeOffset]::MinValue
        $value = $Matches[1] -replace '\s+UTC$', ' +00:00'
        if ([DateTimeOffset]::TryParse($value, [cultureinfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$expires)) {
          return $expires
        }
        Write-Warning "GitHub's token expiration header could not be parsed."
        break
      }
    }
  } finally {
    $env:GH_TOKEN = $oldToken
    $env:GH_DEBUG = $oldDebug
  }
}

function Show-Expiry($Expires) {
  if ($null -eq $Expires) { Write-Host 'Expiry unavailable: GitHub did not report an expiration.'; return }
  $days = [math]::Ceiling(($Expires - [DateTimeOffset]::UtcNow).TotalDays)
  $remaining = if ($days -le 0) { 'expired' } else { "$days days remaining" }
  Write-Host "Expires: $($Expires.UtcDateTime.ToString('u')) ($remaining)"
}

if ($Check) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'No loop token is installed. Run rotate-token.ps1.' }
  $expires = Test-Token ([IO.File]::ReadAllText($file))
  Write-Host 'Loop token validated.'
  Show-Expiry $expires
  exit 0
}

New-Item -ItemType Directory -Path $loopHome -Force | Out-Null
$lock = [IO.File]::Open((Join-Path $loopHome '.token-rotation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$staged = @{}
$candidate = $null
try {
  if ($Rollback) {
    if (!(Test-Path -LiteralPath "$file.prev" -PathType Leaf)) { throw 'No previous loop token to restore.' }
    $candidate = [IO.File]::ReadAllText("$file.prev").Trim()
  } else {
    Write-Host 'Create a 90-day fine-grained token for vzakusylo/victron only:'
    Write-Host 'https://github.com/settings/personal-access-tokens/new'
    Write-Host 'Set Contents, Pull requests and Workflows to Read and write; Actions to Read.'
    $secure = Read-Host 'Paste the new token (hidden)' -AsSecureString
    try { $candidate = [Net.NetworkCredential]::new('', $secure).Password.Trim() }
    finally { $secure.Dispose() }
  }
  $expires = Test-Token $candidate
  $metadata = @{
    token_rotated_at = [DateTimeOffset]::UtcNow.ToString('o')
    expires_at = if ($null -ne $expires) { $expires.ToUniversalTime().ToString('o') } else { $null }
  } | ConvertTo-Json -Compress

  $contents = @{ $file = $candidate; "$file.meta" = $metadata }
  if (Test-Path -LiteralPath $file -PathType Leaf) { $contents["$file.prev"] = [IO.File]::ReadAllText($file) }
  foreach ($target in $contents.Keys) {
    $stage = Join-Path $loopHome ('.token-rotation.' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::Open($stage, 'CreateNew').Dispose()
    $staged[$target] = $stage
    Protect-Stage $stage
    [IO.File]::WriteAllText($stage, $contents[$target])
  }
  foreach ($target in @("$file.prev", $file, "$file.meta")) {
    if ($staged.ContainsKey($target)) { [IO.File]::Move($staged[$target], $target, $true) }
  }
} finally {
  $candidate = $contents = $null
  foreach ($stage in $staged.Values) { [IO.File]::Delete($stage) }
  $lock.Dispose()
}

Write-Host 'Loop token installed.'
Show-Expiry $expires
if ((Test-Path -LiteralPath (Join-Path $loopHome 'venv\Scripts\python.exe')) -and
    (Test-Path -LiteralPath (Join-Path $loopHome 'config.toml'))) {
  $result = & (Join-Path $loopHome 'venv\Scripts\python.exe') -m victron_loop.main `
    --config (Join-Path $loopHome 'config.toml') run-once --dry-run 2>&1
  if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -match 'token-missing|token-invalid|gh-observation-error') {
    throw 'Token installed, but the loop dry run did not pass. Check the run log and retry after any active cycle finishes.'
  }
  Write-Host 'Loop dry run passed.'
} else {
  Write-Host 'Run the Windows launcher with -Once to smoke-test the new token.'
}
Write-Host 'Revoke the previous token in GitHub after verifying the new token.'
