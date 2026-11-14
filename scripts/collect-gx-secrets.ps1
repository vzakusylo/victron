# Requires PowerShell 7. Reads only the documented Victron private files via SSH.
param(
    [string]$GxHost = 'root@venus.local',
    [string]$SecretsDir = (Join-Path $PSScriptRoot '..\.secrets'),
    [string]$SshKey
)
$ErrorActionPreference = 'Stop'
$remoteFiles = @{
    'tuya-cloud.json' = '/data/home/nodered/grid-control-config/tuya-cloud.json'
    'tuya-devices.json' = '/data/home/nodered/grid-control-config/tuya-devices.json'
    'tuya-local-sensors.json' = '/data/home/nodered/grid-control-config/tuya-local-sensors.json'
    'email.json' = '/data/home/nodered/grid-control-config/email.json'
    'mcp-token.txt' = '/data/home/nodered/grid-control-config/mcp-token.txt'
    'flows_cred.json' = '/data/home/nodered/.node-red/flows_cred.json'
    '.config.runtime.json' = '/data/home/nodered/.node-red/.config.runtime.json'
    'settings.js' = '/data/home/nodered/.node-red/settings.js'
}
$contents = @{}
foreach ($file in $remoteFiles.Keys) {
    $info = [Diagnostics.ProcessStartInfo]::new('ssh')
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10')) {
        $info.ArgumentList.Add($argument)
    }
    if ($SshKey) {
        foreach ($argument in @('-i', $SshKey, '-o', 'IdentitiesOnly=yes')) { $info.ArgumentList.Add($argument) }
    }
    $info.ArgumentList.Add($GxHost)
    $info.ArgumentList.Add("base64 '$($remoteFiles[$file])'")
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill($true)
            throw "GX SSH timed out reading $file; no local files changed."
        }
        if ($process.ExitCode -ne 0) {
            throw "GX SSH could not read $file. Check the trusted host, key, permissions and source file; no local files changed."
        }
        try { $contents[$file] = [Convert]::FromBase64String($output.GetAwaiter().GetResult()) }
        catch { throw "Invalid transfer encoding for $file; no local files changed." }
        $null = $errors.GetAwaiter().GetResult()
    }
    finally { $process.Dispose() }
}
New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null
foreach ($file in $contents.Keys) {
    [IO.File]::WriteAllBytes((Join-Path $SecretsDir $file), $contents[$file])
    Write-Host "Collected $file"
}
