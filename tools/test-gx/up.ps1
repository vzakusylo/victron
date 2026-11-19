# Builds and starts the test GX. Fake data only.
# Usage: .\up.ps1 [-Backup C:\learn\test-gx-data\sanitized\<name>] [-Sim e] | .\up.ps1 -Down
# Without -Backup or TEST_GX_BACKUP, uses the isolated repository-generated fixture.
param([string]$Sim = 'e', [string]$Backup, [switch]$Down)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:TEST_GX_SIM = $Sim
$fixtureOverride = Join-Path $PSScriptRoot 'docker-compose.fixture.yml'
if ($env:TEST_GX_FIXTURE_AUTO_OVERRIDE -and $env:TEST_GX_COMPOSE_OVERRIDE -eq $env:TEST_GX_FIXTURE_AUTO_OVERRIDE) {
    Remove-Item Env:TEST_GX_COMPOSE_OVERRIDE
}
Remove-Item Env:TEST_GX_FIXTURE_AUTO_OVERRIDE -ErrorAction SilentlyContinue
$downFiles = @('-f', 'docker-compose.yml', '-f', $fixtureOverride)
if ($env:TEST_GX_COMPOSE_OVERRIDE -and $env:TEST_GX_COMPOSE_OVERRIDE -ne $fixtureOverride) {
    $downFiles += @('-f', $env:TEST_GX_COMPOSE_OVERRIDE)
}
if ($Down) {
    docker compose @downFiles down -v
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop Test GX and remove its volume' }
    return
}
if (-not $Backup -and $env:TEST_GX_BACKUP) { $Backup = $env:TEST_GX_BACKUP }
$fixturePath = (Resolve-Path (Join-Path $PSScriptRoot 'fixture-synthetic')).Path
if ($Backup) {
    $Backup = (Resolve-Path $Backup).Path
    if ($Backup -eq $fixturePath) { $Backup = $null }
}
$synthetic = -not $Backup
if ($synthetic) {
    if ($env:TEST_GX_FIXTURE_ONLINE -eq '1') {
        throw 'The fixture cannot run online; unset TEST_GX_FIXTURE_ONLINE'
    }
    if ($env:TEST_GX_COMPOSE_OVERRIDE -and $env:TEST_GX_COMPOSE_OVERRIDE -ne $fixtureOverride) {
        throw 'Unset TEST_GX_COMPOSE_OVERRIDE before starting the offline fixture'
    }
    node (Join-Path $PSScriptRoot 'build-fixture.js')
    if ($LASTEXITCODE -ne 0) { throw "Synthetic fixture generation failed (exit $LASTEXITCODE)" }
    node (Join-Path $PSScriptRoot 'fixture/check.js')
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic fixture verification failed' }
    $Backup = $fixturePath
    if (-not $env:TEST_GX_COMPOSE_OVERRIDE) {
        $env:TEST_GX_COMPOSE_OVERRIDE = $fixtureOverride
        $env:TEST_GX_FIXTURE_AUTO_OVERRIDE = $fixtureOverride
    }
}
$v = Get-Content (Join-Path $Backup 'versions.json') -Raw | ConvertFrom-Json
if ($synthetic) { Remove-Item Env:TEST_GX_BACKUP -ErrorAction SilentlyContinue }
else { $env:TEST_GX_BACKUP = $Backup }
$env:TEST_GX_NODERED_VERSION = $v.nodeRed
$pal = if (-not $synthetic) {
    foreach ($p in ($v.palette.PSObject.Properties | Where-Object Name -ne 'node-red')) {
        if (npm view "$($p.Name)@$($p.Value)" version 2>$null) { "$($p.Name)@$($p.Value)" }
        else {
            $minor = ($p.Value -split '\.')[0..1] -join '.'
            Write-Warning "$($p.Name)@$($p.Value) is not on npm; using ~$minor (versions differ from the GX)"
            "$($p.Name)@~$minor"
        }
    }
}
$env:TEST_GX_PALETTE = $pal -join ' '
$env:TEST_GX_TAG = Split-Path $Backup -Leaf

# The volume hides the image content; start from a fresh volume.
docker compose @downFiles down -v
if ($LASTEXITCODE -ne 0) { throw 'Could not stop Test GX and remove its volume' }
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
$upFiles = @()
if ($env:TEST_GX_COMPOSE_OVERRIDE) { $upFiles = @('-f', 'docker-compose.yml', '-f', $env:TEST_GX_COMPOSE_OVERRIDE) }
docker compose @upFiles up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Could not build or start Test GX' }
Write-Host "Node-RED http://localhost:1881  Dashboard http://localhost:1881/ui  Venus app http://localhost:8080"
Write-Host "SSH: ssh -i $PSScriptRoot\test_key -p 2222 root@localhost"
