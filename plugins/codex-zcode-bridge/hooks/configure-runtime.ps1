[CmdletBinding()]
param(
    [string]$ZCodeRuntimePath,
    [string]$BuiltinProviderConfigPath,
    [string]$PersonalProviderConfigPath,
    [string]$ZCodeHome,
    [string]$DefaultProviderId,
    [string]$DefaultModelId,
    [string]$DefaultReasoningLevel,
    [ValidateSet("plan", "build", "edit", "yolo")][string]$Mode
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
    $nodeExecutable = if ($env:ZCODE_BRIDGE_NODE) {
        Resolve-ExistingFile $env:ZCODE_BRIDGE_NODE "ZCODE_BRIDGE_NODE"
    } else {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw "Node.js is required to validate $Label." }
        $nodeCommand.Source
    }
    $validator = @'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const object = value !== null && typeof value === 'object' && !Array.isArray(value);
const config = object && value.config && typeof value.config === 'object' && !Array.isArray(value.config);
const rules = config && value.config.providerConfigRules && value.config.providerConfigRules.providerRules;
const count = Array.isArray(rules) ? rules.length : (rules && typeof rules === 'object' ? Object.keys(rules).length : 0);
process.stdout.write(JSON.stringify({ isObject: object, configObject: !!config, providerRuleCount: count }));
'@
    $summaryJson = & $nodeExecutable -e $validator $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $summaryJson) { throw "$Label could not be parsed as JSON: $Path" }
    try { $summary = $summaryJson | ConvertFrom-Json }
    catch { throw "$Label JSON validation returned an invalid summary: $Path" }
    if (-not $summary.isObject) { throw "$Label must contain a JSON object: $Path" }
    return $summary
}

function Test-ProviderConfig {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][ValidateSet("Builtin", "Personal")][string]$Kind)
    $json = Read-JsonObject -Path $Path -Label "$Kind provider config"
    if (-not $json.configObject) { throw "$Kind provider config has no config object: $Path" }
    if ($Kind -eq "Personal") {
        if ($json.providerRuleCount -lt 1) { throw "Personal provider config contains no provider rules (it may be a CLI-created stub): $Path" }
    }
}

function Read-DesktopDataBaseDir {
    param([Parameter(Mandatory)][string]$Path)
    $nodeExecutable = if ($env:ZCODE_BRIDGE_NODE) { $env:ZCODE_BRIDGE_NODE }
        else { (Get-Command node -ErrorAction Stop).Source }
    $reader = @'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (value && typeof value.dataBaseDir === 'string') process.stdout.write(value.dataBaseDir);
'@
    $result = & $nodeExecutable -e $reader $Path 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Could not parse Desktop settings: $Path" }
    return ([string]$result).Trim()
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

function Resolve-ZCodeHome {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "ZCODE_HOME must be an absolute path." }
    $resolved = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetFileName($resolved).ToLowerInvariant() -ne ".zcode") {
        throw "ZCODE_HOME must point to the .zcode directory, not its parent."
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw "ZCODE_HOME directory does not exist: $resolved" }
    return $resolved
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

$configuredZCodeHome = if ($ZCodeHome) { Resolve-ZCodeHome $ZCodeHome }
    elseif ($env:ZCODE_HOME) { Resolve-ZCodeHome $env:ZCODE_HOME }
    else { $null }

$effectivePersonal = if ($PersonalProviderConfigPath) { Resolve-ExistingFile $PersonalProviderConfigPath "Personal provider config" }
    elseif ($env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) { Resolve-ExistingFile $env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" }
    elseif ($configuredZCodeHome) { Join-Path $configuredZCodeHome "v2\provider_config.json" }
    else {
        $desktopDataBase = $null
        $settingsPath = Join-Path $HOME ".zcode\v2\setting.json"
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            try { $desktopDataBase = Read-DesktopDataBaseDir $settingsPath }
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
$effectivePersonal = Resolve-ExistingFile $effectivePersonal "Personal provider config"
Test-ProviderConfig -Path $effectivePersonal -Kind Personal
if ($configuredZCodeHome) {
    $expectedPersonal = [IO.Path]::GetFullPath((Join-Path $configuredZCodeHome "v2\provider_config.json"))
    if ([IO.Path]::GetFullPath($effectivePersonal) -ne $expectedPersonal) {
        throw "The personal provider config must be inside ZCODE_HOME: $expectedPersonal"
    }
}

$effectiveDefaultProvider = if ($DefaultProviderId) { $DefaultProviderId.Trim() } else { $env:ZCODE_BRIDGE_DEFAULT_PROVIDER_ID }
$effectiveDefaultModel = if ($DefaultModelId) { $DefaultModelId.Trim() } else { $env:ZCODE_BRIDGE_DEFAULT_MODEL_ID }
$effectiveReasoning = if ($DefaultReasoningLevel) { $DefaultReasoningLevel.Trim() } else { $env:ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL }
if ([bool]$effectiveDefaultProvider -ne [bool]$effectiveDefaultModel) {
    throw "Default provider and model must be configured together (ZCODE_BRIDGE_DEFAULT_PROVIDER_ID and ZCODE_BRIDGE_DEFAULT_MODEL_ID)."
}
$effectiveMode = if ($Mode) { $Mode } elseif ($env:ZCODE_BRIDGE_MODE) { $env:ZCODE_BRIDGE_MODE } else { "yolo" }
if ($effectiveMode -notin @("plan", "build", "edit", "yolo")) {
    throw "ZCODE_BRIDGE_MODE must be one of: plan, build, edit, yolo."
}

Write-Host "ZCode runtime and provider configuration were found and validated."
Write-Host "Runtime: $effectiveRuntime"
Write-Host "Builtin provider config: $effectiveBuiltin"
Write-Host "Personal provider config: $effectivePersonal"
if ($configuredZCodeHome) { Write-Host "ZCode home: $configuredZCodeHome" }
if ($effectiveDefaultProvider) { Write-Host "Default model: $effectiveDefaultProvider/$effectiveDefaultModel" }
Write-Host "Default execution mode: $effectiveMode"

if ($ZCodeRuntimePath) { Set-UserEnvironmentPath "ZCODE_BRIDGE_ZCODE_CJS" $effectiveRuntime }
if ($BuiltinProviderConfigPath) { Set-UserEnvironmentPath "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" $effectiveBuiltin }
if ($PersonalProviderConfigPath) { Set-UserEnvironmentPath "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" $effectivePersonal }
if ($ZCodeHome) { Set-UserEnvironmentPath "ZCODE_HOME" $configuredZCodeHome }
if ($DefaultProviderId) { Set-UserEnvironmentPath "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID" $effectiveDefaultProvider }
if ($DefaultModelId) { Set-UserEnvironmentPath "ZCODE_BRIDGE_DEFAULT_MODEL_ID" $effectiveDefaultModel }
if ($DefaultReasoningLevel) { Set-UserEnvironmentPath "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL" $effectiveReasoning }
if ($Mode) { Set-UserEnvironmentPath "ZCODE_BRIDGE_MODE" $effectiveMode }

Write-Host "No marketplace or plugin changes were made. Restart Codex only if you configured custom paths, so its MCP process receives the updated user environment."
