# Builds and starts the test GX. Fake data only. Usage: .\up.ps1 [-Sim e] [-Down]
param([string]$Sim = 'e', [switch]$Down)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:TEST_GX_SIM = $Sim
if ($Down) { docker compose down -v; return }

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
