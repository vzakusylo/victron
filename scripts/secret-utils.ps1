# Shared by the upload scripts. Never write secret values to output.
function Set-FileSecret {
    param([string]$Repo, [string]$Name, [string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "Empty content for $Name; not uploaded." }
    if ([Text.Encoding]::UTF8.GetByteCount($Value) -gt 48KB) {
        throw "$Name exceeds the GitHub secret size limit; not uploaded."
    }
    $saved = @{}
    foreach ($key in @('GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN')) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
    try {
        # An enterprise GH_TOKEN overrides the github.com keyring account.
        $env:GH_HOST = 'github.com'
        Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
        $result = $Value | & gh secret set $Name --repo "github.com/$Repo" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Upload failed for $Repo / $Name. Check gh auth status --hostname github.com."
        }
        Write-Host "Updated $Repo / $Name"
    }
    finally {
        foreach ($key in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
        }
    }
}

function Assert-JsonSecret {
    param([string]$Value, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "Empty JSON for $Name." }
    try { $null = ConvertFrom-Json -InputObject $Value -ErrorAction Stop }
    catch { throw "Invalid JSON for $Name; not uploaded." }
}
