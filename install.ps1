[CmdletBinding()]
param(
    [string]$WorkspacePath,
    [switch]$GrantWorkspaceModify,
    [string]$ZCodeRuntimePath,
    [string]$BuiltinProviderConfigPath,
    [string]$PersonalProviderConfigPath,
    [switch]$EnableUnrestrictedExecution,
    [string]$MarketplaceUrl = "https://github.com/Sandyzzx/codex-zcode-bridge.git",
    [string]$MarketplaceRef = "phase7-live-progress",
    [string]$MarketplaceName = "codex-zcode-bridge",
    [string]$PluginName = "codex-zcode-bridge"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-CodexJson {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $lines = & $script:CodexPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Codex command failed ($LASTEXITCODE): codex $($Arguments -join ' ')"
    }
    $json = ($lines | Out-String).Trim()
    if (-not $json) { throw "Codex returned empty JSON for: codex $($Arguments -join ' ')" }
    try { return $json | ConvertFrom-Json }
    catch { throw "Could not parse Codex JSON output for: codex $($Arguments -join ' ')" }
}

function Set-UserEnvironmentPath {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Value
    )

    if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be an absolute path." }
    if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw "$Name file does not exist: $Value" }
    [Environment]::SetEnvironmentVariable($Name, $Value, "User")
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
    Write-Host "Set user environment variable: $Name"
}

function Test-DirectoryWritable {
    param([Parameter(Mandatory)][string]$Path)

    $probe = Join-Path $Path (".codex-zcode-bridge-write-check-" + [guid]::NewGuid().ToString("N"))
    try {
        $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Dispose()
        return $true
    }
    catch [UnauthorizedAccessException] { return $false }
    catch [IO.IOException] { return $false }
    finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
    }
}

function Confirm-ExactPhrase {
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$Phrase
    )

    Write-Warning $Prompt
    $answer = Read-Host "Type '$Phrase' to continue"
    if ($answer -cne $Phrase) { throw "Confirmation did not match; no permission or environment setting was changed." }
}

if ($env:OS -ne "Windows_NT") {
    throw "This setup script is for Windows PowerShell."
}

$codex = Get-Command codex -ErrorAction Stop
$script:CodexPath = $codex.Source
$git = Get-Command git -ErrorAction Stop
$node = Get-Command node -ErrorAction Stop
$nodeVersionText = (& $node.Source -p "process.versions.node").Trim()
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersionText -lt [version]"22.18.0") {
    throw "Node.js 22.18 or later is required; found '$nodeVersionText'."
}
Write-Host "Found Codex, Git, and Node.js $nodeVersionText."

if ($WorkspacePath) {
    if (-not [IO.Path]::IsPathRooted($WorkspacePath)) { throw "WorkspacePath must be an absolute path." }
    $workspaceRoot = (& $git.Source -C $WorkspacePath rev-parse --show-toplevel 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $workspaceRoot) { throw "WorkspacePath must be inside an existing Git repository." }
    $workspaceRoot = [IO.Path]::GetFullPath($workspaceRoot)
    if (-not (Test-DirectoryWritable -Path $workspaceRoot)) {
        if (-not $GrantWorkspaceModify) {
            throw "The current user cannot create files in $workspaceRoot. Re-run with -GrantWorkspaceModify only if you intend to grant your account Modify access to this repository."
        }
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        Confirm-ExactPhrase `
            -Prompt "This changes the selected repository ACL. It grants your Windows account Modify access on this repository, inherited by its files and subdirectories. It does not sandbox ZCode or limit access to this path." `
            -Phrase "GRANT MODIFY"
        & "$env:SystemRoot\System32\icacls.exe" $workspaceRoot /grant "*${sid}:(OI)(CI)M"
        if ($LASTEXITCODE -ne 0) { throw "icacls could not update permissions for $workspaceRoot" }
        if (-not (Test-DirectoryWritable -Path $workspaceRoot)) { throw "Write access still failed after the ACL update." }
        Write-Host "Granted Modify access to the current Windows account on the selected repository."
    }
    else {
        Write-Host "The current user can write to the selected repository."
    }

    & $git.Source -C $workspaceRoot config --local core.longpaths true
    if ($LASTEXITCODE -ne 0) { throw "Could not set core.longpaths=true in $workspaceRoot" }
    Write-Host "Enabled Git long paths for this repository: $workspaceRoot"
}
elseif ($GrantWorkspaceModify) {
    throw "-GrantWorkspaceModify requires -WorkspacePath."
}

if ($ZCodeRuntimePath) { Set-UserEnvironmentPath -Name "ZCODE_BRIDGE_ZCODE_CJS" -Value $ZCodeRuntimePath }
if ($BuiltinProviderConfigPath) { Set-UserEnvironmentPath -Name "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" -Value $BuiltinProviderConfigPath }
if ($PersonalProviderConfigPath) { Set-UserEnvironmentPath -Name "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" -Value $PersonalProviderConfigPath }

if ($EnableUnrestrictedExecution) {
    Confirm-ExactPhrase `
        -Prompt "This lets ZCode run in yolo mode with the current Windows account's permissions. Git worktrees and path instructions are not a sandbox. The setting is stored for your Windows user and requires restarting Codex." `
        -Phrase "I ACCEPT UNRESTRICTED EXECUTION"
    [Environment]::SetEnvironmentVariable("ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION", "1", "User")
    Write-Warning "Unrestricted execution was enabled for your Windows user. Restart Codex for it to take effect."
}
else {
    Write-Host "Execution guard was left unchanged. Without the explicit opt-in, Bridge tasks remain blocked before model startup."
}

$marketplaceState = Invoke-CodexJson -Arguments @("plugin", "marketplace", "list", "--json")
$marketplace = @($marketplaceState.marketplaces | Where-Object { $_.name -eq $MarketplaceName }) | Select-Object -First 1
if ($marketplace) {
    $configuredSource = [string]$marketplace.marketplaceSource.source
    if ($configuredSource -and $configuredSource.TrimEnd("/") -ne $MarketplaceUrl.TrimEnd("/")) {
        throw "Marketplace name '$MarketplaceName' is already used by another source: $configuredSource"
    }
    & $script:CodexPath plugin marketplace upgrade $MarketplaceName
    if ($LASTEXITCODE -ne 0) { throw "Could not refresh marketplace '$MarketplaceName'." }
    Write-Host "Refreshed marketplace '$MarketplaceName'."
}
else {
    & $script:CodexPath plugin marketplace add $MarketplaceUrl --ref $MarketplaceRef
    if ($LASTEXITCODE -ne 0) { throw "Could not add marketplace '$MarketplaceUrl'." }
    Write-Host "Added marketplace '$MarketplaceName'."
}

$pluginState = Invoke-CodexJson -Arguments @("plugin", "list", "--available", "--json")
$pluginId = "$PluginName@$MarketplaceName"
$installed = @($pluginState.installed | Where-Object { $_.pluginId -eq $pluginId -and $_.installed }) | Select-Object -First 1
if ($installed) {
    if (-not $installed.enabled) {
        Write-Warning "Plugin '$pluginId' is installed but disabled. Enable it from Codex's Plugins UI; setup will not override that choice."
    }
    else { Write-Host "Plugin '$pluginId' is already installed and enabled." }
}
else {
    & $script:CodexPath plugin add $pluginId --json
    if ($LASTEXITCODE -ne 0) { throw "Could not install plugin '$pluginId'." }
    Write-Host "Installed plugin '$pluginId'."
}

Write-Host "Restart Codex, then review and trust the plugin's SessionStart hook when Codex asks. New conversations will run its read-only setup check."
Write-Host "No workspace ACL is changed unless -GrantWorkspaceModify is used; unrestricted execution is not enabled unless -EnableUnrestrictedExecution is used and confirmed."
