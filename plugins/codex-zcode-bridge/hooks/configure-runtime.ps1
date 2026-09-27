[CmdletBinding()]
param(
    [string]$ZCodeRuntimePath,
    [string]$BuiltinProviderConfigPath,
    [string]$PersonalProviderConfigPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-ExistingFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Label must be an absolute path." }
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "$Label file does not exist: $resolved" }
    return $resolved
}

function Read-JsonObject {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    try { $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "$Label is not valid JSON: $Path" }
    if ($value -isnot [pscustomobject]) { throw "$Label must contain a JSON object: $Path" }
    return $value
}

function Test-ProviderConfig {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][ValidateSet("Builtin", "Personal")][string]$Kind)
    $json = Read-JsonObject -Path $Path -Label "$Kind provider config"
    if ($json.config -isnot [pscustomobject]) { throw "$Kind provider config has no config object: $Path" }
    if ($Kind -eq "Personal") {
        $rules = $json.config.providerConfigRules.providerRules
        $hasRules = ($rules -is [System.Collections.IDictionary] -and $rules.Count -gt 0) -or
            ($rules -is [array] -and $rules.Count -gt 0) -or
            ($rules -is [pscustomobject] -and $rules.PSObject.Properties.Count -gt 0)
        if (-not $hasRules) { throw "Personal provider config contains no provider rules (it may be a CLI-created stub): $Path" }
    }
}

function Find-DefaultRuntime {
    $roots = @($env:ZCODE_WINDOWS_APP_INSTALL_DIR)
    if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA "Programs\ZCode") }
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles "ZCode") }
    foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
        $candidate = Join-Path $root "resources\glm\zcode.cjs"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Set-UserEnvironmentPath {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
    [Environment]::SetEnvironmentVariable($Name, $Value, "User")
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
    Write-Host "Configured user environment variable: $Name"
}

if ($env:OS -ne "Windows_NT") { throw "This configuration script is for Windows PowerShell." }

# Discover and validate the current setup first. Default paths are read-only and
# never copied into the user environment; only explicit custom paths are stored.
$effectiveRuntime = if ($ZCodeRuntimePath) { Resolve-ExistingFile $ZCodeRuntimePath "ZCode runtime" }
    elseif ($env:ZCODE_BRIDGE_ZCODE_CJS) { Resolve-ExistingFile $env:ZCODE_BRIDGE_ZCODE_CJS "ZCODE_BRIDGE_ZCODE_CJS" }
    else { Find-DefaultRuntime }
if (-not $effectiveRuntime) { throw "Could not discover ZCode runtime. Pass -ZCodeRuntimePath with the absolute path to resources\glm\zcode.cjs." }

$effectiveBuiltin = if ($BuiltinProviderConfigPath) { Resolve-ExistingFile $BuiltinProviderConfigPath "Builtin provider config" }
    elseif ($env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) { Resolve-ExistingFile $env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" }
    else { Join-Path (Split-Path (Split-Path $effectiveRuntime -Parent) -Parent) "config\provider\zcode-builtin.json" }
$effectiveBuiltin = Resolve-ExistingFile $effectiveBuiltin "Builtin provider config"
Test-ProviderConfig -Path $effectiveBuiltin -Kind Builtin

$effectivePersonal = if ($PersonalProviderConfigPath) { Resolve-ExistingFile $PersonalProviderConfigPath "Personal provider config" }
    elseif ($env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) { Resolve-ExistingFile $env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" }
    else {
        $desktopDataBase = $null
        $settingsPath = Join-Path $HOME ".zcode\v2\setting.json"
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            try { $desktopDataBase = [string](Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).dataBaseDir }
            catch { Write-Warning "Could not read ZCode Desktop dataBaseDir from settings.json." }
        }
        $bases = @($env:ZCODE_DATA_BASE_DIR, $desktopDataBase, $HOME) | Where-Object { $_ }
        $found = $null
        foreach ($base in ($bases | Select-Object -Unique)) {
            $candidate = Join-Path $base ".zcode\v2\provider_config.json"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                try { Test-ProviderConfig -Path $candidate -Kind Personal; $found = [IO.Path]::GetFullPath($candidate); break }
                catch { Write-Warning $_.Exception.Message }
            }
        }
        $found
    }
if (-not $effectivePersonal) { throw "Could not find a valid personal provider config. Pass -PersonalProviderConfigPath with an existing ZCode provider config containing provider rules." }
Test-ProviderConfig -Path $effectivePersonal -Kind Personal

Write-Host "ZCode runtime and provider configuration were found and validated."
Write-Host "Runtime: $effectiveRuntime"
Write-Host "Builtin provider config: $effectiveBuiltin"
Write-Host "Personal provider config: $effectivePersonal"

if ($ZCodeRuntimePath) { Set-UserEnvironmentPath "ZCODE_BRIDGE_ZCODE_CJS" $effectiveRuntime }
if ($BuiltinProviderConfigPath) { Set-UserEnvironmentPath "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" $effectiveBuiltin }
if ($PersonalProviderConfigPath) { Set-UserEnvironmentPath "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" $effectivePersonal }

Write-Host "No marketplace or plugin changes were made. Restart Codex only if you configured custom paths, so its MCP process receives the updated user environment."
