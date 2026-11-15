# Checks that the emulator API answers 503 (GET and POST) until it is ready, then 200.
# Recreates the venus container with EMU_READY_DELAY=5, then restores it and restarts Node-RED. Needs the stack from up.ps1 -Sim emu.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:TEST_GX_SIM = 'emu'

function Call($method, $path, $body) {
  try {
    $r = Invoke-WebRequest -Method $method -Uri "http://127.0.0.1:8081$path" -UseBasicParsing -ContentType 'application/json' -Body $body -TimeoutSec 3
    return [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0   # not listening yet
  }
}

$fail = @()
try {
  $env:EMU_READY_DELAY = '5'
  docker compose -p test-gx up -d --no-deps --force-recreate venus 2>&1 | Out-Null
  $start = Get-Date
  $post = 0; $get = 0
  while (((Get-Date) - $start).TotalSeconds -lt 4) {   # the API may take a moment to listen; stay inside the 5 s window
    $post = Call 'POST' '/set' '{"path":"soc","value":50}'
    $get = Call 'GET' '/state' $null
    if ($post -ne 0) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($post -ne 503) { $fail += "POST /set before ready: $post (want 503)" }
  if ($get -ne 503) { $fail += "GET /state before ready: $get (want 503)" }
  Start-Sleep -Seconds 7
  $after = Call 'POST' '/set' '{"path":"soc","value":50}'
  if ($after -ne 200) { $fail += "POST /set after ready: $after (want 200)" }
  $log = docker logs test-gx-venus-1 2>&1 | Out-String
  if ($log -notmatch 'emulator up') { $fail += 'no "emulator up" line in the emulator log' }
} finally {
  $env:EMU_READY_DELAY = '0'
  docker compose -p test-gx up -d --no-deps --force-recreate venus 2>&1 | Out-Null
  docker compose -p test-gx restart nodered 2>&1 | Out-Null
}
if ($fail) { $fail | ForEach-Object { Write-Host "FAIL $_" -ForegroundColor Red }; exit 1 }
Write-Host 'OK  emulator answers 503 (GET, POST) before ready and 200 after'
