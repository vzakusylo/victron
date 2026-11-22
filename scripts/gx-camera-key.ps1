<#
.SYNOPSIS
  Check, add, remove, or test the restricted camera mail key. Defaults to read-only Check.
.DESCRIPTION
  Use the GX administrator identity, not the camera identity. Requires a known SSH host key.
  Add and Remove back up authorized_keys on the GX before replacing it.
#>
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [string]$GxHost = $env:GX_SSH_HOST,
    [string]$KeyPath = $env:GX_SSH_KEY_PATH,
    [string]$PubKeyFile = (Join-Path (Split-Path $PSScriptRoot) 'config\camera-ai.pub'),
    [Parameter(ParameterSetName = 'Check')][switch]$Check,
    [Parameter(ParameterSetName = 'Add', Mandatory = $true)][switch]$Add,
    [Parameter(ParameterSetName = 'Remove', Mandatory = $true)][switch]$Remove,
    [Parameter(ParameterSetName = 'Test', Mandatory = $true)][switch]$Test
)

$ErrorActionPreference = 'Stop'
try {
    if ($GxHost -notmatch '\A(?:root@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])\z') {
        throw 'Give -GxHost root@<host> (or set GX_SSH_HOST).'
    }
    if ($GxHost -notmatch '^root@') { $GxHost = "root@$GxHost" }
    if (-not $KeyPath -or -not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
        throw 'Give -KeyPath pointing to the administrator SSH identity (or set GX_SSH_KEY_PATH).'
    }
    $identity = (Resolve-Path -LiteralPath $KeyPath).ProviderPath
    $ssh = @('-T', '-i', $identity, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
        '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', $GxHost)
    if ($Test) {
        $result = & ssh @ssh 'SSH_ORIGINAL_COMMAND=check /data/home/nodered/tools/camera-mail-gate.js'
        if ($LASTEXITCODE -ne 0) { $result | Write-Output; throw 'Camera mail gate check failed.' }
        $reply = ($result -join "`n") | ConvertFrom-Json
        if ($reply.ok -ne $true -or $reply.check -ne $true) { throw 'Unexpected camera mail gate reply.' }
        Write-Output ('OK gate: ' + ($result -join "`n"))
        exit 0
    }

    $pub = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $PubKeyFile).ProviderPath)
    $match = [regex]::Match($pub, '\Assh-ed25519 ([A-Za-z0-9+/]{68}) camera-ai@omarchy(?:\r?\n)?\z')
    if (-not $match.Success) { throw 'Expected one ssh-ed25519 public key with comment camera-ai@omarchy.' }
    $blob = $match.Groups[1].Value
    $mode = $PSCmdlet.ParameterSetName.ToLowerInvariant()
    # Only the fixed mode and an allowlisted Base64 alphabet appear in the remote command.
    # Send the ASCII helper on stdin; nothing is installed on the GX.
    $helper = Join-Path (Split-Path $PSScriptRoot) 'tools\gx\camera-key.js'
    (Get-Content -LiteralPath $helper -Raw) | & ssh @ssh "node - $mode $blob"
    if ($LASTEXITCODE -ne 0) { throw "GX camera key $mode failed (SSH exit $LASTEXITCODE)." }
    exit 0
} catch {
    Write-Output ('FAIL ' + $_.Exception.Message)
    exit 1
}
