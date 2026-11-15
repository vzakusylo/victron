# Builds and starts the test GX. Fake data only.
# Usage: .\up.ps1 -Backup C:\learn\test-gx-data\sanitized\<name> [-Sim e] | .\up.ps1 -Down
# -Backup (required): sanitized tree from sanitize-backup.js; Node-RED and palette versions are taken from its versions.json.
param([string]$Sim = 'e', [string]$Backup, [switch]$Down)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:TEST_GX_SIM = $Sim
if ($Down) { docker compose down -v; return }
if (-not $Backup) { throw 'up.ps1 needs -Backup <sanitized dir>: run test-gx-refresh.ps1 (downloads and sanitizes a backup) or sanitize-backup.js, the result is in C:\learn\test-gx-data\sanitized\<name>' }
# the gx-data volume is mounted on /data and would hide the new image content: always start from a fresh volume
docker compose down -v
$Backup = (Resolve-Path $Backup).Path
$v = Get-Content (Join-Path $Backup 'versions.json') -Raw | ConvertFrom-Json
$env:TEST_GX_BACKUP = $Backup
$env:TEST_GX_NODERED_VERSION = $v.nodeRed
$pal = foreach ($p in ($v.palette.PSObject.Properties | Where-Object Name -ne 'node-red')) {
    if (npm view "$($p.Name)@$($p.Value)" version 2>$null) { "$($p.Name)@$($p.Value)" }
    else {
        $minor = ($p.Value -split '\.')[0..1] -join '.'
        Write-Warning "$($p.Name)@$($p.Value) is not on npm; using ~$minor (versions differ from the GX)"
        "$($p.Name)@~$minor"
    }
}
$env:TEST_GX_PALETTE = $pal -join ' '
$env:TEST_GX_TAG = Split-Path $Backup -Leaf

$vd = Join-Path $PSScriptRoot '.venus-docker'
if (-not (Test-Path $vd)) { git clone -c core.autocrlf=false --depth 1 https://github.com/victronenergy/venus-docker $vd }
if (-not (docker image ls -q mqtt)) {
    git -C $vd -c core.autocrlf=false submodule update --init --recursive --depth 1
    # The HTML5 app stage fails to build upstream and is not needed here
    $df = Join-Path $vd 'dockerfile'
    $d = [regex]::Replace((Get-Content $df -Raw), '(?s)# Compile html5 app.*?RUN npm run build\s*', '')
    $d = $d -replace 'COPY --from=html5-app \./dist/ /var/www/venus_app/', 'RUN mkdir -p /var/www/venus_app'
    Set-Content $df $d -NoNewline
    docker build $vd -t mqtt
}
if (-not (Test-Path test_key)) { ssh-keygen -t ed25519 -N "" -C test-gx -f test_key | Out-Null }
docker compose up -d --build
Write-Host "Node-RED http://localhost:1881  Dashboard http://localhost:1881/ui  Venus app http://localhost:8080"
Write-Host "SSH: ssh -i $PSScriptRoot\test_key -p 2222 root@localhost"
