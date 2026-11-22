<#
.SYNOPSIS
  Check that the GX is reachable before an SSH tool runs (perf-baseline, deploy, monitor). Read-only.

.DESCRIPTION
  For each host: ping, TCP 22 (SSH), and with -KeyPath a real "ssh ... true" login (BatchMode, 8 s timeout).
  Hosts come from -Hosts, else from $env:GX_SSH_HOST (user@host). No addresses are stored in the repo.
  Exit code 0 when at least one host passes every check, else 1. Prints the first working user@host.

.EXAMPLE
  .\scripts\gx-reach.ps1 -Hosts root@<tailscale-ip>,root@<lan-ip> -KeyPath $HOME\.ssh\<gx-key>
#>
param(
    [string[]]$Hosts = @($env:GX_SSH_HOST),
    [string]$KeyPath = $env:GX_SSH_KEY_PATH,
    [int]$TimeoutMs = 3000
)

$Hosts = @($Hosts | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $Hosts.Count) { Write-Error 'Give -Hosts user@host[,user@host] or set GX_SSH_HOST.'; exit 1 }

$working = $null
foreach ($target in $Hosts) {
    $user, $addr = if ($target -match '@') { $target -split '@', 2 } else { 'root', $target }
    # .NET Ping works the same in Windows PowerShell 5.1 and PowerShell 7 (Test-Connection parameters differ).
    $ping = $false
    try { $ping = ([System.Net.NetworkInformation.Ping]::new().Send($addr, $TimeoutMs).Status -eq 'Success') } catch { }

    $tcp = $false
    $client = [System.Net.Sockets.TcpClient]::new()
    try { $tcp = $client.ConnectAsync($addr, 22).Wait($TimeoutMs) -and $client.Connected } catch { } finally { $client.Dispose() }

    $ssh = 'skipped (no -KeyPath)'
    if ($KeyPath) {
        if (-not (Test-Path $KeyPath)) { $ssh = "key not found: $KeyPath" }
        elseif (-not $tcp) { $ssh = 'skipped (port 22 closed)' }
        else {
            & ssh -T -i $KeyPath -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8 "$user@$addr" true 2>$null
            $ssh = if ($LASTEXITCODE -eq 0) { 'ok' } else { "failed (exit $LASTEXITCODE)" }
        }
    }

    $ok = $tcp -and (-not $KeyPath -or $ssh -eq 'ok')
    '{0,-28} ping {1,-5} ssh-port {2,-5} login {3}  => {4}' -f "$user@$addr", $ping, $tcp, $ssh, ($(if ($ok) { 'OK' } else { 'NO' }))
    if ($ok -and -not $working) { $working = "$user@$addr" }
}

if ($working) { "Use: `$env:GX_SSH_HOST='$working'"; exit 0 }
'No GX host reachable. Check Tailscale on this PC, or that you are on the home LAN.'
exit 1
