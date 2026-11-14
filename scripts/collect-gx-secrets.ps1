# Requires PowerShell 7 and Node.js on GX. One trusted SSH session; no value output.
param(
    [string]$GxHost = 'root@venus.local',
    [string]$SecretsDir = (Join-Path $PSScriptRoot '..\.secrets'),
    [string]$SshKey,
    [string]$SettingsFile = '/usr/lib/node_modules/node-red/venus-settings.js',
    [switch]$IncludeNodeSettings
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
    'venus-settings.js' = $SettingsFile
    '.config.users.json' = '/data/home/nodered/.node-red/.config.users.json'
}
if ($IncludeNodeSettings) {
    $remoteFiles['settings-user.js'] = '/data/home/nodered/.node-red/settings-user.js'
    $remoteFiles['tuya-nodes.json'] = '/data/home/nodered/grid-control-config/tuya-nodes.json'
}
$info = [Diagnostics.ProcessStartInfo]::new('ssh')
$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($argument in @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10')) {
    $info.ArgumentList.Add($argument)
}
if ($SshKey) {
    foreach ($argument in @('-i', $SshKey, '-o', 'IdentitiesOnly=yes')) { $info.ArgumentList.Add($argument) }
}
$info.ArgumentList.Add($GxHost)
$info.ArgumentList.Add('node')
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
try {
    $null = $process.Start()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $script = 'const fs=require("fs"),paths=' + ($remoteFiles | ConvertTo-Json -Compress) +
        ';try{const files={};for(const [name,path] of Object.entries(paths)){' +
        'files[name]=fs.readFileSync(path).toString("base64");}' +
        'process.stdout.write(JSON.stringify(files));}' +
        'catch{console.error("Cannot read required GX secret files.");process.exitCode=1;}'
    $process.StandardInput.Write($script)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(120000)) {
        $process.Kill($true)
        throw 'GX SSH collection timed out; no local files changed.'
    }
    if ($process.ExitCode -ne 0) {
        throw 'GX SSH collection failed. Check trusted host, key, permissions and required files; no local files changed.'
    }
    try { $encoded = ConvertFrom-Json -InputObject $output.GetAwaiter().GetResult() -AsHashtable }
    catch { throw 'Invalid GX transfer response; no local files changed.' }
    $null = $errors.GetAwaiter().GetResult()
}
finally { $process.Dispose() }
$contents = @{}
foreach ($file in $remoteFiles.Keys) {
    if (-not $encoded.ContainsKey($file)) { throw "GX transfer missing $file; no local files changed." }
    try { $contents[$file] = [Convert]::FromBase64String($encoded[$file]) }
    catch { throw "Invalid transfer encoding for $file; no local files changed." }
}
New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null
foreach ($file in $contents.Keys) {
    [IO.File]::WriteAllBytes((Join-Path $SecretsDir $file), $contents[$file])
    Write-Host "Collected $file"
}
