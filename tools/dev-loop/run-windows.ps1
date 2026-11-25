[CmdletBinding()]
param(
  [string]$RepoPath = 'C:\learn\victron',
  [string]$WebBind = '127.0.0.1:8790',
  [switch]$Live,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (!$IsWindows) { throw 'Use this launcher on Windows.' }

$loopHome = Join-Path $env:USERPROFILE 'victron-loop'
$config = Join-Path $loopHome 'config.toml'
$venv = Join-Path $loopHome 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
New-Item -ItemType Directory -Path $loopHome -Force | Out-Null

if (!(Test-Path -LiteralPath $config)) {
  $repoToml = [IO.Path]::GetFullPath($RepoPath) | ConvertTo-Json -Compress
  $bindToml = $WebBind | ConvertTo-Json -Compress
  $template = (Get-Content (Join-Path $PSScriptRoot 'config.example.toml') -Raw)
  $template = $template -replace '(?m)^repo_path = .+$', "repo_path = $repoToml"
  $template = $template -replace '(?m)^notify_backend = .+$', 'notify_backend = "windows"'
  $template = $template -replace '(?m)^model_tiers_file = .+\r?\n', ''
  $template += "`nworker_backend = `"herdr`"`ninstance_name = `"windows`"`nweb_bind = $bindToml`n"
  Set-Content -LiteralPath $config -Value $template -Encoding utf8NoBOM
}

$uv = Get-Command uv -ErrorAction SilentlyContinue
if (!(Test-Path -LiteralPath $python)) {
  if ($uv) { & uv venv --python 3.12 $venv }
  else { & py -3.12 -m venv $venv }
}
$stage = Join-Path ([IO.Path]::GetTempPath()) ('victron-loop-package-' + [Guid]::NewGuid().ToString('N'))
try {
  $modules = New-Item -ItemType Directory -Path (Join-Path $stage 'victron_loop') -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'pyproject.toml') -Destination $stage
  Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'victron_loop') -Filter '*.py' -File |
    Copy-Item -Destination $modules.FullName
  if ($uv) { & uv pip install --python $python --reinstall-package victron-loop $stage }
  else { & $python -m pip install --upgrade --force-reinstall --no-deps $stage
    & $python -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
  }
} finally {
  if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
}

$mode = if ($Live) { '--live' } else { '--dry-run' }
$cliArgs = @('--config', $config, 'serve', $mode)
if ($Once) { $cliArgs += '--once' }
& $python -m victron_loop.main @cliArgs
exit $LASTEXITCODE
