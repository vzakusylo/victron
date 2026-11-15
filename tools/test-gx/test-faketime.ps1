# Manual libfaketime smoke test. Rebuilds the test GX from a sanitized backup.
# Usage: .\test-faketime.ps1 -Backup C:\learn\test-gx-data\sanitized\<name> [-FakeTime "@2026-03-29 01:50:00"] [-DelaySeconds 10]
param(
    [Parameter(Mandatory = $true)][string]$Backup,
    [string]$FakeTime = '@2026-03-29 01:50:00',
    [ValidateRange(1, 60)][int]$DelaySeconds = 10,
    [ValidateRange(0, 7200)][int]$ObserveSeconds = 0,
    [switch]$CheckMidnightCleanup,
    [switch]$CheckMonthRollover
)
$ErrorActionPreference = 'Stop'
if ($FakeTime -notmatch '^@\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$') {
    throw 'FakeTime must be @YYYY-MM-DD HH:mm:ss, for example "@2026-03-29 01:50:00"'
}
$fakeStart = [DateTime]::ParseExact(
    $FakeTime.Substring(1),
    'yyyy-MM-dd HH:mm:ss',
    [Globalization.CultureInfo]::InvariantCulture
)
if ($CheckMidnightCleanup) {
    if ($fakeStart.Hour -ne 23 -or $fakeStart.Minute -ne 59 -or $ObserveSeconds -lt 120) {
        throw 'Midnight checks require FakeTime at 23:59 and ObserveSeconds of at least 120'
    }
}
if ($CheckMonthRollover) {
    $isMonthEnd = $fakeStart.Day -eq [DateTime]::DaysInMonth($fakeStart.Year, $fakeStart.Month) `
        -and $fakeStart.Hour -eq 23 -and $fakeStart.Minute -eq 59
    $isFirstClosedHour = $fakeStart.Day -eq 1 -and $fakeStart.Hour -eq 0 `
        -and $fakeStart.Minute -eq 59 -and $ObserveSeconds -ge 70
    if (-not $isMonthEnd -and -not $isFirstClosedHour) {
        throw 'Month rollover requires the last day at 23:59 (observe >=3720s) or the first day at 00:59 (observe >=70s)'
    }
    if ($isMonthEnd -and $ObserveSeconds -lt 3720) {
        throw 'Starting at 23:59 on month end requires ObserveSeconds of at least 3720'
    }
    $nextMonth = if ($isMonthEnd) { $fakeStart.AddMonths(1).ToString('yyyy-MM') } else { $fakeStart.ToString('yyyy-MM') }
}
$Backup = (Resolve-Path $Backup).Path
$env:TEST_GX_FAKETIME = $FakeTime
& (Join-Path $PSScriptRoot 'up.ps1') -Backup $Backup -Sim emu
if ($LASTEXITCODE -ne 0) { throw "up.ps1 failed (exit $LASTEXITCODE)" }

$container = (docker compose -f (Join-Path $PSScriptRoot 'docker-compose.yml') ps -q nodered).Trim()
if (-not $container) { throw 'Node-RED container was not created' }
$deadline = (Get-Date).AddMinutes(2)
do {
    $health = docker inspect -f '{{.State.Health.Status}}' $container
    if ($LASTEXITCODE -ne 0) { throw 'could not inspect Node-RED container' }
    if ($health -eq 'healthy') { break }
    if ($health -eq 'unhealthy') { throw 'Node-RED healthcheck failed; inspect docker compose logs nodered' }
    Start-Sleep 2
} while ((Get-Date) -lt $deadline)
if ($health -ne 'healthy') { throw 'Node-RED did not become healthy within 2 minutes' }

$processEnv = @(docker exec $container sh -c "tr '\000' '\n' < /proc/1/environ")
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Node-RED process environment' }
foreach ($required in @(
    "FAKETIME=$FakeTime",
    'FAKETIME_DONT_FAKE_MONOTONIC=1',
    'LD_PRELOAD=/usr/local/lib/faketime/libfaketimeMT.so.1'
)) {
    if ($processEnv -notcontains $required) {
        throw "Node-RED process is missing required faketime setting: $($required.Split('=')[0])"
    }
}
Write-Host 'PASS Node-RED process has FAKETIME, LD_PRELOAD and monotonic protection'

$probe = @'
const delay = Number(process.argv[1]);
const local = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Oslo', hour12: false });
const startedAt = local();
const startedMono = process.hrtime.bigint();
setTimeout(() => {
    const elapsedMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
    console.log(JSON.stringify({ startedAt, endedAt: local(), elapsedMs }));
    if (Math.abs(elapsedMs - delay * 1000) > 2000) process.exitCode = 1;
}, delay * 1000);
'@
$probeOutput = & docker exec `
    -e "FAKETIME=$FakeTime" `
    -e 'FAKETIME_DONT_FAKE_MONOTONIC=1' `
    -e 'LD_PRELOAD=/usr/local/lib/faketime/libfaketimeMT.so.1' `
    -e 'TZ=Europe/Oslo' `
    $container node -e $probe $DelaySeconds
if ($LASTEXITCODE -ne 0) { throw 'Date / monotonic timer probe failed' }
$result = ($probeOutput | Select-Object -Last 1) | ConvertFrom-Json
$expected = $FakeTime.Substring(1, 16)
if (-not $result.startedAt.StartsWith($expected)) {
    throw "Node Date started at $($result.startedAt), expected local time beginning $expected"
}
Write-Host "PASS Date: $($result.startedAt) Europe/Oslo"
Write-Host ("PASS setTimeout: {0:N0} ms real time for {1} s" -f $result.elapsedMs, $DelaySeconds)
Write-Host 'PASS Node-RED healthcheck: healthy'

$startup = docker compose -f (Join-Path $PSScriptRoot 'docker-compose.yml') logs --no-log-prefix nodered 2>&1 |
    Select-String '\[info\] Started flows' | Select-Object -Last 1
if (-not $startup) { throw 'Node-RED did not log "Started flows"' }
Write-Host "PASS Node-RED started: $($startup.Line.Trim())"

$apiHeaders = @{ 'Node-RED-API-Version' = 'v2' }
$flows = Invoke-RestMethod -Headers $apiHeaders 'http://127.0.0.1:1881/flows'
$cleanupCheckEnabled = $false
if ($CheckMidnightCleanup) {
    $cleanupInject = @($flows.flows | Where-Object { $_.type -eq 'inject' -and $_.name -eq 'Daily cleanup midnight' }) | Select-Object -First 1
    $cleanupExec = @($flows.flows | Where-Object { $_.type -eq 'exec' -and $_.name -eq 'Delete logs older than 45 days' }) | Select-Object -First 1
    if (-not $cleanupInject -or -not $cleanupExec -or $cleanupInject.d -eq $true -or $cleanupExec.d -eq $true) {
        throw 'Daily cleanup inject or exec node is disabled/missing in this backup; cannot test it'
    }
    $cleanupCheckEnabled = $true
}
$mainTabs = @($flows.flows | Where-Object { $_.type -eq 'tab' })
if ($mainTabs.Count -ne 1 -or $mainTabs[0].label -notmatch '^d#\d+ Day / Night') {
    throw "Expected one main d#... Day / Night tab before the temporary probe; found $($mainTabs.Count)"
}
$mainTabId = $mainTabs[0].id
$probeIds = @(1..4 | ForEach-Object { [guid]::NewGuid().ToString('N').Substring(0, 16) })
$injectId, $startId, $delayId, $endId = $probeIds
$runId = $injectId
$startWires = ,([string[]]@($startId))
$delayWires = ,([string[]]@($delayId))
$endWires = ,([string[]]@($endId))
$noWires = ,([string[]]@())
$probeNodes = @(
    @{
        id = $injectId; type = 'inject'; name = 'once start marker'
        props = @(@{ p = 'payload'; v = ''; vt = 'date' })
        repeat = ''; crontab = ''; once = $true; onceDelay = 1
        topic = ''; payload = ''; payloadType = 'date'; wires = $startWires
    },
    @{
        id = $startId; type = 'function'; name = 'start marker'
        func = "node.warn('FAKETIME-MARK-$runId start ' + new Date().toISOString()); return msg;"
        outputs = 1; timeout = 0; noerr = 0; initialize = ''; finalize = ''; libs = @()
        wires = $delayWires
    },
    @{
        id = $delayId; type = 'delay'; name = '10 seconds'
        pauseType = 'delay'; timeout = '10'; timeoutUnits = 'seconds'
        rate = '1'; nbRateUnits = '1'; rateUnits = 'second'
        randomFirst = '1'; randomLast = '5'; randomUnits = 'seconds'
        drop = $false; allowrate = $false; outputs = 1; wires = $endWires
    },
    @{
        id = $endId; type = 'function'; name = 'after-delay marker'
        func = "node.warn('FAKETIME-MARK-$runId after-delay ' + new Date().toISOString()); return msg;"
        outputs = 1; timeout = 0; noerr = 0; initialize = ''; finalize = ''; libs = @()
        wires = $noWires
    }
)
$probe = $null
try {
    $probeBody = @{ label = "faketime-probe-$runId"; nodes = $probeNodes } | ConvertTo-Json -Depth 10
    $probe = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:1881/flow' `
        -Headers $apiHeaders -ContentType 'application/json' -Body $probeBody
    if (-not $probe.id) { throw 'POST /flow did not return a tab id' }

    $deployed = Invoke-RestMethod -Headers $apiHeaders 'http://127.0.0.1:1881/flows'
    $deployedTabs = @($deployed.flows | Where-Object { $_.type -eq 'tab' })
    if (-not @($deployedTabs | Where-Object { $_.id -eq $mainTabId -and $_.label -eq $mainTabs[0].label }).Count) {
        throw 'The main flow disappeared after POST /flow'
    }
    if (@($deployedTabs | Where-Object { $_.id -eq $probe.id }).Count -ne 1) {
        throw 'The temporary faketime probe tab was not returned by GET /flows'
    }
    $probeRuntimeNodes = @($deployed.flows | Where-Object { $_.id -in $probeIds })
    if ($probeRuntimeNodes.Count -ne 4 -or @($probeRuntimeNodes | Where-Object { $_.d -eq $true }).Count) {
        throw 'The temporary probe nodes are missing or disabled'
    }
    Write-Host "PASS Admin API kept the main tab and added the temporary probe ($($deployedTabs.Count) tabs)"

    Start-Sleep 13
    $markers = @(docker compose -f (Join-Path $PSScriptRoot 'docker-compose.yml') `
        logs --no-log-prefix --since 1m nodered 2>&1 | Select-String "FAKETIME-MARK-$runId")
    $startMarker = @($markers | Where-Object Line -match "FAKETIME-MARK-$runId start ")
    $endMarker = @($markers | Where-Object Line -match "FAKETIME-MARK-$runId after-delay ")
    if ($startMarker.Count -ne 1 -or $endMarker.Count -ne 1) {
        throw "Expected one start and one after-delay marker; got $($startMarker.Count)/$($endMarker.Count)"
    }
    $startTime = [DateTimeOffset]::Parse(($startMarker[0].Line -replace "^.*FAKETIME-MARK-$runId start ", ''))
    $endTime = [DateTimeOffset]::Parse(($endMarker[0].Line -replace "^.*FAKETIME-MARK-$runId after-delay ", ''))
    $elapsed = ($endTime - $startTime).TotalSeconds
    if ($elapsed -lt 9 -or $elapsed -gt 13) {
        throw "Node-RED delay elapsed $([math]::Round($elapsed, 1)) fake seconds; expected about 10"
    }
    Write-Host ("PASS Node-RED delay: both markers, {0:N1} fake seconds apart" -f $elapsed)
}
finally {
    if ($probe -and $probe.id) {
        Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:1881/flow/$($probe.id)" `
            -Headers $apiHeaders | Out-Null
        $afterProbe = Invoke-RestMethod -Headers $apiHeaders 'http://127.0.0.1:1881/flows'
        $afterTabs = @($afterProbe.flows | Where-Object { $_.type -eq 'tab' })
        if (@($afterTabs | Where-Object { $_.id -eq $probe.id }).Count) {
            throw 'DELETE /flow did not remove the temporary probe tab'
        }
        if (-not @($afterTabs | Where-Object { $_.id -eq $mainTabId -and $_.label -eq $mainTabs[0].label }).Count) {
            throw 'The main flow is missing after temporary probe cleanup'
        }
        Write-Host 'PASS temporary probe removed; main flow retained'
    }
}

$expiredLog = $null
if ($cleanupCheckEnabled) {
    $expiredLog = "/data/home/nodered/grid-control-logs/grid-control-test-expired-$runId.log"
    docker exec $container sh -c "touch -t 200001010000 '$expiredLog'"
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the expired-log sentinel for the midnight cleanup check' }
    Write-Host 'Created an expired test log for the midnight cleanup check'
}

$writes = Invoke-RestMethod 'http://127.0.0.1:8081/writes'
if ($writes -isnot [array]) { $writes = @($writes) }
$before = $writes
if ($ObserveSeconds -gt 0) {
    Write-Host "Observing Node-RED and D-Bus writes for $ObserveSeconds real seconds..."
    Start-Sleep $ObserveSeconds
    $writes = Invoke-RestMethod 'http://127.0.0.1:8081/writes'
    if ($writes -isnot [array]) { $writes = @($writes) }
    $previous = if ($before.Count) { [double](($before | Measure-Object ts -Maximum).Maximum) } else { 0 }
    $newWrites = @($writes | Where-Object { $_.ts -gt $previous })
    Write-Host "New emulator writes: $($newWrites.Count) $(($newWrites.path | Sort-Object -Unique) -join ', ')"
    docker compose -f (Join-Path $PSScriptRoot 'docker-compose.yml') logs --no-log-prefix --since "$($ObserveSeconds + 15)s" nodered 2>&1 |
        Select-String 'Started flows|error|warn' | Select-Object -Last 80 | ForEach-Object { Write-Host $_.Line }
}
if ($expiredLog) {
    docker exec $container sh -c "test ! -e '$expiredLog'"
    if ($LASTEXITCODE -ne 0) { throw 'Daily cleanup did not remove the expired test log by 00:01' }
    Write-Host 'PASS midnight cleanup removed the expired test log'
}
if ($CheckMonthRollover) {
    $monthCsv = "/data/home/nodered/grid-control-logs/energy-$nextMonth.csv"
    docker exec $container sh -c "test -s '$monthCsv' && grep -q '^$nextMonth-01 00,' '$monthCsv'"
    if ($LASTEXITCODE -ne 0) { throw "Monthly energy CSV for $nextMonth was not created with its first closed hour" }
    Write-Host "PASS month rollover created energy-$nextMonth.csv with the 00:00 hour"
}
if ($writes.Count) {
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [double](($writes | Measure-Object ts -Maximum).Maximum)
    if ($age -lt -5 -or $age -gt 120) { throw "D-Bus emulator write timestamps are not near real time (age ${age}s)" }
    Write-Host "PASS D-Bus emulator timestamps use real time; $($writes.Count) fake write(s), latest age ${age}s"
} else {
    Write-Warning 'No emulator writes yet; start the flow and check /writes manually.'
}

Write-Host "`nFor cron/DST/month scenarios, set FakeTime to just before the target, use -ObserveSeconds to span it, then inspect Node-RED logs plus http://127.0.0.1:8081/writes."
