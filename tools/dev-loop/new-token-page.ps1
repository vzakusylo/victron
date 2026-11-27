[CmdletBinding()]
param(
  [switch]$NoRotate
)

# Opens GitHub's "new fine-grained token" page pre-filled for the dev loop, then runs rotate-token.ps1.
# GitHub pre-fills name, owner, expiry and permissions from the URL; the repository
# (Only select repositories -> vzakusylo/victron) must still be picked by hand.
# The token never passes through this script: copy it from GitHub and paste it at rotate-token.ps1's hidden prompt.

$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Use this script on Windows.' }

$name = "victron-loop $((Get-Date).ToString('yyyy-MM-dd'))"
$query = @(
  "name=$([uri]::EscapeDataString($name))"
  "description=$([uri]::EscapeDataString('Windows dev loop (tools/dev-loop)'))"
  'target_name=vzakusylo'
  'expires_in=90'
  'contents=write'
  'pull_requests=write'
  'workflows=write'
  'actions=read'
) -join '&'
$url = "https://github.com/settings/personal-access-tokens/new?$query"

Write-Host "Opening: $url"
Start-Process $url
Write-Host ''
Write-Host 'On the page:'
Write-Host '  1. Check name, 90-day expiry and permissions (Contents, Pull requests, Workflows: Read and write; Actions: Read).'
Write-Host '  2. Repository access: Only select repositories -> vzakusylo/victron.'
Write-Host '  3. Generate token, click the copy icon, copy nothing else afterwards.'
Write-Host ''

if ($NoRotate) { Write-Host 'Then run: tools\dev-loop\rotate-token.ps1'; exit 0 }
Read-Host 'Press Enter once the token is copied'
& (Join-Path $PSScriptRoot 'rotate-token.ps1')
